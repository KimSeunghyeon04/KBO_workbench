import { randomUUID } from "node:crypto";

import {
  canonicalStringify,
  parseStagingGameDocumentV2,
  type CorrectionCommand,
  type CorrectionCommitRequest,
  type CorrectionCommitResult,
  type CorrectionFinding,
  type CorrectionMutationResult,
  type CorrectionSession,
  type CorrectionSessionCreateRequest,
  type CorrectionSourceEvidence,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { applyCorrectionCommand, buildCorrectionPreview } from "@kbo/correction";
import {
  compileStagingGameDocumentV2,
  stagingDocumentHash,
  type GameState,
  type ReplayResult,
} from "@kbo/game-core";
import type { StagingCorrectionCommit, StagingWorkspace, StoredFinding } from "@kbo/persistence";

interface HistoryEntry {
  readonly before: StagingGameDocumentV2;
  readonly after: StagingGameDocumentV2;
}
interface InternalSession {
  readonly sessionId: string;
  readonly gameId: string;
  baseDocumentHash: string;
  authority: "staging" | "quarantine" | "superseded";
  snapshotId?: string;
  baseCurrentContentHash: string | null;
  document: StagingGameDocumentV2;
  replay: ReplayResult;
  storedFindings: StoredFinding[];
  sessionVersion: number;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
}
type CorrectionWorkspace = Pick<
  StagingWorkspace,
  | "commitCorrection"
  | "readCurrentDocumentSnapshot"
  | "readOriginal"
  | "readSourceBundle"
  | "readSupersededSnapshot"
>;
export type CorrectionSourceEvidenceExtractor = (input: {
  readonly event: StagingGameDocumentV2["events"][number];
  readonly payloads: Readonly<Record<string, unknown>>;
}) => CorrectionSourceEvidence;

export class CorrectionSessionNotFoundError extends Error {}
export class StaleCorrectionSessionError extends Error {}
export class CorrectionSourceNotFoundError extends Error {}
export class CorrectionCommitBlockedError extends Error {}

export class CorrectionSessionManager {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly mutexes = new Map<string, AsyncMutex>();
  public constructor(
    private readonly workspace: CorrectionWorkspace,
    private readonly newId: () => string = randomUUID,
    private readonly extractSourceEvidence: CorrectionSourceEvidenceExtractor = () => {
      throw new CorrectionSourceNotFoundError("source evidence extractor가 설정되지 않았습니다.");
    },
  ) {}

  public async create(request: CorrectionSessionCreateRequest): Promise<CorrectionSession> {
    if (request.authority === "superseded") {
      const source = await this.workspace.readSupersededSnapshot(
        request.gameId,
        request.snapshotId,
      );
      const session: InternalSession = {
        sessionId: this.newId(),
        gameId: request.gameId,
        baseDocumentHash: stagingDocumentHash(source.document),
        authority: "superseded",
        snapshotId: source.snapshotId,
        baseCurrentContentHash: source.currentContentHash,
        document: source.document,
        replay: compileStagingGameDocumentV2(source.document),
        storedFindings: [...source.findings],
        sessionVersion: 0,
        undoStack: [],
        redoStack: [],
      };
      this.sessions.set(session.sessionId, session);
      this.mutexes.set(session.sessionId, new AsyncMutex());
      return snapshot(session);
    }
    const current = await this.workspace.readCurrentDocumentSnapshot(request.gameId);
    if (current === null || current.authority !== request.authority)
      throw new CorrectionSourceNotFoundError(
        `보정할 파일 원장을 찾을 수 없습니다: ${request.gameId}`,
      );
    const document = current.document;
    const storedFindings = current.findings;
    const session: InternalSession = {
      sessionId: this.newId(),
      gameId: request.gameId,
      baseDocumentHash: stagingDocumentHash(document),
      authority: current.authority,
      baseCurrentContentHash: null,
      document,
      replay: compileStagingGameDocumentV2(document),
      storedFindings: [...storedFindings],
      sessionVersion: 0,
      undoStack: [],
      redoStack: [],
    };
    this.sessions.set(session.sessionId, session);
    this.mutexes.set(session.sessionId, new AsyncMutex());
    return snapshot(session);
  }
  public get(sessionId: string): CorrectionSession {
    return snapshot(this.required(sessionId));
  }
  public async command(
    sessionId: string,
    expected: number,
    command: CorrectionCommand,
    apply: boolean,
  ): Promise<CorrectionMutationResult> {
    return this.withSessionLock(sessionId, expected, (session) => {
      const result = applyCorrectionCommand(session.document, command);
      if (apply) {
        session.undoStack.push({ before: session.document, after: result.document });
        session.redoStack = [];
        session.document = result.document;
        session.replay = result.replay;
        session.sessionVersion += 1;
      }
      return { session: snapshot(session), preview: result.preview };
    });
  }
  public async undo(sessionId: string, expected: number): Promise<CorrectionMutationResult> {
    return this.withSessionLock(sessionId, expected, (session) => {
      const entry = session.undoStack.pop();
      if (entry === undefined)
        throw new CorrectionCommitBlockedError("실행 취소할 작업이 없습니다.");
      const before = session.document;
      const beforeReplay = session.replay;
      session.redoStack.push(entry);
      session.document = entry.before;
      session.replay = compileStagingGameDocumentV2(entry.before);
      session.sessionVersion += 1;
      return {
        session: snapshot(session),
        preview: buildCorrectionPreview(before, beforeReplay, session.document, session.replay),
      };
    });
  }
  public async redo(sessionId: string, expected: number): Promise<CorrectionMutationResult> {
    return this.withSessionLock(sessionId, expected, (session) => {
      const entry = session.redoStack.pop();
      if (entry === undefined)
        throw new CorrectionCommitBlockedError("다시 실행할 작업이 없습니다.");
      const before = session.document;
      const beforeReplay = session.replay;
      session.undoStack.push(entry);
      session.document = entry.after;
      session.replay = compileStagingGameDocumentV2(entry.after);
      session.sessionVersion += 1;
      return {
        session: snapshot(session),
        preview: buildCorrectionPreview(before, beforeReplay, session.document, session.replay),
      };
    });
  }
  public async commit(
    sessionId: string,
    request: CorrectionCommitRequest,
  ): Promise<CorrectionCommitResult> {
    return this.withSessionLock(sessionId, request.expectedSessionVersion, async (session) => {
      const committedFindings = mergePersistentSourceFindings(
        session.storedFindings,
        session.replay.findings,
        session.document,
      );
      const blocking = committedFindings.filter(
        (finding) => finding.severity === "blocking",
      ).length;
      const canPromoteCleanQuarantine = session.authority === "quarantine" && blocking === 0;
      const canRestoreSuperseded = session.authority === "superseded";
      if (session.undoStack.length === 0 && !canPromoteCleanQuarantine && !canRestoreSuperseded) {
        throw new CorrectionCommitBlockedError("저장할 보정 작업이 없습니다.");
      }
      if (blocking > 0 && !request.allowBlockingStaging)
        throw new CorrectionCommitBlockedError(
          "차단 finding이 남아 있습니다. quarantine 저장을 명시적으로 허용해야 합니다.",
        );
      const targetAuthority = blocking > 0 ? "quarantine" : "staging";
      const document = session.document;
      const input: StagingCorrectionCommit =
        session.authority === "superseded"
          ? {
              baseAuthority: "superseded",
              baseSnapshotId: requiredSnapshotId(session),
              baseCurrentContentHash: session.baseCurrentContentHash,
              targetAuthority,
              baseDocumentHash: session.baseDocumentHash,
              document,
              findingEnvelope: { schemaVersion: 2, findings: committedFindings },
            }
          : {
              baseAuthority: session.authority,
              targetAuthority,
              baseDocumentHash: session.baseDocumentHash,
              document,
              findingEnvelope: { schemaVersion: 2, findings: committedFindings },
            };
      await this.workspace.commitCorrection(input);
      session.baseDocumentHash = stagingDocumentHash(document);
      session.authority = targetAuthority;
      delete session.snapshotId;
      session.baseCurrentContentHash = null;
      session.storedFindings = committedFindings;
      session.undoStack = [];
      session.redoStack = [];
      session.sessionVersion += 1;
      return { session: snapshot(session), committedAuthority: targetAuthority };
    });
  }
  public async original(sessionId: string): Promise<StagingGameDocumentV2> {
    const session = this.required(sessionId);
    return this.workspace.readOriginal(session.document.metadata.season, session.gameId);
  }
  public async sourceEvidence(
    sessionId: string,
    eventId: string,
  ): Promise<CorrectionSourceEvidence> {
    const session = this.required(sessionId);
    const event = session.document.events.find((item) => item.identity.eventId === eventId);
    if (event === undefined) {
      throw new CorrectionSourceNotFoundError(`원장 event를 찾을 수 없습니다: ${eventId}`);
    }
    if (event.identity.kind !== "source") {
      throw new CorrectionSourceNotFoundError("수동 추가 원장 행에는 immutable source가 없습니다.");
    }
    const bundle = await this.workspace.readSourceBundle(
      session.document.metadata.season,
      session.gameId,
      session.document.source.sourceBundleHash,
    );
    try {
      return this.extractSourceEvidence({ event, payloads: bundle.payloads });
    } catch (error: unknown) {
      if (error instanceof CorrectionSourceNotFoundError) throw error;
      throw new CorrectionSourceNotFoundError(
        error instanceof Error ? error.message : "immutable source evidence를 해석할 수 없습니다.",
      );
    }
  }
  public async loadOriginal(
    sessionId: string,
    expected: number,
  ): Promise<CorrectionMutationResult> {
    return this.withSessionLock(sessionId, expected, async (session) => {
      const original = await this.workspace.readOriginal(
        session.document.metadata.season,
        session.gameId,
      );
      const rebasedOriginal = parseSessionDocument({
        ...original,
        revisionBase: session.document.revisionBase,
      });
      const before = session.document;
      const beforeReplay = session.replay;
      const replay = compileStagingGameDocumentV2(rebasedOriginal);
      session.undoStack.push({ before, after: rebasedOriginal });
      session.redoStack = [];
      session.document = rebasedOriginal;
      session.replay = replay;
      session.sessionVersion += 1;
      return {
        session: snapshot(session),
        preview: buildCorrectionPreview(before, beforeReplay, rebasedOriginal, replay),
      };
    });
  }
  public async delete(sessionId: string, expected: number): Promise<void> {
    await this.withSessionLock(sessionId, expected, () => {
      this.sessions.delete(sessionId);
    });
    this.mutexes.delete(sessionId);
  }
  public close(): void {
    this.sessions.clear();
    this.mutexes.clear();
  }
  private required(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined)
      throw new CorrectionSessionNotFoundError("보정 session을 찾을 수 없습니다.");
    return session;
  }
  private requiredVersion(sessionId: string, expected: number): InternalSession {
    const session = this.required(sessionId);
    if (session.sessionVersion !== expected)
      throw new StaleCorrectionSessionError(
        `stale session: expected=${String(expected)}, current=${String(session.sessionVersion)}`,
      );
    return session;
  }
  private async withSessionLock<Result>(
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

  public async run<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    let release = (): void => undefined;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function parseSessionDocument(value: unknown): StagingGameDocumentV2 {
  return parseStagingGameDocumentV2(JSON.parse(canonicalStringify(value)) as unknown);
}

function snapshot(session: InternalSession): CorrectionSession {
  const currentFindings = mergePersistentSourceFindings(
    session.storedFindings,
    session.replay.findings,
    session.document,
  );
  const pitchFacts = new Map(session.replay.pitchFacts.map((pitch) => [pitch.pitchId, pitch]));
  return {
    sessionId: session.sessionId,
    authority: session.authority,
    ...(session.snapshotId === undefined ? {} : { snapshotId: session.snapshotId }),
    gameId: session.gameId,
    baseDocumentHash: session.baseDocumentHash,
    sessionVersion: session.sessionVersion,
    draftDocumentHash: stagingDocumentHash(session.document),
    draftDocument: parseSessionDocument(session.document),
    storedFindings: session.storedFindings.map((finding) =>
      storedFindingSnapshot(session.gameId, finding),
    ),
    findings: currentFindings.map((finding) => storedFindingSnapshot(session.gameId, finding)),
    eventContexts: session.replay.frames.map((frame) => {
      const pitch = pitchFacts.get(frame.eventId);
      return {
        eventId: frame.eventId,
        applied: frame.applied,
        before: correctionState(frame.before),
        after: correctionState(frame.after),
        ...(pitch === undefined
          ? {}
          : {
              pitch: {
                plateAppearanceEventId: pitch.plateAppearanceEventId,
                pitchEventNumber: pitch.pitchEventNumber,
                actualPitchNumber: pitch.actualPitchNumber,
                batterId: pitch.batterId,
                pitcherId: pitch.pitcherId,
                sourcePitchId: pitch.sourcePitchId,
                call: pitch.call,
                actual: pitch.actual,
              },
            }),
      };
    }),
    calculatedRecords: {
      batters: session.replay.batterLines.map((line) => ({ ...line })),
      pitchers: session.replay.pitcherLines.map((line) => ({ ...line })),
    },
    blockingCount: currentFindings.filter((finding) => finding.severity === "blocking").length,
    warningCount: currentFindings.filter((finding) => finding.severity === "warning").length,
    canUndo: session.undoStack.length > 0,
    canRedo: session.redoStack.length > 0,
    dirty: session.undoStack.length > 0,
  };
}

function requiredSnapshotId(session: InternalSession): string {
  if (session.snapshotId === undefined) {
    throw new CorrectionCommitBlockedError("superseded session snapshot ID가 없습니다.");
  }
  return session.snapshotId;
}
function storedFindingSnapshot(gameId: string, finding: StoredFinding): CorrectionFinding {
  return {
    code: finding.code,
    category: finding.category,
    severity: finding.severity,
    message: finding.message,
    gameId: finding.gameId ?? gameId,
    ...(finding.eventId === undefined ? {} : { eventId: finding.eventId }),
    ...(finding.eventSequence === undefined ? {} : { eventSequence: finding.eventSequence }),
    ...(finding.recordIdentity === undefined ? {} : { recordIdentity: finding.recordIdentity }),
    details: [
      ...(finding.endpoint === undefined ? [] : [{ field: "endpoint", actual: finding.endpoint }]),
      ...(finding.details ?? []).map((detail) => ({ ...detail })),
    ],
  };
}

function mergePersistentSourceFindings(
  stored: readonly StoredFinding[],
  current: ReplayResult["findings"],
  document: StagingGameDocumentV2,
): StoredFinding[] {
  const findings: StoredFinding[] = [
    ...stored.filter((finding) => shouldRetainStoredFinding(finding, document)),
    ...current.map((finding) => ({
      producer: "compiler" as const,
      lifecycle: "recomputed" as const,
      code: finding.code,
      category: finding.category,
      severity: finding.severity,
      message: finding.message,
      ...(finding.eventId === undefined ? {} : { eventId: finding.eventId }),
      ...(finding.eventSequence === undefined ? {} : { eventSequence: finding.eventSequence }),
      ...(finding.recordIdentity === undefined ? {} : { recordIdentity: finding.recordIdentity }),
      ...(finding.details.length === 0
        ? {}
        : { details: finding.details.map((detail) => ({ ...detail })) }),
    })),
  ];
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = canonicalStringify(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function shouldRetainStoredFinding(
  finding: StoredFinding,
  document: StagingGameDocumentV2,
): boolean {
  if (finding.lifecycle === "persistent") return true;
  if (finding.lifecycle === "while_event_unresolved" && finding.eventId !== undefined) {
    return document.events.some(
      (event) => event.identity.eventId === finding.eventId && event.kind === "unresolved",
    );
  }
  return false;
}
function correctionState(state: GameState): CorrectionSession["eventContexts"][number]["after"] {
  return {
    balls: state.balls,
    strikes: state.strikes,
    outs: state.outs,
    bases: state.bases.map((base) => base?.runnerId ?? null),
    awayScore: state.awayScore,
    homeScore: state.homeScore,
    batterId: state.activePlateAppearance?.currentBatterId ?? null,
    pitcherId: state.activePlateAppearance?.currentPitcherId ?? null,
  };
}
