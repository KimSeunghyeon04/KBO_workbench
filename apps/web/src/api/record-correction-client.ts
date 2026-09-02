import {
  CorrectionMutationResultSchema,
  RecordCorrectionCaseSchema,
  RecordCorrectionDraftCreateResponseSchema,
  RecordCorrectionJobCreatedSchema,
  RecordCorrectionJobListSchema,
  RecordCorrectionListSchema,
  RecordCorrectionProposalSchema,
  RecordCorrectionSummarySchema,
  type CorrectionMutationResult,
  type RecordCorrectionCase,
  type RecordCorrectionCaseStatus,
  type RecordCorrectionJob,
  type RecordCorrectionJobCreated,
  type RecordCorrectionProposal,
  type RecordCorrectionReviewActionRequest,
  type RecordCorrectionSummary,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

import { requestJson, requestNoContent } from "./transport";

export async function getRecordCorrectionSummary(): Promise<RecordCorrectionSummary> {
  return Value.Decode(
    RecordCorrectionSummarySchema,
    await requestJson("/api/v2/record-corrections/summary"),
  );
}

export async function getRecordCorrectionCases(filters: {
  readonly season?: number;
  readonly status?: RecordCorrectionCaseStatus;
  readonly search?: string;
}): Promise<readonly RecordCorrectionCase[]> {
  const query = new URLSearchParams();
  if (filters.season !== undefined) query.set("season", String(filters.season));
  if (filters.status !== undefined) query.set("status", filters.status);
  if (filters.search !== undefined && filters.search.trim().length > 0)
    query.set("search", filters.search.trim());
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return Value.Decode(
    RecordCorrectionListSchema,
    await requestJson(`/api/v2/record-corrections${suffix}`),
  ).cases;
}

export async function getRecordCorrectionCase(noticeId: string): Promise<RecordCorrectionCase> {
  return Value.Decode(
    RecordCorrectionCaseSchema,
    await requestJson(`/api/v2/record-corrections/${encodeURIComponent(noticeId)}`),
  );
}

export async function getRecordCorrectionJobs(): Promise<readonly RecordCorrectionJob[]> {
  return Value.Decode(
    RecordCorrectionJobListSchema,
    await requestJson("/api/v2/record-correction-jobs"),
  ).jobs;
}

export async function createRecordCorrectionJob(
  seasons?: readonly number[],
): Promise<RecordCorrectionJobCreated> {
  return Value.Decode(
    RecordCorrectionJobCreatedSchema,
    await requestJson("/api/v2/record-correction-jobs", {
      method: "POST",
      body: JSON.stringify({
        ...(seasons === undefined ? {} : { seasons }),
        idempotencyKey: globalThis.crypto.randomUUID(),
      }),
    }),
  );
}

export async function cancelRecordCorrectionJob(jobId: string): Promise<void> {
  await requestNoContent(`/api/v2/record-correction-jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export async function submitRecordCorrectionReviewAction(
  noticeId: string,
  action: RecordCorrectionReviewActionRequest,
): Promise<RecordCorrectionCase> {
  return Value.Decode(
    RecordCorrectionCaseSchema,
    await requestJson(`/api/v2/record-corrections/${encodeURIComponent(noticeId)}/review-actions`, {
      method: "POST",
      body: JSON.stringify(action),
    }),
  );
}

export async function createRecordCorrectionDraft(noticeId: string): Promise<{
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly noticeId: string;
}> {
  return Value.Decode(
    RecordCorrectionDraftCreateResponseSchema,
    await requestJson(
      `/api/v2/record-corrections/${encodeURIComponent(noticeId)}/correction-drafts`,
      { method: "POST" },
    ),
  );
}

export async function getRecordCorrectionProposal(
  sessionId: string,
  noticeId: string,
): Promise<RecordCorrectionProposal> {
  return Value.Decode(
    RecordCorrectionProposalSchema,
    await requestJson(
      `/api/v2/correction-sessions/${encodeURIComponent(sessionId)}/record-correction-proposals/${encodeURIComponent(noticeId)}`,
    ),
  );
}

export async function applyRecordCorrectionProposal(
  sessionId: string,
  noticeId: string,
  expectedSessionVersion: number,
  proposalHash: string,
): Promise<CorrectionMutationResult> {
  return Value.Decode(
    CorrectionMutationResultSchema,
    await requestJson(
      `/api/v2/correction-sessions/${encodeURIComponent(sessionId)}/record-correction-proposals/${encodeURIComponent(noticeId)}`,
      {
        method: "POST",
        body: JSON.stringify({ expectedSessionVersion, proposalHash }),
      },
    ),
  );
}
