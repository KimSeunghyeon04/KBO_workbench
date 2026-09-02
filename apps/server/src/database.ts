import type { DatabaseStatus } from "@kbo/contracts";
import { Pool } from "pg";

import { EXPECTED_POSTGRES_MAJOR_VERSION, type AppConfig } from "./config.js";

interface ServerVersionRow {
  readonly server_version_num: string;
}

interface MigrationVersionRow {
  readonly version: string;
}

export function createDatabasePool(config: AppConfig): Pool {
  return new Pool({
    ...config.database,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export async function inspectDatabase(
  pool: Pool,
  expectedMigrationVersion: string,
): Promise<DatabaseStatus> {
  try {
    const versionResult = await pool.query<ServerVersionRow>(
      "SELECT current_setting('server_version_num') AS server_version_num",
    );
    const versionNumber = Number(versionResult.rows[0]?.server_version_num);
    const serverMajorVersion = Number.isFinite(versionNumber)
      ? Math.trunc(versionNumber / 10_000)
      : null;

    const tableResult = await pool.query<{ readonly table_name: string | null }>(
      "SELECT to_regclass('workbench.schema_migrations')::text AS table_name",
    );
    let migrationVersion: string | null = null;
    if (tableResult.rows[0]?.table_name !== null) {
      const migrationResult = await pool.query<MigrationVersionRow>(
        "SELECT version FROM workbench.schema_migrations ORDER BY version DESC LIMIT 1",
      );
      migrationVersion = migrationResult.rows[0]?.version ?? null;
    }

    const healthy =
      serverMajorVersion === EXPECTED_POSTGRES_MAJOR_VERSION &&
      migrationVersion === expectedMigrationVersion;
    const message = healthy
      ? "PostgreSQL과 migration 계약이 정상입니다."
      : `계약 불일치: PostgreSQL ${serverMajorVersion ?? "확인 불가"}, migration ${migrationVersion ?? "없음"}`;

    return {
      reachable: true,
      healthy,
      serverMajorVersion,
      expectedServerMajorVersion: EXPECTED_POSTGRES_MAJOR_VERSION,
      migrationVersion,
      expectedMigrationVersion,
      message,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "알 수 없는 DB 연결 오류";
    return {
      reachable: false,
      healthy: false,
      serverMajorVersion: null,
      expectedServerMajorVersion: EXPECTED_POSTGRES_MAJOR_VERSION,
      migrationVersion: null,
      expectedMigrationVersion,
      message,
    };
  }
}
