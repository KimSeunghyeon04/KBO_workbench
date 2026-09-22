import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";
import { DisciplineRowSchema } from "./batter-discipline.js";
import { PitchCallSchema, PlateResultSchema } from "./game-document/events.js";
const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 }),
  textOrNull = Type.Union([text, Type.Null()]);
const count = Type.Integer({ minimum: 0 }),
  ratio = Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]);
export const PitchOutcomeQuerySchema = Type.Object(
  {
    ...AnalysisScopeQuerySchema.properties,
    balls: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    strikes: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
    pitchType: Type.Optional(text),
    stance: Type.Optional(Type.Union([Type.Literal("L"), Type.Literal("R"), Type.Literal("S")])),
    cohort: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("discipline")])),
  },
  strict,
);
export const PitchOutcomeRowSchema = Type.Object(
  {
    ...DisciplineRowSchema.properties,
    season: AnalysisScopeQuerySchema.properties.season,
    batterId: textOrNull,
    pitcherId: textOrNull,
    pitchSequence: count,
    paId: textOrNull,
    pitchCall: PitchCallSchema,
    calledStrike: Type.Boolean(),
    csw: Type.Boolean(),
    inPlay: Type.Boolean(),
  },
  strict,
);
export const TerminalPaRowSchema = Type.Object(
  {
    gameId: text,
    revision: Type.Integer({ minimum: 1 }),
    gameDate: text,
    paId: text,
    batterId: text,
    pitcherId: text,
    completed: Type.Boolean(),
    countsAsPa: Type.Boolean(),
    countsAsAb: Type.Boolean(),
    countsAsBf: Type.Boolean(),
    result: Type.Union([PlateResultSchema, Type.Null()]),
    eligible: Type.Boolean(),
    pitchId: textOrNull,
    terminalActual: Type.Union([Type.Boolean(), Type.Null()]),
    terminalBatterId: textOrNull,
    terminalPitcherId: textOrNull,
    pitchType: textOrNull,
    stance: textOrNull,
    speedKph: Type.Union([Type.Number(), Type.Null()]),
    pitchCall: Type.Union([PitchCallSchema, Type.Null()]),
    inPlay: Type.Union([Type.Boolean(), Type.Null()]),
    beforeBalls: Type.Union([count, Type.Null()]),
    beforeStrikes: Type.Union([count, Type.Null()]),
    afterBalls: Type.Union([count, Type.Null()]),
    afterStrikes: Type.Union([count, Type.Null()]),
  },
  strict,
);
export const PitchRateGroupSchema = Type.Object(
  {
    key: text,
    pitches: count,
    swings: count,
    whiffs: count,
    calledStrikes: count,
    csw: count,
    inPlay: count,
    zoneKnown: count,
    zonePitches: count,
    zoneSwings: count,
    outsidePitches: count,
    outsideSwings: count,
    twoStrikePitches: count,
    terminalStrikeouts: count,
    inPlayResults: count,
    inPlayHits: count,
    swingRate: ratio,
    whiffRate: ratio,
    swingingStrikeRate: ratio,
    calledStrikeRate: ratio,
    cswRate: ratio,
    zoneRate: ratio,
    chaseRate: ratio,
    zoneSwingRate: ratio,
    putAwayRate: ratio,
    inPlayHitRate: ratio,
  },
  strict,
);
export const PitchLocationPointSchema = Type.Object(
  {
    ...Type.Pick(PitchOutcomeRowSchema, [
      "gameId",
      "revision",
      "pitchId",
      "gameDate",
      "pitchType",
      "speedKph",
      "balls",
      "strikes",
      "stance",
      "swing",
      "whiff",
    ]).properties,
    cell: Type.Integer({ minimum: 0, maximum: 24 }),
    xCm: Type.Number(),
    zCm: Type.Number(),
    normalizedX: Type.Number(),
    normalizedZ: Type.Number(),
    inZone: Type.Boolean(),
  },
  strict,
);
export const PitchLocationResponseSchema = Type.Object(
  {
    query: PitchOutcomeQuerySchema,
    pitcherId: text,
    scope: AnalysisScopeSchema,
    sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    coverage: Type.Object(
      {
        scopePitches: count,
        filteredPitches: count,
        excludedSituations: count,
        locationPitches: count,
        missingLocation: count,
        automaticStrikeouts: count,
      },
      strict,
    ),
    total: PitchRateGroupSchema,
    byType: Type.Array(PitchRateGroupSchema),
    byCount: Type.Array(PitchRateGroupSchema),
    byStance: Type.Array(PitchRateGroupSchema),
    cells: Type.Array(PitchRateGroupSchema, { minItems: 25, maxItems: 25 }),
    points: Type.Array(PitchLocationPointSchema, { maxItems: 25000 }),
  },
  strict,
);
export type PitchOutcomeQuery = Static<typeof PitchOutcomeQuerySchema>;
export type PitchOutcomeRow = Static<typeof PitchOutcomeRowSchema>;
export type TerminalPaRow = Static<typeof TerminalPaRowSchema>;
export type PitchRateGroup = Static<typeof PitchRateGroupSchema>;
export type PitchLocationPoint = Static<typeof PitchLocationPointSchema>;
export type PitchLocationResponse = Static<typeof PitchLocationResponseSchema>;
