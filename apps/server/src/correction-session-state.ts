import type { CorrectionSession, StagingGameDocumentV2 } from "@kbo/contracts";
import type { ReplayResult } from "@kbo/game-core";
import type { StoredFinding } from "@kbo/persistence";
import type { PreparedCorrectionSnapshot } from "./correction-snapshot.js";

export interface HistoryEntry {
  readonly before: StagingGameDocumentV2;
  readonly after: StagingGameDocumentV2;
}

export interface InternalSession {
  readonly sessionId: string;
  readonly gameId: string;
  baseDocumentHash: string;
  authority: "staging" | "quarantine" | "superseded";
  snapshotId?: string;
  baseCurrentContentHash: string | null;
  document: StagingGameDocumentV2;
  replay: ReplayResult;
  prepared: PreparedCorrectionSnapshot;
  storedFindings: StoredFinding[];
  sessionVersion: number;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  cachedSnapshot?: CorrectionSession;
}

export class CorrectionSessionNotFoundError extends Error {}

export class StaleCorrectionSessionError extends Error {}

export class CorrectionSourceNotFoundError extends Error {}

export class CorrectionCommitBlockedError extends Error {}

export class CorrectionSessionLimitError extends Error {}

export function snapshot(session: InternalSession): CorrectionSession {
  if (session.cachedSnapshot?.sessionVersion === session.sessionVersion)
    return structuredClone(session.cachedSnapshot);
  const result: CorrectionSession = {
    ...session.prepared,
    sessionId: session.sessionId,
    authority: session.authority,
    ...(session.snapshotId === undefined ? {} : { snapshotId: session.snapshotId }),
    gameId: session.gameId,
    baseDocumentHash: session.baseDocumentHash,
    sessionVersion: session.sessionVersion,
    canUndo: session.undoStack.length > 0,
    canRedo: session.redoStack.length > 0,
    dirty: session.undoStack.length > 0,
  };
  session.cachedSnapshot = result;
  return structuredClone(result);
}
