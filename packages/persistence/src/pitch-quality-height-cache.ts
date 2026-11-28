import type { Pool, PoolClient } from "pg";
import { readHeightDependencyFingerprint } from "./season-batter-height-keys.js";

// Values are derived hashes, not player rows. Each pool retains at most five training periods.
const caches = new WeakMap<
  Pool,
  Map<number, { fingerprint: string; hashes: Map<number, string> }>
>();
export async function pitchQualityHeightCache(client: PoolClient, pool: Pool, through: number) {
  const fingerprint = await readHeightDependencyFingerprint(
    client,
    `SELECT game_id,revision,document_hash,source_bundle_hash
     FROM analytics.current_analysis_games WHERE competition='regular' AND season BETWEEN 2020 AND $1`,
    [through + 1],
  );
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
