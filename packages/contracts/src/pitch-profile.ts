import { Type, type Static } from "@sinclair/typebox";
const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 });
const number = Type.Union([Type.Number(), Type.Null()]);
export const PitchProfileGroupSchema = Type.Object(
  {
    pitchType: Type.Union([Type.String(), Type.Null()]),
    actualPitches: count,
    usageRate: number,
    speedCount: count,
    meanSpeedKph: number,
    shapeCount: count,
    calibratedCount: count,
    meanXCm: number,
    meanZCm: number,
    sdXCm: number,
    sdZCm: number,
    meanArrivalMs: number,
    calibratedXCm: number,
    calibratedZCm: number,
    calibratedArrivalMs: number,
    swings: count,
    whiffs: count,
    whiffRate: number,
  },
  strict,
);
export const PitchProfileSchema = Type.Object(
  {
    groups: Type.Array(PitchProfileGroupSchema),
    months: Type.Array(
      Type.Object(
        {
          month: Type.String({ pattern: "^\\d{4}-\\d{2}$" }),
          actualPitches: count,
          groups: Type.Array(PitchProfileGroupSchema),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type PitchProfile = Static<typeof PitchProfileSchema>;
export type PitchProfileGroup = Static<typeof PitchProfileGroupSchema>;
