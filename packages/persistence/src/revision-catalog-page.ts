import { DatabaseGamesSchema, type DatabaseGames, type DatabaseGamesQuery } from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";

const from = `FROM analytics.current_game_revisions r
 JOIN workbench.game_team_snapshots away ON away.game_id=r.game_id AND away.revision=r.revision AND away.side='away'
 JOIN workbench.game_team_snapshots home ON home.game_id=r.game_id AND home.revision=r.revision AND home.side='home'`;
const where = `WHERE ($1::integer IS NULL OR r.season=$1)
 AND strpos(lower(concat(r.game_id,' ',r.game_date::text,' ',away.team_name,' ',home.team_name)),lower($2::text))>0`;
const seasonRows = Type.Array(
  Type.Object(
    { season: Type.Integer({ minimum: 1982, maximum: 9999 }) },
    { additionalProperties: false },
  ),
);
const countRows = Type.Tuple([
  Type.Object({ total: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
]);

export async function readDatabaseSeasons(pool: Pick<Pool, "query">): Promise<number[]> {
  const result = await pool.query(
    "SELECT DISTINCT season FROM analytics.current_game_revisions ORDER BY season DESC",
  );
  return Value.Decode(seasonRows, result.rows).map((row) => row.season);
}

export async function readDatabaseCatalogPage(
  pool: Pick<Pool, "query">,
  query: DatabaseGamesQuery,
): Promise<DatabaseGames> {
  const page = query.page ?? 1,
    limit = query.limit ?? 50;
  const filters = [query.season ?? null, (query.search ?? "").trim()];
  const [rows, counts, seasons] = await Promise.all([
    pool.query(
      `SELECT r.game_id AS "gameId", r.season, 'database' AS authority,
      r.game_date::text AS "gameDate", r.revision AS "currentRevision",
      (SELECT count(*)::integer FROM workbench.game_revisions revisions WHERE revisions.game_id=r.game_id AND revisions.sealed) AS "revisionCount",
      to_char(COALESCE(r.sealed_at,r.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
      0 AS "blockingFindings", v.warning_count AS "warningFindings",
      away.team_id AS "awayTeamId", away.team_name AS "awayName", home.team_id AS "homeTeamId", home.team_name AS "homeName"
      ${from} JOIN workbench.validation_runs v ON v.game_id=r.game_id AND v.revision=r.revision
      ${where} ORDER BY r.game_date DESC, r.game_id COLLATE "C" ASC LIMIT $3 OFFSET $4`,
      [...filters, limit, (page - 1) * limit],
    ),
    pool.query(`SELECT count(*)::integer AS total ${from} ${where}`, filters),
    readDatabaseSeasons(pool),
  ]);
  // Decode after shaping the relational team columns; no unverified DB object leaves this boundary.
  const games = rows.rows.map((row: Record<string, unknown>) => {
    const { awayTeamId, awayName, homeTeamId, homeName, ...game } = row;
    return {
      ...game,
      teams: {
        away: { teamId: awayTeamId, name: awayName },
        home: { teamId: homeTeamId, name: homeName },
      },
    };
  });
  return Value.Decode(DatabaseGamesSchema, {
    games,
    total: Value.Decode(countRows, counts.rows)[0].total,
    page,
    limit,
    seasons,
  });
}
