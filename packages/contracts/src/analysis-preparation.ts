import { Type, type Static } from "@sinclair/typebox";
import { ZonedDateTimeSchema } from "./game-document/primitives.js";

export const AnalysisPreparationSchema = Type.Object(
  {
    version: Type.Literal(1),
    season: Type.Integer({ minimum: 1982, maximum: 2200 }),
    sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    competitionHash: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
    state: Type.Union([
      Type.Literal("pending"),
      Type.Literal("classifying"),
      Type.Literal("models"),
      Type.Literal("ready"),
      Type.Literal("failed"),
    ]),
    unclassified: Type.Integer({ minimum: 0 }),
    updatedAt: ZonedDateTimeSchema,
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type AnalysisPreparation = Static<typeof AnalysisPreparationSchema>;
export const AnalysisSeasonsSchema = Type.Object(
  {
    sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    seasons: Type.Array(Type.Integer({ minimum: 1982, maximum: 2200 }), { uniqueItems: true }),
    preparation: Type.Array(AnalysisPreparationSchema),
  },
  { additionalProperties: false },
);
