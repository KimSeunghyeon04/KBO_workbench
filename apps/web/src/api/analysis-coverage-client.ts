import {
  canonicalStringify,
  resolveAnalysisScope,
  type AnalysisScopeOptions,
} from "@kbo/contracts";
import { AnalysisCoverageResultSchema, validAnalysisCoverage } from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { requestJson } from "./transport";

export async function getAnalysisCoverage(
  season: number,
  signal: AbortSignal,
  options: AnalysisScopeOptions = {},
  retry = false,
) {
  const response = Value.Decode(
    AnalysisCoverageResultSchema,
    await requestJson(
      `/api/v2/analysis/coverage${retry ? "/prepare" : ""}?${new URLSearchParams(Object.entries({ season, ...options }).map(([k, v]) => [k, String(v)]))}`,
      { signal, method: retry ? "POST" : "GET" },
    ),
  );
  if (
    response.scope.season !== season ||
    canonicalStringify(response.scope) !==
      canonicalStringify(resolveAnalysisScope({ season, ...options })) ||
    (!("state" in response) && (response.season !== season || !validAnalysisCoverage(response)))
  )
    throw new Error("분석 범위 또는 표본 합계가 일치하지 않습니다.");
  return response;
}
