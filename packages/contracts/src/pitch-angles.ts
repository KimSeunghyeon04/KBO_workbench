import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeSchema } from "./analysis-scope.js";
const strict = { additionalProperties: false } as const,
  count = Type.Integer({ minimum: 0 }),
  number = Type.Number(),
  nullable = Type.Union([number, Type.Null()]);
const group = Type.Object(
  {
    pitchType: Type.Union([Type.String(), Type.Null()]),
    pitches: count,
    vaaDegrees: nullable,
    haaDegrees: nullable,
    sdVaaDegrees: nullable,
    sdHaaDegrees: nullable,
    meanHeightCm: nullable,
    meanSideCm: nullable,
  },
  strict,
);
export const PitchAnglesResponseSchema = Type.Object(
  {
    version: Type.Literal(1),
    policy: Type.Literal("raw-trajectory-middle-plane-v1"),
    planeYFeet: number,
    scope: AnalysisScopeSchema,
    pitcherId: Type.String(),
    sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    coverage: Type.Object(
      { actual: count, missingTracking: count, unsupported: count, invalid: count, used: count },
      strict,
    ),
    groups: Type.Array(group),
    games: Type.Array(
      Type.Object(
        {
          gameId: Type.String(),
          revision: Type.Integer(),
          gameDate: Type.String(),
          stadium: Type.Union([Type.String(), Type.Null()]),
          groups: Type.Array(group),
        },
        strict,
      ),
    ),
    points: Type.Array(
      Type.Object(
        {
          gameId: Type.String(),
          revision: Type.Integer(),
          pitchId: Type.String(),
          gameDate: Type.String(),
          pitchType: Type.Union([Type.String(), Type.Null()]),
          vaaDegrees: number,
          haaDegrees: number,
          heightCm: number,
          sideCm: number,
        },
        strict,
      ),
    ),
  },
  strict,
);
export type PitchAnglesResponse = Static<typeof PitchAnglesResponseSchema>;
