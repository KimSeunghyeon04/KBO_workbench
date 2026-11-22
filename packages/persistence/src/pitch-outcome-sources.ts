import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { PoolClient } from "pg";
import type { AnalysisScope } from "@kbo/contracts";
import {
  ANALYSIS_COMPETITION_DATASET,
  ANALYSIS_GAME_WHERE,
  ANALYSIS_SOURCE_COLUMNS,
  analysisManifestHash,
  analysisScopeParameters,
} from "./analysis-scope.js";

const sourceSchema = Type.Object(
  {
    sources: Type.Array(Type.Unknown()),
    dataset: Type.Array(Type.Unknown()),
    supplements: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

/** Sealed facts use the regular manifest. Late supplements and zone policy have their own identity. */
export async function readPitchOutcomeSources(client: PoolClient, scope: AnalysisScope) {
  const result = await client.query<Record<string, unknown>>(
    `WITH selected_games AS MATERIALIZED (
      SELECT r.game_id,r.revision,r.document_hash,r.competition,r.competition_dataset_hash,
        r.source_bundle_hash,r.season
      FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE}
    ), supplements AS (
      SELECT r.game_id,r.source_bundle_hash,profile.dataset_hash AS batting_profile, (
        SELECT jsonb_agg(jsonb_build_array(b.extraction_version,b.dataset_hash) ORDER BY b.extraction_version)
        FROM registry.game_height_bundles b
        WHERE b.game_id=r.game_id AND b.source_bundle_hash=r.source_bundle_hash AND b.season=r.season AND b.sealed
      ) AS height_bundles, (
        SELECT jsonb_agg(jsonb_build_array(c.player_id,c.height_cm) ORDER BY c.player_id COLLATE "C")
        FROM registry.game_player_height_choices c
        WHERE c.game_id=r.game_id AND c.source_bundle_hash=r.source_bundle_hash
      ) AS height_choices, (
        SELECT jsonb_agg(jsonb_build_array(h.pitcher_id,h.evidence_hash) ORDER BY h.pitcher_id COLLATE "C")
        FROM registry.official_pitcher_hands h
        WHERE h.game_id=r.game_id AND h.source_bundle_hash=r.source_bundle_hash
      ) AS official_pitcher_hands
      FROM selected_games r LEFT JOIN registry.game_batting_profile_bundles profile
        ON profile.game_id=r.game_id AND profile.source_bundle_hash=r.source_bundle_hash
        AND profile.season=r.season AND profile.sealed
    )
    SELECT (
      SELECT COALESCE(json_agg(g ORDER BY g."gameId" COLLATE "C"),'[]'::json)
      FROM (SELECT ${ANALYSIS_SOURCE_COLUMNS} FROM selected_games r) g
    ) AS sources, (
      SELECT COALESCE(json_agg(d),'[]'::json) FROM (${ANALYSIS_COMPETITION_DATASET}) d
    ) AS dataset, encode(sha256(convert_to(jsonb_build_array(
      (SELECT jsonb_agg(s ORDER BY s.game_id COLLATE "C") FROM supplements s),
      (SELECT jsonb_agg(jsonb_build_array(measurement_profile_id,supports_zone,zone_formula_version)
        ORDER BY measurement_profile_id COLLATE "C") FROM catalog.tracking_measurement_profiles),
      (SELECT jsonb_agg(jsonb_build_array(version,checksum) ORDER BY version COLLATE "C")
        FROM workbench.schema_migrations)
    )::text,'UTF8')),'hex') AS supplements`,
    analysisScopeParameters(scope),
  );
  const { sources, dataset, supplements } = Value.Decode(sourceSchema, result.rows[0]);
  return { manifest: analysisManifestHash(scope, sources, dataset), supplements };
}
