import type { PoolClient, QueryResultRow } from "pg";

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
    for (const row of normalized[name]) {
      await client.query(
        `INSERT INTO ${schema}.${name} (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(",")})`,
        columns.map((column) => row[column]),
      );
    }
  }
}

export async function readProjection(
  client: PoolClient,
  gameId: string,
  revision: number,
): Promise<ProjectionTables> {
  const entries: [ProjectionTableName, readonly ProjectionRow[]][] = [];
  for (const descriptor of PROJECTION_TABLE_DESCRIPTORS) {
    const { columns, name, orderBy, schema } = descriptor;
    const result = await client.query(
      `SELECT ${columns.join(",")} FROM ${schema}.${name} WHERE game_id=$1 AND revision=$2 ORDER BY ${orderBy}`,
      [gameId, revision],
    );
    entries.push([name, result.rows.map((row) => normalizeProjectionRow(row, columns))]);
  }
  return Object.fromEntries(entries) as unknown as ProjectionTables;
}

function normalizeProjectionRow(row: QueryResultRow, columns: readonly string[]): ProjectionRow {
  return Object.fromEntries(
    columns.map((column) => {
      const value = row[column];
      if (typeof value === "bigint") return [column, Number(value)];
      if (value instanceof Date) return [column, value.toISOString()];
      return [column, value ?? null];
    }),
  );
}
