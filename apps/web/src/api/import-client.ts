import {
  ImportJobCreatedSchema,
  ImportJobListSchema,
  ImportReadyBatchCreatedSchema,
  StagingGameDocumentV2Schema,
  type ImportJob,
  type ImportJobCreated,
  type ImportReadyBatchCreated,
  type StagingGameDocumentV2,
  ImportJobSchema,
  ImportSelectionSchema,
  ImportHistorySchema,
  DatabaseGamesSchema,
  type ImportSelectionRequest,
  type ImportSelection,
  type ImportHistoryQuery,
  type ImportHistory,
  type DatabaseGames,
  type DatabaseGamesQuery,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";

import { requestJson } from "./transport";
import { createRequestKey } from "./request-key";

export async function getImportJobs(): Promise<readonly ImportJob[]> {
  return Value.Decode(ImportJobListSchema, await requestJson("/api/v2/import-jobs")).jobs;
}
export async function createImportJob(gameId: string): Promise<ImportJobCreated> {
  return createImportForDocument({ gameId, idempotencyKey: createRequestKey() });
}
export async function createImportForDocument(
  request: import("@kbo/contracts").ImportJobCreateRequest,
): Promise<ImportJobCreated> {
  return Value.Decode(
    ImportJobCreatedSchema,
    await requestJson("/api/v2/import-jobs", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
}
export async function createReadyImportBatch(
  selectionId: string,
  idempotencyKey: string,
): Promise<ImportReadyBatchCreated> {
  return Value.Decode(
    ImportReadyBatchCreatedSchema,
    await requestJson("/api/v2/import-jobs/batch", {
      method: "POST",
      body: JSON.stringify({ selectionId, idempotencyKey }),
    }),
  );
}

export async function createImportSelection(
  criteria: ImportSelectionRequest,
): Promise<ImportSelection> {
  return Value.Decode(
    ImportSelectionSchema,
    await requestJson("/api/v2/import-selections", {
      method: "POST",
      body: JSON.stringify(criteria),
    }),
  );
}
export async function getDatabaseGames(
  query: DatabaseGamesQuery,
  signal?: AbortSignal,
): Promise<DatabaseGames> {
  return Value.Decode(
    DatabaseGamesSchema,
    await requestJson(
      `/api/v2/database/games?${queryString(query)}`,
      signal === undefined ? {} : { signal },
    ),
  );
}
export async function getImportHistory(
  query: ImportHistoryQuery,
  signal?: AbortSignal,
): Promise<ImportHistory> {
  return Value.Decode(
    ImportHistorySchema,
    await requestJson(
      `/api/v2/import-history?${queryString(query)}`,
      signal === undefined ? {} : { signal },
    ),
  );
}
export async function getImportJob(jobId: string, signal?: AbortSignal): Promise<ImportJob> {
  return Value.Decode(
    ImportJobSchema,
    await requestJson(
      `/api/v2/import-jobs/${encodeURIComponent(jobId)}`,
      signal === undefined ? {} : { signal },
    ),
  );
}
export async function reconcileImportJob(jobId: string): Promise<ImportJob> {
  return Value.Decode(
    ImportJobSchema,
    await requestJson(`/api/v2/import-jobs/${encodeURIComponent(jobId)}/reconcile`, {
      method: "POST",
    }),
  );
}
export async function cancelImportBatch(batchId: string): Promise<void> {
  Value.Decode(
    Type.Object({ cancelled: Type.Literal(true) }, { additionalProperties: false }),
    await requestJson(`/api/v2/import-batches/${encodeURIComponent(batchId)}/cancel`, {
      method: "POST",
    }),
  );
}
function queryString(query: Readonly<Record<string, string | number>>): string {
  return new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  ).toString();
}
export async function reopenRevisionDraft(
  gameId: string,
  revision: number,
): Promise<StagingGameDocumentV2> {
  return Value.Decode(
    StagingGameDocumentV2Schema,
    await requestJson(
      `/api/v2/games/${encodeURIComponent(gameId)}/revisions/${String(revision)}/correction-drafts`,
      { method: "POST" },
    ),
  );
}
