import { createHash } from "node:crypto";
import { Pool } from "pg";
import { KboScheduleCollector, linkKboCompetitionGames } from "@kbo/collection";
import { GameCompetitionRepository, StagingWorkspace } from "@kbo/persistence";
import { loadConfig } from "../config.js";

async function main() {
  const args = process.argv.slice(2);
  let season: number | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--season" && season === undefined) season = Number(args[++index]);
    else if (args[index] === "--dry-run") dryRun = true;
    else throw new Error("허용 인자: --season <연도> [--dry-run]");
  }
  if (season === undefined || !Number.isInteger(season) || season < 1982 || season > 2200)
    throw new Error("시즌이 필요합니다.");
  const config = loadConfig(),
    pool = new Pool(config.database);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let workspace: StagingWorkspace | undefined;
  try {
    if (!dryRun) workspace = await StagingWorkspace.open(config.workspacePath);
    const seasonValue = season;
    const dataset = await new KboScheduleCollector().collect(
      season,
      async (page) => {
        const hash = createHash("sha256").update(page.body).digest("hex");
        return workspace === undefined
          ? { artifactKey: `dry-run/${hash}`, contentHash: hash }
          : workspace.competitionSources.save(seasonValue, page);
      },
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const repository = new GameCompetitionRepository(pool);
    const links = linkKboCompetitionGames(dataset, await repository.games(season));
    const result = await repository.adopt(dataset, dryRun, links);
    process.stdout.write(JSON.stringify({ season, ...result }) + "\n");
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await workspace?.close();
    await pool.end();
  }
}
await main();
