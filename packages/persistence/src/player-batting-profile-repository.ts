import { createHash } from "node:crypto";
import {
  canonicalStringify,
  parseGamePlayerBattingProfileDataset,
  type GamePlayerBattingProfileDataset,
} from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";
import { PersistenceIntegrityError } from "./errors.js";

const manifestSchema = Type.Object(
  {
    season: Type.Integer(),
    datasetHash: Type.String(),
    observationCount: Type.Integer(),
    sealed: Type.Boolean(),
  },
  { additionalProperties: false },
);
const sourceSchema = Type.Object(
  { gameId: Type.String(), season: Type.Integer(), sourceBundleHash: Type.String() },
  { additionalProperties: false },
);
function datasetHash(input: GamePlayerBattingProfileDataset): string {
  return createHash("sha256").update(canonicalStringify(input)).digest("hex");
}

/** The transaction owner verifies the immutable source before supplying the dataset. */
export async function writeGamePlayerBattingProfiles(
  client: PoolClient,
  input: unknown,
): Promise<boolean> {
  const dataset = parseGamePlayerBattingProfileDataset(input);
  const key = [dataset.gameId, dataset.sourceBundleHash];
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `batting-profile:${dataset.gameId}:${dataset.sourceBundleHash}`,
  ]);
  const expected = datasetHash(dataset);
  const existing = await client.query<Record<string, unknown>>(
    `SELECT season,dataset_hash AS "datasetHash",observation_count AS "observationCount",sealed
     FROM registry.game_batting_profile_bundles WHERE game_id=$1 AND source_bundle_hash=$2`,
    key,
  );
  const raw = existing.rows[0];
  if (raw !== undefined) {
    const stored = Value.Decode(manifestSchema, raw);
    if (
      !stored.sealed ||
      stored.season !== dataset.season ||
      stored.datasetHash !== expected ||
      stored.observationCount !== dataset.observations.length
    )
      throw new PersistenceIntegrityError(
        "저장된 선수 타석 프로필과 같은 원문의 추출 결과가 다릅니다.",
      );
    return false;
  }
  await client.query(
    `INSERT INTO registry.game_batting_profile_bundles
      (game_id,source_bundle_hash,season,dataset_hash,observation_count) VALUES ($1,$2,$3,$4,$5)`,
    [...key, dataset.season, expected, dataset.observations.length],
  );
  for (let offset = 0; offset < dataset.observations.length; offset += 200) {
    const parameters: unknown[] = [];
    const tuples = dataset.observations.slice(offset, offset + 200).map((row, index) => {
      const start = parameters.length;
      parameters.push(
        ...key,
        offset + index,
        row.playerId,
        row.battingSide,
        row.rawValue,
        row.endpoint,
        row.sourcePath,
      );
      return `(${Array.from({ length: 8 }, (_, i) => `$${start + i + 1}`).join(",")})`;
    });
    await client.query(
      `INSERT INTO registry.game_player_batting_profile_observations
       (game_id,source_bundle_hash,observation_sequence,player_id,batting_side,raw_value,endpoint,source_path)
       VALUES ${tuples.join(",")}`,
      parameters,
    );
  }
  const stored = await client.query<Record<string, unknown>>(
    `SELECT player_id AS "playerId",batting_side AS "battingSide",raw_value AS "rawValue",endpoint,source_path AS "sourcePath"
     FROM registry.game_player_batting_profile_observations WHERE game_id=$1 AND source_bundle_hash=$2
     ORDER BY observation_sequence`,
    key,
  );
  if (
    datasetHash(parseGamePlayerBattingProfileDataset({ ...dataset, observations: stored.rows })) !==
    expected
  )
    throw new PersistenceIntegrityError("선수 타석 프로필 재조회 hash가 다릅니다.");
  await client.query(
    "UPDATE registry.game_batting_profile_bundles SET sealed=TRUE WHERE game_id=$1 AND source_bundle_hash=$2",
    key,
  );
  return true;
}

export class PlayerBattingProfileRepository {
  public constructor(private readonly pool: Pool) {}
  public async importDataset(input: unknown): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const added = await writeGamePlayerBattingProfiles(client, input);
      await client.query("COMMIT");
      return added;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  public async pendingSources(season: number | null = null, gameId: string | null = null) {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT DISTINCT r.game_id AS "gameId",r.season,r.source_bundle_hash AS "sourceBundleHash"
       FROM workbench.game_revisions r
       LEFT JOIN registry.game_batting_profile_bundles b ON b.game_id=r.game_id AND b.source_bundle_hash=r.source_bundle_hash AND b.sealed
       WHERE r.sealed AND b.game_id IS NULL AND ($1::int IS NULL OR r.season=$1) AND ($2::text IS NULL OR r.game_id=$2)
       ORDER BY r.season,"gameId","sourceBundleHash"`,
      [season, gameId],
    );
    return Value.Decode(Type.Array(sourceSchema), result.rows);
  }
}
