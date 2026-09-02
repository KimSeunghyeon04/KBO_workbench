import { createHash, randomUUID } from "node:crypto";

import { KboRegistryCollector, KboRegistryHttpClient } from "@kbo/collection";
import { RegistryRepository, RegistryWorkspace } from "@kbo/persistence";
import { Pool } from "pg";

import { loadConfig } from "../config.js";

interface Options {
  readonly season: number;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly dryRun: boolean;
  readonly resumeRunId?: string;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  const pool = new Pool(config.database);
  const repository = new RegistryRepository(pool, config.expectedMigrationVersion);
  const range =
    options.dateFrom !== undefined && options.dateTo !== undefined
      ? { dateFrom: options.dateFrom, dateTo: options.dateTo }
      : await repository.seasonDateRange(options.season);
  const runId = options.resumeRunId ?? randomUUID();
  const workspace = new RegistryWorkspace(config.workspacePath, options.season, runId);
  process.stdout.write(
    `${JSON.stringify({
      runId,
      status: "collecting",
      dryRun: options.dryRun,
      season: options.season,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    })}\n`,
  );
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("registry sync가 중단되었습니다."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const collector = new KboRegistryCollector(
      new KboRegistryHttpClient({
        maxAttempts: positiveInteger("KBO_REGISTRY_MAX_ATTEMPTS", 3),
        requestsPerSecond: positiveNumber("KBO_REGISTRY_REQUESTS_PER_SECOND", 2),
        timeoutMs: positiveInteger("KBO_REGISTRY_TIMEOUT_MS", 15_000),
      }),
    );
    const result = await collector.collect({
      season: options.season,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      concurrency: positiveInteger("KBO_REGISTRY_CONCURRENCY", 2),
      signal: controller.signal,
      sink: async (page) =>
        options.dryRun
          ? {
              artifactKey: `dry-run/${page.requestKey}`,
              contentHash: createHash("sha256").update(page.body, "utf8").digest("hex"),
            }
          : workspace.savePage(page),
      ...(options.resumeRunId === undefined || options.dryRun
        ? {}
        : {
            cache: async (pageKind: "register" | "trade", requestKey: string) => {
              const page = await workspace.readPage(pageKind, requestKey);
              return page === null
                ? null
                : {
                    body: page.body,
                    collectedAt: page.collectedAt,
                    artifactKey: page.artifactKey,
                    contentHash: page.contentHash,
                  };
            },
          }),
    });
    const imported = options.dryRun
      ? null
      : await repository.importSeason(runId, result.dataset, result.sourceBundleHash);
    process.stdout.write(
      `${JSON.stringify({
        runId,
        dryRun: options.dryRun,
        season: options.season,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        sourcePages: result.dataset.sourcePages.length,
        registrationSnapshots: result.dataset.registrationSnapshots.length,
        statusEvents: result.dataset.statusEvents.length,
        sourceBundleHash: result.sourceBundleHash,
        imported,
      })}\n`,
    );
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await pool.end();
  }
}

function parseArguments(args: readonly string[]): Options {
  let season: number | undefined;
  let dateFrom: string | undefined;
  let dateTo: string | undefined;
  let dryRun = false;
  let resumeRunId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--season") {
      season = Number(args[index + 1]);
      index += 1;
    } else if (argument === "--from") {
      dateFrom = args[index + 1];
      index += 1;
    } else if (argument === "--to") {
      dateTo = args[index + 1];
      index += 1;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--resume") {
      resumeRunId = args[index + 1];
      index += 1;
    } else {
      throw new Error(`알 수 없는 registry sync 인자입니다: ${argument ?? "없음"}`);
    }
  }
  if (season === undefined || !Number.isInteger(season) || season < 2017 || season > 9999)
    throw new Error("registry season은 2017 이상이어야 합니다.");
  if ((dateFrom === undefined) !== (dateTo === undefined))
    throw new Error("--from과 --to는 함께 지정해야 합니다.");
  if (
    dateFrom !== undefined &&
    (!date(dateFrom) ||
      !date(dateTo ?? "") ||
      dateFrom > (dateTo ?? "") ||
      !dateFrom.startsWith(`${String(season)}-`) ||
      !(dateTo ?? "").startsWith(`${String(season)}-`))
  )
    throw new Error("registry 날짜 범위가 올바르지 않습니다.");
  if (dryRun && resumeRunId !== undefined)
    throw new Error("--dry-run과 --resume은 함께 사용할 수 없습니다.");
  if (resumeRunId !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(resumeRunId))
    throw new Error("resume run ID 형식이 올바르지 않습니다.");
  return {
    season,
    ...(dateFrom === undefined ? {} : { dateFrom }),
    ...(dateTo === undefined ? {} : { dateTo }),
    dryRun,
    ...(resumeRunId === undefined ? {} : { resumeRunId }),
  };
}

function date(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}은 양의 정수여야 합니다.`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}은 양수여야 합니다.`);
  return value;
}

await main();
