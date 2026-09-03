import {
  CorrectionCommitResultSchema,
  CorrectionGameCatalogSchema,
  CorrectionMutationResultSchema,
  CorrectionSessionSchema,
  CorrectionSourceEvidenceSchema,
  StagingGameDocumentV2Schema,
  type CorrectionCommand,
  type CorrectionCommitResult,
  type CorrectionGameCatalog,
  type CorrectionMutationResult,
  type CorrectionSession,
  type CorrectionSourceEvidence,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

import { requestJson } from "./transport";

export async function getCorrectionGameCatalog(): Promise<CorrectionGameCatalog> {
  return Value.Decode(CorrectionGameCatalogSchema, await requestJson("/api/v2/correction-games"));
}

export async function createCorrectionSession(
  authority: "staging" | "quarantine",
  gameId: string,
): Promise<CorrectionSession> {
  return Value.Decode(
    CorrectionSessionSchema,
    await requestJson("/api/v2/correction-sessions", {
      method: "POST",
      body: JSON.stringify({ authority, gameId }),
    }),
  );
}
export async function getCorrectionSession(sessionId: string): Promise<CorrectionSession> {
  return Value.Decode(
    CorrectionSessionSchema,
    await requestJson(`/api/v2/correction-sessions/${encodeURIComponent(sessionId)}`),
  );
}
export async function submitCorrectionCommand(
  sessionId: string,
  expectedSessionVersion: number,
  command: CorrectionCommand,
  apply: boolean,
): Promise<CorrectionMutationResult> {
  return Value.Decode(
    CorrectionMutationResultSchema,
    await requestJson(`/api/v2/correction-sessions/${encodeURIComponent(sessionId)}/commands`, {
      method: "POST",
      body: JSON.stringify({ expectedSessionVersion, command, apply }),
    }),
  );
}
export async function moveCorrectionHistory(
  sessionId: string,
  expectedSessionVersion: number,
  direction: "undo" | "redo",
): Promise<CorrectionMutationResult> {
  return Value.Decode(
    CorrectionMutationResultSchema,
    await requestJson(`/api/v2/correction-sessions/${encodeURIComponent(sessionId)}/${direction}`, {
      method: "POST",
      body: JSON.stringify({ expectedSessionVersion }),
    }),
  );
}
export async function commitCorrection(
  sessionId: string,
  expectedSessionVersion: number,
  allowBlockingStaging: boolean,
): Promise<CorrectionCommitResult> {
  return Value.Decode(
    CorrectionCommitResultSchema,
    await requestJson(`/api/v2/correction-sessions/${encodeURIComponent(sessionId)}/commit`, {
      method: "POST",
      body: JSON.stringify({ expectedSessionVersion, allowBlockingStaging }),
    }),
  );
}
export async function getCorrectionOriginal(sessionId: string): Promise<StagingGameDocumentV2> {
  return Value.Decode(
    StagingGameDocumentV2Schema,
    await requestJson(`/api/v2/correction-sessions/${encodeURIComponent(sessionId)}/original`),
  );
}
export async function getCorrectionSourceEvidence(
  sessionId: string,
  eventId: string,
): Promise<CorrectionSourceEvidence> {
  return Value.Decode(
    CorrectionSourceEvidenceSchema,
    await requestJson(
      `/api/v2/correction-sessions/${encodeURIComponent(sessionId)}/source-evidence/${encodeURIComponent(eventId)}`,
    ),
  );
}
export async function loadCorrectionOriginal(
  sessionId: string,
  expectedSessionVersion: number,
): Promise<CorrectionMutationResult> {
  return Value.Decode(
    CorrectionMutationResultSchema,
    await requestJson(
      `/api/v2/correction-sessions/${encodeURIComponent(sessionId)}/load-original`,
      { method: "POST", body: JSON.stringify({ expectedSessionVersion }) },
    ),
  );
}
