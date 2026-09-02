import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

import { loadConfig } from "./config.js";

const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;

interface AppliedMigrationRow {
  readonly checksum: string;
  readonly version: string;
}

function checksum(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

async function migrate(): Promise<void> {
  const config = loadConfig();
  const migrationsDirectory = path.resolve(process.env.MIGRATIONS_DIR?.trim() || "database/v3");
  const pool = new Pool({ ...config.database, max: 1 });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('kbo-workbench-schema-migrations'))");
    await client.query("CREATE SCHEMA IF NOT EXISTS workbench");
    await client.query("CREATE SCHEMA IF NOT EXISTS analytics");
    await client.query(`
      CREATE TABLE IF NOT EXISTS workbench.schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const appliedResult = await client.query<AppliedMigrationRow>(
      "SELECT version, checksum FROM workbench.schema_migrations",
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum]));
    const files = (await readdir(migrationsDirectory))
      .filter((file) => migrationPattern.test(file))
      .sort();

    if (files.length === 0) {
      throw new Error(`migration 파일이 없습니다: ${migrationsDirectory}`);
    }

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const contents = await readFile(path.join(migrationsDirectory, file), "utf8");
      const fileChecksum = checksum(contents);
      const recordedChecksum = applied.get(version);
      if (recordedChecksum !== undefined) {
        if (recordedChecksum !== fileChecksum) {
          throw new Error(`적용된 migration checksum이 다릅니다: ${version}`);
        }
        continue;
      }

      await client.query(contents);
      await client.query(
        "INSERT INTO workbench.schema_migrations (version, checksum) VALUES ($1, $2)",
        [version, fileChecksum],
      );
      process.stdout.write(`applied migration ${version}\n`);
    }

    const latestVersion = files.at(-1)?.replace(/\.sql$/, "");
    if (latestVersion !== config.expectedMigrationVersion) {
      throw new Error(
        `최신 migration이 계약과 다릅니다: expected=${config.expectedMigrationVersion}, actual=${latestVersion ?? "없음"}`,
      );
    }

    const analystUser = process.env.KBO_ANALYST_USER?.trim() || undefined;
    const analystPassword = process.env.KBO_ANALYST_PASSWORD?.trim() || undefined;
    if (analystUser !== undefined || analystPassword !== undefined) {
      if (analystUser === undefined || analystPassword === undefined) {
        throw new Error("KBO_ANALYST_USER와 KBO_ANALYST_PASSWORD는 함께 설정해야 합니다.");
      }
      await configureAnalyst(client, config.database.database, analystUser, analystPassword);
    }

    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function configureAnalyst(
  client: import("pg").PoolClient,
  database: string,
  user: string,
  password: string,
): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(user)) {
    throw new Error("KBO_ANALYST_USER는 PostgreSQL identifier 형식이어야 합니다.");
  }
  const identifier = `"${user.replaceAll('"', '""')}"`;
  const passwordLiteral = `'${password.replaceAll("'", "''")}'`;
  const databaseIdentifier = `"${database.replaceAll('"', '""')}"`;
  const exists = await client.query<{ readonly exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists",
    [user],
  );
  if (exists.rows[0]?.exists === true) {
    await client.query(`ALTER ROLE ${identifier} PASSWORD ${passwordLiteral}`);
  } else {
    await client.query(`CREATE ROLE ${identifier} LOGIN PASSWORD ${passwordLiteral}`);
  }
  await client.query(`ALTER ROLE ${identifier} SET default_transaction_read_only=on`);
  await client.query(`GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${identifier}`);
  await client.query(`GRANT USAGE ON SCHEMA analytics TO ${identifier}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO ${identifier}`);
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO ${identifier}`,
  );
  await client.query("REVOKE CREATE ON SCHEMA analytics FROM PUBLIC");
  await client.query("REVOKE ALL ON SCHEMA workbench FROM PUBLIC");
}

try {
  await migrate();
} catch (error: unknown) {
  const message = error instanceof Error ? error.stack : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
