import { Value } from "@sinclair/typebox/value";
import {
  MatchupModelResponseSchema,
  canonicalStringify,
  resolveAnalysisScope,
  type MatchupQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getMatchupModel(query: MatchupQuery, signal: AbortSignal) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) search.set(key, String(value));
  const result = Value.Decode(
    MatchupModelResponseSchema,
    await requestJson(`/api/v2/analysis/matchups/model?${search}`, { signal }),
  );
  const { pitcherId, batterId, ...scope } = query;
  if (
    result.query.pitcherId !== pitcherId ||
    result.query.batterId !== batterId ||
    canonicalStringify(result.scope) !==
      canonicalStringify(resolveAnalysisScope(scope, "regular")) ||
    [result.pitcherCoverage, result.batterCoverage].some(
      (c) =>
        c.actual !==
        c.ineligible +
          c.missing +
          c.calibrationUnsupported +
          c.outOfSupport +
          c.modelUnavailable +
          c.used,
    ) ||
    (result.similarity !== null &&
      (result.similarity.rows.length !== result.similarity.pitches ||
        result.similarity.conditionCandidates !==
          result.similarity.pitches + result.similarity.excludedByDistance))
  )
    throw new Error("매치업 모델의 범위 또는 표본 합계가 맞지 않습니다.");
  return result;
}
