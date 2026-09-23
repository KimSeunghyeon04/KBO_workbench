import { randomUUID } from "node:crypto";
import {
  CorrectionCommitBlockedError,
  CorrectionSourceNotFoundError,
  snapshot,
  type InternalSession,
} from "./correction-session-state.js";
import { CorrectionSessionStore } from "./correction-session-store.js";
export {
  CorrectionCommitBlockedError,
  CorrectionSessionLimitError,
  CorrectionSessionNotFoundError,
  CorrectionSourceNotFoundError,
  StaleCorrectionSessionError,
} from "./correction-session-state.js";
export { mergePersistentSourceFindings } from "./correction-snapshot.js";

import {
  canonicalStringify,
  type CorrectionCommand,
  type CorrectionCommitRequest,
  type CorrectionCommitResult,
  type CorrectionMutationResult,
  type CorrectionSession,
  type CorrectionSessionCreateRequest,
  type CorrectionSourceEvidence,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { buildCorrectionPreview } from "@kbo/correction";
import type {
  ImmutableSourceBundle,
  StagingCorrectionCommit,
  StagingWorkspace,
} from "@kbo/persistence";

import { BoundedReadCache } from "./bounded-read-cache.js";
import {
  compileCorrectionDocument,
  inlineComputation,
  type ComputationRunner,
} from "./computation.js";
import { mergePersistentSourceFindings } from "./correction-snapshot.js";
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

export class CorrectionSessionManager {
  private readonly sessions: CorrectionSessionStore;
  private readonly sources = new BoundedReadCache<{ bundle: ImmutableSourceBundle; bytes: number }>(
    32 * 1024 * 1024,
    8,
    300_000,
    undefined,
    (entry) => entry.bytes,
  );
  public constructor(
    private readonly workspace: CorrectionWorkspace,
    private readonly newId: () => string = randomUUID,
    private readonly extractSourceEvidence: CorrectionSourceEvidenceExtractor = () => {
      throw new CorrectionSourceNotFoundError("source evidence extractor가 설정되지 않았습니다.");
    },
    now: () => number = Date.now,
    private readonly computation: ComputationRunner = inlineComputation,
    private readonly readEvidence?: (
      season: number,
      gameId: string,
      hash: string,
      event: StagingGameDocumentV2["events"][number],
    ) => Promise<CorrectionSourceEvidence>,
  ) {
    this.sessions = new CorrectionSessionStore(now);
  }

  public async create(request: CorrectionSessionCreateRequest): Promise<CorrectionSession> {
    this.sessions.makeRoom();
    if (request.authority === "superseded") {
      const source = await this.workspace.readSupersededSnapshot(
        request.gameId,
        request.snapshotId,
      );
      const { replay, prepared } = await compileCorrectionDocument(
        this.computation,
        source.document,
        source.findings,
      );
      const session: InternalSession = {
        sessionId: this.newId(),
        gameId: request.gameId,
        baseDocumentHash: prepared.draftDocumentHash,
        authority: "superseded",
        snapshotId: source.snapshotId,
        baseCurrentContentHash: source.currentContentHash,
        document: source.document,
        replay,
        prepared,
        storedFindings: [...source.findings],
        sessionVersion: 0,
        undoStack: [],
        redoStack: [],
      };
      this.sessions.add(session);
      return snapshot(session);
    }
    const current = await this.workspace.readCurrentDocumentSnapshot(request.gameId);
    if (current === null || current.authority !== request.authority)
      throw new CorrectionSourceNotFoundError(
        `보정할 파일 원장을 찾을 수 없습니다: ${request.gameId}`,
      );
    const document = current.document;
    const storedFindings = current.findings;
    const { replay, prepared } = await compileCorrectionDocument(
      this.computation,
      document,
      storedFindings,
    );
    const session: InternalSession = {
      sessionId: this.newId(),
      gameId: request.gameId,
      baseDocumentHash: prepared.draftDocumentHash,
      authority: current.authority,
      baseCurrentContentHash: null,
      document,
      replay,
      prepared,
      storedFindings: [...storedFindings],
      sessionVersion: 0,
      undoStack: [],
      redoStack: [],
    };
    this.sessions.add(session);
    return snapshot(session);
  }
  public get(sessionId: string): CorrectionSession {
    return snapshot(this.sessions.required(sessionId));
  }
  public async command(
    sessionId: string,
    expected: number,
    command: CorrectionCommand,
    apply: boolean,
  ): Promise<CorrectionMutationResult> {
    return this.sessions.withSessionLock(sessionId, expected, async (session) => {
      const computed = await this.computation.run({
        kind: "command",
        ...(apply ? { storedFindings: session.storedFindings } : {}),
        document: session.document,
        command,
      });
      if (computed.kind !== "command") throw new Error("Unexpected correction result");
      const result = computed.value;
      if (apply) {
        if (computed.snapshot === undefined) throw new Error("Missing correction snapshot");
        session.undoStack.push({ before: session.document, after: result.document });
        session.redoStack = [];
        session.document = result.document;
        session.replay = result.replay;
        session.prepared = computed.snapshot;
        session.sessionVersion += 1;
      }
      return { session: snapshot(session), preview: result.preview };
    });
  }
  public async undo(sessionId: string, expected: number): Promise<CorrectionMutationResult> {
    return this.sessions.withSessionLock(sessionId, expected, async (session) => {
      const entry = session.undoStack.at(-1);
      if (entry === undefined)
        throw new CorrectionCommitBlockedError("실행 취소할 작업이 없습니다.");
      const before = session.document;
      const beforeReplay = session.replay;
      const { replay, prepared } = await compileCorrectionDocument(
        this.computation,
        entry.before,
        session.storedFindings,
      );
      session.undoStack.pop();
      session.redoStack.push(entry);
      session.document = entry.before;
      session.replay = replay;
      session.prepared = prepared;
      session.sessionVersion += 1;
      return {
        session: snapshot(session),
        preview: buildCorrectionPreview(before, beforeReplay, session.document, session.replay),
      };
    });
  }
  public async redo(sessionId: string, expected: number): Promise<CorrectionMutationResult> {
    return this.sessions.withSessionLock(sessionId, expected, async (session) => {
      const entry = session.redoStack.at(-1);
      if (entry === undefined)
        throw new CorrectionCommitBlockedError("다시 실행할 작업이 없습니다.");
      const before = session.document;
      const beforeReplay = session.replay;
      const { replay, prepared } = await compileCorrectionDocument(
        this.computation,
        entry.after,
        session.storedFindings,
      );
      session.redoStack.pop();
      session.undoStack.push(entry);
      session.document = entry.after;
      session.replay = replay;
      session.prepared = prepared;
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
    return this.sessions.withSessionLock(
      sessionId,
      request.expectedSessionVersion,
      async (session) => {
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
        session.baseDocumentHash = session.prepared.draftDocumentHash;
        session.prepared = { ...session.prepared, storedFindings: session.prepared.findings };
        session.authority = targetAuthority;
        delete session.snapshotId;
        session.baseCurrentContentHash = null;
        session.storedFindings = committedFindings;
        session.undoStack = [];
        session.redoStack = [];
        session.sessionVersion += 1;
        return { session: snapshot(session), committedAuthority: targetAuthority };
      },
    );
  }
  public async original(sessionId: string): Promise<StagingGameDocumentV2> {
    const session = this.sessions.required(sessionId);
    return this.workspace.readOriginal(session.document.metadata.season, session.gameId);
  }
  public async sourceEvidence(
    sessionId: string,
    eventId: string,
  ): Promise<CorrectionSourceEvidence> {
    const session = this.sessions.required(sessionId);
    const event = session.document.events.find((item) => item.identity.eventId === eventId);
    if (event === undefined) {
      throw new CorrectionSourceNotFoundError(`원장 event를 찾을 수 없습니다: ${eventId}`);
    }
    if (event.identity.kind !== "source") {
      throw new CorrectionSourceNotFoundError("수동 추가 원장 행에는 immutable source가 없습니다.");
    }
    if (this.readEvidence !== undefined)
      return this.readEvidence(
        session.document.metadata.season,
        session.gameId,
        session.document.source.sourceBundleHash,
        event,
      );
    const { bundle } = await this.sources.load(
      canonicalStringify([
        session.document.metadata.season,
        session.gameId,
        session.document.source.sourceBundleHash,
      ]),
      async () => {
        const bundle = await this.workspace.readSourceBundle(
          session.document.metadata.season,
          session.gameId,
          session.document.source.sourceBundleHash,
        );
        return { bundle, bytes: Buffer.byteLength(JSON.stringify(bundle), "utf8") };
      },
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
    return this.sessions.withSessionLock(sessionId, expected, async (session) => {
      const original = await this.workspace.readOriginal(
        session.document.metadata.season,
        session.gameId,
      );
      const rebasedOriginal = {
        ...original,
        revisionBase: session.document.revisionBase,
      };
      const before = session.document;
      const beforeReplay = session.replay;
      const { replay, prepared } = await compileCorrectionDocument(
        this.computation,
        rebasedOriginal,
        session.storedFindings,
      );
      session.undoStack.push({ before, after: rebasedOriginal });
      session.redoStack = [];
      session.document = rebasedOriginal;
      session.replay = replay;
      session.prepared = prepared;
      session.sessionVersion += 1;
      return {
        session: snapshot(session),
        preview: buildCorrectionPreview(before, beforeReplay, rebasedOriginal, replay),
      };
    });
  }
  public async delete(sessionId: string, expected: number): Promise<void> {
    await this.sessions.delete(sessionId, expected);
    if (this.sessions.size === 0) this.sources.clear();
  }
  public close(): void {
    this.sessions.clear();
    this.sources.clear();
  }
}

function requiredSnapshotId(session: InternalSession): string {
  if (session.snapshotId === undefined) {
    throw new CorrectionCommitBlockedError("superseded session snapshot ID가 없습니다.");
  }
  return session.snapshotId;
}
