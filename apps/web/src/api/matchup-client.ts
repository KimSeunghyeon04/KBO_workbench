import { Value } from "@sinclair/typebox/value";
import { canonicalStringify, MatchupResponseSchema, type MatchupQuery } from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getMatchup(query: MatchupQuery, signal: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const r = Value.Decode(
    MatchupResponseSchema,
    await requestJson(`/api/v2/analysis/matchups?${params}`, { signal }),
  );
  if (
    canonicalStringify(query) !== canonicalStringify(r.query) ||
    r.direct.pitches !== r.direct.rows.length ||
    r.similar.pitches !== r.similar.rows.length
  )
    throw new Error("매치업 범위 또는 표본이 다릅니다.");
  return r;
}
