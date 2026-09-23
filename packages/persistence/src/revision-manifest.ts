import type { StagingGameDocumentV2 } from "@kbo/contracts";
import type { PoolClient } from "pg";
import { PersistenceIntegrityError } from "./errors.js";
import { text } from "./projection-values.js";
import {
  DatabaseContractError,
  GameRevisionNotFoundError,
  type ManifestRow,
} from "./revision-types.js";

export async function assertDatabaseContract(
  client: PoolClient,
  expectedMigration: string,
): Promise<void> {
  const major = await client.query(
    "SELECT current_setting('server_version_num')::int / 10000 AS major",
  );
  const majorRow = databaseContractRow(major, ["major"], "PostgreSQL version");
  if (safeInteger(majorRow.major, "PostgreSQL major") !== 16)
    throw new DatabaseContractError("PostgreSQL 16만 지원합니다.");
  const migration = await client.query(
    "SELECT version FROM workbench.schema_migrations ORDER BY version DESC LIMIT 1",
  );
  const migrationRow = databaseContractRow(migration, ["version"], "migration head");
  const migrationVersion = text(migrationRow.version);
  if (migrationVersion !== expectedMigration)
    throw new DatabaseContractError(
      `migration head 불일치: expected=${expectedMigration}, actual=${migrationVersion}`,
    );
  const contract = await client.query(
    "SELECT analytics_contract_version, projection_version, registry_contract_version FROM workbench.contract_metadata WHERE singleton",
  );
  const contractRow = databaseContractRow(
    contract,
    ["analytics_contract_version", "projection_version", "registry_contract_version"],
    "contract metadata",
  );
  if (
    safeInteger(contractRow.analytics_contract_version, "analytics contract") !== 4 ||
    safeInteger(contractRow.projection_version, "projection contract") !== 4 ||
    safeInteger(contractRow.registry_contract_version, "registry contract") !== 1
  )
    throw new DatabaseContractError(
      "analytics/projection/registry contract version이 4/4/1이어야 합니다.",
    );
}

export async function insertManifest(
  client: PoolClient,
  document: StagingGameDocumentV2,
  revision: number,
  documentHash: string,
  projectionHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO workbench.game_revisions
     (game_id,revision,parent_revision,base_document_hash,schema_version,provider,source_game_id,source_bundle_hash,collected_at_text,season,game_date,scheduled_at_text,game_status,stadium,scheduled_innings,document_hash,projection_hash,projection_version)
     VALUES ($1,$2,$3,$4,2,'naver',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,4)`,
    [
      document.metadata.gameId,
      revision,
      document.revisionBase.kind === "sealed_revision" ? document.revisionBase.revision : null,
      document.revisionBase.kind === "sealed_revision" ? document.revisionBase.documentHash : null,
      document.source.sourceGameId,
      document.source.sourceBundleHash,
      document.source.collectedAt,
      document.metadata.season,
      document.metadata.gameDate,
      document.metadata.scheduledAt ?? null,
      document.metadata.status,
      document.metadata.stadium ?? null,
      document.metadata.scheduledInnings,
      documentHash,
      projectionHash,
    ],
  );
}

export async function loadManifest(
  client: PoolClient,
  gameId: string,
  revision: number,
): Promise<ManifestRow> {
  const result = await client.query(
    "SELECT * FROM workbench.game_revisions WHERE game_id=$1 AND revision=$2",
    [gameId, revision],
  );
  if (result.rows.length === 0) throw new GameRevisionNotFoundError(gameId, revision);
  if (result.rowCount !== 1 || result.rows.length !== 1 || result.rows[0] === undefined) {
    throw new PersistenceIntegrityError("game revision manifest는 정확히 한 행이어야 합니다.");
  }
  return decodeManifestRow(result.rows[0], gameId, revision);
}

const MANIFEST_COLUMNS = [
  "game_id",
  "revision",
  "parent_revision",
  "base_document_hash",
  "schema_version",
  "provider",
  "source_game_id",
  "source_bundle_hash",
  "collected_at_text",
  "season",
  "game_date",
  "scheduled_at_text",
  "game_status",
  "stadium",
  "scheduled_innings",
  "document_hash",
  "projection_hash",
  "projection_version",
  "sealed",
  "created_at",
  "sealed_at",
] as const;

export function decodeManifestRow(
  value: unknown,
  expectedGameId: string,
  expectedRevision?: number,
): ManifestRow {
  const row = databaseRow(value, MANIFEST_COLUMNS, "game revision manifest");
  const gameId = text(row.game_id);
  const revision = safeInteger(row.revision, "manifest revision");
  if (
    gameId !== expectedGameId ||
    (expectedRevision !== undefined && revision !== expectedRevision)
  ) {
    throw new PersistenceIntegrityError("game revision manifest 문맥이 요청과 다릅니다.");
  }
  const schemaVersion = safeInteger(row.schema_version, "manifest schema_version");
  const projectionVersion = safeInteger(row.projection_version, "manifest projection_version");
  if (schemaVersion !== 2 || (projectionVersion !== 3 && projectionVersion !== 4)) {
    throw new PersistenceIntegrityError(
      "game revision manifest contract version이 올바르지 않습니다.",
    );
  }
  const provider = text(row.provider);
  if (provider !== "naver") {
    throw new PersistenceIntegrityError("game revision manifest provider가 올바르지 않습니다.");
  }
  const gameStatus = text(row.game_status);
  if (!isGameStatus(gameStatus)) {
    throw new PersistenceIntegrityError("game revision manifest status가 올바르지 않습니다.");
  }
  return {
    game_id: gameId,
    revision,
    schema_version: schemaVersion,
    provider,
    source_game_id: text(row.source_game_id),
    source_bundle_hash: hashText(row.source_bundle_hash, "source_bundle_hash"),
    collected_at_text: isoText(row.collected_at_text, "collected_at_text"),
    parent_revision: nullableSafeInteger(row.parent_revision, "parent_revision"),
    base_document_hash: nullableHashText(row.base_document_hash, "base_document_hash"),
    season: safeInteger(row.season, "season"),
    game_date: dateValue(row.game_date, "game_date"),
    scheduled_at_text: nullableIsoText(row.scheduled_at_text, "scheduled_at_text"),
    game_status: gameStatus,
    stadium: nullableDatabaseText(row.stadium, "stadium"),
    scheduled_innings: safeInteger(row.scheduled_innings, "scheduled_innings"),
    document_hash: hashText(row.document_hash, "document_hash"),
    projection_hash: hashText(row.projection_hash, "projection_hash"),
    projection_version: projectionVersion,
    sealed: databaseBoolean(row.sealed, "sealed"),
    created_at: timestampValue(row.created_at, "created_at"),
    sealed_at: row.sealed_at === null ? null : timestampValue(row.sealed_at, "sealed_at"),
  };
}

export async function currentRevision(client: PoolClient, gameId: string): Promise<number> {
  const result = await client.query(
    "SELECT current_revision FROM workbench.games WHERE game_id=$1",
    [gameId],
  );
  const revision = decodeOptionalCurrentRevision(result, "current revision row");
  if (revision === null) throw new GameRevisionNotFoundError(gameId, null);
  return revision;
}

function databaseRow(
  value: unknown,
  columns: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PersistenceIntegrityError(`${label}가 object가 아닙니다.`);
  }
  const row = value as Record<string, unknown>;
  const expected = new Set(columns);
  const missing = columns.filter((column) => !Object.hasOwn(row, column));
  const extra = Object.keys(row).filter((column) => !expected.has(column));
  if (missing.length > 0 || extra.length > 0) {
    throw new PersistenceIntegrityError(
      `${label} column 불일치: 누락=${missing.join(",") || "없음"}; 초과=${extra.join(",") || "없음"}`,
    );
  }
  return row;
}

export function requiredDatabaseResultRow(
  result: { readonly rows: readonly unknown[]; readonly rowCount: number | null },
  columns: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (result.rowCount !== 1 || result.rows.length !== 1 || result.rows[0] === undefined) {
    throw new PersistenceIntegrityError(`${label}은 정확히 한 행이어야 합니다.`);
  }
  return databaseRow(result.rows[0], columns, label);
}

function databaseContractRow(
  result: { readonly rows: readonly unknown[]; readonly rowCount: number | null },
  columns: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    return requiredDatabaseResultRow(result, columns, label);
  } catch (error: unknown) {
    throw new DatabaseContractError(
      error instanceof Error ? error.message : `${label} 응답이 올바르지 않습니다.`,
    );
  }
}

export function decodeOptionalCurrentRevision(
  result: { readonly rows: readonly unknown[]; readonly rowCount: number | null },
  label: string,
): number | null {
  if (result.rows.length === 0) {
    if (result.rowCount !== 0) {
      throw new PersistenceIntegrityError(`${label} rowCount가 올바르지 않습니다.`);
    }
    return null;
  }
  const row = requiredDatabaseResultRow(result, ["current_revision"], label);
  return nullableSafeInteger(row.current_revision, `${label}.current_revision`);
}

export function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PersistenceIntegrityError(`${label} 값이 safe integer가 아닙니다.`);
  }
  return value;
}

function nullableSafeInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function databaseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new PersistenceIntegrityError(`${label} 값이 boolean이 아닙니다.`);
  }
  return value;
}

export function hashText(value: unknown, label: string): string {
  const result = text(value);
  if (!/^[0-9a-f]{64}$/.test(result)) {
    throw new PersistenceIntegrityError(`${label} 값이 SHA-256 hash가 아닙니다.`);
  }
  return result;
}

function nullableHashText(value: unknown, label: string): string | null {
  return value === null ? null : hashText(value, label);
}

function nullableDatabaseText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new PersistenceIntegrityError(`${label} 값이 string 또는 null이 아닙니다.`);
  }
  return value;
}

function isoText(value: unknown, label: string): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) {
    throw new PersistenceIntegrityError(`${label} 값이 ISO timestamp가 아닙니다.`);
  }
  return result;
}

function nullableIsoText(value: unknown, label: string): string | null {
  return value === null ? null : isoText(value, label);
}

function timestampValue(value: unknown, label: string): string | Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  return isoText(value, label);
}

function dateValue(value: unknown, label: string): string | Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00Z`))) {
    throw new PersistenceIntegrityError(`${label} 값이 ISO date가 아닙니다.`);
  }
  return result;
}

function isGameStatus(value: string): value is StagingGameDocumentV2["metadata"]["status"] {
  return ["scheduled", "in_progress", "final", "suspended", "cancelled"].includes(value);
}

export function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
