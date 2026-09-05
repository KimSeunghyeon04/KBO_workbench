import { createHash } from "node:crypto";

import {
  canonicalStringify,
  parseStagingGameDocumentV2,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import {
  compileStagingGameDocumentV2,
  stagingDocumentHash,
  type ReplayResult,
} from "@kbo/game-core";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { projectionTableDescriptors } from "./projection-descriptor.js";
import type { ProjectionRow, ProjectionTableName, ProjectionTables } from "./projection.js";
import {
  DatabaseContractError,
  GameRevisionNotFoundError,
  hydrateProjectionLedger,
  PersistenceIntegrityError,
  type ProjectionLedgerManifest,
} from "./revision-store.js";

export interface V2ExportedCurrentGame {
  readonly document: StagingGameDocumentV2;
  readonly normalizedDocument: StagingGameDocumentV2;
  readonly sourceRevision: number;
  readonly sourceDocumentHash: string;
  readonly sourceProjectionHash: string;
  readonly sourceBundleHash: string;
  readonly sourceContentHash: string;
  readonly normalizedDocumentHash: string;
  readonly compilerHash: string;
  readonly replaySemanticHash: string;
}

interface V2ManifestRow extends ProjectionLedgerManifest, QueryResultRow {
  readonly revision: number;
  readonly document_hash: string;
  readonly projection_hash: string;
  readonly projection_version: number;
  readonly sealed: boolean;
}

interface LegacyProjectionRead {
  readonly tables: ProjectionTables;
  readonly projectionHash: string;
}

const V2_PITCH_TRACKING_COLUMNS = [
  "game_id",
  "revision",
  "tracking_sequence",
  "pitch_id",
  "tracking_id",
  "source_pitch_id",
  "source_pitch_ordinal",
  "source_endpoint",
  "source_block_index",
  "source_row_index",
  "pitcher_id",
  "batter_id",
  "observed_at",
  "stance",
  "x0",
  "y0",
  "z0",
  "vx0",
  "vy0",
  "vz0",
  "ax",
  "ay",
  "az",
  "cross_plate_x",
  "cross_plate_y",
  "top_sz",
  "bottom_sz",
] as const;

export class V2CurrentRevisionExporter {
  public constructor(private readonly pool: Pool) {}

  public async exportCurrent(
    consume: (game: V2ExportedCurrentGame) => Promise<void>,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await assertV2Contract(client);
      const games = await client.query<{ readonly game_id: string; readonly revision: number }>(
        `SELECT g.game_id,g.current_revision AS revision
         FROM workbench.games g
         JOIN workbench.game_revisions r
           ON r.game_id=g.game_id AND r.revision=g.current_revision
         WHERE g.current_revision IS NOT NULL AND r.sealed
         ORDER BY g.game_id`,
      );
      for (const game of games.rows)
        await consume(await exportOne(client, game.game_id, game.revision));
      await client.query("COMMIT");
      return games.rows.length;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function replayCompilerHash(replay: ReplayResult): string {
  return canonicalHash(replay);
}

export function stagingSourceContentHash(document: StagingGameDocumentV2): string {
  return canonicalHash(sourceContent(document));
}

export function replaySemanticHash(replay: ReplayResult): string {
  return canonicalHash({
    gameId: replay.gameId,
    finalState: replay.finalState,
    frames: replay.frames,
    plays: replay.plays,
    plateAppearances: replay.plateAppearances,
    pitchFacts: replay.pitchFacts,
    batterLines: replay.batterLines,
    pitcherLines: replay.pitcherLines,
    baserunnerLines: replay.baserunnerLines,
  });
}

async function exportOne(
  client: PoolClient,
  gameId: string,
  revision: number,
): Promise<V2ExportedCurrentGame> {
  const manifestResult = await client.query<V2ManifestRow>(
    "SELECT * FROM workbench.game_revisions WHERE game_id=$1 AND revision=$2",
    [gameId, revision],
  );
  const manifest = manifestResult.rows[0];
  if (manifest === undefined) throw new GameRevisionNotFoundError(gameId, revision);
  if (!manifest.sealed)
    throw new PersistenceIntegrityError(`V2 current revision이 seal되지 않았습니다: ${gameId}`);
  if (manifest.projection_version !== 2) {
    throw new DatabaseContractError(
      `V2 export projection_version이 2가 아닙니다: ${String(manifest.projection_version)}`,
    );
  }
  const projection = await readLegacyProjection(client, gameId, revision);
  if (projection.projectionHash !== manifest.projection_hash) {
    throw new PersistenceIntegrityError(
      `V2 projection hash가 다릅니다: ${gameId} expected=${manifest.projection_hash} actual=${projection.projectionHash}`,
    );
  }
  const document = hydrateProjectionLedger(manifest, projection.tables);
  if (stagingDocumentHash(document) !== manifest.document_hash) {
    throw new PersistenceIntegrityError(`V2 원장 hash가 다릅니다: ${gameId}`);
  }
  const replay = compileStagingGameDocumentV2(document);
  const blocking = replay.findings.filter((finding) => finding.severity === "blocking");
  if (blocking.length > 0) {
    throw new PersistenceIntegrityError(
      `V2 current 원장에 blocking finding이 있습니다: ${gameId} ${blocking.map((item) => item.code).join(",")}`,
    );
  }
  const normalizedDocument = parseStagingGameDocumentV2({
    ...document,
    revisionBase: { kind: "new_game" },
  });
  return {
    document,
    normalizedDocument,
    sourceRevision: revision,
    sourceDocumentHash: manifest.document_hash,
    sourceProjectionHash: manifest.projection_hash,
    sourceBundleHash: manifest.source_bundle_hash,
    sourceContentHash: stagingSourceContentHash(document),
    normalizedDocumentHash: stagingDocumentHash(normalizedDocument),
    compilerHash: replayCompilerHash(replay),
    replaySemanticHash: replaySemanticHash(replay),
  };
}

async function assertV2Contract(client: PoolClient): Promise<void> {
  const metadata = await client.query<{
    readonly analytics_contract_version: number;
    readonly projection_version: number;
  }>("SELECT analytics_contract_version,projection_version FROM workbench.contract_metadata");
  const row = metadata.rows[0];
  if (row?.analytics_contract_version !== 2 || row.projection_version !== 2) {
    throw new DatabaseContractError(
      "source database가 analytics/projection contract V2가 아닙니다.",
    );
  }
  const migration = await client.query<{ readonly version: string }>(
    "SELECT version FROM workbench.schema_migrations ORDER BY applied_at DESC,version DESC LIMIT 1",
  );
  if (migration.rows[0]?.version !== "0002_tracking_source_ordinal_nullable") {
    throw new DatabaseContractError("source database가 지원하는 최종 V2 migration이 아닙니다.");
  }
}

async function readLegacyProjection(
  client: PoolClient,
  gameId: string,
  revision: number,
): Promise<LegacyProjectionRead> {
  const tables = emptyProjectionTables();
  const legacyEntries: [string, readonly ProjectionRow[]][] = [];
  for (const descriptor of projectionTableDescriptors(3)) {
    const sourceName = sourceTableName(descriptor.name);
    const sourceSchema = descriptor.schema === "baseball" ? "analytics" : "workbench";
    const sourceColumns = sourceProjectionColumns(descriptor.name, descriptor.columns);
    const result = await client.query(
      `SELECT ${sourceColumns.join(",")} FROM ${sourceSchema}.${sourceName}
       WHERE game_id=$1 AND revision=$2 ORDER BY ${descriptor.orderBy}`,
      [gameId, revision],
    );
    const legacyRows = result.rows.map((row) => normalizeRow(row, sourceColumns));
    legacyEntries.push([sourceName, legacyRows]);
    const targetRows =
      descriptor.name === "tracking_observations"
        ? legacyRows.map((row) => ({ ...row, measurement_profile_id: "naver_pts_v1" }))
        : descriptor.name === "pitch_tracking_links"
          ? legacyRows.map((row) => ({
              game_id: row.game_id ?? null,
              revision: row.revision ?? null,
              tracking_sequence: row.tracking_sequence ?? null,
              pitch_id: row.pitch_id ?? null,
              tracking_id: row.tracking_id ?? null,
            }))
          : legacyRows;
    tables[descriptor.name] = targetRows;
  }
  return {
    tables,
    projectionHash: canonicalHash(Object.fromEntries(legacyEntries)),
  };
}

function emptyProjectionTables(): Record<ProjectionTableName, readonly ProjectionRow[]> {
  return {
    game_team_snapshots: [],
    game_roster_snapshots: [],
    game_roster_positions: [],
    relay_event_facts: [],
    relay_half_inning_starts: [],
    relay_batter_starts: [],
    relay_pitches: [],
    relay_plate_results: [],
    relay_runner_advances: [],
    relay_substitutions: [],
    relay_reviews: [],
    relay_administrative: [],
    relay_unresolved: [],
    tracking_observations: [],
    pitch_facts: [],
    pitch_tracking_links: [],
    official_batter_lines: [],
    official_pitcher_lines: [],
    play_facts: [],
    play_events: [],
    runner_movement_facts: [],
    game_final_states: [],
    plate_appearance_facts: [],
    plate_appearance_events: [],
    batter_game_facts: [],
    pitcher_game_facts: [],
    baserunner_game_facts: [],
    validation_runs: [],
    validation_issues: [],
    validation_issue_details: [],
  };
}

function sourceTableName(name: ProjectionTableName): string {
  if (name === "game_team_snapshots") return "game_teams";
  if (name === "game_roster_snapshots") return "game_rosters";
  if (name === "tracking_observations") return "tracking_candidates";
  if (name === "pitch_tracking_links") return "pitch_tracking";
  return name;
}

function sourceProjectionColumns(
  name: ProjectionTableName,
  targetColumns: readonly string[],
): readonly string[] {
  if (name === "tracking_observations") {
    return targetColumns.filter((column) => column !== "measurement_profile_id");
  }
  if (name === "pitch_tracking_links") return V2_PITCH_TRACKING_COLUMNS;
  return targetColumns;
}

function normalizeRow(row: QueryResultRow, columns: readonly string[]): ProjectionRow {
  return Object.fromEntries(
    columns.map((column) => {
      const value = row[column];
      if (typeof value === "bigint") return [column, Number(value)];
      if (value instanceof Date) return [column, value.toISOString()];
      return [column, value ?? null];
    }),
  );
}

function sourceContent(document: StagingGameDocumentV2): unknown {
  return {
    schemaVersion: document.schemaVersion,
    source: document.source,
    metadata: document.metadata,
    teams: document.teams,
    rosters: document.rosters,
    events: document.events,
    trackingCandidates: document.trackingCandidates,
    officialRecords: document.officialRecords,
  };
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}
