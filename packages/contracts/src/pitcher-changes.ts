import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";
import { PitchProfileGroupSchema } from "./pitch-profile.js";
const strict = { additionalProperties: false } as const,
  number = Type.Union([Type.Number(), Type.Null()]),
  count = Type.Integer({ minimum: 0 });
export const PitcherChangesQuerySchema = Type.Object(
  {
    ...AnalysisScopeQuerySchema.properties,
    dateTo: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  },
  strict,
);
export const PitchChangeObservationSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: Type.Integer(),
    gameDate: Type.String(),
    pitchId: Type.String(),
    stadium: Type.Union([Type.String(), Type.Null()]),
    pitchType: Type.Union([Type.String(), Type.Null()]),
    speedKph: number,
    stance: Type.Union([Type.String(), Type.Null()]),
    balls: count,
    strikes: count,
    swing: Type.Boolean(),
    whiff: Type.Boolean(),
    xCm: number,
    zCm: number,
    arrivalMs: number,
    calibrated: Type.Boolean(),
  },
  strict,
);
export const PitchChangeGameSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: Type.Integer(),
    gameDate: Type.String(),
    stadium: Type.Union([Type.String(), Type.Null()]),
    pitches: count,
    groups: Type.Array(PitchProfileGroupSchema),
  },
  strict,
);
const metric = Type.Object(
  {
    metric: Type.Union([
      Type.Literal("speedKph"),
      Type.Literal("xCm"),
      Type.Literal("zCm"),
      Type.Literal("arrivalMs"),
      Type.Literal("usage"),
    ]),
    recent: number,
    previous: number,
    difference: number,
    recentGameMean: number,
    previousGameMean: number,
    recentCount: count,
    previousCount: count,
    recentGames: count,
    previousGames: count,
    status: Type.Union([
      Type.Literal("sufficient"),
      Type.Literal("small_sample"),
      Type.Literal("unavailable"),
    ]),
    lower: number,
    upper: number,
  },
  strict,
);
const composition = Type.Object({ key: Type.String(), pitches: count }, strict);
const window = Type.Object(
  {
    games: Type.Array(PitchChangeGameSchema),
    pitches: count,
    calibrated: count,
    parks: Type.Array(composition),
    counts: Type.Array(composition),
    stances: Type.Array(composition),
  },
  strict,
);
export const PitcherChangesResponseSchema = Type.Object(
  {
    query: PitcherChangesQuerySchema,
    pitcherId: Type.String(),
    scope: AnalysisScopeSchema,
    sourceHash: Type.String(),
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("insufficient_games"),
      Type.Literal("ambiguous_same_day"),
    ]),
    seed: Type.Integer(),
    bootstrapReplicates: Type.Integer(),
    baselineLastDate: Type.Union([Type.String(), Type.Null()]),
    games: Type.Array(PitchChangeGameSchema),
    recent: window,
    previous: window,
    changes: Type.Array(
      Type.Object(
        { pitchType: Type.Union([Type.String(), Type.Null()]), metrics: Type.Array(metric) },
        strict,
      ),
    ),
  },
  strict,
);
export type PitcherChangesQuery = Static<typeof PitcherChangesQuerySchema>;
export type PitchChangeObservation = Static<typeof PitchChangeObservationSchema>;
export type PitcherChangesResponse = Static<typeof PitcherChangesResponseSchema>;
