import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { parseOfficialPlayerHeights } from "@kbo/contracts";
import { PlayerHeightRepository, PlayerHeightSupplementRepository } from "@kbo/persistence";
import { loadConfig } from "../config.js";
import { ComputationPool } from "../computation-pool.js";

/** Explicit, resumable import from immutable local source bundles. No network or game rewrites. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let profilesPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profiles" && profilesPath === undefined && args[i + 1] !== undefined) {
      profilesPath = args[++i];
    } else if (args[i] !== "--dry-run") {
      throw new Error("허용되는 인자: --dry-run, --profiles <검토한 공식 키 JSON>");
    }
  }
  const dryRun = args.includes("--dry-run");
  const profiles =
    profilesPath === undefined
      ? []
      : parseOfficialPlayerHeights(JSON.parse(await readFile(profilesPath, "utf8")));
  const config = loadConfig();
  const pool = new Pool(config.database);
  const workers = new ComputationPool();
  const repository = new PlayerHeightRepository(pool);
  const supplements = new PlayerHeightSupplementRepository(pool);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let completed = 0,
    failed = 0,
    observations = 0,
    next = 0;
  try {
    const pending = await repository.pendingSources();
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
                kind: "player_heights",
                root: config.workspacePath,
                gameId: source.gameId,
                season: source.season,
                hash: source.sourceBundleHash,
              },
              controller.signal,
            );
            if (result.kind !== "player_heights")
              throw new Error("Unexpected player height result");
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
    if (failed > 0 || controller.signal.aborted) {
      process.exitCode = 1;
    } else {
      // Resolve only after every pending source was checked, so fallback cannot hide an unread source.
      const officialAdded = dryRun ? 0 : await supplements.importOfficialProfiles(profiles);
      process.stdout.write(
        JSON.stringify({ dryRun, officialProfiles: profiles.length, officialAdded }) + "\n",
      );
      if (!dryRun) {
        for (const season of await supplements.seasons()) {
          if (controller.signal.aborted) {
            process.exitCode = 1;
            break;
          }
          const choices = await supplements.resolveSeason(season);
          process.stdout.write(JSON.stringify({ season, choices }) + "\n");
        }
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await workers.close();
    await pool.end();
  }
}
await main();
