import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";
const strict = { additionalProperties: false } as const,
  text = Type.String(),
  count = Type.Integer({ minimum: 0 }),
  nullable = Type.Union([Type.Number(), Type.Null()]);
export const BaserunningTotalsSchema = Type.Object(
  {
    identity: text,
    playerId: Type.Union([text, Type.Null()]),
    name: text,
    teamId: text,
    teamName: text,
    games: count,
    advances: count,
    extraBases: count,
    runs: count,
    stolenBases: count,
    caughtStealing: count,
    pickoffs: count,
  },
  strict,
);
export const BaserunningOpportunitySchema = Type.Object(
  {
    gameId: text,
    revision: Type.Integer({ minimum: 1 }),
    gameDate: text,
    playId: text,
    runnerId: text,
    fromBase: Type.Union([Type.Literal(1), Type.Literal(2)]),
    outcome: Type.Union([
      Type.Literal("extra_base"),
      Type.Literal("no_extra_base"),
      Type.Literal("out"),
      Type.Literal("unknown"),
      Type.Literal("excluded_complex"),
    ]),
    finalBase: Type.Union([count, Type.Null()]),
    reason: Type.Union([text, Type.Null()]),
  },
  strict,
);
export const BaserunningResponseSchema = Type.Object(
  {
    query: AnalysisScopeQuerySchema,
    scope: AnalysisScopeSchema,
    sourceHash: text,
    playerId: Type.Union([text, Type.Null()]),
    players: Type.Array(
      Type.Object({ ...BaserunningTotalsSchema.properties, stealRate: nullable }, strict),
    ),
    teams: Type.Array(
      Type.Object({ ...BaserunningTotalsSchema.properties, stealRate: nullable }, strict),
    ),
    opportunities: Type.Array(BaserunningOpportunitySchema),
    opportunitySummary: Type.Object(
      {
        candidates: count,
        eligible: count,
        extraBase: count,
        noExtraBase: count,
        out: count,
        unknown: count,
        excludedComplex: count,
        extraBaseRate: nullable,
      },
      strict,
    ),
  },
  strict,
);
export type BaserunningTotals = Static<typeof BaserunningTotalsSchema>;
export type BaserunningOpportunity = Static<typeof BaserunningOpportunitySchema>;
export type BaserunningResponse = Static<typeof BaserunningResponseSchema>;
