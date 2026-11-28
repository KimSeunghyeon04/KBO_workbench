import { Value } from "@sinclair/typebox/value";
import {
  AnalysisModelManagementSchema,
  AnalysisModelJobSchema,
  AnalysisModelPolicySchema,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getAnalysisModels(season = 2025, signal?: AbortSignal) {
  return Value.Decode(
    AnalysisModelManagementSchema,
    await requestJson(
      `/api/v2/analysis/models?season=${season}`,
      signal === undefined ? {} : { signal },
    ),
  );
}
export async function getAnalysisModelJob(id: string, signal: AbortSignal) {
  const job = Value.Decode(
    AnalysisModelJobSchema,
    await requestJson(`/api/v2/analysis/model-jobs/${encodeURIComponent(id)}`, { signal }),
  );
  if (job.id !== id) throw new Error("조회한 모델 작업이 일치하지 않습니다.");
  return job;
}
export async function refreshAnalysisModels(
  requestId: string,
  force: boolean,
  applicationSeason: number,
) {
  return Value.Decode(
    AnalysisModelJobSchema,
    await requestJson("/api/v2/analysis/model-jobs", {
      method: "POST",
      body: JSON.stringify({ requestId, force, applicationSeason }),
    }),
  );
}
export async function cancelModelRefresh(id: string) {
  return Value.Decode(
    AnalysisModelJobSchema,
    await requestJson(`/api/v2/analysis/model-jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  );
}
export async function setModelPolicy(enabled: boolean, applicationSeason: number) {
  return Value.Decode(
    AnalysisModelPolicySchema,
    await requestJson("/api/v2/analysis/model-policy", {
      method: "PUT",
      body: JSON.stringify({ enabled, applicationSeason }),
    }),
  );
}
