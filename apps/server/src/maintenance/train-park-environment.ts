import { modelTrainingPeriod } from "@kbo/game-core";
import { Pool } from "pg";
import { StagingWorkspace, ParkEnvironmentRepository, parkTrainingHash } from "@kbo/persistence";
import { loadConfig } from "../config.js";
import { ComputationPool } from "../computation-pool.js";
import { TrainingMeasurement } from "./training-measurement.js";
async function main() {
  const args = process.argv.slice(2);
  let through = 2024,
    dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--through") through = Number(args[++i]);
    else if (args[i] === "--dry-run") dryRun = true;
    else throw new Error("허용 인자: --through <2020–2024> [--dry-run]");
  }
  if (!Number.isInteger(through) || through < 2020 || through > 2024)
    throw new Error("훈련 마지막 시즌은 2020–2024여야 합니다.");
  if (modelTrainingPeriod("park", through + 1).support !== "eligible")
    throw new Error("적용 시즌 이전의 학습 자료와 두 검증 시즌이 필요합니다.");
  const config = loadConfig(),
    pool = new Pool({ ...config.database, max: 1 }),
    worker = new ComputationPool(1, 1, 30 * 60_000),
    controller = new AbortController(),
    stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let workspace: StagingWorkspace | undefined;
  const measurement = new TrainingMeasurement();
  try {
    if (!dryRun) workspace = await StagingWorkspace.open(config.workspacePath);
    const input = await new ParkEnvironmentRepository(pool).training(through, controller.signal);
    measurement.mark("read");
    const sourceHash = parkTrainingHash(input.manifest),
      result = await worker.run(
        { kind: "park_model", rows: input.rows, through, sourceHash },
        controller.signal,
      );
    if (result.kind !== "park_model") throw new Error("Unexpected model result");
    measurement.mark("fit");
    controller.signal.throwIfAborted();
    const modelHash =
      workspace === undefined
        ? null
        : await workspace.parkEnvironment.save(result.value, input.manifest, controller.signal);
    measurement.mark("save");
    process.stdout.write(
      JSON.stringify({
        dryRun,
        through,
        sourceHash,
        modelHash,
        rows: input.rows.length,
        metrics: result.value.metrics.map((m) => ({
          metric: m.metric,
          adopted: m.adopted,
          selectedFamily: m.fitted.family,
          trainingGames: m.fitted.trainingGames,
          dispersion: m.fitted.dispersion,
          validation: m.validation,
          evaluation: m.evaluation,
        })),
        ...measurement.report(),
      }) + "\n",
    );
  } finally {
    measurement.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await worker.close();
    await workspace?.close();
    await pool.end();
  }
}
await main();
