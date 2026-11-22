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

export const pitchCountOutcomes = [
  "ball",
  "strike",
  "foul",
  "walk",
  "strikeout",
  "inPlay",
  "hitByPitch",
  "unresolved",
] as const;
export type PitchCountOutcome = (typeof pitchCountOutcomes)[number];

const summary = {
  pitches: Type.Integer({ minimum: 1 }),
  transitions: Type.Array(
    Type.Object(
      {
        outcome: Type.Union(pitchCountOutcomes.map((outcome) => Type.Literal(outcome))),
        pitches: Type.Integer({ minimum: 0 }),
        rate: Type.Number({ minimum: 0, maximum: 1 }),
      },
      strict,
    ),
    { minItems: pitchCountOutcomes.length, maxItems: pitchCountOutcomes.length },
  ),
};
export const PitchCountFlowGroupSchema = Type.Object(
  {
    balls: PitchArsenalGroupSchema.properties.balls,
    strikes: PitchArsenalGroupSchema.properties.strikes,
    stance: Type.Union([Type.Literal("all"), Type.Literal("L"), Type.Literal("R")]),
    ...summary,
    types: Type.Array(
      Type.Object(
        {
          ...PitchArsenalGroupSchema.properties.types.items.properties,
          ...summary,
        },
        strict,
      ),
      { minItems: 1 },
    ),
  },
  strict,
);
export type PitchCountFlowGroup = Static<typeof PitchCountFlowGroupSchema>;
