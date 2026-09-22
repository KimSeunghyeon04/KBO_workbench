import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";

// Values are derived hashes, not player rows. Each pool retains at most five training periods.
const caches = new WeakMap<
  Pool,
  Map<number, { fingerprint: string; hashes: Map<number, string> }>
>();
const fingerprintSchema = Type.Object(
  { fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false },
);
export async function pitchQualityHeightCache(client: PoolClient, pool: Pool, through: number) {
  const result = await client.query<Record<string, unknown>>(
    `WITH selected AS MATERIALIZED (
      SELECT game_id,revision,document_hash,source_bundle_hash
      FROM analytics.current_analysis_games WHERE competition='regular' AND season BETWEEN 2020 AND $1
    ), dependencies AS (
      SELECT r.*, (
        SELECT string_agg(ROW(b.extraction_version,b.dataset_hash)::text,',' ORDER BY b.extraction_version)
        FROM registry.game_height_bundles b WHERE b.game_id=r.game_id AND b.source_bundle_hash=r.source_bundle_hash AND b.sealed
      ) AS bundles, (
        SELECT encode(sha256(convert_to(COALESCE(string_agg(ROW(c.player_id,c.height_cm)::text,',' ORDER BY c.player_id COLLATE "C"),''),'UTF8')),'hex')
        FROM registry.game_player_height_choices c WHERE c.game_id=r.game_id AND c.source_bundle_hash=r.source_bundle_hash
      ) AS choices FROM selected r
    ) SELECT encode(sha256(convert_to(COALESCE(string_agg(
      ROW(game_id,revision,document_hash,source_bundle_hash,bundles,choices)::text,',' ORDER BY game_id COLLATE "C"
    ),''),'UTF8')),'hex') AS fingerprint FROM dependencies`,
    [through + 1],
  );
  const { fingerprint } = Value.Decode(fingerprintSchema, result.rows[0]);
  const cache = caches.get(pool) ?? new Map();
  caches.set(pool, cache);
  const previous = cache.get(through);
  return {
    hashes: previous?.fingerprint === fingerprint ? previous.hashes : null,
    save(hashes: Map<number, string>) {
      cache.delete(through);
      cache.set(through, { fingerprint, hashes });
      if (cache.size > 5) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    },
  };
}
