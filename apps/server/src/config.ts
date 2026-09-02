export const EXPECTED_POSTGRES_MAJOR_VERSION = 16;
export const EXPECTED_MIGRATION_VERSION = "0003_record_correction_scope_classification";

export interface AppConfig {
  readonly apiVersion: string;
  readonly database: {
    readonly database: string;
    readonly host: string;
    readonly password: string;
    readonly port: number;
    readonly user: string;
  };
  readonly expectedMigrationVersion: string;
  readonly collection: {
    readonly maxConcurrentJobs: number;
    readonly maxAttempts: number;
    readonly requestsPerSecond: number;
    readonly timeoutMs: number;
  };
  readonly host: string;
  readonly port: number;
  readonly workspacePath: string;
  readonly recordCorrection: {
    readonly autoSync: boolean;
    readonly maxAttempts: number;
    readonly requestsPerSecond: number;
    readonly timeoutMs: number;
    readonly syncIntervalMs: number;
    readonly retryIntervalMs: number;
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`필수 환경 변수가 없습니다: ${name}`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "3000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`유효하지 않은 PORT입니다: ${value ?? ""}`);
  }
  return parsed;
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}은 양의 정수여야 합니다.`);
  return value;
}

function positiveNumberEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}은 양수여야 합니다.`);
  return value;
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name}은 true 또는 false여야 합니다.`);
}

export function loadConfig(): AppConfig {
  return {
    apiVersion: process.env.APP_VERSION?.trim() || "3.1.1",
    collection: {
      maxConcurrentJobs: positiveIntegerEnvironment("KBO_COLLECTION_CONCURRENCY", 1),
      maxAttempts: positiveIntegerEnvironment("KBO_NAVER_MAX_ATTEMPTS", 3),
      requestsPerSecond: positiveNumberEnvironment("KBO_NAVER_REQUESTS_PER_SECOND", 4),
      timeoutMs: positiveIntegerEnvironment("KBO_NAVER_TIMEOUT_MS", 15_000),
    },
    database: {
      database: requiredEnvironment("PGDATABASE"),
      host: process.env.PGHOST?.trim() || "db",
      password: requiredEnvironment("PGPASSWORD"),
      port: parsePort(process.env.PGPORT ?? "5432"),
      user: requiredEnvironment("PGUSER"),
    },
    expectedMigrationVersion:
      process.env.EXPECTED_MIGRATION_VERSION?.trim() || EXPECTED_MIGRATION_VERSION,
    host: process.env.HOST?.trim() || "0.0.0.0",
    port: parsePort(process.env.PORT),
    recordCorrection: {
      autoSync: booleanEnvironment("KBO_RECORD_CORRECTION_AUTO_SYNC", true),
      maxAttempts: positiveIntegerEnvironment("KBO_RECORD_CORRECTION_MAX_ATTEMPTS", 3),
      requestsPerSecond: positiveNumberEnvironment("KBO_RECORD_CORRECTION_REQUESTS_PER_SECOND", 2),
      timeoutMs: positiveIntegerEnvironment("KBO_RECORD_CORRECTION_TIMEOUT_MS", 15_000),
      syncIntervalMs: positiveIntegerEnvironment(
        "KBO_RECORD_CORRECTION_SYNC_INTERVAL_MS",
        24 * 60 * 60 * 1_000,
      ),
      retryIntervalMs: positiveIntegerEnvironment(
        "KBO_RECORD_CORRECTION_RETRY_INTERVAL_MS",
        6 * 60 * 60 * 1_000,
      ),
    },
    workspacePath: process.env.KBO_DATA_DIR?.trim() || "/var/lib/kbo",
  };
}
