import {
  ImportJobCreatedSchema,
  ImportJobListSchema,
  ImportReadyBatchCreatedSchema,
  StagingGameDocumentV2Schema,
  type ImportJob,
  type ImportJobCreated,
  type ImportReadyBatchCreated,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

import { requestJson } from "./transport";

export async function getImportJobs(): Promise<readonly ImportJob[]> {
  return Value.Decode(ImportJobListSchema, await requestJson("/api/v2/import-jobs")).jobs;
}
export async function createImportJob(gameId: string): Promise<ImportJobCreated> {
  return Value.Decode(
    ImportJobCreatedSchema,
    await requestJson("/api/v2/import-jobs", {
      method: "POST",
      body: JSON.stringify({ gameId, idempotencyKey: crypto.randomUUID() }),
    }),
  );
}
export async function createReadyImportBatch(): Promise<ImportReadyBatchCreated> {
  return Value.Decode(
    ImportReadyBatchCreatedSchema,
    await requestJson("/api/v2/import-jobs/batch", {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    }),
  );
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
