import {
  DatabaseGameCatalogItemSchema,
  DatabaseGamesSchema,
  ReplayCatalogCalendarSchema,
  ReplayCatalogPageSchema,
  type DatabaseGames,
  type DatabaseGamesQuery,
  type GameCatalogItem,
  type ReplayCatalogQuery,
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
const replayGameOrder = `date_trunc('milliseconds',g.updated_at) DESC,g.game_date DESC,g.game_id DESC`;
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

export async function readStoredGameCounts(pool: CatalogPool, candidates: readonly string[]) {
  const result = await pool.query<{ stored: number; alreadyStored: number }>(
    `SELECT count(*)::integer AS stored,
       count(*) FILTER (WHERE game_id = ANY($1::text[]))::integer AS "alreadyStored"
     FROM analytics.current_game_revisions`,
    [candidates],
  );
  const counts = result.rows[0];
  if (counts === undefined) throw new Error("Stored game counts are missing");
  return counts;
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
  const { rows } = await pool.query<Record<string, unknown>>(
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
      SELECT totals.total,${catalogColumns}, ARRAY(
        SELECT DISTINCT season FROM analytics.current_game_revisions ORDER BY season DESC
      ) AS seasons FROM totals
      LEFT JOIN selected_page g ON TRUE
      LEFT JOIN LATERAL (
        SELECT count(*)::integer AS revision_count FROM workbench.game_revisions
        WHERE game_id=g.game_id AND sealed
      ) c ON TRUE
      ORDER BY g.game_date DESC,g.game_id COLLATE "C" ASC`,
    [query.season ?? null, (query.search ?? "").trim(), limit, (page - 1) * limit],
  );
  // The total includes candidates with both teams, while a displayed row also needs validation.
  const games = rows.flatMap(({ total, seasons, ...game }) => {
    void total;
    void seasons;
    return game.gameId === null ? [] : [game];
  });
  return Value.Decode(DatabaseGamesSchema, {
    games: decodeCatalogRows(games),
    total: Value.Decode(totalSchema, rows[0]?.total),
    page,
    limit,
    seasons: rows[0]?.seasons,
  });
}

export async function readReplayCatalogPage(pool: CatalogPool, query: ReplayCatalogQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const { rows } = await pool.query<Record<string, unknown>>(
    `WITH catalog AS NOT MATERIALIZED (
      SELECT g.*,v.warning_count FROM (${catalogGames}) g ${validationJoin}
    ), filtered AS (
      SELECT g.* FROM catalog g
      WHERE ($1::integer IS NULL OR g.season=$1)
        AND ($2::date IS NULL OR g.game_date=$2)
        AND ($3='' OR EXISTS (
          SELECT 1 FROM unnest(ARRAY[g.game_id,g.season::text,to_char(g.game_date,'YYYY-MM-DD'),
            g.away_name,g.home_name]) field
          WHERE strpos(lower(field COLLATE "ko-x-icu"),$3)>0
        ))
    ), page AS (
      SELECT g.*,false AS selected FROM filtered g
      ORDER BY ${replayGameOrder} LIMIT $4 OFFSET $5
    ), selected AS (
      SELECT g.*,true AS selected FROM catalog g
      WHERE $6::text IS NULL OR g.game_id=$6
      ORDER BY ${replayGameOrder} LIMIT 1
    ), totals AS (
      SELECT count(*)::integer AS total FROM filtered
    )
    SELECT totals.total,g.selected,${catalogColumns}
    FROM totals LEFT JOIN (SELECT * FROM page UNION ALL SELECT * FROM selected) g ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS revision_count FROM workbench.game_revisions
      WHERE game_id=g.game_id AND sealed
    ) c ON TRUE
    ORDER BY g.selected,${replayGameOrder}`,
    [
      query.season ?? null,
      query.gameDate ?? null,
      (query.search ?? "").trim().toLocaleLowerCase("ko-KR"),
      limit,
      (page - 1) * limit,
      query.selectedGameId ?? null,
    ],
  );
  const games: Record<string, unknown>[] = [];
  const selection: Record<string, unknown>[] = [];
  for (const { total, selected, ...game } of rows) {
    void total;
    if (game.gameId === null) continue;
    (selected === true ? selection : games).push(game);
  }
  return Value.Decode(ReplayCatalogPageSchema, {
    games: decodeCatalogRows(games),
    selectedGame: decodeCatalogRows(selection)[0] ?? null,
    total: rows[0]?.total,
    page,
    limit,
  });
}

export async function readReplayCatalogCalendar(pool: CatalogPool) {
  const { rows } = await pool.query(
    `SELECT g.season,to_char(g.game_date,'YYYY-MM-DD') AS "gameDate",count(*)::integer AS count
     FROM (${catalogGames}) g ${validationJoin}
     GROUP BY g.season,g.game_date ORDER BY g.season DESC,g.game_date`,
  );
  return Value.Decode(ReplayCatalogCalendarSchema, rows);
}
