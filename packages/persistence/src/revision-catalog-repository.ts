import type { GameCatalogItem } from "@kbo/contracts";
import type { Pool, QueryResultRow } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

type CatalogPool = Pick<Pool, "query">;

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

export async function readDatabaseCatalog(
  pool: CatalogPool,
  gameIds?: readonly string[],
): Promise<readonly GameCatalogItem[]> {
  if (gameIds?.length === 0) return [];
  const result = await pool.query<
    QueryResultRow & {
      readonly game_id: string;
      readonly season: number;
      readonly game_date: Date | string;
      readonly current_revision: number;
      readonly revision_count: number;
      readonly away_team_id: string;
      readonly away_team_name: string;
      readonly home_team_id: string;
      readonly home_team_name: string;
      readonly updated_at: Date | string;
      readonly warning_count: number;
    }
  >(
    `SELECT r.game_id, r.season, r.game_date, r.revision AS current_revision,
            revisions.revision_count,
            away.team_id AS away_team_id, away.team_name AS away_team_name,
            home.team_id AS home_team_id, home.team_name AS home_team_name,
            COALESCE(r.sealed_at,r.created_at) updated_at, v.warning_count
     FROM analytics.current_game_revisions r
     JOIN workbench.validation_runs v USING (game_id,revision)
     JOIN workbench.game_team_snapshots away
       ON away.game_id=r.game_id AND away.revision=r.revision AND away.side='away'
     JOIN workbench.game_team_snapshots home
       ON home.game_id=r.game_id AND home.revision=r.revision AND home.side='home'
     JOIN (
       SELECT game_id, COUNT(*)::integer AS revision_count
       FROM workbench.game_revisions
       WHERE sealed
       GROUP BY game_id
     ) revisions ON revisions.game_id=r.game_id
     WHERE ($1::text[] IS NULL OR r.game_id=ANY($1::text[]))
     ORDER BY r.game_date DESC, r.game_id DESC`,
    [gameIds ?? null],
  );
  return result.rows.map((row) => ({
    gameId: row.game_id,
    season: row.season,
    authority: "database",
    gameDate: dateText(row.game_date),
    teams: {
      away: { teamId: row.away_team_id, name: row.away_team_name },
      home: { teamId: row.home_team_id, name: row.home_team_name },
    },
    currentRevision: row.current_revision,
    revisionCount: row.revision_count,
    updatedAt: iso(row.updated_at),
    blockingFindings: 0,
    warningFindings: row.warning_count,
  }));
}

function dateText(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
