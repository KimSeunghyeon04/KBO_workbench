import type { PoolClient } from "pg";

import { canonicalStringify } from "@kbo/contracts";

import { PersistenceIntegrityError } from "./errors.js";
import { projectionTableDescriptors, type ProjectionVersion } from "./projection-descriptor.js";
import {
  normalizeProjectionTables,
  type ProjectionRow,
  type ProjectionTableName,
  type ProjectionTables,
} from "./projection.js";

export async function writeProjection(
  client: Pick<PoolClient, "query">,
  tables: ProjectionTables,
  version: ProjectionVersion = 4,
): Promise<void> {
  const normalized = normalizeProjectionTables(tables, version);
  for (const descriptor of projectionTableDescriptors(version)) {
    const { columns, name, schema } = descriptor;
    // Stay below the protocol parameter limit while preserving descriptor and row order.
    const batchSize = Math.min(500, Math.floor(60_000 / columns.length));
    const rows = normalized[name];
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const values = batch.flatMap((row, index) => {
        const decoded = descriptor.decodeRow(row, offset + index);
        return columns.map((column) => decoded[column]);
      });
      const placeholders = batch.map(
        (_, rowIndex) =>
          `(${columns.map((_, columnIndex) => `$${String(rowIndex * columns.length + columnIndex + 1)}`).join(",")})`,
      );
      await client.query(
        `INSERT INTO ${schema}.${name} (${columns.join(",")}) VALUES ${placeholders.join(",")}`,
        values,
      );
    }
  }
}

export async function readProjection(
  client: PoolClient,
  gameId: string,
  revision: number,
  version: ProjectionVersion = 4,
): Promise<ProjectionTables> {
  const tables: Record<ProjectionTableName, ProjectionRow[]> = emptyProjectionTables();
  for (const descriptor of projectionTableDescriptors(version)) {
    const { columns, name, orderBy, schema } = descriptor;
    const result = await client.query(
      `SELECT ${columns.join(",")} FROM ${schema}.${name} WHERE game_id=$1 AND revision=$2 ORDER BY ${orderBy}`,
      [gameId, revision],
    );
    if (result.rowCount !== result.rows.length) {
      throw new PersistenceIntegrityError(
        `${name} DB rowCount가 실제 행 수와 다릅니다: rowCount=${String(result.rowCount)}, rows=${String(result.rows.length)}`,
      );
    }
    const seen = new Set<string>();
    for (const [rowIndex, row] of result.rows.entries()) {
      const decoded = descriptor.decodeRow(row, rowIndex);
      if (decoded.game_id !== gameId || decoded.revision !== revision) {
        throw new PersistenceIntegrityError(
          `${name}[${String(rowIndex)}] game/revision 문맥이 다릅니다.`,
        );
      }
      const uniqueKey = canonicalStringify(descriptor.uniqueBy.map((column) => decoded[column]));
      if (seen.has(uniqueKey)) {
        throw new PersistenceIntegrityError(
          `${name} primary order key가 중복되었습니다: ${uniqueKey}`,
        );
      }
      seen.add(uniqueKey);
      tables[name].push(decoded);
    }
  }
  return tables;
}

function emptyProjectionTables(): Record<ProjectionTableName, ProjectionRow[]> {
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
