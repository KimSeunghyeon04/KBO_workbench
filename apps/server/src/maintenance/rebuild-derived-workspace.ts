import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { RawGameBundle } from "@kbo/collection";
import { stagingDocumentHash } from "@kbo/game-core";
import { GameRevisionStore, StagingWorkspace } from "@kbo/persistence";
import { Pool } from "pg";

import { loadConfig } from "../config.js";
import { projectNaverSourceBundle } from "../source-projection.js";
import {
  assertNoUnexpectedQuarantineIncrease,
  type RebuildFindingProjection,
} from "./derived-rebuild-validation.js";

interface RebuildSummary {
  readonly season: number;
  readonly games: number;
  readonly ready: number;
  readonly quarantined: number;
  readonly pendingTracking: number;
  readonly sourceHashesVerified: number;
  readonly replaced: boolean;
}

interface DerivedGame {
  readonly gameId: string;
  readonly season: number;
  readonly authority: "staging" | "quarantine";
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  const workspaceRoot = path.resolve(options.workspace ?? config.workspacePath);
  await assertNoActiveWriterOrJournal(workspaceRoot);
  await assertDatabaseEmpty(config);

  const runId = randomUUID();
  const temporaryRoot = path.join(workspaceRoot, `.derived-rebuild-${runId}`);
  const rollbackRoot = path.join(workspaceRoot, `.derived-rollback-${runId}`);
  let sourceWorkspace: StagingWorkspace | null = null;
  let targetWorkspace: StagingWorkspace | null = null;
  let replaced = false;
  try {
    sourceWorkspace = await StagingWorkspace.open(workspaceRoot);
    targetWorkspace = await StagingWorkspace.open(temporaryRoot);
    const games = derivedGames(await sourceWorkspace.catalog(), options.season);
    if (games.length === 0) throw new Error(`${String(options.season)} 파생 원장이 없습니다.`);
    const baselineQuarantined = games.filter((game) => game.authority === "quarantine").length;

    let ready = 0;
    let quarantined = 0;
    let pendingTracking = 0;
    const expectedSourceHashes = new Map<string, string>();
    const findingProjections: RebuildFindingProjection[] = [];
    for (const game of games) {
      const current = await sourceWorkspace.readDocument(game.authority, game.season, game.gameId);
      expectedSourceHashes.set(game.gameId, current.source.sourceBundleHash);
      const source = await sourceWorkspace.readSourceBundle(
        game.season,
        game.gameId,
        current.source.sourceBundleHash,
      );
      const bundle: RawGameBundle = {
        gameId: source.gameId,
        collectedAt: source.collectedAt,
        payloads: source.payloads,
        missingEndpoints: source.missingEndpoints,
      };
      const projection = projectNaverSourceBundle(bundle, null);
      findingProjections.push({ gameId: game.gameId, findings: projection.findings });
      if (projection.document.source.sourceBundleHash !== current.source.sourceBundleHash) {
        throw new Error(`재생성 source hash가 현재 문서와 다릅니다: ${game.gameId}`);
      }
      pendingTracking += projection.document.trackingCandidates.filter(
        (candidate) => candidate.resolution.kind === "pending",
      ).length;
      if (projection.findings.some((finding) => finding.severity === "blocking")) {
        await targetWorkspace.saveQuarantine(projection.document, projection.findings);
        quarantined += 1;
      } else {
        await targetWorkspace.saveReady(projection.document, projection.findings);
        ready += 1;
      }
    }
    assertNoUnexpectedQuarantineIncrease(baselineQuarantined, findingProjections);
    if (pendingTracking !== 0) {
      throw new Error(`재생성 후 pending tracking이 ${String(pendingTracking)}개 남았습니다.`);
    }
    await validateDerivedWorkspace(targetWorkspace, options.season, games.length);
    await targetWorkspace.close();
    targetWorkspace = null;
    await sourceWorkspace.close();
    sourceWorkspace = null;

    if (options.confirmReplacement) {
      await replaceSeasonDirectories(workspaceRoot, temporaryRoot, rollbackRoot, options.season);
      replaced = true;
      const verification = await StagingWorkspace.open(workspaceRoot);
      try {
        await validateDerivedWorkspace(verification, options.season, games.length);
        const rebuiltAuthorities = new Map(
          derivedGames(await verification.catalog(), options.season).map((game) => [
            game.gameId,
            game.authority,
          ]),
        );
        for (const game of games) {
          const authority = rebuiltAuthorities.get(game.gameId);
          if (authority === undefined) {
            throw new Error(`교체 후 원장을 찾지 못했습니다: ${game.gameId}`);
          }
          const rebuilt = await verification.readDocument(authority, game.season, game.gameId);
          if (rebuilt.source.sourceBundleHash !== expectedSourceHashes.get(game.gameId)) {
            throw new Error(`교체 후 source hash가 다릅니다: ${game.gameId}`);
          }
          void stagingDocumentHash(rebuilt);
        }
      } catch (error: unknown) {
        await verification.close();
        await rollbackSeasonDirectories(workspaceRoot, rollbackRoot, options.season);
        replaced = false;
        throw error;
      }
      await verification.close();
      await removeControlledDirectory(workspaceRoot, rollbackRoot, ".derived-rollback-");
      await removeControlledDirectory(workspaceRoot, temporaryRoot, ".derived-rebuild-");
    }

    const summary: RebuildSummary = {
      season: options.season,
      games: games.length,
      ready,
      quarantined,
      pendingTracking,
      sourceHashesVerified: games.length,
      replaced,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await targetWorkspace?.close().catch(() => undefined);
    await sourceWorkspace?.close().catch(() => undefined);
    if (!replaced) {
      await removeControlledDirectory(workspaceRoot, temporaryRoot, ".derived-rebuild-").catch(
        () => undefined,
      );
    }
  }
}

async function assertDatabaseEmpty(config: ReturnType<typeof loadConfig>): Promise<void> {
  const pool = new Pool(config.database);
  try {
    const stored = await new GameRevisionStore(
      pool,
      config.expectedMigrationVersion,
    ).countStoredGames();
    if (stored !== 0) {
      throw new Error(`DB 적재 경기가 ${String(stored)}건이므로 파생 원장을 교체할 수 없습니다.`);
    }
  } finally {
    await pool.end();
  }
}

async function assertNoActiveWriterOrJournal(workspaceRoot: string): Promise<void> {
  try {
    await access(path.join(workspaceRoot, ".writer.lock"));
    throw new Error("workspace writer가 실행 중입니다. API를 먼저 중지하세요.");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const journals = await readdir(path.join(workspaceRoot, "journals"), {
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  if (journals.some((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
    throw new Error("활성 journal이 있어 파생 원장을 교체할 수 없습니다.");
  }
}

async function validateDerivedWorkspace(
  workspace: StagingWorkspace,
  season: number,
  expectedGames: number,
): Promise<void> {
  const games = derivedGames(await workspace.catalog(), season);
  if (
    games.length !== expectedGames ||
    new Set(games.map((game) => game.gameId)).size !== expectedGames
  ) {
    throw new Error(
      `재생성 원장 수가 다릅니다: expected=${String(expectedGames)}, actual=${String(games.length)}`,
    );
  }
  for (const game of games) {
    const document = await workspace.readDocument(game.authority, season, game.gameId);
    const original = await workspace.readOriginal(season, game.gameId);
    if (stagingDocumentHash(document) !== stagingDocumentHash(original)) {
      throw new Error(`재생성 original과 현재 원장이 다릅니다: ${game.gameId}`);
    }
  }
}

function derivedGames(
  catalog: Awaited<ReturnType<StagingWorkspace["catalog"]>>,
  season: number,
): DerivedGame[] {
  return catalog.games.flatMap((game) =>
    game.season === season && (game.authority === "staging" || game.authority === "quarantine")
      ? [{ gameId: game.gameId, season, authority: game.authority }]
      : [],
  );
}

async function replaceSeasonDirectories(
  workspaceRoot: string,
  temporaryRoot: string,
  rollbackRoot: string,
  season: number,
): Promise<void> {
  await mkdir(rollbackRoot, { recursive: false });
  const moved: Array<{ target: string; backup: string; incoming: string }> = [];
  try {
    for (const authority of ["original", "staging", "quarantine"] as const) {
      const target = path.join(workspaceRoot, authority, String(season));
      const incoming = path.join(temporaryRoot, authority, String(season));
      const backup = path.join(rollbackRoot, authority);
      await rename(target, backup);
      moved.push({ target, backup, incoming });
      await rename(incoming, target);
    }
  } catch (error: unknown) {
    for (const item of [...moved].reverse()) {
      await rename(item.target, item.incoming).catch(() => undefined);
      await rename(item.backup, item.target).catch(() => undefined);
    }
    throw error;
  }
}

async function rollbackSeasonDirectories(
  workspaceRoot: string,
  rollbackRoot: string,
  season: number,
): Promise<void> {
  for (const authority of ["original", "staging", "quarantine"] as const) {
    const target = path.join(workspaceRoot, authority, String(season));
    const failed = path.join(workspaceRoot, `.derived-failed-${randomUUID()}-${authority}`);
    const backup = path.join(rollbackRoot, authority);
    await rename(target, failed);
    await rename(backup, target);
    await removeControlledDirectory(workspaceRoot, failed, ".derived-failed-");
  }
}

async function removeControlledDirectory(
  workspaceRoot: string,
  target: string,
  requiredPrefix: string,
): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(requiredPrefix)) {
    throw new Error(`삭제 대상이 허용된 임시 디렉터리가 아닙니다: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

function parseArguments(args: readonly string[]): {
  readonly season: number;
  readonly workspace?: string;
  readonly confirmReplacement: boolean;
} {
  let season = 2024;
  let workspace: string | undefined;
  let confirmReplacement = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--season") {
      season = Number(args[index + 1]);
      index += 1;
    } else if (argument === "--workspace") {
      workspace = args[index + 1];
      index += 1;
    } else if (argument === "--confirm-derived-replacement") {
      confirmReplacement = true;
    } else {
      throw new Error(`알 수 없는 인자입니다: ${argument ?? "없음"}`);
    }
  }
  if (!Number.isInteger(season) || season < 1982 || season > 9999) {
    throw new Error("season이 올바르지 않습니다.");
  }
  return {
    season,
    ...(workspace === undefined ? {} : { workspace }),
    confirmReplacement,
  };
}

await main();
