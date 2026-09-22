import { Type, type Static } from "@sinclair/typebox";
const strict = { additionalProperties: false } as const,
  text = Type.String(),
  count = Type.Integer({ minimum: 0 }),
  number = Type.Union([Type.Number(), Type.Null()]);
export const RunTrainingGameSchema = Type.Object(
  {
    gameId: text,
    revision: Type.Integer({ minimum: 1 }),
    season: Type.Integer(),
    gameDate: text,
    scheduledInnings: Type.Integer(),
    status: text,
    normalEnd: Type.Boolean(),
    documentHash: text,
  },
  strict,
);
export const RunObservationSchema = Type.Object(
  {
    gameId: text,
    revision: Type.Integer(),
    season: Type.Integer(),
    gameDate: text,
    inning: Type.Integer({ minimum: 1, maximum: 8 }),
    half: Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
    outs: Type.Integer({ minimum: 0, maximum: 2 }),
    bases: Type.Integer({ minimum: 0, maximum: 7 }),
    remainingRuns: count,
  },
  strict,
);
export const RunExpectancyCellSchema = Type.Object(
  {
    outs: Type.Integer({ minimum: 0, maximum: 2 }),
    bases: Type.Integer({ minimum: 0, maximum: 7 }),
    samples: count,
    mean: number,
  },
  strict,
);
const evaluation = Type.Object(
  {
    season: Type.Integer(),
    samples: count,
    unsupported: count,
    mae: number,
    rmse: number,
    bias: number,
    states: Type.Array(
      Type.Object({ outs: count, bases: count, samples: count, bias: number }, strict),
    ),
  },
  strict,
);
export const RunExpectancyModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("pa-start-re24"),
    sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    trainedThrough: Type.Integer(),
    status: Type.Union([Type.Literal("ready"), Type.Literal("insufficient_data")]),
    trainingSamples: count,
    trainingGames: count,
    policy: Type.Literal("regular-nine-innings-complete-halves-1-to-8"),
    method: Type.Union([
      Type.Literal("pooled"),
      Type.Literal("recent-shrink-20"),
      Type.Literal("recent-shrink-100"),
    ]),
    cells: Type.Array(RunExpectancyCellSchema, { minItems: 24, maxItems: 24 }),
    validation: Type.Array(
      Type.Object(
        {
          method: Type.String(),
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
export const RunValueResponseSchema = Type.Object(
  {
    gameId: text,
    revision: Type.Integer({ minimum: 1 }),
    documentHash: text,
    modelHash: Type.Union([text, Type.Null()]),
    modelTrainedThrough: Type.Union([Type.Integer(), Type.Null()]),
    model: Type.Union([RunExpectancyModelSchema, Type.Null()]),
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("model_unavailable"),
      Type.Literal("outside_training_period"),
    ]),
    halves: Type.Array(
      Type.Object(
        {
          inning: Type.Integer(),
          half: Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
          complete: Type.Boolean(),
          referenceOnly: Type.Boolean(),
          runs: count,
          startRE: number,
          valueSum: number,
          conserved: Type.Union([Type.Boolean(), Type.Null()]),
        },
        strict,
      ),
    ),
    plays: Type.Array(
      Type.Object(
        {
          playId: text,
          sequence: count,
          inning: Type.Integer(),
          half: Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
          kind: text,
          action: Type.Union([
            Type.Literal("steal_only"),
            Type.Literal("bunt"),
            Type.Literal("compound"),
            Type.Literal("other"),
          ]),
          runs: Type.Integer(),
          beforeRE: number,
          afterRE: number,
          value: number,
          status: Type.Union([
            Type.Literal("supported"),
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
export type RunTrainingGame = Static<typeof RunTrainingGameSchema>;
export type RunObservation = Static<typeof RunObservationSchema>;
export type RunExpectancyModel = Static<typeof RunExpectancyModelSchema>;
export type RunValueResponse = Static<typeof RunValueResponseSchema>;
