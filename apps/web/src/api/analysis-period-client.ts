import { Value } from "@sinclair/typebox/value";
import {
  StatisticsPeriodResponseSchema,
  PitchProfilePeriodResponseSchema,
  BatterPeriodResponseSchema,
  DisciplinePeriodResponseSchema,
  canonicalStringify,
  analysisPeriodQueries,
  resolveAnalysisScope,
  type StatisticsPeriodQuery,
  type BatterPeriodQuery,
  type DisciplinePeriodQuery,
  type AnalysisPeriodQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export type PeriodComparisonKind =
  "statistics" | "pitch-shape" | "batter-profile" | "batter-discipline";
export async function getAnalysisPeriodComparison(
  kind: PeriodComparisonKind,
  query: StatisticsPeriodQuery | BatterPeriodQuery | DisciplinePeriodQuery | AnalysisPeriodQuery,
  id: string,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const raw = await requestJson(
    `/api/v2/analysis/${kind}/${encodeURIComponent(id)}/comparison?${params}`,
    { signal },
  );
  const data =
    kind === "statistics"
      ? Value.Decode(StatisticsPeriodResponseSchema, raw)
      : kind === "pitch-shape"
        ? Value.Decode(PitchProfilePeriodResponseSchema, raw)
        : kind === "batter-profile"
          ? Value.Decode(BatterPeriodResponseSchema, raw)
          : Value.Decode(DisciplinePeriodResponseSchema, raw);
  const expected = analysisPeriodQueries(query);
  const scopes = [expected.first, expected.second].map(
    ({ season, competition, dateFrom, dateTo }) =>
      resolveAnalysisScope({
        season,
        ...(competition === undefined ? {} : { competition }),
        ...(dateFrom === undefined ? {} : { dateFrom }),
        ...(dateTo === undefined ? {} : { dateTo }),
      }),
  );
  if (
    data.playerId !== id ||
    canonicalStringify(data.query) !== canonicalStringify(query) ||
    canonicalStringify(data.first.scope) !== canonicalStringify(scopes[0]) ||
    canonicalStringify(data.second.scope) !== canonicalStringify(scopes[1]) ||
    new Set(data.metrics.map((row) => row.key)).size !== data.metrics.length ||
    data.metrics.some(
      (row) =>
        (row.difference !== null &&
          (row.first.value === null ||
            row.second.value === null ||
            Math.abs(row.difference - (row.second.value - row.first.value)) > 1e-10)) ||
        (row.unit === "rate" &&
          [row.first, row.second].some(
            (o) =>
              (o.value !== null && (o.value < -1 || o.value > 1)) ||
              (o.denominator !== null &&
                o.numerator !== null &&
                (o.denominator === 0
                  ? o.value !== null
                  : o.value === null || Math.abs(o.value - o.numerator / o.denominator) > 1e-10)),
          )),
    )
  )
    throw new Error("기간 비교의 요청 범위 또는 차이가 일치하지 않습니다.");
  return data;
}
