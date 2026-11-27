import {
  DatabaseGameCatalogItemSchema,
  DatabaseGamesSchema,
  type DatabaseGames,
  type DatabaseGamesQuery,
  type GameCatalogItem,
} from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";

type CatalogPool = Pick<Pool, "query">;

const catalogGames = `SELECT r.game_id,r.revision,r.season,r.game_date,
  COALESCE(r.sealed_at,r.created_at) AS updated_at,
  away.team_id AS away_id,away.team_name AS away_name,
  home.team_id AS home_id,home.team_name AS home_name
  FROM analytics.current_game_revisions r
  JOIN workbench.game_team_snapshots away
    ON away.game_id=r.game_id AND away.revision=r.revision AND away.side='away'
  JOIN workbench.game_team_snapshots home
    ON home.game_id=r.game_id AND home.revision=r.revision AND home.side='home'`;
const validationJoin = `JOIN workbench.validation_runs v
  ON v.game_id=g.game_id AND v.revision=g.revision`;
const catalogColumns = `g.game_id AS "gameId",g.season,'database' AS authority,
  to_char(g.game_date,'YYYY-MM-DD') AS "gameDate",g.revision AS "currentRevision",
  c.revision_count AS "revisionCount",
  to_char(g.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  0 AS "blockingFindings",g.warning_count AS "warningFindings",
  g.away_id AS "awayTeamId",g.away_name AS "awayName",g.home_id AS "homeTeamId",g.home_name AS "homeName"`;
const catalogRowsSchema = Type.Array(DatabaseGameCatalogItemSchema);
const seasonRows = Type.Array(
  Type.Object(
    { season: Type.Integer({ minimum: 1982, maximum: 9999 }) },
    { additionalProperties: false },
  ),
);
const totalSchema = Type.Integer({ minimum: 0 });

function decodeCatalogRows(rows: readonly Record<string, unknown>[]) {
  return Value.Decode(
    catalogRowsSchema,
    rows.map((row) => {
      const { awayTeamId, awayName, homeTeamId, homeName, ...game } = row;
      return {
        ...game,
        teams: {
          away: { teamId: awayTeamId, name: awayName },
          home: { teamId: homeTeamId, name: homeName },
        },
      };
    }),
  );
}

export async function readStoredGameIds(pool: CatalogPool): Promise<string[]> {
  const result = await pool.query(
    'SELECT game_id AS "gameId" FROM analytics.current_game_revisions ORDER BY game_id',
  );
  return Value.Decode(
    Type.Array(
      Type.Object({ gameId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ),
    result.rows,
  ).map((row) => row.gameId);
}

export async function readDatabaseSeasons(pool: CatalogPool): Promise<number[]> {
  const result = await pool.query(
    "SELECT DISTINCT season FROM analytics.current_game_revisions ORDER BY season DESC",
  );
  return Value.Decode(seasonRows, result.rows).map((row) => row.season);
}

export async function readDatabaseCatalog(
  pool: CatalogPool,
  gameIds?: readonly string[],
): Promise<readonly GameCatalogItem[]> {
  if (gameIds?.length === 0) return [];
  const { rows } = await pool.query<Record<string, unknown>>(
    `WITH candidates AS (
      ${catalogGames} WHERE ($1::text[] IS NULL OR r.game_id=ANY($1::text[]))
    ), validated AS (
      SELECT g.*,v.warning_count FROM candidates g ${validationJoin}
    ), revision_counts AS (
      SELECT game_id,count(*)::integer AS revision_count FROM workbench.game_revisions
      WHERE sealed AND ($1::text[] IS NULL OR game_id=ANY($1::text[])) GROUP BY game_id
    )
    SELECT ${catalogColumns} FROM validated g JOIN revision_counts c USING (game_id)
    ORDER BY g.game_date DESC,g.game_id DESC`,
    [gameIds ?? null],
  );
  return decodeCatalogRows(rows);
}

export async function readDatabaseCatalogPage(
  pool: CatalogPool,
  query: DatabaseGamesQuery,
): Promise<DatabaseGames> {
  const page = query.page ?? 1,
    limit = query.limit ?? 50;
  const [result, seasons] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `WITH candidates AS (
        ${catalogGames}
        WHERE ($1::integer IS NULL OR r.season=$1)
          AND strpos(lower(concat(r.game_id,' ',r.game_date::text,' ',away.team_name,' ',home.team_name)),lower($2::text))>0
      ), selected_page AS (
        SELECT g.*,v.warning_count FROM candidates g ${validationJoin}
        ORDER BY g.game_date DESC,g.game_id COLLATE "C" ASC LIMIT $3 OFFSET $4
      ), totals AS (
        SELECT count(*)::integer AS total FROM candidates
      )
      SELECT totals.total,${catalogColumns} FROM totals
      LEFT JOIN selected_page g ON TRUE
      LEFT JOIN LATERAL (
        SELECT count(*)::integer AS revision_count FROM workbench.game_revisions
        WHERE game_id=g.game_id AND sealed
      ) c ON TRUE
      ORDER BY g.game_date DESC,g.game_id COLLATE "C" ASC`,
      [query.season ?? null, (query.search ?? "").trim(), limit, (page - 1) * limit],
    ),
    readDatabaseSeasons(pool),
  ]);
  // The total includes candidates with both teams, while a displayed row also needs validation.
  const rows = result.rows.flatMap(({ total, ...game }) => {
    void total;
    return game.gameId === null ? [] : [game];
  });
  return Value.Decode(DatabaseGamesSchema, {
    games: decodeCatalogRows(rows),
    total: Value.Decode(totalSchema, result.rows[0]?.total),
    page,
    limit,
    seasons,
  });
}
