import { Value } from "@sinclair/typebox/value";
import {
  ParkEnvironmentResponseSchema,
  resolveAnalysisScope,
  type AnalysisScopeQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getParkEnvironment(query: AnalysisScopeQuery, signal: AbortSignal) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) search.set(key, String(value));
  const response = Value.Decode(
      ParkEnvironmentResponseSchema,
      await requestJson(`/api/v2/analysis/park-environment?${search}`, { signal }),
    ),
    scope = resolveAnalysisScope(query, "regular");
  if (
    response.scope.season !== scope.season ||
    response.scope.competition !== scope.competition ||
    response.scope.dateFrom !== scope.dateFrom ||
    response.scope.dateTo !== scope.dateTo ||
    response.parks.reduce((s, p) => s + p.total.games, 0) !== response.games
  )
    throw new Error("구장 분석 범위 또는 경기 합계가 맞지 않습니다.");
  return response;
}
