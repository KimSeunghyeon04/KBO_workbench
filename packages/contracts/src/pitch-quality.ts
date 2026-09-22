import { Type, type Static } from "@sinclair/typebox";
import { DisciplineRowSchema } from "./batter-discipline.js";
import { AnalysisScopeSchema } from "./analysis-scope.js";
import { PitchCalibrationProfileSchema } from "./pitch-calibration.js";
const strict = { additionalProperties: false } as const;
const text = Type.String(),
  n = Type.Number(),
  count = Type.Integer({ minimum: 0 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const nullable = Type.Union([n, Type.Null()]);
export const PitchQualityRowSchema = Type.Object(
  {
    ...DisciplineRowSchema.properties,
    pitcherId: text,
    stadium: Type.Union([text, Type.Null()]),
    parkId: Type.Union([text, Type.Null()]),
    calledStrike: Type.Boolean(),
  },
  strict,
);
export const PitchQualityTrajectorySchema = Type.Object(
  {
    distance: n,
    vy: n,
    ay: n,
    lateralAcceleration: n,
    verticalAcceleration: n,
    speedKph: n,
    arrivalSeconds: n,
  },
  strict,
);
export const PitchQualityPreprocessingSchema = Type.Object(
  {
    through: Type.Integer(),
    policy: Type.Literal("frozen-training-season-middle-plane-v1"),
    profiles: Type.Array(
      Type.Object({ season: Type.Integer(), profile: PitchCalibrationProfileSchema }, strict),
    ),
    reference: Type.Union([PitchQualityTrajectorySchema, Type.Null()]),
    referenceHash: hash,
    pitchTypes: Type.Array(text),
    stances: Type.Array(text),
    means: Type.Array(n),
    scales: Type.Array(n),
    minima: Type.Array(n),
    maxima: Type.Array(n),
  },
  strict,
);
const target = Type.Union([
  Type.Literal("swing"),
  Type.Literal("whiff"),
  Type.Literal("called_strike"),
]);
const kind = Type.Union([
  Type.Literal("baseline"),
  Type.Literal("shape"),
  Type.Literal("location"),
]);
const coverage = Type.Object(
  {
    actual: count,
    ineligible: count,
    missing: count,
    calibrationUnsupported: count,
    outOfSupport: count,
    modelUnavailable: count,
    used: count,
  },
  strict,
);
const score = Type.Object(
  { samples: count, positives: count, logLoss: nullable, brier: nullable },
  strict,
);
const evaluation = Type.Object(
  {
    season: Type.Integer(),
    coverage,
    samples: count,
    games: count,
    logLoss: nullable,
    brier: nullable,
    calibration: Type.Array(
      Type.Object({ bin: count, samples: count, observed: nullable, expected: nullable }, strict),
    ),
    groups: Type.Array(Type.Object({ key: text, ...score.properties }, strict)),
    newPitchers: score,
  },
  strict,
);
export const PitchQualityFitSchema = Type.Object(
  {
    target,
    kind,
    lambda: n,
    converged: Type.Boolean(),
    samples: count,
    positives: count,
    prior: Type.Number({ minimum: 0, maximum: 1 }),
    cells: Type.Array(
      Type.Object(
        {
          key: text,
          samples: count,
          positives: count,
          probability: Type.Number({ minimum: 0, maximum: 1 }),
        },
        strict,
      ),
    ),
    coefficients: Type.Array(n),
  },
  strict,
);
export const PitchQualityModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("pitch-quality"),
    sourceHash: hash,
    trainedThrough: Type.Integer(),
    preprocessing: PitchQualityPreprocessingSchema,
    targets: Type.Array(
      Type.Object(
        {
          target,
          adopted: Type.Boolean(),
          fitted: PitchQualityFitSchema,
          validation: Type.Array(
            Type.Object(
              {
                kind,
                lambda: n,
                converged: Type.Boolean(),
                evaluations: Type.Array(evaluation),
                lossDifference95: Type.Union([
                  Type.Object({ low: n, high: n }, strict),
                  Type.Null(),
                ]),
                subgroupGate: Type.Boolean(),
              },
              strict,
            ),
          ),
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
const rate = Type.Object(
  { samples: count, observed: nullable, expected: nullable, difference: nullable },
  strict,
);
export const PitchQualityResponseSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: AnalysisScopeSchema,
    pitcherId: text,
    sourceHash: hash,
    modelHash: Type.Union([hash, Type.Null()]),
    trainedThrough: Type.Union([Type.Integer(), Type.Null()]),
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("not_adopted"),
      Type.Literal("model_unavailable"),
      Type.Literal("scope_mismatch"),
    ]),
    coverage,
    models: Type.Array(
      Type.Object(
        {
          target,
          adopted: Type.Boolean(),
          kind,
          evaluation: Type.Union([evaluation, Type.Null()]),
        },
        strict,
      ),
    ),
    groups: Type.Array(
      Type.Object(
        {
          pitchType: Type.Union([text, Type.Null()]),
          pitches: count,
          swing: rate,
          whiff: rate,
          calledStrike: rate,
          whiffPerPitch: rate,
        },
        strict,
      ),
    ),
  },
  strict,
);
export type PitchQualityRow = Static<typeof PitchQualityRowSchema>;
export type PitchQualityPreprocessing = Static<typeof PitchQualityPreprocessingSchema>;
export type PitchQualityFit = Static<typeof PitchQualityFitSchema>;
export type PitchQualityModel = Static<typeof PitchQualityModelSchema>;
export type PitchQualityEvaluation = Static<typeof evaluation>;
export type PitchQualityCoverage = Static<typeof coverage>;
export type PitchQualityResponse = Static<typeof PitchQualityResponseSchema>;
