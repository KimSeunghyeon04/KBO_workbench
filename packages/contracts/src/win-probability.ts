import { Type, type Static } from "@sinclair/typebox";
const strict = { additionalProperties: false } as const,
  count = Type.Integer({ minimum: 0 }),
  nullable = Type.Union([Type.Number(), Type.Null()]),
  probability = Type.Number({ minimum: 0, maximum: 1 });
export const WinStateSchema = Type.Object(
  {
    inning: Type.Integer({ minimum: 1, maximum: 12 }),
    half: Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
    outs: Type.Integer({ minimum: 0, maximum: 3 }),
    bases: Type.Integer({ minimum: 0, maximum: 7 }),
    lead: Type.Integer(),
    limit: Type.Union([Type.Literal(11), Type.Literal(12)]),
  },
  strict,
);
export const WinObservationSchema = Type.Object(
  {
    ...WinStateSchema.properties,
    gameId: Type.String(),
    revision: Type.Integer({ minimum: 1 }),
    season: Type.Integer(),
    outcome: Type.Integer({ minimum: 0, maximum: 2 }),
    weight: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  },
  strict,
);
export const WinProbabilitySchema = Type.Object(
  { homeWin: probability, draw: probability, homeLoss: probability, value: probability },
  strict,
);
const evaluation = Type.Object(
  {
    season: Type.Integer(),
    games: count,
    states: count,
    unsupported: count,
    logLoss: nullable,
    brier: nullable,
    calibration: Type.Array(
      Type.Object(
        {
          outcome: Type.Integer({ minimum: 0, maximum: 2 }),
          bin: count,
          weight: Type.Number(),
          predicted: nullable,
          observed: nullable,
        },
        strict,
      ),
    ),
  },
  strict,
);
export const WinModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("home-win-draw-loss"),
    policy: Type.Literal("regular-2022-2025-shortened-limit-v1"),
    sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    trainedThrough: Type.Integer(),
    status: Type.Union([Type.Literal("ready"), Type.Literal("insufficient_data")]),
    trainingGames: count,
    trainingStates: count,
    limits: Type.Array(Type.Union([Type.Literal(11), Type.Literal(12)]), {
      maxItems: 1,
      uniqueItems: true,
    }),
    method: Type.Union([Type.Literal("state_table"), Type.Literal("multinomial")]),
    lambda: Type.Number(),
    prior: WinProbabilitySchema,
    table: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          states: count,
          weight: Type.Number(),
          probability: WinProbabilitySchema,
        },
        strict,
      ),
    ),
    means: Type.Array(Type.Number()),
    scales: Type.Array(Type.Number({ exclusiveMinimum: 0 })),
    coefficients: Type.Array(Type.Number()),
    converged: Type.Boolean(),
    validation: Type.Array(
      Type.Object(
        {
          method: Type.String(),
          lambda: Type.Number(),
          converged: Type.Boolean(),
          evaluations: Type.Array(evaluation),
          logLossDifference95: Type.Union([
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
export const WinProbabilityResponseSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: count,
    documentHash: Type.String(),
    modelHash: Type.Union([Type.String(), Type.Null()]),
    model: Type.Union([WinModelSchema, Type.Null()]),
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("model_unavailable"),
      Type.Literal("unsupported_rules"),
      Type.Literal("outside_training_period"),
      Type.Literal("incomplete_game"),
    ]),
    startValue: nullable,
    terminalValue: nullable,
    wpaSum: nullable,
    conserved: Type.Union([Type.Boolean(), Type.Null()]),
    plays: Type.Array(
      Type.Object(
        {
          playId: Type.String(),
          sequence: count,
          inning: count,
          half: Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
          kind: Type.String(),
          terminal: Type.Boolean(),
          before: Type.Union([WinProbabilitySchema, Type.Null()]),
          after: Type.Union([WinProbabilitySchema, Type.Null()]),
          homeWpa: nullable,
          awayWpa: nullable,
        },
        strict,
      ),
    ),
  },
  strict,
);
export type WinState = Static<typeof WinStateSchema>;
export type WinObservation = Static<typeof WinObservationSchema>;
export type WinModel = Static<typeof WinModelSchema>;
export type WinProbability = Static<typeof WinProbabilitySchema>;
export type WinProbabilityResponse = Static<typeof WinProbabilityResponseSchema>;
