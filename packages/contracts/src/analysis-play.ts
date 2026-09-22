import { Type, type Static } from "@sinclair/typebox";
import { PlateResultSchema, PitchCallSchema } from "./game-document.js";
const strict = { additionalProperties: false } as const,
  text = Type.String(),
  nullable = Type.Union([text, Type.Null()]),
  count = Type.Integer({ minimum: 0 });
export const AnalysisStateSchema = Type.Object(
  {
    inning: count,
    half: Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
    halfActive: Type.Boolean(),
    balls: count,
    strikes: count,
    outs: Type.Integer({ minimum: 0, maximum: 3 }),
    awayScore: count,
    homeScore: count,
    batterId: nullable,
    pitcherId: nullable,
    awayPitcherId: nullable,
    homePitcherId: nullable,
    paId: nullable,
    bases: Type.Array(
      Type.Union([Type.Object({ runnerId: text, pitcherId: text }, strict), Type.Null()]),
      { minItems: 3, maxItems: 3 },
    ),
  },
  strict,
);
export const AnalysisMovementSchema = Type.Object(
  {
    sequence: count,
    runnerId: text,
    pitcherId: text,
    fromBase: count,
    toBase: count,
    outcome: Type.Union([Type.Literal("safe"), Type.Literal("out"), Type.Literal("scored")]),
    reason: text,
    derived: Type.Boolean(),
  },
  strict,
);
export const AnalysisPlaySchema = Type.Object(
  {
    gameId: text,
    revision: Type.Integer({ minimum: 1 }),
    gameDate: text,
    playId: text,
    sequence: count,
    kind: text,
    applied: Type.Boolean(),
    inning: count,
    half: Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
    before: AnalysisStateSchema,
    after: AnalysisStateSchema,
    result: Type.Union([PlateResultSchema, Type.Null()]),
    isBunt: Type.Union([Type.Boolean(), Type.Null()]),
    pitch: Type.Union([
      Type.Object(
        { id: text, call: PitchCallSchema, actual: Type.Boolean(), inPlay: Type.Boolean() },
        strict,
      ),
      Type.Null(),
    ]),
    movements: Type.Array(AnalysisMovementSchema),
  },
  strict,
);
export type AnalysisState = Static<typeof AnalysisStateSchema>;
export type AnalysisMovement = Static<typeof AnalysisMovementSchema>;
export type AnalysisPlay = Static<typeof AnalysisPlaySchema>;
