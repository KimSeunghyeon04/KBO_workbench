import type { PoolClient } from "pg";
export async function assertContract(
  client: PoolClient,
  expectedMigrationVersion: string,
): Promise<void> {
  const migration = await client.query<{ readonly version: string }>(
    "SELECT version FROM workbench.schema_migrations ORDER BY version DESC LIMIT 1",
  );
  const contract = await client.query<{
    readonly analytics_contract_version: number;
    readonly projection_version: number;
    readonly registry_contract_version: number;
    readonly record_correction_contract_version: number;
  }>(
    `SELECT analytics_contract_version,projection_version,registry_contract_version,
            record_correction_contract_version
     FROM workbench.contract_metadata WHERE singleton`,
  );
  const row = contract.rows[0];
  if (
    migration.rows[0]?.version !== expectedMigrationVersion ||
    row?.analytics_contract_version !== 4 ||
    row.projection_version !== 4 ||
    row.registry_contract_version !== 1 ||
    row.record_correction_contract_version !== 2
  )
    throw new Error("record correction DB contract가 4/4/1/2와 일치하지 않습니다.");
}

export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}
