import { Pool } from "pg";
import { PlayerBattingProfileRepository } from "@kbo/persistence";
import { loadConfig } from "../config.js";
import { ComputationPool } from "../computation-pool.js";

/** Explicit, resumable extraction from verified local bundles; no network or game rewrites. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let season: number | null = null,
    gameId: string | null = null,
    dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i],
      value = args[i + 1];
    if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (
      arg === "--season" &&
      season === null &&
      value !== undefined &&
      /^\d{4}$/.test(value) &&
      Number(value) >= 1982
    ) {
      season = Number(value);
      i++;
    } else if (
      arg === "--game" &&
      gameId === null &&
      value !== undefined &&
      /^[A-Za-z0-9_-]{1,100}$/.test(value)
    ) {
      gameId = value;
      i++;
    } else throw new Error("허용되는 인자: --dry-run, --season <연도>, --game <경기 ID>");
  }
  const config = loadConfig();
  const pool = new Pool(config.database);
  const workers = new ComputationPool();
  const repository = new PlayerBattingProfileRepository(pool);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let completed = 0,
    failed = 0,
    observations = 0,
    next = 0;
  try {
    const pending = await repository.pendingSources(season, gameId);
    process.stdout.write(JSON.stringify({ dryRun, pending: pending.length }) + "\n");
    await workers.warmup();
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (!controller.signal.aborted) {
          const source = pending[next++];
          if (source === undefined) return;
          try {
            const result = await workers.run(
              {
                kind: "player_batting_profiles",
                root: config.workspacePath,
                gameId: source.gameId,
                season: source.season,
                hash: source.sourceBundleHash,
              },
              controller.signal,
            );
            if (result.kind !== "player_batting_profiles")
              throw new Error("Unexpected batting profile result");
            if (!dryRun) await repository.importDataset(result.value);
            observations += result.value.observations.length;
            completed++;
            if (completed % 50 === 0)
              process.stdout.write(
                JSON.stringify({ completed, failed, total: pending.length, observations }) + "\n",
              );
          } catch (error: unknown) {
            failed++;
            process.stderr.write(
              JSON.stringify({
                gameId: source.gameId,
                error: error instanceof Error ? error.message : String(error),
              }) + "\n",
            );
          }
        }
      }),
    );
    process.stdout.write(
      JSON.stringify({ dryRun, completed, failed, total: pending.length, observations }) + "\n",
    );
    if (failed > 0 || controller.signal.aborted) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await workers.close();
    await pool.end();
  }
}
await main();
