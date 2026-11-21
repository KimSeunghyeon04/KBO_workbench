import { Type, type Static } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;
export const PitchArsenalGroupSchema = Type.Object(
  {
    balls: Type.Integer({ minimum: 0, maximum: 3 }),
    strikes: Type.Integer({ minimum: 0, maximum: 2 }),
    stance: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    pitches: Type.Integer({ minimum: 1 }),
    types: Type.Array(
      Type.Object(
        {
          pitchType: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          pitches: Type.Integer({ minimum: 1 }),
          usageRate: Type.Number({ minimum: 0, maximum: 1 }),
        },
        strict,
      ),
      { minItems: 1 },
    ),
  },
  strict,
);
export type PitchArsenalGroup = Static<typeof PitchArsenalGroupSchema>;
