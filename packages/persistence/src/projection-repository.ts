import type { PoolClient } from "pg";

import { canonicalStringify } from "@kbo/contracts";

import { PersistenceIntegrityError } from "./errors.js";
import { PROJECTION_TABLE_DESCRIPTORS } from "./projection-descriptor.js";
import {
  normalizeProjectionTables,
  type ProjectionRow,
  type ProjectionTableName,
  type ProjectionTables,
} from "./projection.js";

export async function writeProjection(client: PoolClient, tables: ProjectionTables): Promise<void> {
  const normalized = normalizeProjectionTables(tables);
  for (const descriptor of PROJECTION_TABLE_DESCRIPTORS) {
    const { columns, name, schema } = descriptor;
    for (const [rowIndex, row] of normalized[name].entries()) {
      const decoded = descriptor.decodeRow(row, rowIndex);
      await client.query(
        `INSERT INTO ${schema}.${name} (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(",")})`,
        columns.map((column) => decoded[column]),
      );
    }
  }
}

export async function readProjection(
  client: PoolClient,
  gameId: string,
  revision: number,
): Promise<ProjectionTables> {
  const tables: Record<ProjectionTableName, ProjectionRow[]> = emptyProjectionTables();
  for (const descriptor of PROJECTION_TABLE_DESCRIPTORS) {
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
