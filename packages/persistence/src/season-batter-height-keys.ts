import { createHash } from "node:crypto";
import {
  canonicalStringify,
  PITCH_CALIBRATION_PARAMETERS,
  PITCH_REFERENCE_VERSION,
  type AnalysisScope,
} from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";
import { COVERAGE_SUMMARY_VERSION, coverageHash } from "./analysis-coverage-summary.js";
import { analysisScopeParameters, scopedAnalysisGamesSql } from "./analysis-scope.js";

const fingerprintSchema = Type.Object(
  { fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false },
);

/** The selected SQL supplies current game IDs, revisions, document hashes, and source bundle hashes. */
export async function readHeightDependencyFingerprint(
  client: PoolClient,
  selectedGames: string,
  parameters: readonly unknown[],
): Promise<string> {
  const result = await client.query<Record<string, unknown>>(
    `WITH selected AS MATERIALIZED (${selectedGames}), dependencies AS (
      SELECT r.*, (
        SELECT string_agg(ROW(b.season,b.extraction_version,b.dataset_hash)::text,',' ORDER BY b.extraction_version)
        FROM registry.game_height_bundles b
        WHERE b.game_id=r.game_id AND b.source_bundle_hash=r.source_bundle_hash AND b.sealed
      ) AS bundles, (
        SELECT encode(sha256(convert_to(COALESCE(string_agg(ROW(c.player_id,c.height_cm)::text,',' ORDER BY c.player_id COLLATE "C"),''),'UTF8')),'hex')
        FROM registry.game_player_height_choices c
        WHERE c.game_id=r.game_id AND c.source_bundle_hash=r.source_bundle_hash
      ) AS choices FROM selected r
    ) SELECT encode(sha256(convert_to(COALESCE(string_agg(
      ROW(game_id,revision,document_hash,source_bundle_hash,bundles,choices)::text,',' ORDER BY game_id COLLATE "C"
    ),''),'UTF8')),'hex') AS fingerprint FROM dependencies`,
    [...parameters],
  );
  return Value.Decode(fingerprintSchema, result.rows[0]).fingerprint;
}

const heightRowsSchema = Type.Array(
  Type.Object(
    {
      gameId: Type.String(),
      revision: Type.Integer(),
      playerId: Type.Union([Type.String(), Type.Null()]),
      heightCm: Type.Union([Type.Integer(), Type.Null()]),
    },
    { additionalProperties: false },
  ),
);
const selectedSeasonGames = scopedAnalysisGamesSql(
  "r.game_id,r.revision,r.document_hash,r.source_bundle_hash",
);

interface SeasonHeightKeys {
  readonly disciplineHash: string;
  readonly coverageKey: string;
}
const poolKeys = new WeakMap<Pool, Map<string, SeasonHeightKeys>>();

export async function seasonBatterHeightKeys(
  client: PoolClient,
  pool: Pool,
  scope: AnalysisScope,
  referenceHash: string,
): Promise<SeasonHeightKeys> {
  const params = analysisScopeParameters(scope);
  const fingerprint = await readHeightDependencyFingerprint(client, selectedSeasonGames, params);
  const key = canonicalStringify([scope, referenceHash, fingerprint]);
  const cache = poolKeys.get(pool) ?? new Map<string, SeasonHeightKeys>();
  poolKeys.set(pool, cache);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const { rows } = await client.query<Record<string, unknown>>(
    `WITH selected_games AS MATERIALIZED (${selectedSeasonGames})
      SELECT r.game_id AS "gameId",r.revision,h.player_id AS "playerId",h.height_cm AS "heightCm"
      FROM selected_games r LEFT JOIN LATERAL (
        SELECT h.player_id,h.height_cm FROM analytics.game_batter_heights h
        WHERE h.game_id=r.game_id AND h.revision=r.revision OFFSET 0
      ) h ON TRUE
      ORDER BY r.game_id COLLATE "C",h.player_id COLLATE "C"`,
    params,
  );
  const heights = Value.Decode(heightRowsSchema, rows);
  const result = {
    disciplineHash: createHash("sha256")
      .update(
        canonicalStringify({
          referenceHash,
          referenceVersion: PITCH_REFERENCE_VERSION,
          zonePolicy: "frozen-player-height-effective-season-v4",
          heights,
        }),
      )
      .digest("hex"),
    // Coverage's stored key omits the empty-game row and uses a different property name.
    coverageKey: coverageHash({
      version: COVERAGE_SUMMARY_VERSION,
      scope,
      referenceHash,
      heights: heights.flatMap(({ gameId, revision, playerId, heightCm }) =>
        playerId === null ? [] : [{ gameId, revision, playerId, height: heightCm }],
      ),
      calibration: PITCH_CALIBRATION_PARAMETERS,
    }),
  };
  cache.set(key, result);
  if (cache.size > 16) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return result;
}
