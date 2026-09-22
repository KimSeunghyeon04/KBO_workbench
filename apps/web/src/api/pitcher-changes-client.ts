import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  PitcherChangesResponseSchema,
  type PitcherChangesQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getPitcherChanges(
  query: PitcherChangesQuery,
  id: string,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const r = Value.Decode(
    PitcherChangesResponseSchema,
    await requestJson(`/api/v2/analysis/pitcher-changes/${encodeURIComponent(id)}?${params}`, {
      signal,
    }),
  );
  if (
    r.pitcherId !== id ||
    canonicalStringify(query) !== canonicalStringify(r.query) ||
    r.games.some((g) => g.gameDate > query.dateTo) ||
    (r.baselineLastDate !== null && r.baselineLastDate > query.dateTo)
  )
    throw new Error("변화 분석 범위가 요청과 다릅니다.");
  return r;
}
