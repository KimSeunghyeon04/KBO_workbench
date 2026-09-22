import { Type, type Static } from "@sinclair/typebox";
import { RunObservationSchema } from "./run-expectancy.js";
const strict = { additionalProperties: false } as const,
  count = Type.Integer({ minimum: 0 }),
  nullable = Type.Union([Type.Number(), Type.Null()]);
export const CountRunObservationSchema = Type.Object(
  {
    ...RunObservationSchema.properties,
    balls: Type.Integer({ minimum: 0, maximum: 3 }),
    strikes: Type.Integer({ minimum: 0, maximum: 2 }),
  },
  strict,
);
const cell = Type.Object(
  { outs: count, bases: count, balls: count, strikes: count, samples: count, mean: nullable },
  strict,
);
const evaluation = Type.Object(
  {
    season: Type.Integer(),
    samples: count,
    unsupported: count,
    mae: nullable,
    rmse: nullable,
    bias: nullable,
  },
  strict,
);
export const CountRunModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("decision-count-re"),
    sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    trainedThrough: Type.Integer(),
    status: Type.Union([Type.Literal("ready"), Type.Literal("insufficient_data")]),
    trainingSamples: count,
    trainingGames: count,
    shrinkage: Type.Union([Type.Literal(20), Type.Literal(100)]),
    cells: Type.Array(cell, { minItems: 288, maxItems: 288 }),
    validation: Type.Array(
      Type.Object(
        {
          shrinkage: Type.Number(),
          evaluations: Type.Array(evaluation),
          mseDifference95: Type.Union([
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
);
export const CountRunValueResponseSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: Type.Integer({ minimum: 1 }),
    documentHash: Type.String(),
    modelHash: Type.Union([Type.String(), Type.Null()]),
    model: Type.Union([CountRunModelSchema, Type.Null()]),
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("model_unavailable"),
      Type.Literal("outside_training_period"),
    ]),
    halves: Type.Array(
      Type.Object(
        {
          inning: count,
          half: Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
          complete: Type.Boolean(),
          referenceOnly: Type.Boolean(),
          runs: count,
          startRE: nullable,
          pitchValue: nullable,
          nonPitchValue: nullable,
          valueSum: nullable,
          conserved: Type.Union([Type.Boolean(), Type.Null()]),
        },
        strict,
      ),
    ),
    transitions: Type.Array(
      Type.Object(
        {
          playIds: Type.Array(Type.String(), { minItems: 1 }),
          inning: count,
          half: Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
          kind: Type.Union([Type.Literal("pitch"), Type.Literal("non_pitch")]),
          terminalLinked: Type.Boolean(),
          runs: Type.Integer(),
          beforeRE: nullable,
          afterRE: nullable,
          value: nullable,
          status: Type.Union([
            Type.Literal("supported"),
            Type.Literal("unsupported_link"),
            Type.Literal("unsupported_state"),
            Type.Literal("incomplete_half"),
            Type.Literal("not_applied"),
            Type.Literal("boundary"),
          ]),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type CountRunObservation = Static<typeof CountRunObservationSchema>;
export type CountRunModel = Static<typeof CountRunModelSchema>;
export type CountRunValueResponse = Static<typeof CountRunValueResponseSchema>;
