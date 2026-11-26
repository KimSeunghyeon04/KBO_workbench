import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  DirectMatchupResponseSchema,
  MatchupResponseSchema,
  resolveAnalysisScope,
  type MatchupQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getDirectMatchup(query: MatchupQuery, signal: AbortSignal) {
  const { pitcherId, batterId, ...scope } = query;
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    DirectMatchupResponseSchema,
    await requestJson(`/api/v2/analysis/matchups/direct?${params}`, { signal }),
  );
  if (
    canonicalStringify(query) !== canonicalStringify(result.query) ||
    canonicalStringify(result.scope) !==
      canonicalStringify(resolveAnalysisScope(scope, "regular")) ||
    result.direct.pitches !== result.direct.rows.length ||
    result.direct.rows.some((row) => row.pitcherId !== pitcherId) ||
    result.batting.plateAppearances !== result.directPlateAppearances.length ||
    result.directPlateAppearances.some(
      (row) => row.pitcherId !== pitcherId || row.batterId !== batterId,
    )
  )
    throw new Error("직접 맞대결의 조회 범위 또는 표본이 다릅니다.");
  return result;
}
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
