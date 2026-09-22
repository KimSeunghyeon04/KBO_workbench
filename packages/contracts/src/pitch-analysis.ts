import { type Static, Type } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";
import { PitchProfileSchema } from "./pitch-profile.js";
import {
  PitchCalibrationStatusSchema,
  PitchCalibrationSummarySchema,
} from "./pitch-calibration.js";
import {
  PITCH_REFERENCE_VERSION,
  PitchExpectationSchema,
  PitchReferenceBandSchema,
  PitchReferenceDistributionSchema,
} from "./pitch-expectation.js";

const strict = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 200 });
const count = Type.Integer({ minimum: 0 });
const season = Type.Integer({ minimum: 1900, maximum: 2200 });
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const PITCH_ANALYSIS_MODEL_VERSION = 2;
const baselineSchema = Type.Object(
  {
    pitchType: Type.Literal("직구"),
    candidateCount: count,
    sampleCount: Type.Integer({ minimum: 1 }),
    excludedCount: count,
    arrivalMs: Type.Number({ exclusiveMinimum: 0 }),
    speedKphAt50Feet: Type.Number({ exclusiveMinimum: 0 }),
    firstGameDate: Type.String(),
    lastGameDate: Type.String(),
  },
  strict,
);

export const PitchReferenceKeySchema = Type.Object(
  {
    modelVersion: Type.Literal(PITCH_ANALYSIS_MODEL_VERSION),
    referenceVersion: Type.Literal(PITCH_REFERENCE_VERSION),
    season,
    sourceHash: hash,
    calibrationHash: Type.Union([hash, Type.Null()]),
  },
  strict,
);
export const PitchReferenceSchema = Type.Object(
  {
    ...PitchReferenceKeySchema.properties,
    reference: Type.Union([
      Type.Null(),
      Type.Object(
        {
          trajectory: Type.Object(
            {
              distance: Type.Number({ exclusiveMinimum: 0 }),
              vy: Type.Number({ exclusiveMaximum: 0 }),
              ay: Type.Number(),
              lateralAcceleration: Type.Number(),
              verticalAcceleration: Type.Number(),
              speedKph: Type.Number({ exclusiveMinimum: 0 }),
              arrivalSeconds: Type.Number({ exclusiveMinimum: 0 }),
            },
            strict,
          ),
          summary: baselineSchema,
          distribution: Type.Union([PitchReferenceDistributionSchema, Type.Null()]),
        },
        strict,
      ),
    ]),
  },
  strict,
);
export const PitchReferenceEnvelopeSchema = Type.Object(
  { hash, payload: PitchReferenceSchema },
  strict,
);
export type PitchReferenceKey = Static<typeof PitchReferenceKeySchema>;
export type PitchReference = Static<typeof PitchReferenceSchema>;

export const PitchAnalysisQuerySchema = AnalysisScopeQuerySchema;
export const PitchAnalysisDetailQuerySchema = Type.Object(
  {
    ...AnalysisScopeQuerySchema.properties,
    clusterCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  },
  strict,
);
export const PitchAnalysisPitcherParamsSchema = Type.Object({ pitcherId: id }, strict);
export const PitchAnalysisCatalogSchema = Type.Object(
  {
    season,
    scope: AnalysisScopeSchema,
    pitchers: Type.Array(Type.Object({ pitcherId: id, name: id, pitches: count }, strict)),
  },
  strict,
);
export const PitchAnalysisPointSchema = Type.Object(
  {
    gameId: id,
    revision: Type.Integer({ minimum: 1 }),
    pitchId: id,
    trackingId: id,
    gameDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    pitchType: Type.Union([id, Type.Null()]),
    clusterId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    speedKph: nullableNumber,
    xCm: Type.Number(),
    zCm: Type.Number(),
    arrivalMs: Type.Number({ exclusiveMinimum: 0 }),
    timingDifferenceMs: Type.Number(),
    distanceToPlateCm: Type.Number(),
    extrapolated: Type.Boolean(),
    swing: Type.Boolean(),
    whiff: Type.Boolean(),
    referenceBand: Type.Union([PitchReferenceBandSchema, Type.Null()]),
    stadium: Type.Union([id, Type.Null()]),
    calibrationStatus: PitchCalibrationStatusSchema,
    calibrationXcm: nullableNumber,
    calibrationZcm: nullableNumber,
  },
  strict,
);
export const PitchAnalysisSampleSchema = Type.Object(
  {
    modelVersion: Type.Literal(PITCH_ANALYSIS_MODEL_VERSION),
    season,
    pitcherId: id,
    sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    referenceSourceHash: hash,
    profile: PitchProfileSchema,
    baseline: Type.Union([baselineSchema, Type.Null()]),
    referenceDistribution: Type.Union([PitchReferenceDistributionSchema, Type.Null()]),
    actualPitchCount: count,
    missingTrackingCount: count,
    invalidTrackingCount: count,
    calibration: PitchCalibrationSummarySchema,
    points: Type.Array(Type.Omit(PitchAnalysisPointSchema, ["clusterId"])),
  },
  strict,
);

export const PITCH_CLUSTER_PARAMETERS = {
  algorithm: "gmm",
  modelVersion: 2,
  scaling: "z-score",
  covariance: "full",
  initializations: 10,
  maxIterations: 500,
  tolerance: 1e-3,
  regularization: 1e-5,
  seed: 42,
} as const;
export const PitchClusterResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("empty"),
      Type.Literal("not_converged"),
    ]),
    componentCount: count,
    clusterCount: count,
    unassignedCount: count,
    iterations: count,
    labels: Type.Array(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  },
  strict,
);
export type PitchClusterResult = Static<typeof PitchClusterResultSchema>;
export const PitchClusterInputSchema = Type.Object(
  {
    points: Type.Array(Type.Pick(PitchAnalysisPointSchema, ["xCm", "zCm", "distanceToPlateCm"])),
    componentCount: count,
  },
  strict,
);
export type PitchClusterInput = Static<typeof PitchClusterInputSchema>;
export const PitchAnalysisResponseSchema = Type.Object(
  {
    ...PitchAnalysisSampleSchema.properties,
    scope: AnalysisScopeSchema,
    expectation: PitchExpectationSchema,
    points: Type.Array(PitchAnalysisPointSchema),
    clustering: Type.Object(
      {
        ...Type.Omit(PitchClusterResultSchema, ["labels"]).properties,
        algorithm: Type.Literal(PITCH_CLUSTER_PARAMETERS.algorithm),
        modelVersion: Type.Literal(PITCH_CLUSTER_PARAMETERS.modelVersion),
        scaling: Type.Literal(PITCH_CLUSTER_PARAMETERS.scaling),
        covariance: Type.Literal(PITCH_CLUSTER_PARAMETERS.covariance),
        initializations: Type.Literal(PITCH_CLUSTER_PARAMETERS.initializations),
        maxIterations: Type.Literal(PITCH_CLUSTER_PARAMETERS.maxIterations),
        tolerance: Type.Literal(PITCH_CLUSTER_PARAMETERS.tolerance),
        regularization: Type.Literal(PITCH_CLUSTER_PARAMETERS.regularization),
        seed: Type.Literal(PITCH_CLUSTER_PARAMETERS.seed),
        defaultClusterCount: count,
        maxClusterCount: count,
      },
      strict,
    ),
  },
  strict,
);

export type PitchAnalysisCatalog = Static<typeof PitchAnalysisCatalogSchema>;
export type PitchAnalysisPoint = Static<typeof PitchAnalysisPointSchema>;
export type PitchAnalysisResponse = Static<typeof PitchAnalysisResponseSchema>;
export type PitchAnalysisSample = Static<typeof PitchAnalysisSampleSchema>;
