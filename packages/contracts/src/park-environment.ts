import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeSchema } from "./analysis-scope.js";
const strict = { additionalProperties: false } as const,
  text = Type.String(),
  count = Type.Integer({ minimum: 0 }),
  nullable = Type.Union([Type.Number(), Type.Null()]);
export const ParkEnvironmentRowSchema = Type.Object(
  {
    gameId: text,
    revision: Type.Integer({ minimum: 1 }),
    season: Type.Integer(),
    gameDate: text,
    documentHash: text,
    stadium: Type.Union([text, Type.Null()]),
    parkId: Type.Union([text, Type.Null()]),
    teamId: text,
    opponentId: text,
    side: Type.Union([Type.Literal("away"), Type.Literal("home")]),
    normalEnd: Type.Boolean(),
    pa: count,
    homeRuns: count,
    runs: count,
    completeHalves: count,
    completeRuns: count,
    excludedHalves: count,
  },
  strict,
);
const stats = Type.Object(
  {
    games: count,
    pa: count,
    homeRuns: count,
    runs: count,
    completeHalves: count,
    completeRuns: count,
    excludedHalves: count,
    runRate: nullable,
    homeRunRate: nullable,
    completeRunRate: nullable,
  },
  strict,
);
const metric = Type.Union([Type.Literal("home_runs"), Type.Literal("runs")]);
const family = Type.Union([Type.Literal("poisson"), Type.Literal("negative_binomial")]);
const evaluation = Type.Object(
  {
    season: Type.Integer(),
    games: count,
    rows: count,
    excluded: count,
    deviance: nullable,
    mae: nullable,
    observed: Type.Number(),
    expected: Type.Number(),
    dispersion: nullable,
  },
  strict,
);
const fitted = Type.Object(
  {
    metric,
    family,
    lambda: Type.Number(),
    alpha: Type.Number(),
    withPark: Type.Boolean(),
    columns: Type.Array(text),
    coefficients: Type.Array(Type.Number()),
    seasons: Type.Array(Type.Integer()),
    parks: Type.Array(text),
    teams: Type.Array(text),
    months: Type.Array(text),
    converged: Type.Boolean(),
    identifiable: Type.Boolean(),
    trainingGames: count,
    trainingRows: count,
    dispersion: nullable,
    factors: Type.Array(
      Type.Object(
        {
          parkId: text,
          games: count,
          exposure: count,
          index: nullable,
          low95: nullable,
          high95: nullable,
          status: Type.Union([
            Type.Literal("supported"),
            Type.Literal("insufficient_data"),
            Type.Literal("unidentified"),
            Type.Literal("not_adopted"),
          ]),
        },
        strict,
      ),
    ),
  },
  strict,
);
export const ParkEnvironmentModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("park-counts"),
    sourceHash: text,
    trainedThrough: Type.Integer(),
    policy: Type.Literal("regular-normal-nine-complete-halves-1-to-8"),
    metrics: Type.Array(
      Type.Object(
        {
          metric,
          adopted: Type.Boolean(),
          fitted,
          validation: Type.Array(
            Type.Object(
              {
                family,
                lambda: Type.Number(),
                withPark: Type.Boolean(),
                converged: Type.Boolean(),
                evaluations: Type.Array(evaluation),
                devianceDifference95: Type.Union([
                  Type.Object({ low: Type.Number(), high: Type.Number() }, strict),
                  Type.Null(),
                ]),
              },
              strict,
            ),
          ),
          evaluation: Type.Union([evaluation, Type.Null()]),
        },
        strict,
      ),
      { minItems: 2, maxItems: 2 },
    ),
  },
  strict,
);
export const ParkEnvironmentResponseSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: AnalysisScopeSchema,
    sourceHash: text,
    rows: count,
    games: count,
    unknownParkGames: count,
    parks: Type.Array(
      Type.Object(
        {
          key: text,
          parkId: Type.Union([text, Type.Null()]),
          stadiums: Type.Array(text),
          total: stats,
          home: stats,
          away: stats,
        },
        strict,
      ),
    ),
    modelHash: Type.Union([text, Type.Null()]),
    model: Type.Union([ParkEnvironmentModelSchema, Type.Null()]),
    modelStatus: Type.Union([
      Type.Literal("ready"),
      Type.Literal("not_adopted"),
      Type.Literal("model_unavailable"),
      Type.Literal("scope_mismatch"),
    ]),
    evidence: Type.Array(
      Type.Object(
        {
          gameId: text,
          revision: count,
          gameDate: text,
          stadium: Type.Union([text, Type.Null()]),
          parkId: Type.Union([text, Type.Null()]),
        },
        strict,
      ),
    ),
    weather: Type.Literal("excluded_no_confirmed_start_time"),
  },
  strict,
);
export type ParkEnvironmentRow = Static<typeof ParkEnvironmentRowSchema>;
export type ParkEnvironmentModel = Static<typeof ParkEnvironmentModelSchema>;
export type ParkEnvironmentFit = Static<typeof fitted>;
export type ParkEnvironmentResponse = Static<typeof ParkEnvironmentResponseSchema>;
