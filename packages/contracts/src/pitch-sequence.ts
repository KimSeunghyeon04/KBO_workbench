import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeSchema } from "./analysis-scope.js";
import { PitchOutcomeQuerySchema } from "./pitch-outcomes.js";
import { PitchCallSchema } from "./game-document/events.js";
const strict = { additionalProperties: false } as const,
  text = Type.String(),
  nullableText = Type.Union([text, Type.Null()]),
  n = Type.Union([Type.Number(), Type.Null()]),
  count = Type.Integer({ minimum: 0 });
export const PitchSequenceQuerySchema = Type.Object(
  {
    ...PitchOutcomeQuerySchema.properties,
    previousType: Type.Optional(Type.String({ minLength: 1 })),
  },
  strict,
);
export const PitchSequenceRowSchema = Type.Object(
  {
    gameId: text,
    revision: count,
    gameDate: text,
    stadium: nullableText,
    pitchId: text,
    pitchSequence: count,
    paId: nullableText,
    pitcherId: nullableText,
    batterId: nullableText,
    pitchType: nullableText,
    stance: nullableText,
    speedKph: n,
    balls: count,
    strikes: count,
    actual: Type.Boolean(),
    pitchCall: PitchCallSchema,
    swing: Type.Boolean(),
    whiff: Type.Boolean(),
    calledStrike: Type.Boolean(),
    eligible: Type.Boolean(),
    interveningChange: Type.Boolean(),
    supported: Type.Boolean(),
    trackingId: nullableText,
    x0: n,
    y0: n,
    z0: n,
    vx0: n,
    vy0: n,
    vz0: n,
    ax: n,
    ay: n,
    az: n,
    crossPlateX: n,
    crossPlateY: n,
  },
  strict,
);
const group = Type.Object(
  {
    key: text,
    pairs: count,
    swings: count,
    whiffs: count,
    calledStrikes: count,
    swingRate: n,
    whiffRate: n,
    calledStrikeRate: n,
    geometryPairs: count,
    meanPlaneDistanceCm: n,
    meanPlaneTimeDifferenceMs: n,
    meanSpeedDifferenceKph: n,
    meanArrivalDistanceCm: n,
  },
  strict,
);
export const PitchSequenceResponseSchema = Type.Object(
  {
    query: PitchSequenceQuerySchema,
    pitcherId: text,
    scope: AnalysisScopeSchema,
    sourceHash: text,
    planeYFeet: Type.Literal(23.8),
    coverage: Type.Object(
      {
        targetPitches: count,
        noPrevious: count,
        nonActualBoundary: count,
        playerChange: count,
        eligiblePairs: count,
        filteredPairs: count,
        geometryPairs: count,
      },
      strict,
    ),
    groups: Type.Array(group),
    pairs: Type.Array(
      Type.Object(
        {
          previous: PitchSequenceRowSchema,
          current: PitchSequenceRowSchema,
          planeDistanceCm: n,
          planeTimeDifferenceMs: n,
          speedDifferenceKph: n,
          arrivalDistanceCm: n,
        },
        strict,
      ),
      { maxItems: 25000 },
    ),
  },
  strict,
);
export type PitchSequenceQuery = Static<typeof PitchSequenceQuerySchema>;
export type PitchSequenceRow = Static<typeof PitchSequenceRowSchema>;
export type PitchSequenceResponse = Static<typeof PitchSequenceResponseSchema>;
