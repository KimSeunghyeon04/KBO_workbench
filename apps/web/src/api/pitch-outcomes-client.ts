import {
  canonicalStringify,
  PitchLocationResponseSchema,
  BatterProfileResponseSchema,
  type PitchOutcomeQuery,
  type PitchLocationResponse,
  type BatterProfileResponse,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { requestJson } from "./transport";
function validate(query: PitchOutcomeQuery, result: PitchLocationResponse | BatterProfileResponse) {
  const c = result.coverage;
  if (
    canonicalStringify(query) !== canonicalStringify(result.query) ||
    c.filteredPitches !== result.total.pitches + c.excludedSituations ||
    result.total.pitches !== c.missingLocation + c.locationPitches ||
    c.locationPitches !== result.points.length ||
    result.cells.reduce((n, g) => n + g.pitches, 0) !== c.locationPitches ||
    new Set(result.points.map((p) => JSON.stringify([p.gameId, p.revision, p.pitchId]))).size !==
      result.points.length
  )
    throw new Error("투구 결과의 요청 범위 또는 표본 합계가 다릅니다.");
}
export async function getPitchLocation(query: PitchOutcomeQuery, id: string, signal: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    PitchLocationResponseSchema,
    await requestJson(`/api/v2/analysis/pitch-location/${encodeURIComponent(id)}?${params}`, {
      signal,
    }),
  );
  validate(query, result);
  if (result.pitcherId !== id) throw new Error("투수가 요청과 다릅니다.");
  return result;
}
export async function getBatterProfile(query: PitchOutcomeQuery, id: string, signal: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    BatterProfileResponseSchema,
    await requestJson(`/api/v2/analysis/batter-profile/${encodeURIComponent(id)}?${params}`, {
      signal,
    }),
  );
  validate(query, result);
  if (
    result.batterId !== id ||
    result.plateAppearances.rows.length !== result.plateAppearances.total.pa ||
    result.plateAppearances.byTerminalType.reduce((n, g) => n + g.pa, 0) !==
      result.plateAppearances.total.pa
  )
    throw new Error("타자 또는 타석 합계가 다릅니다.");
  return result;
}
