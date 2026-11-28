import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";

const strict = { additionalProperties: false } as const;
const positiveCount = Type.Integer({ minimum: 1 });

export const PitchReleaseQuerySchema = Type.Pick(
  AnalysisScopeQuerySchema,
  ["season", "competition"],
  strict,
);

export const PitchReleaseGroupSchema = Type.Object(
  {
    pitchType: Type.String({ minLength: 1 }),
    pitches: positiveCount,
    games: positiveCount,
    estimate: Type.Union([
      Type.Object(
        {
          xCm: Type.Number(),
          heightCm: Type.Number({ exclusiveMinimum: 0 }),
        },
        strict,
      ),
      Type.Null(),
    ]),
  },
  strict,
);

export const PitchReleaseResponseSchema = Type.Object(
  {
    pitcherId: Type.String({ minLength: 1 }),
    scope: AnalysisScopeSchema,
    sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    groups: Type.Array(PitchReleaseGroupSchema),
  },
  strict,
);

export type PitchReleaseQuery = Static<typeof PitchReleaseQuerySchema>;
export type PitchReleaseGroup = Static<typeof PitchReleaseGroupSchema>;
export type PitchReleaseResponse = Static<typeof PitchReleaseResponseSchema>;
