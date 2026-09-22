import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";
import {
  canonicalStringify,
  resolveAnalysisScope,
  BattingStatisticsQuerySchema,
  PitchingStatisticsQuerySchema,
  BattingStatisticsTotalsSchema,
  PitchingStatisticsTotalsSchema,
  BattingStatisticsResponseSchema,
  PitchingStatisticsResponseSchema,
  type BattingStatisticsQuery,
  type PitchingStatisticsQuery,
  type BattingStatisticsResponse,
  type PitchingStatisticsResponse,
} from "@kbo/contracts";
import { battingStatistics, pitchingStatistics } from "@kbo/game-core";
import {
  ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";

// Team affiliation is the game snapshot. Player rows deliberately remain separated by that team.
const identity = `CASE WHEN $5='player' THEN f.player_identity_key ELSE t.team_identity_key END AS identity,
  CASE WHEN $5='player' THEN f.player_id ELSE NULL END AS "playerId",
  CASE WHEN $5='player' THEN COALESCE(roster.name,f.player_id) ELSE t.team_name END AS name,
  t.team_id AS "teamId",t.team_name AS "teamName"`;
const joins = `JOIN analytics.current_analysis_games r USING(game_id,revision)
  JOIN workbench.game_team_snapshots t ON t.game_id=f.game_id AND t.revision=f.revision AND t.side=f.side
  LEFT JOIN LATERAL(SELECT min(player_name COLLATE "C") AS name FROM workbench.game_roster_snapshots s
    WHERE s.game_id=f.game_id AND s.revision=f.revision AND s.side=f.side AND s.player_id=f.player_id) roster ON TRUE`;
const battingSql = `WITH selected AS (SELECT ${identity},f.* FROM analytics.current_player_game_batting f ${joins}
  WHERE ${ANALYSIS_GAME_WHERE})
  SELECT identity,"playerId",min(name COLLATE "C") AS name,"teamId",min("teamName" COLLATE "C") AS "teamName",
    count(DISTINCT game_id)::integer AS games,
    sum(plate_appearances)::integer AS "plateAppearances",sum(at_bats)::integer AS "atBats",
    sum(hits)::integer AS hits,sum(doubles)::integer AS doubles,sum(triples)::integer AS triples,
    sum(home_runs)::integer AS "homeRuns",sum(walks)::integer AS walks,
    sum(intentional_walks)::integer AS "intentionalWalks",sum(hit_by_pitch)::integer AS "hitByPitch",
    sum(strikeouts)::integer AS strikeouts,sum(sacrifice_flies)::integer AS "sacrificeFlies",
    sum(sacrifice_bunts)::integer AS "sacrificeBunts",sum(runs)::integer AS runs
  FROM selected GROUP BY identity,"playerId","teamId" ORDER BY identity COLLATE "C","teamId" COLLATE "C"`;
const pitchingSql = `WITH selected AS (SELECT ${identity},f.* FROM analytics.current_player_game_pitching f ${joins}
  WHERE ${ANALYSIS_GAME_WHERE}), per_game AS (
  SELECT identity,"playerId","teamId",game_id,min(name COLLATE "C") AS name,min("teamName" COLLATE "C") AS "teamName",
    sum(batters_faced) AS bf,sum(outs_recorded) AS outs,sum(hits) AS hits,sum(runs) AS runs,
    sum(walks) AS walks,sum(intentional_walks) AS ibb,sum(hit_by_pitch) AS hbp,sum(strikeouts) AS so,
    sum(pitches) AS pitches,sum(strikes) AS strikes,
    CASE WHEN bool_and(official_earned_runs IS NOT NULL) THEN sum(official_earned_runs) ELSE NULL END AS er
  FROM selected GROUP BY identity,"playerId","teamId",game_id)
  SELECT identity,"playerId",min(name COLLATE "C") AS name,"teamId",min("teamName" COLLATE "C") AS "teamName",
    count(*)::integer AS games,sum(bf)::integer AS "battersFaced",sum(outs)::integer AS "outsRecorded",
    sum(hits)::integer AS hits,sum(runs)::integer AS runs,sum(walks)::integer AS walks,sum(ibb)::integer AS "intentionalWalks",
    sum(hbp)::integer AS "hitByPitch",sum(so)::integer AS strikeouts,sum(pitches)::integer AS pitches,sum(strikes)::integer AS strikes,
    count(er)::integer AS "knownErGames",COALESCE(sum(outs) FILTER(WHERE er IS NOT NULL),0)::integer AS "knownErOuts",
    COALESCE(sum(er),0)::integer AS "knownEarnedRuns"
  FROM per_game GROUP BY identity,"playerId","teamId" ORDER BY identity COLLATE "C","teamId" COLLATE "C"`;

export class PlayerStatisticsRepository {
  public constructor(private readonly pool: Pool) {}
  public async batting(input: BattingStatisticsQuery): Promise<BattingStatisticsResponse> {
    const query = Value.Decode(BattingStatisticsQuerySchema, input);
    const {
      group = "player",
      sort = "ops",
      minPA = 0,
      page = 1,
      limit = 50,
      ...scopeInput
    } = query;
    const snapshot = await this.read(scopeInput, group, battingSql);
    const rows = Value.Decode(Type.Array(BattingStatisticsTotalsSchema), snapshot.rows)
      .map(battingStatistics)
      .filter((r) => r.plateAppearances >= minPA);
    rows.sort((a, b) => compareMetric(a[sort], b[sort], false) || compareIdentity(a, b));
    return Value.Decode(BattingStatisticsResponseSchema, {
      kind: "batting",
      query,
      ...snapshot,
      rows: rows.slice((page - 1) * limit, page * limit),
      group,
      total: rows.length,
      page,
      limit,
    });
  }
  public async pitching(input: PitchingStatisticsQuery): Promise<PitchingStatisticsResponse> {
    const query = Value.Decode(PitchingStatisticsQuerySchema, input);
    const {
      group = "player",
      sort = "kMinusBbRate",
      minBF = 0,
      page = 1,
      limit = 50,
      ...scopeInput
    } = query;
    const snapshot = await this.read(scopeInput, group, pitchingSql);
    const rows = Value.Decode(Type.Array(PitchingStatisticsTotalsSchema), snapshot.rows)
      .map(pitchingStatistics)
      .filter((r) => r.battersFaced >= minBF);
    rows.sort((a, b) => compareMetric(a[sort], b[sort], sort === "era") || compareIdentity(a, b));
    return Value.Decode(PitchingStatisticsResponseSchema, {
      kind: "pitching",
      query,
      ...snapshot,
      rows: rows.slice((page - 1) * limit, page * limit),
      group,
      total: rows.length,
      page,
      limit,
    });
  }
  private async read(
    input: Parameters<typeof resolveAnalysisScope>[0],
    group: "player" | "team",
    sql: string,
  ) {
    const scope = resolveAnalysisScope(input, "regular");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const manifest = await analysisSourceHash(client, scope);
      const result = await client.query<Record<string, unknown>>(sql, [
        ...analysisScopeParameters(scope),
        group,
      ]);
      const sourceHash = createHash("sha256")
        .update(canonicalStringify({ version: 1, manifest, group, rows: result.rows }))
        .digest("hex");
      await client.query("COMMIT");
      return { scope, sourceHash, rows: result.rows };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
