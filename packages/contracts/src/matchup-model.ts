import { Type, type Static } from "@sinclair/typebox";
import { MatchupQuerySchema, MatchupPitchSchema } from "./matchup.js";
import { AnalysisScopeSchema } from "./analysis-scope.js";
import { PitchQualityModelSchema, PitchQualityResponseSchema } from "./pitch-quality.js";
const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 }),
  number = Type.Number();
const nullable = Type.Union([number, Type.Null()]);
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const target = Type.Union([
  Type.Literal("swing"),
  Type.Literal("whiff"),
  Type.Literal("called_strike"),
]);
const evaluation =
  PitchQualityModelSchema.properties.targets.items.properties.validation.items.properties
    .evaluations.items;
const interval = Type.Union([Type.Object({ low: number, high: number }, strict), Type.Null()]);
const validation = Type.Object(
  {
    parameter: number,
    evaluations: Type.Array(evaluation),
    lossDifference95: interval,
    subgroupGate: Type.Boolean(),
  },
  strict,
);
export const MatchupEffectSchema = Type.Object(
  {
    batterId: Type.String(),
    samples: count,
    games: count,
    offset: number,
    converged: Type.Boolean(),
  },
  strict,
);
export const MatchupModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("matchup"),
    policy: Type.Literal("frozen-shape-batter-offset-v1"),
    sourceHash: hash,
    trainedThrough: Type.Integer(),
    baseModelHash: hash,
    base: PitchQualityModelSchema,
    similarity: Type.Object(
      {
        radius: number,
        minSamples: Type.Literal(20),
        validatedImprovement: Type.Boolean(),
        validation: Type.Array(validation),
      },
      strict,
    ),
    targets: Type.Array(
      Type.Object(
        {
          target,
          adopted: Type.Boolean(),
          penalty: number,
          effects: Type.Array(MatchupEffectSchema),
          validation: Type.Array(validation),
          evaluation: Type.Union([evaluation, Type.Null()]),
        },
        strict,
      ),
      { minItems: 3, maxItems: 3 },
    ),
    validationPreprocessing: Type.Array(Type.Object({ season: Type.Integer(), hash }, strict)),
  },
  strict,
);
const rate = Type.Object({ samples: count, probability: nullable }, strict);
export const MatchupModelResponseSchema = Type.Object(
  {
    query: MatchupQuerySchema,
    scope: AnalysisScopeSchema,
    sourceHash: hash,
    modelHash: Type.Union([hash, Type.Null()]),
    trainedThrough: Type.Union([Type.Integer(), Type.Null()]),
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("model_unavailable"),
      Type.Literal("scope_mismatch"),
    ]),
    pitcherCoverage: PitchQualityResponseSchema.properties.coverage,
    batterCoverage: PitchQualityResponseSchema.properties.coverage,
    similarity: Type.Union([
      Type.Null(),
      Type.Object(
        {
          radius: number,
          minSamples: Type.Literal(20),
          validatedImprovement: Type.Boolean(),
          pitches: count,
          games: count,
          pitchers: count,
          directOverlap: count,
          largestPitcherShare: nullable,
          conditionCandidates: count,
          excludedByDistance: count,
          swing: rate,
          whiff: rate,
          calledStrike: rate,
          rows: Type.Array(
            Type.Object({ ...MatchupPitchSchema.properties, distance: number }, strict),
            { maxItems: 10000 },
          ),
        },
        strict,
      ),
    ]),
    effects: Type.Array(
      Type.Object(
        {
          target,
          status: Type.Union([
            Type.Literal("ready"),
            Type.Literal("not_adopted"),
            Type.Literal("insufficient_history"),
          ]),
          trainingSamples: count,
          trainingGames: count,
          penalty: number,
        },
        strict,
      ),
    ),
    groups: Type.Array(
      Type.Object(
        {
          pitchType: Type.String(),
          stance: Type.String(),
          location: Type.String(),
          pitches: count,
          swing: nullable,
          whiff: nullable,
          calledStrike: nullable,
          whiffPerPitch: nullable,
        },
        strict,
      ),
    ),
  },
  strict,
);
export type MatchupEffect = Static<typeof MatchupEffectSchema>;
export type MatchupModel = Static<typeof MatchupModelSchema>;
export type MatchupModelResponse = Static<typeof MatchupModelResponseSchema>;
