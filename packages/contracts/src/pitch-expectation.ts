import { type Static, Type } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 });
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const position = Type.Object(
  { xCm: Type.Number(), distanceToPlateCm: Type.Number(), zCm: Type.Number() },
  strict,
);
const contour = Type.Object({ radius: Type.Number({ minimum: 0 }), includedCount: count }, strict);
export const PITCH_REFERENCE_VERSION = 2;
export const PitchReferenceDistributionSchema = Type.Object(
  {
    modelVersion: Type.Literal(1),
    method: Type.Literal("empirical_mahalanobis"),
    sampleCount: Type.Integer({ minimum: 4 }),
    regularizationCm2: Type.Literal(0.0001),
    center: position,
    transform: Type.Object(
      {
        xx: Type.Number({ exclusiveMinimum: 0 }),
        yx: Type.Number(),
        yy: Type.Number({ exclusiveMinimum: 0 }),
        zx: Type.Number(),
        zy: Type.Number(),
        zz: Type.Number({ exclusiveMinimum: 0 }),
      },
      strict,
    ),
    central50: contour,
    central90: contour,
  },
  strict,
);
export const PitchReferenceBandSchema = Type.Union([
  Type.Literal("core50"),
  Type.Literal("shell90"),
  Type.Literal("outside90"),
]);
export const PitchExpectationGroupSchema = Type.Object(
  {
    count,
    meanXCm: nullableNumber,
    meanZCm: nullableNumber,
    meanDepthCm: nullableNumber,
    meanTimingMs: nullableNumber,
    sdXCm: nullableNumber,
    sdZCm: nullableNumber,
    sdTimingMs: nullableNumber,
    outside90Count: Type.Union([count, Type.Null()]),
    swings: count,
    whiffs: count,
    whiffRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  },
  strict,
);
export const PitchExpectationSchema = Type.Object(
  {
    modelVersion: Type.Literal(1),
    providerGroups: Type.Array(
      Type.Object(
        {
          pitchType: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          ...PitchExpectationGroupSchema.properties,
        },
        strict,
      ),
    ),
    clusterGroups: Type.Array(
      Type.Object(
        {
          clusterId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
          ...PitchExpectationGroupSchema.properties,
        },
        strict,
      ),
    ),
    bands: Type.Array(
      Type.Object(
        { band: PitchReferenceBandSchema, ...PitchExpectationGroupSchema.properties },
        strict,
      ),
    ),
  },
  strict,
);
export type PitchReferenceDistribution = Static<typeof PitchReferenceDistributionSchema>;
export type PitchReferenceBand = Static<typeof PitchReferenceBandSchema>;
export type PitchExpectationGroup = Static<typeof PitchExpectationGroupSchema>;
export type PitchExpectation = Static<typeof PitchExpectationSchema>;
