import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  PitcherWorkloadResponseSchema,
  type AnalysisScopeQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getPitcherWorkload(
  query: AnalysisScopeQuery,
  id: string,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    PitcherWorkloadResponseSchema,
    await requestJson(`/api/v2/analysis/pitcher-workload/${encodeURIComponent(id)}?${params}`, {
      signal,
    }),
  );
  if (
    result.pitcherId !== id ||
    canonicalStringify(query) !== canonicalStringify(result.query) ||
    result.appearances.some((r) => r.encounters.reduce((n, e) => n + e.pitches, 0) > r.pitches)
  )
    throw new Error("투수 운용 범위 또는 표본이 다릅니다.");
  return result;
}
