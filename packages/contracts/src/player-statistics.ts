import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";
const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 });
const nullable = Type.Union([Type.Number(), Type.Null()]);
const group = Type.Union([Type.Literal("player"), Type.Literal("team")]);
const commonQuery = {
  ...AnalysisScopeQuerySchema.properties,
  group: Type.Optional(group),
  playerId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
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
};
const battingTotals = {
  games: count,
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
};
const pitchingTotals = {
  games: count,
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
};
const battingRates = {
  totalBases: count,
  obpDenominator: count,
  avg: nullable,
  obp: nullable,
  slg: nullable,
  ops: nullable,
  kRate: nullable,
  bbRate: nullable,
};
const pitchingRates = {
  era: nullable,
  knownGamesEra: nullable,
  kRate: nullable,
  bbRate: nullable,
  kMinusBbRate: nullable,
};
export const BattingStatisticsTotalsSchema = Type.Object({ ...identity, ...battingTotals }, strict);
export const PitchingStatisticsTotalsSchema = Type.Object(
  { ...identity, ...pitchingTotals },
  strict,
);
export const BattingStatisticsRowSchema = Type.Object(
  { ...BattingStatisticsTotalsSchema.properties, ...battingRates },
  strict,
);
export const PitchingStatisticsRowSchema = Type.Object(
  { ...PitchingStatisticsTotalsSchema.properties, ...pitchingRates },
  strict,
);
const seasonIdentity = {
  season: AnalysisScopeSchema.properties.season,
  teams: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
};
export const PlayerSeasonBattingTotalsSchema = Type.Object(
  { ...seasonIdentity, ...battingTotals },
  strict,
);
export const PlayerSeasonPitchingTotalsSchema = Type.Object(
  { ...seasonIdentity, ...pitchingTotals },
  strict,
);
const playerSeasonBattingRow = Type.Object(
  { ...PlayerSeasonBattingTotalsSchema.properties, ...battingRates },
  strict,
);
const playerSeasonPitchingRow = Type.Object(
  { ...PlayerSeasonPitchingTotalsSchema.properties, ...pitchingRates },
  strict,
);
export const PlayerSeasonStatisticsQuerySchema = Type.Object(
  {
    ...AnalysisScopeQuerySchema.properties,
    season: Type.Optional(AnalysisScopeSchema.properties.season),
    player: Type.String({ minLength: 1, maxLength: 200 }),
    sourceRole: Type.Optional(Type.Union([Type.Literal("batter"), Type.Literal("pitcher")])),
  },
  strict,
);
export const PlayerSeasonStatisticsResponseSchema = Type.Object(
  {
    query: PlayerSeasonStatisticsQuerySchema,
    batting: Type.Array(playerSeasonBattingRow),
    pitching: Type.Array(playerSeasonPitchingRow),
  },
  strict,
);
const playerRecordQuery = {
  ...AnalysisScopeQuerySchema.properties,
  player: PlayerSeasonStatisticsQuerySchema.properties.player,
  role: Type.Union([Type.Literal("batter"), Type.Literal("pitcher")]),
  source: Type.Optional(Type.Literal("naver")),
};
export const PlayerGameRecordsQuerySchema = Type.Object(playerRecordQuery, strict);
const playerGameIdentity = {
  gameId: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  gameDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  teams: seasonIdentity.teams,
  opponents: seasonIdentity.teams,
  side: Type.Union([Type.Literal("home"), Type.Literal("away"), Type.Literal("both")]),
};
export const PlayerGameBattingRowSchema = Type.Object(
  {
    ...playerGameIdentity,
    plateAppearances: count,
    atBats: count,
    hits: count,
    homeRuns: count,
    walks: count,
    strikeouts: count,
    runs: count,
  },
  strict,
);
export const PlayerGamePitchingRowSchema = Type.Object(
  {
    ...playerGameIdentity,
    battersFaced: count,
    outsRecorded: count,
    hits: count,
    runs: count,
    earnedRuns: Type.Union([count, Type.Null()]),
    walks: count,
    strikeouts: count,
    pitches: count,
  },
  strict,
);
const playerGameEnvelope = { query: PlayerGameRecordsQuerySchema, scope: AnalysisScopeSchema };
export const PlayerGameRecordsResponseSchema = Type.Union([
  Type.Object(
    {
      ...playerGameEnvelope,
      role: Type.Literal("batter"),
      rows: Type.Array(PlayerGameBattingRowSchema),
    },
    strict,
  ),
  Type.Object(
    {
      ...playerGameEnvelope,
      role: Type.Literal("pitcher"),
      rows: Type.Array(PlayerGamePitchingRowSchema),
    },
    strict,
  ),
]);
export const PlayerSplitDimensionSchema = Type.Union([
  Type.Literal("hand"),
  Type.Literal("venue"),
  Type.Literal("risp"),
]);
export const PlayerSplitBucketSchema = Type.Union([
  Type.Literal("L"),
  Type.Literal("R"),
  Type.Literal("unknown"),
  Type.Literal("home"),
  Type.Literal("away"),
  Type.Literal("risp"),
  Type.Literal("no-risp"),
]);
export const playerSplitBuckets = {
  hand: ["L", "R", "unknown"],
  venue: ["home", "away"],
  risp: ["risp", "no-risp", "unknown"],
} as const;
export const PlayerSplitQuerySchema = Type.Object(
  {
    ...playerRecordQuery,
    split: PlayerSplitDimensionSchema,
    countFor: Type.Optional(PlayerSplitBucketSchema),
  },
  strict,
);
const terminalCount = Type.Object(
  {
    balls: Type.Integer({ minimum: 0, maximum: 3 }),
    strikes: Type.Integer({ minimum: 0, maximum: 2 }),
  },
  strict,
);
const splitRow = Type.Object(
  {
    bucket: PlayerSplitBucketSchema,
    ...Type.Omit(BattingStatisticsTotalsSchema, [
      "identity",
      "playerId",
      "name",
      "teamId",
      "teamName",
      "games",
      "runs",
    ]).properties,
    ...battingRates,
  },
  strict,
);
export const PlayerSplitResponseSchema = Type.Object(
  {
    query: PlayerSplitQuerySchema,
    scope: AnalysisScopeSchema,
    rows: Type.Array(splitRow),
    byCount: Type.Optional(
      Type.Array(
        Type.Object(
          {
            count: Type.Union([terminalCount, Type.Null()]),
            ...Type.Omit(splitRow, ["bucket"]).properties,
          },
          strict,
        ),
        { maxItems: 13 },
      ),
    ),
  },
  strict,
);
export const LeagueBattingTotalsSchema = Type.Object(battingTotals, strict);
export const LeaguePitchingTotalsSchema = Type.Object(pitchingTotals, strict);
const leagueBatting = Type.Object({ ...battingTotals, ...battingRates }, strict);
const leaguePitching = Type.Object({ ...pitchingTotals, ...pitchingRates }, strict);
const leagueContext = { query: PlayerGameRecordsQuerySchema, scope: AnalysisScopeSchema };
export const PlayerLeagueResponseSchema = Type.Union([
  Type.Object(
    {
      ...leagueContext,
      role: Type.Literal("batter"),
      player: Type.Union([leagueBatting, Type.Null()]),
      league: Type.Union([leagueBatting, Type.Null()]),
    },
    strict,
  ),
  Type.Object(
    {
      ...leagueContext,
      role: Type.Literal("pitcher"),
      player: Type.Union([leaguePitching, Type.Null()]),
      league: Type.Union([leaguePitching, Type.Null()]),
    },
    strict,
  ),
]);
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
export type PlayerSeasonStatisticsQuery = Static<typeof PlayerSeasonStatisticsQuerySchema>;
export type PlayerSeasonStatisticsResponse = Static<typeof PlayerSeasonStatisticsResponseSchema>;
export type PlayerGameRecordsQuery = Static<typeof PlayerGameRecordsQuerySchema>;
export type PlayerGameRecordsResponse = Static<typeof PlayerGameRecordsResponseSchema>;
export type PlayerSplitQuery = Static<typeof PlayerSplitQuerySchema>;
export type PlayerSplitBucket = Static<typeof PlayerSplitBucketSchema>;
export type PlayerSplitResponse = Static<typeof PlayerSplitResponseSchema>;
export type PlayerLeagueResponse = Static<typeof PlayerLeagueResponseSchema>;
