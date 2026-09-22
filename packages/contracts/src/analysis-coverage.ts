import { type Static, Type } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";
import { GameCompetitionSchema } from "./game-competition.js";

const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 });
const nullableDate = Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()]);

export const AnalysisCoverageQuerySchema = AnalysisScopeQuerySchema;
export const AnalysisCoverageCountsSchema = Type.Object(
  {
    games: count,
    actualPitches: count,
    completedPlateAppearances: count,
    withPitchType: count,
    withSpeed: count,
    zoneKnown: count,
    linkedTracking: count,
    missingTracking: count,
    invalidTrajectory: count,
    validTrajectory: count,
    calibratedTrajectory: count,
    insufficientCalibration: count,
    unsupportedPark: count,
  },
  strict,
);
export const AnalysisCoverageResponseSchema = Type.Object(
  {
    version: Type.Literal(1),
    season: Type.Integer(),
    sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    calibrationHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    scope: AnalysisScopeSchema,
    competitions: Type.Array(
      Type.Object(
        { competition: Type.Union([GameCompetitionSchema, Type.Literal("unknown")]), games: count },
        strict,
      ),
      { minItems: 4, maxItems: 4 },
    ),
    unclassifiedGames: count,
    firstGameDate: nullableDate,
    lastGameDate: nullableDate,
    total: AnalysisCoverageCountsSchema,
    stadiums: Type.Array(
      Type.Object(
        { stadium: Type.Union([Type.String(), Type.Null()]), counts: AnalysisCoverageCountsSchema },
        strict,
      ),
    ),
  },
  strict,
);
export type AnalysisCoverageCounts = Static<typeof AnalysisCoverageCountsSchema>;
export type AnalysisCoverageResponse = Static<typeof AnalysisCoverageResponseSchema>;

export const AnalysisCoveragePreparationSchema = Type.Object(
  {
    state: Type.Union([Type.Literal("preparing"), Type.Literal("failed")]),
    scope: AnalysisScopeSchema,
    sourceKey: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  strict,
);
export const AnalysisCoverageResultSchema = Type.Union([
  AnalysisCoverageResponseSchema,
  AnalysisCoveragePreparationSchema,
]);
export type AnalysisCoveragePreparation = Static<typeof AnalysisCoveragePreparationSchema>;
export type AnalysisCoverageResult = Static<typeof AnalysisCoverageResultSchema>;

export function validAnalysisCoverage(value: AnalysisCoverageResponse): boolean {
  const valid = (c: AnalysisCoverageCounts) =>
    c.actualPitches === c.missingTracking + c.invalidTrajectory + c.validTrajectory &&
    c.linkedTracking === c.invalidTrajectory + c.validTrajectory &&
    c.validTrajectory === c.calibratedTrajectory + c.insufficientCalibration + c.unsupportedPark &&
    c.withPitchType <= c.actualPitches &&
    c.withSpeed <= c.actualPitches &&
    c.zoneKnown <= c.actualPitches;
  return (
    valid(value.total) &&
    value.unclassifiedGames <= value.total.games &&
    new Set(value.competitions.map((c) => c.competition)).size === 4 &&
    value.competitions.reduce((n, c) => n + c.games, 0) === value.total.games &&
    value.competitions.find((c) => c.competition === "unknown")?.games ===
      value.unclassifiedGames &&
    value.stadiums.every((s) => valid(s.counts)) &&
    new Set(value.stadiums.map((s) => s.stadium)).size === value.stadiums.length &&
    (
      Object.keys(AnalysisCoverageCountsSchema.properties) as (keyof AnalysisCoverageCounts)[]
    ).every((key) => value.total[key] === value.stadiums.reduce((n, s) => n + s.counts[key], 0))
  );
}
