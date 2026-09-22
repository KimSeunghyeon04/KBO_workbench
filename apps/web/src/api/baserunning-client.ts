import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  BaserunningResponseSchema,
  type AnalysisScopeQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getBaserunning(
  query: AnalysisScopeQuery,
  playerId: string | null,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    BaserunningResponseSchema,
    await requestJson(
      `/api/v2/analysis/baserunning${playerId === null ? "" : `/${encodeURIComponent(playerId)}`}?${params}`,
      { signal },
    ),
  );
  const c = result.opportunitySummary;
  if (
    result.playerId !== playerId ||
    canonicalStringify(query) !== canonicalStringify(result.query) ||
    c.candidates !== result.opportunities.length ||
    c.eligible !== c.extraBase + c.noExtraBase + c.out + c.unknown ||
    c.candidates !== c.eligible + c.excludedComplex
  )
    throw new Error("주루 범위 또는 기회 합계가 다릅니다.");
  return result;
}
