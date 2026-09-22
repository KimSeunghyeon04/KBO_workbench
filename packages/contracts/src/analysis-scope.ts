import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { GameCompetitionSchema } from "./game-competition.js";

const strict = { additionalProperties: false } as const;
export const AnalysisCompetitionSchema = Type.Union([
  GameCompetitionSchema,
  Type.Literal("unknown"),
  Type.Literal("all"),
]);
const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
export const AnalysisScopeQuerySchema = Type.Object(
  {
    season: Type.Integer({ minimum: 1982, maximum: 2200 }),
    competition: Type.Optional(AnalysisCompetitionSchema),
    dateFrom: Type.Optional(date),
    dateTo: Type.Optional(date),
  },
  strict,
);
export const AnalysisScopeSchema = Type.Object(
  {
    season: AnalysisScopeQuerySchema.properties.season,
    competition: AnalysisCompetitionSchema,
    dateFrom: Type.Union([date, Type.Null()]),
    dateTo: Type.Union([date, Type.Null()]),
  },
  strict,
);
export type AnalysisScope = Static<typeof AnalysisScopeSchema>;
export type AnalysisScopeQuery = Static<typeof AnalysisScopeQuerySchema>;
export type AnalysisScopeOptions = Omit<AnalysisScopeQuery, "season">;
export class InvalidAnalysisScopeError extends Error {}

export function resolveAnalysisScope(
  query: AnalysisScopeQuery,
  defaultCompetition: AnalysisScope["competition"] = "all",
): AnalysisScope {
  if (!Value.Check(AnalysisScopeQuerySchema, query))
    throw new InvalidAnalysisScopeError("분석 범위 형식이 올바르지 않습니다.");
  for (const value of [query.dateFrom, query.dateTo]) {
    if (value === undefined) continue;
    const timestamp = new Date(`${value}T00:00:00Z`);
    if (
      !Number.isFinite(timestamp.getTime()) ||
      timestamp.toISOString().slice(0, 10) !== value ||
      !value.startsWith(`${query.season}-`)
    )
      throw new InvalidAnalysisScopeError("기간은 선택 시즌의 유효한 날짜여야 합니다.");
  }
  if (query.dateFrom !== undefined && query.dateTo !== undefined && query.dateFrom > query.dateTo)
    throw new InvalidAnalysisScopeError("시작일은 종료일보다 늦을 수 없습니다.");
  return {
    season: query.season,
    competition: query.competition ?? defaultCompetition,
    dateFrom: query.dateFrom ?? null,
    dateTo: query.dateTo ?? null,
  };
}
export function inAnalysisPeriod(
  date: string,
  scope: Pick<AnalysisScope, "dateFrom" | "dateTo">,
): boolean {
  return (
    (scope.dateFrom === null || date >= scope.dateFrom) &&
    (scope.dateTo === null || date <= scope.dateTo)
  );
}
