import { createHash } from "node:crypto";
import {
  canonicalStringify,
  parseGamePlayerHeightDataset,
  type GamePlayerHeightDataset,
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
  {
    gameId: Type.String(),
    season: Type.Integer(),
    sourceBundleHash: Type.String(),
  },
  { additionalProperties: false },
);

function datasetHash(input: GamePlayerHeightDataset): string {
  return createHash("sha256").update(canonicalStringify(input)).digest("hex");
}

/** The caller owns the transaction, including the game import when applicable. */
export async function writeGamePlayerHeights(client: PoolClient, input: unknown): Promise<boolean> {
  const dataset = parseGamePlayerHeightDataset(input);
  const key = [dataset.gameId, dataset.sourceBundleHash];
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `player-height:${dataset.gameId}:${dataset.sourceBundleHash}`,
  ]);
  const expected = datasetHash(dataset);
  const existing = await client.query<Record<string, unknown>>(
    `
    SELECT season,dataset_hash AS "datasetHash",observation_count AS "observationCount",sealed
    FROM registry.game_height_bundles WHERE game_id=$1 AND source_bundle_hash=$2 AND extraction_version=2`,
    key,
  );
  const raw = existing.rows[0];
  if (raw !== undefined) {
    const row = Value.Decode(manifestSchema, raw);
    if (
      !row.sealed ||
      row.season !== dataset.season ||
      row.datasetHash !== expected ||
      row.observationCount !== dataset.observations.length
    )
      throw new PersistenceIntegrityError("저장된 선수 키와 같은 원문의 추출 결과가 다릅니다.");
    return false;
  }
  await client.query(
    `INSERT INTO registry.game_height_bundles
    (game_id,source_bundle_hash,season,dataset_hash,observation_count,extraction_version) VALUES ($1,$2,$3,$4,$5,2)`,
    [...key, dataset.season, expected, dataset.observations.length],
  );
  // A bounded batch per game; no JSON/ARRAY storage and no per-pitch copies of player height.
  for (let offset = 0; offset < dataset.observations.length; offset += 200) {
    const rows = dataset.observations.slice(offset, offset + 200);
    const parameters: unknown[] = [];
    const tuples = rows.map((row, index) => {
      const start = parameters.length;
      parameters.push(
        ...key,
        offset + index,
        row.playerId,
        row.heightCm,
        row.rawHeight,
        row.endpoint,
        row.sourcePath,
        2,
      );
      return `(${Array.from({ length: 9 }, (_, i) => `$${start + i + 1}`).join(",")})`;
    });
    await client.query(
      `INSERT INTO registry.game_player_height_observations
      (game_id,source_bundle_hash,observation_sequence,player_id,height_cm,raw_height,endpoint,source_path,extraction_version)
      VALUES ${tuples.join(",")}`,
      parameters,
    );
  }
  const stored = await client.query<Record<string, unknown>>(
    `
    SELECT player_id AS "playerId",height_cm AS "heightCm",raw_height AS "rawHeight",endpoint,source_path AS "sourcePath"
    FROM registry.game_player_height_observations WHERE game_id=$1 AND source_bundle_hash=$2 AND extraction_version=2
    ORDER BY observation_sequence`,
    key,
  );
  if (
    datasetHash(parseGamePlayerHeightDataset({ ...dataset, observations: stored.rows })) !==
    expected
  )
    throw new PersistenceIntegrityError("선수 키 재조회 hash가 다릅니다.");
  await client.query(
    "UPDATE registry.game_height_bundles SET sealed=TRUE WHERE game_id=$1 AND source_bundle_hash=$2 AND extraction_version=2",
    key,
  );
  return true;
}

export class PlayerHeightRepository {
  public constructor(private readonly pool: Pool) {}

  /** Explicit maintenance input is a verified source dataset, not a sealed game correction. */
  public async importDataset(input: unknown): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const added = await writeGamePlayerHeights(client, input);
      await client.query("COMMIT");
      return added;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async pendingSources(): Promise<
    Array<Pick<GamePlayerHeightDataset, "gameId" | "season" | "sourceBundleHash">>
  > {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT DISTINCT r.game_id AS "gameId",r.season,r.source_bundle_hash AS "sourceBundleHash"
      FROM workbench.game_revisions r
      LEFT JOIN registry.game_height_bundles h ON h.game_id=r.game_id AND h.source_bundle_hash=r.source_bundle_hash AND h.extraction_version=2 AND h.sealed
      WHERE r.sealed AND h.game_id IS NULL ORDER BY r.season,"gameId","sourceBundleHash"`);
    return Value.Decode(Type.Array(sourceSchema), result.rows);
  }
}
