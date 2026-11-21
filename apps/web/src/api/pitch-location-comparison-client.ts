import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  PitchLocationComparisonResponseSchema,
  pitchLocationComparisonQueries,
  resolveAnalysisScope,
  type PitchLocationComparisonQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";

export async function getPitchLocationComparison(
  query: PitchLocationComparisonQuery,
  id: string,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  const result = Value.Decode(
    PitchLocationComparisonResponseSchema,
    await requestJson(
      `/api/v2/analysis/pitch-location/${encodeURIComponent(id)}/comparison?${params}`,
      { signal },
    ),
  );
  const expected = pitchLocationComparisonQueries(query);
  const scopeOf = ({ season, competition, dateFrom, dateTo }: typeof expected.first) =>
    resolveAnalysisScope(
      {
        season,
        ...(competition === undefined ? {} : { competition }),
        ...(dateFrom === undefined ? {} : { dateFrom }),
        ...(dateTo === undefined ? {} : { dateTo }),
      },
      "regular",
    );
  if (
    result.pitcherId !== id ||
    canonicalStringify(result.query) !== canonicalStringify(query) ||
    canonicalStringify(result.first.query) !== canonicalStringify(expected.first) ||
    canonicalStringify(result.second.query) !== canonicalStringify(expected.second) ||
    canonicalStringify(result.first.scope) !== canonicalStringify(scopeOf(expected.first)) ||
    canonicalStringify(result.second.scope) !== canonicalStringify(scopeOf(expected.second)) ||
    [result.first, result.second].some(
      (period) =>
        period.cells.reduce((sum, cell) => sum + cell.pitches, 0) !==
          period.coverage.locationPitches ||
        period.coverage.locationPitches + period.coverage.missingLocation !==
          period.total.pitches ||
        period.total.pitches + period.coverage.excludedSituations !==
          period.coverage.filteredPitches ||
        period.cells.some((cell, index) => cell.key !== String(index)),
    ) ||
    result.differences.some((cell, index) => cell.cell !== index)
  )
    throw new Error("코스 비교의 요청 범위 또는 표본 합계가 다릅니다.");
  return result;
}
