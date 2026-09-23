import {
  type InternalSession,
  CorrectionSessionLimitError,
  CorrectionSessionNotFoundError,
  StaleCorrectionSessionError,
} from "./correction-session-state.js";

// Session capacity and optimistic version checks share the same lock lifetime.
export class CorrectionSessionStore {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly accessedAt = new Map<string, number>();
  public constructor(private readonly now: () => number) {}
  public get size(): number {
    return this.sessions.size;
  }
  public add(session: InternalSession): void {
    this.makeRoom();
    this.accessedAt.set(session.sessionId, this.now());
    this.sessions.set(session.sessionId, session);
    this.mutexes.set(session.sessionId, new AsyncMutex());
  }
  public async delete(sessionId: string, expected: number): Promise<void> {
    await this.withSessionLock(sessionId, expected, () => {
      this.sessions.delete(sessionId);
    });
    this.mutexes.delete(sessionId);
    this.accessedAt.delete(sessionId);
  }
  public clear(): void {
    this.sessions.clear();
    this.mutexes.clear();
    this.accessedAt.clear();
  }
  public required(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined)
      throw new CorrectionSessionNotFoundError("보정 session을 찾을 수 없습니다.");
    this.accessedAt.set(sessionId, this.now());
    return session;
  }

  public makeRoom(): void {
    for (const [id, session] of this.sessions) {
      if (
        session.undoStack.length === 0 &&
        !this.mutexes.get(id)?.busy &&
        this.now() - (this.accessedAt.get(id) ?? this.now()) >= 30 * 60_000
      ) {
        this.sessions.delete(id);
        this.mutexes.delete(id);
        this.accessedAt.delete(id);
      }
    }
    if (this.sessions.size >= 64) {
      throw new CorrectionSessionLimitError(
        "열린 작업 사본이 많습니다. 사용하지 않는 작업 사본을 닫은 뒤 다시 시도하세요.",
      );
    }
  }

  private requiredVersion(sessionId: string, expected: number): InternalSession {
    const session = this.required(sessionId);
    if (session.sessionVersion !== expected)
      throw new StaleCorrectionSessionError(
        `stale session: expected=${String(expected)}, current=${String(session.sessionVersion)}`,
      );
    return session;
  }

  public async withSessionLock<Result>(
    sessionId: string,
    expected: number,
    operation: (session: InternalSession) => Result | Promise<Result>,
  ): Promise<Result> {
    const mutex = this.mutexes.get(sessionId);
    if (mutex === undefined) this.required(sessionId);
    if (mutex === undefined)
      throw new CorrectionSessionNotFoundError("보정 session을 찾을 수 없습니다.");
    return mutex.run(() => operation(this.requiredVersion(sessionId, expected)));
  }
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  public get busy(): boolean {
    return this.pending > 0;
  }

  public async run<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    this.pending += 1;
    let release = (): void => undefined;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      this.pending -= 1;
      release();
    }
  }
}
