import {
  readAnalysisPeriods,
  withAnalysisReadSnapshot,
  withAnalysisSnapshot,
  type AnalysisReadSnapshot,
} from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";
import {
  canonicalStringify,
  defaultAnalysisCompetition,
  InvalidAnalysisScopeError,
  resolveAnalysisScope,
  BattingStatisticsQuerySchema,
  PitchingStatisticsQuerySchema,
  BattingStatisticsTotalsSchema,
  PitchingStatisticsTotalsSchema,
  BattingStatisticsResponseSchema,
  PitchingStatisticsResponseSchema,
  PlayerSeasonBattingTotalsSchema,
  PlayerSeasonPitchingTotalsSchema,
  PlayerSeasonStatisticsQuerySchema,
  PlayerGameRecordsQuerySchema,
  PlayerGameBattingRowSchema,
  PlayerGamePitchingRowSchema,
  PlateResultSchema,
  PlayerSplitQuerySchema,
  LeagueBattingTotalsSchema,
  LeaguePitchingTotalsSchema,
  playerSplitBuckets,
  type AnalysisScope,
  type AnalysisScopeQuery,
  type BattingStatisticsQuery,
  type PitchingStatisticsQuery,
  type BattingStatisticsResponse,
  type PitchingStatisticsResponse,
  type PlayerSeasonStatisticsQuery,
  type PlayerSeasonStatisticsResponse,
  type PlayerGameRecordsQuery,
  type PlayerGameRecordsResponse,
  type PlayerSplitQuery,
  type PlayerSplitResponse,
  type PlayerLeagueResponse,
  type PlayerSplitBucket,
} from "@kbo/contracts";
import {
  battingStatistics,
  pitchingStatistics,
  summarizeBattingResults,
  summarizePlayerSplits,
} from "@kbo/game-core";
import { effectiveBattingSideSql, lastPitchesCteSql } from "./analysis-pitch-input.js";
import { readGamePitcherHands, type ResolvePitcherHand } from "./pitcher-hands.js";
import {
  ANALYSIS_GAME_WHERE,
  OPTIONAL_SEASON_ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";

// Team affiliation is the game snapshot. Player rows deliberately remain separated by that team.
const identity = `CASE WHEN $5='player' THEN f.player_identity_key ELSE t.team_identity_key END AS identity,
  CASE WHEN $5='player' THEN f.player_id ELSE NULL END AS "playerId",
  CASE WHEN $5='player' THEN COALESCE(roster.name,f.player_id) ELSE t.team_name END AS name,
  t.team_id AS "teamId",t.team_name AS "teamName"`;
const gameTeamJoin = `JOIN workbench.game_team_snapshots t
  ON t.game_id=f.game_id AND t.revision=f.revision AND t.side=f.side`;
const rankingJoins = `${gameTeamJoin}
  LEFT JOIN LATERAL(SELECT min(player_name COLLATE "C") AS name FROM workbench.game_roster_snapshots s
    WHERE s.game_id=f.game_id AND s.revision=f.revision AND s.side=f.side AND s.player_id=f.player_id) roster ON TRUE`;
function selectedStatPlayer(bySource: boolean, actor: "player" | "batter" | "pitcher" = "player") {
  return bySource
    ? `f.${actor}_id=$5`
    : `f.${actor}_identity_key IN (SELECT identity_key FROM catalog.player_identities WHERE player_id=$5)`;
}

const gameFactPlayers = {
  all: "",
  canonical: ` AND ${selectedStatPlayer(false)}`,
  source: ` AND ${selectedStatPlayer(true)}`,
  optionalRankingSource: " AND ($6::text IS NULL OR f.player_id=$6)",
};

function playerGameFactsFrom(
  kind: "batting" | "pitching",
  player: keyof typeof gameFactPlayers,
  joins = "",
  allowAllSeasons = false,
) {
  return `FROM analytics.current_player_game_${kind} f
    JOIN analytics.current_analysis_games r USING(game_id,revision)
    ${joins}
    WHERE ${allowAllSeasons ? OPTIONAL_SEASON_ANALYSIS_GAME_WHERE : ANALYSIS_GAME_WHERE}${gameFactPlayers[player]}`;
}

const battingTotalsSql = `count(DISTINCT game_id)::integer AS games,
    sum(plate_appearances)::integer AS "plateAppearances",sum(at_bats)::integer AS "atBats",
    sum(hits)::integer AS hits,sum(doubles)::integer AS doubles,sum(triples)::integer AS triples,
    sum(home_runs)::integer AS "homeRuns",sum(walks)::integer AS walks,
    sum(intentional_walks)::integer AS "intentionalWalks",sum(hit_by_pitch)::integer AS "hitByPitch",
    sum(strikeouts)::integer AS strikeouts,sum(sacrifice_flies)::integer AS "sacrificeFlies",
    sum(sacrifice_bunts)::integer AS "sacrificeBunts",sum(runs)::integer AS runs`;
const pitchingGameTotalsSql = `sum(batters_faced) AS bf,sum(outs_recorded) AS outs,sum(hits) AS hits,sum(runs) AS runs,
    sum(walks) AS walks,sum(intentional_walks) AS ibb,sum(hit_by_pitch) AS hbp,sum(strikeouts) AS so,
    sum(pitches) AS pitches,sum(strikes) AS strikes,
    CASE WHEN bool_and(official_earned_runs IS NOT NULL) THEN sum(official_earned_runs) ELSE NULL END AS er`;
const pitchingTotalsSql = `count(*)::integer AS games,sum(bf)::integer AS "battersFaced",sum(outs)::integer AS "outsRecorded",
    sum(hits)::integer AS hits,sum(runs)::integer AS runs,sum(walks)::integer AS walks,sum(ibb)::integer AS "intentionalWalks",
    sum(hbp)::integer AS "hitByPitch",sum(so)::integer AS strikeouts,sum(pitches)::integer AS pitches,sum(strikes)::integer AS strikes,
    count(er)::integer AS "knownErGames",COALESCE(sum(outs) FILTER(WHERE er IS NOT NULL),0)::integer AS "knownErOuts",
    COALESCE(sum(er),0)::integer AS "knownEarnedRuns"`;
const battingSql = `WITH selected AS (SELECT ${identity},f.*
  ${playerGameFactsFrom("batting", "optionalRankingSource", rankingJoins)})
  SELECT identity,"playerId",min(name COLLATE "C") AS name,"teamId",min("teamName" COLLATE "C") AS "teamName",
    ${battingTotalsSql}
  FROM selected GROUP BY identity,"playerId","teamId" ORDER BY identity COLLATE "C","teamId" COLLATE "C"`;
const pitchingSql = `WITH selected AS (SELECT ${identity},f.*
  ${playerGameFactsFrom("pitching", "optionalRankingSource", rankingJoins)}), per_game AS (
  SELECT identity,"playerId","teamId",game_id,min(name COLLATE "C") AS name,min("teamName" COLLATE "C") AS "teamName",
    ${pitchingGameTotalsSql}
  FROM selected GROUP BY identity,"playerId","teamId",game_id)
  SELECT identity,"playerId",min(name COLLATE "C") AS name,"teamId",min("teamName" COLLATE "C") AS "teamName",
    ${pitchingTotalsSql}
  FROM per_game GROUP BY identity,"playerId","teamId" ORDER BY identity COLLATE "C","teamId" COLLATE "C"`;

function playerSeasonSql(kind: "batting" | "pitching", bySource: boolean) {
  const totals =
    kind === "batting"
      ? `SELECT season,${battingTotalsSql} FROM selected GROUP BY season`
      : `SELECT season,${pitchingTotalsSql} FROM (
           SELECT season,${pitchingGameTotalsSql} FROM selected GROUP BY season,game_id
         ) per_game GROUP BY season`;
  return `WITH selected AS (
    SELECT f.*,r.season,r.game_date,t.team_id,t.team_name
    ${playerGameFactsFrom(kind, bySource ? "source" : "canonical", gameTeamJoin, true)}
  ), clubs AS (
    SELECT season,team_id,min(team_name COLLATE "C") AS name,min(game_date) AS first_date
    FROM selected GROUP BY season,team_id
  ), season_clubs AS (
    SELECT season,array_agg(name ORDER BY first_date,team_id COLLATE "C") AS teams
    FROM clubs GROUP BY season
  ), totals AS (${totals})
  SELECT totals.*,season_clubs.teams FROM totals JOIN season_clubs USING(season)
  ORDER BY season DESC`;
}

function playerGamesSql(role: PlayerGameRecordsQuery["role"], bySource: boolean) {
  const kind = role === "batter" ? "batting" : "pitching";
  const batting = `sum(plate_appearances)::integer AS "plateAppearances",sum(at_bats)::integer AS "atBats",
    sum(home_runs)::integer AS "homeRuns"`;
  const pitching = `sum(batters_faced)::integer AS "battersFaced",sum(outs_recorded)::integer AS "outsRecorded",
    sum(pitches)::integer AS pitches,
    CASE WHEN bool_and(official_earned_runs IS NOT NULL) THEN sum(official_earned_runs)::integer END AS "earnedRuns"`;
  return `SELECT f.game_id AS "gameId",f.revision,to_char(r.game_date,'YYYY-MM-DD') AS "gameDate",
      array_agg(DISTINCT t.team_name COLLATE "C" ORDER BY t.team_name COLLATE "C") AS teams,
      array_agg(DISTINCT opponent.team_name COLLATE "C" ORDER BY opponent.team_name COLLATE "C") AS opponents,
      CASE WHEN min(f.side)=max(f.side) THEN min(f.side) ELSE 'both' END AS side,
      sum(f.hits)::integer AS hits,sum(f.walks)::integer AS walks,
      sum(f.strikeouts)::integer AS strikeouts,sum(f.runs)::integer AS runs,
      ${role === "batter" ? batting : pitching}
    ${playerGameFactsFrom(
      kind,
      bySource ? "source" : "canonical",
      `${gameTeamJoin}
       JOIN workbench.game_team_snapshots opponent
         ON opponent.game_id=f.game_id AND opponent.revision=f.revision AND opponent.side<>f.side`,
    )}
    GROUP BY f.game_id,f.revision,r.game_date
    ORDER BY r.game_date DESC,f.game_id COLLATE "C" DESC`;
}

function leagueTotalsSql(role: PlayerGameRecordsQuery["role"], bySource: boolean | undefined) {
  const kind = role === "batter" ? "batting" : "pitching";
  const subject = bySource === undefined ? "all" : bySource ? "source" : "canonical";
  const selected = `SELECT f.* ${playerGameFactsFrom(kind, subject)}`;
  return role === "batter"
    ? `SELECT ${battingTotalsSql} FROM (${selected}) selected HAVING count(*)>0`
    : `WITH selected AS (${selected}), per_game AS (
      SELECT ${pitchingGameTotalsSql}
      FROM selected GROUP BY game_id${bySource === undefined ? ",side,player_identity_key" : ""}
    ) SELECT ${pitchingTotalsSql} FROM per_game HAVING count(*)>0`;
}

type LeagueTotals =
  typeof LeagueBattingTotalsSchema.static | typeof LeaguePitchingTotalsSchema.static;

async function readLeagueTotals(
  client: PoolClient,
  role: PlayerGameRecordsQuery["role"],
  scope: AnalysisScope,
): Promise<LeagueTotals | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    leagueTotalsSql(role, undefined),
    analysisScopeParameters(scope),
  );
  if (rows[0] === undefined) return null;
  return role === "batter"
    ? Value.Decode(LeagueBattingTotalsSchema, rows[0])
    : Value.Decode(LeaguePitchingTotalsSchema, rows[0]);
}

const splitAppearance = Type.Object(
  {
    gameId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    pitcherId: Type.String({ minLength: 1 }),
    opponentBattingSide: Type.Union([
      Type.Literal("L"),
      Type.Literal("R"),
      Type.Literal("S"),
      Type.Null(),
    ]),
    side: Type.Union([Type.Literal("home"), Type.Literal("away")]),
    scoringPosition: Type.Union([Type.Boolean(), Type.Null()]),
    result: PlateResultSchema,
    countsAsAtBat: Type.Boolean(),
    balls: Type.Union([Type.Integer({ minimum: 0, maximum: 3 }), Type.Null()]),
    strikes: Type.Union([Type.Integer({ minimum: 0, maximum: 2 }), Type.Null()]),
  },
  { additionalProperties: false },
);

function playerSplitSql({ role, source, split, countFor }: PlayerSplitQuery) {
  const hand = split === "hand";
  const batterHand = hand && role === "pitcher";
  const terminalPitch = batterHand || countFor !== undefined;
  const runners = split === "risp";
  const credited = role === "batter" ? "counts_as_plate_appearance" : "counts_as_batter_faced";
  const awayHalf = role === "batter" ? "top" : "bottom";
  return `WITH selected_pas AS (
    SELECT f.*,f.start_event_id AS pa_id FROM analytics.current_plate_appearances f
    JOIN analytics.current_analysis_games r USING(game_id,revision)
    WHERE ${ANALYSIS_GAME_WHERE} AND ${selectedStatPlayer(source !== undefined, role)}
      AND f.completed AND f.${credited}
  )${terminalPitch ? `, ${lastPitchesCteSql}` : ""}
  SELECT f.game_id AS "gameId",f.revision,
    ${hand ? "COALESCE(ending.before_pitcher_id,f.pitcher_id)" : "f.pitcher_id"} AS "pitcherId",
    ${batterHand ? effectiveBattingSideSql : "NULL"} AS "opponentBattingSide",
    CASE WHEN f.half='${awayHalf}' THEN 'away' ELSE 'home' END AS side,
    ${
      runners
        ? `CASE WHEN ending.applied THEN
      ending.before_base2_runner_id IS NOT NULL OR ending.before_base3_runner_id IS NOT NULL END`
        : "NULL"
    } AS "scoringPosition",
    f.result,f.counts_as_at_bat AS "countsAsAtBat",
    ${
      countFor === undefined
        ? "NULL AS balls,NULL AS strikes"
        : `
      CASE WHEN q.before_balls BETWEEN 0 AND 3 AND q.before_strikes BETWEEN 0 AND 2 THEN q.before_balls END AS balls,
      CASE WHEN q.before_balls BETWEEN 0 AND 3 AND q.before_strikes BETWEEN 0 AND 2 THEN q.before_strikes END AS strikes`
    }
  FROM selected_pas f
  ${terminalPitch ? "LEFT JOIN last_pitches q ON q.game_id=f.game_id AND q.revision=f.revision AND q.plate_appearance_event_id=f.pa_id" : ""}
  ${
    runners || hand
      ? `LEFT JOIN baseball.play_events e ON e.game_id=f.game_id AND e.revision=f.revision AND e.event_id=f.end_event_id
  LEFT JOIN baseball.play_facts ending ON ending.game_id=e.game_id AND ending.revision=e.revision AND ending.play_sequence=e.play_sequence`
      : ""
  }
  ${
    batterHand
      ? `LEFT JOIN baseball.pitch_tracking_links l
    ON l.game_id=q.game_id AND l.revision=q.revision AND l.pitch_id=q.pitch_id
    AND q.batter_id=COALESCE(ending.before_batter_id,f.batter_id)
  LEFT JOIN workbench.tracking_observations t
    ON t.game_id=l.game_id AND t.revision=l.revision AND t.tracking_id=l.tracking_id
  LEFT JOIN analytics.game_batter_profiles profile ON profile.game_id=f.game_id AND profile.revision=f.revision
    AND profile.player_id=COALESCE(ending.before_batter_id,f.batter_id)`
      : ""
  }
  ORDER BY f.game_id COLLATE "C",f.plate_appearance_index`;
}

export class PlayerStatisticsRepository {
  private readonly leagueReferences = new Map<string, Promise<LeagueTotals | null>>();
  public constructor(private readonly pool: Pool) {}
  public async batting(input: BattingStatisticsQuery): Promise<BattingStatisticsResponse> {
    return (await this.battingWithManifest(input)).response;
  }
  public async pitching(input: PitchingStatisticsQuery): Promise<PitchingStatisticsResponse> {
    return (await this.pitchingWithManifest(input)).response;
  }
  public async playerGames(input: PlayerGameRecordsQuery): Promise<PlayerGameRecordsResponse> {
    const query = Value.Decode(PlayerGameRecordsQuerySchema, input);
    const { player, source, role, ...options } = query;
    const scope = resolveAnalysisScope(options);
    const { rows } = await withAnalysisSnapshot(this.pool, (client) =>
      client.query<Record<string, unknown>>(playerGamesSql(role, source !== undefined), [
        ...analysisScopeParameters(scope),
        player,
      ]),
    );
    return role === "batter"
      ? { query, scope, role, rows: Value.Decode(Type.Array(PlayerGameBattingRowSchema), rows) }
      : { query, scope, role, rows: Value.Decode(Type.Array(PlayerGamePitchingRowSchema), rows) };
  }
  public async playerLeague(input: PlayerGameRecordsQuery): Promise<PlayerLeagueResponse> {
    const query = Value.Decode(PlayerGameRecordsQuerySchema, input);
    const { player, source, role, ...options } = query;
    const scope = resolveAnalysisScope(options);
    const parameters = analysisScopeParameters(scope);
    const { playerTotals, leagueTotals } = await withAnalysisSnapshot(this.pool, async (client) => {
      const manifest = await analysisSourceHash(client, scope);
      const playerTotals = (
        await client.query<Record<string, unknown>>(leagueTotalsSql(role, source !== undefined), [
          ...parameters,
          player,
        ])
      ).rows[0];
      const key = `${role}:${manifest}`;
      let reference = this.leagueReferences.get(key);
      if (reference === undefined) {
        reference = readLeagueTotals(client, role, scope);
        this.leagueReferences.set(key, reference);
        if (this.leagueReferences.size > 32) {
          const oldest = this.leagueReferences.keys().next().value;
          if (oldest !== undefined) this.leagueReferences.delete(oldest);
        }
      }
      try {
        return { playerTotals, leagueTotals: await reference };
      } catch (error) {
        if (this.leagueReferences.get(key) === reference) this.leagueReferences.delete(key);
        throw error;
      }
    });
    if (role === "batter") {
      return {
        query,
        scope,
        role,
        player: playerTotals
          ? battingStatistics(Value.Decode(LeagueBattingTotalsSchema, playerTotals))
          : null,
        league: leagueTotals
          ? battingStatistics(Value.Decode(LeagueBattingTotalsSchema, leagueTotals))
          : null,
      };
    }
    return {
      query,
      scope,
      role,
      player: playerTotals
        ? pitchingStatistics(Value.Decode(LeaguePitchingTotalsSchema, playerTotals))
        : null,
      league: leagueTotals
        ? pitchingStatistics(Value.Decode(LeaguePitchingTotalsSchema, leagueTotals))
        : null,
    };
  }
  public async playerSplits(
    input: PlayerSplitQuery,
    resolveHand: ResolvePitcherHand,
  ): Promise<PlayerSplitResponse> {
    const query = Value.Decode(PlayerSplitQuerySchema, input);
    const { player, role, split, source, countFor, ...options } = query;
    void source;
    const buckets: readonly PlayerSplitBucket[] = playerSplitBuckets[split];
    if (countFor !== undefined && !buckets.includes(countFor))
      throw new InvalidAnalysisScopeError("카운트별로 볼 상황을 현재 비교 기준에서 선택하세요.");
    const scope = resolveAnalysisScope(options);
    const appearances = await withAnalysisSnapshot(this.pool, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(playerSplitSql(query), [
        ...analysisScopeParameters(scope),
        player,
      ]);
      const captured = Value.Decode(Type.Array(splitAppearance), rows);
      const handFor =
        split === "hand" && role === "batter"
          ? await readGamePitcherHands(client, captured, resolveHand)
          : undefined;
      return captured.map((row) => {
        const hand = role === "batter" ? handFor?.(row) : row.opponentBattingSide;
        let bucket: PlayerSplitBucket = "unknown";
        if (split === "venue") bucket = row.side;
        if (split === "hand" && (hand === "L" || hand === "R")) bucket = hand;
        if (split === "risp" && row.scoringPosition !== null)
          bucket = row.scoringPosition ? "risp" : "no-risp";
        return {
          result: row.result,
          countsAsAtBat: row.countsAsAtBat,
          bucket,
          balls: row.balls,
          strikes: row.strikes,
        };
      });
    });
    const rows = summarizePlayerSplits(buckets, appearances);
    if (countFor === undefined) return { query, scope, rows };
    const groups = new Map<number, typeof appearances>();
    for (const appearance of appearances) {
      if (appearance.bucket !== countFor) continue;
      const key =
        appearance.balls === null || appearance.strikes === null
          ? 12
          : appearance.balls * 3 + appearance.strikes;
      const group = groups.get(key);
      if (group) group.push(appearance);
      else groups.set(key, [appearance]);
    }
    const byCount = [...groups]
      .sort(([a], [b]) => a - b)
      .map(([key, group]) => ({
        count: key === 12 ? null : { balls: Math.floor(key / 3), strikes: key % 3 },
        ...summarizeBattingResults(group),
      }));
    return { query, scope, rows, byCount };
  }
  public async playerSeasons(
    input: PlayerSeasonStatisticsQuery,
  ): Promise<PlayerSeasonStatisticsResponse> {
    const query = Value.Decode(PlayerSeasonStatisticsQuerySchema, input);
    const { player, sourceRole, season, ...options } = query;
    if (season === undefined && (options.dateFrom !== undefined || options.dateTo !== undefined))
      throw new InvalidAnalysisScopeError("기간을 지정하려면 시즌을 함께 지정해야 합니다.");
    const scope = season === undefined ? null : resolveAnalysisScope({ season, ...options });
    const parameters = [
      scope?.season ?? null,
      options.competition ?? defaultAnalysisCompetition,
      scope?.dateFrom ?? null,
      scope?.dateTo ?? null,
      player,
    ];
    const bySource = sourceRole !== undefined;
    const { batting, pitching } = await withAnalysisSnapshot(this.pool, async (client) => ({
      batting:
        sourceRole === "pitcher"
          ? []
          : (
              await client.query<Record<string, unknown>>(
                playerSeasonSql("batting", bySource),
                parameters,
              )
            ).rows,
      pitching:
        sourceRole === "batter"
          ? []
          : (
              await client.query<Record<string, unknown>>(
                playerSeasonSql("pitching", bySource),
                parameters,
              )
            ).rows,
    }));
    return {
      query,
      batting: Value.Decode(Type.Array(PlayerSeasonBattingTotalsSchema), batting).map((row) =>
        battingStatistics(row),
      ),
      pitching: Value.Decode(Type.Array(PlayerSeasonPitchingTotalsSchema), pitching).map((row) =>
        pitchingStatistics(row),
      ),
    };
  }
  public readSourceHash(input: AnalysisScopeQuery) {
    return analysisSourceHash(this.pool, resolveAnalysisScope(input, "regular"));
  }
  public async battingWithManifest(input: BattingStatisticsQuery) {
    const query = Value.Decode(BattingStatisticsQuerySchema, input);
    return this.battingResponse(query, await this.read(query, battingSql));
  }
  public async pitchingWithManifest(input: PitchingStatisticsQuery) {
    const query = Value.Decode(PitchingStatisticsQuerySchema, input);
    return this.pitchingResponse(query, await this.read(query, pitchingSql));
  }
  public async compareBatting(
    first: AnalysisScopeQuery,
    second: AnalysisScopeQuery,
    playerId: string,
  ) {
    const common = { playerId, group: "player" as const, limit: 200, page: 1 };
    const a = Value.Decode(BattingStatisticsQuerySchema, { ...first, ...common });
    const b = Value.Decode(BattingStatisticsQuerySchema, { ...second, ...common });
    const rows = await this.compareRows(first, second, battingSql, playerId);
    return {
      first: this.battingResponse(a, rows.first),
      second: this.battingResponse(b, rows.second),
    };
  }
  public async comparePitching(
    first: AnalysisScopeQuery,
    second: AnalysisScopeQuery,
    playerId: string,
  ) {
    const common = { playerId, group: "player" as const, limit: 200, page: 1 };
    const a = Value.Decode(PitchingStatisticsQuerySchema, { ...first, ...common });
    const b = Value.Decode(PitchingStatisticsQuerySchema, { ...second, ...common });
    const rows = await this.compareRows(first, second, pitchingSql, playerId);
    return {
      first: this.pitchingResponse(a, rows.first),
      second: this.pitchingResponse(b, rows.second),
    };
  }
  private compareRows(
    first: AnalysisScopeQuery,
    second: AnalysisScopeQuery,
    sql: string,
    playerId: string,
  ) {
    return readAnalysisPeriods(
      this.pool,
      resolveAnalysisScope(first, "regular"),
      resolveAnalysisScope(second, "regular"),
      async (snapshot, scope) => {
        const rows = await this.readRows(snapshot, scope, "player", sql, playerId);
        return { first: rows, second: rows };
      },
    );
  }
  private battingResponse(
    query: BattingStatisticsQuery,
    { manifest, ...snapshot }: Awaited<ReturnType<PlayerStatisticsRepository["readRows"]>>,
  ) {
    const { group = "player", sort = "ops", minPA = 0, page = 1, limit = 50 } = query;
    const rows = Value.Decode(Type.Array(BattingStatisticsTotalsSchema), snapshot.rows)
      .map(battingStatistics)
      .filter((r) => r.plateAppearances >= minPA);
    rows.sort((a, b) => compareMetric(a[sort], b[sort], false) || compareIdentity(a, b));
    const response = Value.Decode(BattingStatisticsResponseSchema, {
      kind: "batting",
      query,
      ...snapshot,
      rows: rows.slice((page - 1) * limit, page * limit),
      group,
      total: rows.length,
      page,
      limit,
    });
    return { sourceHash: manifest, response };
  }
  private pitchingResponse(
    query: PitchingStatisticsQuery,
    { manifest, ...snapshot }: Awaited<ReturnType<PlayerStatisticsRepository["readRows"]>>,
  ) {
    const { group = "player", sort = "kMinusBbRate", minBF = 0, page = 1, limit = 50 } = query;
    const rows = Value.Decode(Type.Array(PitchingStatisticsTotalsSchema), snapshot.rows)
      .map(pitchingStatistics)
      .filter((r) => r.battersFaced >= minBF);
    rows.sort((a, b) => compareMetric(a[sort], b[sort], sort === "era") || compareIdentity(a, b));
    const response = Value.Decode(PitchingStatisticsResponseSchema, {
      kind: "pitching",
      query,
      ...snapshot,
      rows: rows.slice((page - 1) * limit, page * limit),
      group,
      total: rows.length,
      page,
      limit,
    });
    return { sourceHash: manifest, response };
  }
  private read(input: BattingStatisticsQuery | PitchingStatisticsQuery, sql: string) {
    const { group = "player", playerId, season, competition, dateFrom, dateTo } = input;
    if (group === "team" && playerId !== undefined)
      throw new InvalidAnalysisScopeError("팀 합계 조회에는 선수 조건을 함께 사용할 수 없습니다.");
    const scope = resolveAnalysisScope(
      {
        season,
        ...(competition === undefined ? {} : { competition }),
        ...(dateFrom === undefined ? {} : { dateFrom }),
        ...(dateTo === undefined ? {} : { dateTo }),
      },
      "regular",
    );
    return withAnalysisReadSnapshot(this.pool, (snapshot) =>
      this.readRows(snapshot, scope, group, sql, playerId),
    );
  }
  private async readRows(
    snapshot: AnalysisReadSnapshot,
    scope: AnalysisScope,
    group: "player" | "team",
    sql: string,
    playerId: string | undefined,
  ) {
    const manifest = await snapshot.sourceHash(scope);
    const result = await snapshot.client.query<Record<string, unknown>>(sql, [
      ...analysisScopeParameters(scope),
      group,
      playerId ?? null,
    ]);
    const sourceHash = createHash("sha256")
      .update(
        canonicalStringify({
          version: 1,
          manifest,
          group,
          ...(playerId === undefined ? {} : { playerId }),
          rows: result.rows,
        }),
      )
      .digest("hex");
    await snapshot.release();
    return { scope, sourceHash, rows: result.rows, manifest };
  }
}
function compareMetric(a: number | null, b: number | null, ascending: boolean) {
  return a === b ? 0 : a === null ? 1 : b === null ? -1 : ascending ? a - b : b - a;
}
function compareIdentity(
  a: { identity: string; teamId: string },
  b: { identity: string; teamId: string },
) {
  const x = canonicalStringify([a.identity, a.teamId]),
    y = canonicalStringify([b.identity, b.teamId]);
  return x < y ? -1 : x > y ? 1 : 0;
}
