import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalStringify, parseOfficialPlayerHeights } from "@kbo/contracts";
import type { Pool, PoolClient } from "pg";
import { PersistenceIntegrityError } from "./errors.js";

const countSchema = Type.Object(
  {
    sourceKind: Type.Union([
      Type.Literal("same_game"),
      Type.Literal("same_season"),
      Type.Literal("official_profile"),
    ]),
    players: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Freeze valid choices; missing/conflicting evidence remains unresolved and can be retried. */
export async function resolvePlayerHeights(
  client: PoolClient,
  season: number,
  gameId: string | null = null,
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`height-choices:${season}`]);
  const result = await client.query<Record<string, unknown>>(
    `WITH observations AS MATERIALIZED (
      SELECT o.*,b.season FROM registry.game_player_height_observations o
      JOIN registry.game_height_bundles b USING(game_id,source_bundle_hash,extraction_version)
      WHERE b.season=$1 AND b.sealed AND b.extraction_version=2 AND o.height_cm IS NOT NULL
        AND EXISTS (SELECT 1 FROM workbench.game_revisions r WHERE r.game_id=b.game_id
          AND r.source_bundle_hash=b.source_bundle_hash AND r.season=b.season AND r.sealed)
    ), own_counts AS (
      SELECT game_id,source_bundle_hash,player_id,count(DISTINCT height_cm) AS n
      FROM observations GROUP BY game_id,source_bundle_hash,player_id
    ), season_counts AS (
      SELECT player_id,count(DISTINCT height_cm) AS n FROM observations GROUP BY player_id
    ), own_first AS (
      SELECT DISTINCT ON (game_id,source_bundle_hash,player_id) * FROM observations
      ORDER BY game_id,source_bundle_hash,player_id,observation_sequence
    ), season_first AS (
      SELECT DISTINCT ON (player_id) * FROM observations
      ORDER BY player_id,game_id COLLATE "C",source_bundle_hash COLLATE "C",observation_sequence
    ), targets AS (
      SELECT DISTINCT r.game_id,r.source_bundle_hash,r.season,p.batter_id AS player_id
      FROM workbench.game_revisions r
      JOIN baseball.pitch_facts p USING(game_id,revision)
      JOIN registry.game_height_bundles b ON b.game_id=r.game_id
        AND b.source_bundle_hash=r.source_bundle_hash AND b.season=r.season AND b.extraction_version=2 AND b.sealed
      WHERE r.sealed AND r.season=$1 AND ($2::text IS NULL OR r.game_id=$2)
        AND p.actual AND p.batter_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM registry.game_player_height_choices c
          WHERE c.game_id=r.game_id AND c.source_bundle_hash=r.source_bundle_hash AND c.player_id=p.batter_id)
    ), chosen AS (
      SELECT t.*,COALESCE(own.height_cm,other.height_cm,official.height_cm) AS height_cm,
        CASE WHEN own.height_cm IS NOT NULL THEN 'same_game'
             WHEN other.height_cm IS NOT NULL THEN 'same_season' ELSE 'official_profile' END AS source_kind,
        COALESCE(own.game_id,other.game_id) AS evidence_game_id,
        COALESCE(own.source_bundle_hash,other.source_bundle_hash) AS evidence_bundle_hash,
        COALESCE(own.extraction_version,other.extraction_version) AS evidence_extraction_version,
        COALESCE(own.observation_sequence,other.observation_sequence) AS evidence_sequence,
        official.season AS official_season,official.player_id AS official_player_id
      FROM targets t
      LEFT JOIN own_counts oc USING(game_id,source_bundle_hash,player_id)
      LEFT JOIN season_counts sc USING(player_id)
      LEFT JOIN own_first own ON own.game_id=t.game_id AND own.source_bundle_hash=t.source_bundle_hash
        AND own.player_id=t.player_id AND oc.n=1
      LEFT JOIN season_first other ON other.player_id=t.player_id AND oc.n IS NULL AND sc.n=1
      LEFT JOIN registry.official_player_heights official ON official.season=t.season
        AND official.player_id=t.player_id AND oc.n IS NULL AND sc.n IS NULL
        AND EXISTS (SELECT 1 FROM workbench.game_revisions r
          JOIN workbench.game_roster_snapshots roster USING(game_id,revision)
          WHERE r.game_id=t.game_id AND r.source_bundle_hash=t.source_bundle_hash AND r.sealed
            AND roster.player_id=t.player_id AND roster.player_name=official.player_name)
    ), inserted AS (
      INSERT INTO registry.game_player_height_choices
        (game_id,source_bundle_hash,player_id,season,height_cm,source_kind,evidence_game_id,
         evidence_bundle_hash,evidence_extraction_version,evidence_sequence,official_season,official_player_id)
      SELECT game_id,source_bundle_hash,player_id,season,height_cm,source_kind,evidence_game_id,
         evidence_bundle_hash,evidence_extraction_version,evidence_sequence,official_season,official_player_id
      FROM chosen WHERE height_cm IS NOT NULL
      ORDER BY game_id COLLATE "C",source_bundle_hash COLLATE "C",player_id COLLATE "C"
      ON CONFLICT (game_id,source_bundle_hash,player_id) DO NOTHING RETURNING source_kind
    ) SELECT source_kind AS "sourceKind",count(*)::int AS players FROM inserted
      GROUP BY source_kind ORDER BY source_kind COLLATE "C"`,
    [season, gameId],
  );
  return Value.Decode(Type.Array(countSchema), result.rows);
}

export class PlayerHeightSupplementRepository {
  public constructor(private readonly pool: Pool) {}

  /** A reviewed file is the complete evidence input; no live profile fetch or overwrite. */
  public async importOfficialProfiles(input: unknown): Promise<number> {
    const profiles = parseOfficialPlayerHeights(input);
    const client = await this.pool.connect();
    let added = 0;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('official-player-heights'))");
      for (const row of profiles) {
        const hash = createHash("sha256").update(canonicalStringify(row)).digest("hex");
        const existing = await client.query<Record<string, unknown>>(
          "SELECT evidence_hash FROM registry.official_player_heights WHERE season=$1 AND player_id=$2",
          [row.season, row.playerId],
        );
        if (existing.rows.length > 0) {
          if (existing.rows[0]?.evidence_hash !== hash)
            throw new PersistenceIntegrityError("이미 확정한 공식 프로필 키의 근거가 다릅니다.");
          continue;
        }
        await client.query(
          `INSERT INTO registry.official_player_heights
          (season,player_id,player_name,birth_date,height_cm,reported_value,reported_unit,source_url,source_player_id,checked_on,evidence_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            row.season,
            row.playerId,
            row.playerName,
            row.birthDate,
            row.heightCm,
            row.reportedValue,
            row.reportedUnit,
            row.sourceUrl,
            row.sourcePlayerId,
            row.checkedOn,
            hash,
          ],
        );
        added++;
      }
      await client.query("COMMIT");
      return added;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async resolveSeason(season: number, dryRun = false) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const counts = await resolvePlayerHeights(client, season);
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
      return counts;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async seasons(): Promise<number[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      "SELECT DISTINCT season FROM workbench.game_revisions WHERE sealed ORDER BY season",
    );
    return Value.Decode(Type.Array(Type.Object({ season: Type.Integer() })), result.rows).map(
      (row) => row.season,
    );
  }
}
