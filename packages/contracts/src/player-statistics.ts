import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";
const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 });
const nullable = Type.Union([Type.Number(), Type.Null()]);
const group = Type.Union([Type.Literal("player"), Type.Literal("team")]);
const commonQuery = {
  ...AnalysisScopeQuerySchema.properties,
  group: Type.Optional(group),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};
export const BattingStatisticsQuerySchema = Type.Object(
  {
    ...commonQuery,
    minPA: Type.Optional(count),
    sort: Type.Optional(
      Type.Union([
        Type.Literal("ops"),
        Type.Literal("avg"),
        Type.Literal("plateAppearances"),
        Type.Literal("homeRuns"),
      ]),
    ),
  },
  strict,
);
export const PitchingStatisticsQuerySchema = Type.Object(
  {
    ...commonQuery,
    minBF: Type.Optional(count),
    sort: Type.Optional(
      Type.Union([
        Type.Literal("era"),
        Type.Literal("kMinusBbRate"),
        Type.Literal("battersFaced"),
        Type.Literal("outsRecorded"),
      ]),
    ),
  },
  strict,
);
const identity = {
  identity: Type.String(),
  playerId: Type.Union([Type.String(), Type.Null()]),
  name: Type.String(),
  teamId: Type.String(),
  teamName: Type.String(),
  games: count,
};
export const BattingStatisticsTotalsSchema = Type.Object(
  {
    ...identity,
    plateAppearances: count,
    atBats: count,
    hits: count,
    doubles: count,
    triples: count,
    homeRuns: count,
    walks: count,
    intentionalWalks: count,
    hitByPitch: count,
    strikeouts: count,
    sacrificeFlies: count,
    sacrificeBunts: count,
    runs: count,
  },
  strict,
);
export const PitchingStatisticsTotalsSchema = Type.Object(
  {
    ...identity,
    battersFaced: count,
    outsRecorded: count,
    hits: count,
    runs: count,
    walks: count,
    intentionalWalks: count,
    hitByPitch: count,
    strikeouts: count,
    pitches: count,
    strikes: count,
    knownErGames: count,
    knownErOuts: count,
    knownEarnedRuns: count,
  },
  strict,
);
export const BattingStatisticsRowSchema = Type.Object(
  {
    ...BattingStatisticsTotalsSchema.properties,
    totalBases: count,
    obpDenominator: count,
    avg: nullable,
    obp: nullable,
    slg: nullable,
    ops: nullable,
    kRate: nullable,
    bbRate: nullable,
  },
  strict,
);
export const PitchingStatisticsRowSchema = Type.Object(
  {
    ...PitchingStatisticsTotalsSchema.properties,
    era: nullable,
    knownGamesEra: nullable,
    kRate: nullable,
    bbRate: nullable,
    kMinusBbRate: nullable,
  },
  strict,
);
const envelope = {
  scope: AnalysisScopeSchema,
  sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  group,
  total: count,
  page: Type.Integer({ minimum: 1 }),
  limit: Type.Integer({ minimum: 1, maximum: 200 }),
};
export const BattingStatisticsResponseSchema = Type.Object(
  {
    ...envelope,
    kind: Type.Literal("batting"),
    query: BattingStatisticsQuerySchema,
    rows: Type.Array(BattingStatisticsRowSchema, { maxItems: 200 }),
  },
  strict,
);
export const PitchingStatisticsResponseSchema = Type.Object(
  {
    ...envelope,
    kind: Type.Literal("pitching"),
    query: PitchingStatisticsQuerySchema,
    rows: Type.Array(PitchingStatisticsRowSchema, { maxItems: 200 }),
  },
  strict,
);
export type BattingStatisticsQuery = Static<typeof BattingStatisticsQuerySchema>;
export type PitchingStatisticsQuery = Static<typeof PitchingStatisticsQuerySchema>;
export type BattingStatisticsTotals = Static<typeof BattingStatisticsTotalsSchema>;
export type PitchingStatisticsTotals = Static<typeof PitchingStatisticsTotalsSchema>;
export type BattingStatisticsRow = Static<typeof BattingStatisticsRowSchema>;
export type PitchingStatisticsRow = Static<typeof PitchingStatisticsRowSchema>;
export type BattingStatisticsResponse = Static<typeof BattingStatisticsResponseSchema>;
export type PitchingStatisticsResponse = Static<typeof PitchingStatisticsResponseSchema>;
