import { access, appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { GameRevisionStore, StagingWorkspace, verifyBackupDirectory } from "@kbo/persistence";
import { Pool } from "pg";

import { loadConfig } from "../config.js";
import { enrichPitchMetadataGame } from "./pitch-metadata-enrichment.js";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2).filter((arg) => arg !== "--"));
  const config = loadConfig();
  const root = path.resolve(options.workspace ?? config.workspacePath);
  await assertOffline(root);
  if (options.apply) {
    if (options.backup === undefined)
      throw new Error("--apply는 workspace·DB 쌍의 --backup 경로가 필요합니다.");
    await verifyBackupDirectory(options.backup);
    const manifest: unknown = JSON.parse(
      await readFile(path.join(options.backup, "manifest.json"), "utf8"),
    );
    if (
      !isRecord(manifest) ||
      !isRecord(manifest.database) ||
      manifest.database.name !== config.database.database
    ) {
      throw new Error("백업의 database name이 적용 대상 DB와 다릅니다.");
    }
  }
  const pool = new Pool({ ...config.database, max: 2 });
  let workspace: StagingWorkspace | undefined;
  try {
    const store = new GameRevisionStore(pool, config.expectedMigrationVersion);
    workspace = await StagingWorkspace.open(root);
    const local = (await workspace.catalog()).games;
    const excluded = new Set(
      local.filter((game) => game.authority === "source_failure").map((game) => game.gameId),
    );
    const games = new Map(
      [...(await store.catalog()), ...local.filter((game) => game.authority !== "source_failure")]
        .filter((game) => options.season === undefined || game.season === options.season)
        .map((game) => [game.gameId, game]),
    );
    const report = path.resolve(
      options.report ??
        path.join(
          root,
          "logs",
          `pitch-metadata-${new Date().toISOString().replaceAll(":", "-")}.jsonl`,
        ),
    );
    await mkdir(path.dirname(report), { recursive: true });
    await appendFile(
      report,
      `${JSON.stringify({ kind: "run", mode: options.apply ? "apply" : "dry-run", games: games.size, excludedSourceFailures: [...excluded].sort() })}\n`,
      { flag: "wx" },
    );
    const summary = {
      games: 0,
      changedGames: 0,
      changedPitches: 0,
      unchanged: 0,
      failed: 0,
      pitches: 0,
      beforeSpeed: 0,
      afterSpeed: 0,
      beforeType: 0,
      afterType: 0,
    };
    for (const gameId of [...games.keys()].sort()) {
      let result: unknown;
      try {
        const game = await enrichPitchMetadataGame(workspace, store, gameId, options.apply);
        summary.games += 1;
        summary.changedPitches += game.changedPitches;
        summary.changedGames += game.changedPitches > 0 ? 1 : 0;
        summary.unchanged += game.changedPitches === 0 ? 1 : 0;
        summary.pitches += game.before.pitches;
        summary.beforeSpeed += game.before.speed;
        summary.afterSpeed += game.after.speed;
        summary.beforeType += game.before.type;
        summary.afterType += game.after.type;
        result = game;
      } catch (error: unknown) {
        summary.failed += 1;
        result = {
          gameId,
          status: "failed",
          message: error instanceof Error ? error.message : "알 수 없는 보완 실패",
        };
      }
      await appendFile(report, `${JSON.stringify(result)}\n`);
      const completed = summary.games + summary.failed;
      if (completed % 25 === 0 || completed === games.size)
        process.stdout.write(
          `${String(completed)}/${String(games.size)} games, ${String(summary.failed)} failed\n`,
        );
    }
    const rates = {
      beforeSpeedRate: rate(summary.beforeSpeed, summary.pitches),
      afterSpeedRate: rate(summary.afterSpeed, summary.pitches),
      beforeTypeRate: rate(summary.beforeType, summary.pitches),
      afterTypeRate: rate(summary.afterType, summary.pitches),
    };
    await appendFile(report, `${JSON.stringify({ kind: "summary", ...summary, ...rates })}\n`);
    process.stdout.write(`${JSON.stringify({ ...summary, ...rates, report })}\n`);
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await workspace?.close();
    await pool.end();
  }
}

async function assertOffline(root: string): Promise<void> {
  try {
    await access(path.join(root, ".writer.lock"));
    throw new Error("workspace writer가 실행 중입니다. API·수집 writer를 먼저 중지하세요.");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const journals = await readdir(path.join(root, "journals")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  if (journals.some((name) => name.endsWith(".json")))
    throw new Error("미완료 journal을 정상 writer로 복구한 뒤 다시 실행하세요.");
}

function parseOptions(args: readonly string[]) {
  let mode: "--apply" | "--dry-run" | undefined;
  let backup: string | undefined;
  let workspace: string | undefined;
  let report: string | undefined;
  let season: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--apply" || name === "--dry-run") {
      if (mode !== undefined) throw new Error("--dry-run 또는 --apply 중 하나만 지정하세요.");
      mode = name;
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error("옵션 값이 없습니다.");
    if (name === "--backup") backup = path.resolve(value);
    else if (name === "--workspace") workspace = value;
    else if (name === "--report") report = value;
    else if (name === "--season") season = Number(value);
    else throw new Error(`알 수 없는 옵션: ${name ?? "없음"}`);
  }
  if (
    mode === undefined ||
    (season !== undefined && (!Number.isInteger(season) || season < 1982 || season > 9999))
  ) {
    throw new Error(
      "사용법: maintenance:enrich-pitch-metadata -- --dry-run|--apply [--backup <dir>] [--workspace <dir>] [--season <year>] [--report <new.jsonl>]",
    );
  }
  return { apply: mode === "--apply", backup, workspace, report, season };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function rate(value: number, total: number) {
  return total === 0 ? null : value / total;
}

await main();
