import { Pool } from "pg";
import { modelTrainingPeriod } from "@kbo/game-core";
import { ComputationPool } from "../computation-pool.js";
import type { RunModelObservation } from "../run-model-computation.js";
import { RunValueRepository, runTrainingHash, StagingWorkspace } from "@kbo/persistence";
import { loadConfig } from "../config.js";
import { TrainingMeasurement } from "./training-measurement.js";
async function main() {
  const args = process.argv.slice(2);
  let through = 2024,
    dryRun = false,
    countModel = false,
    winModel = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--through") through = Number(args[++i]);
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--count") countModel = true;
    else if (args[i] === "--win") winModel = true;
    else throw new Error("허용 인자: --through <2020–2024> [--count | --win] [--dry-run]");
  }
  if (!Number.isInteger(through) || through < 2020 || through > 2024)
    throw new Error("훈련 마지막 시즌은 2020–2024여야 합니다.");
  if (
    modelTrainingPeriod(winModel ? "win" : countModel ? "count" : "re24", through + 1).support !==
    "eligible"
  )
    throw new Error("적용 시즌 이전의 지원 규정·학습 자료와 두 검증 시즌이 필요합니다.");
  if (countModel && winModel) throw new Error("학습 모델은 한 번에 하나를 선택합니다.");
  const config = loadConfig(),
    pool = new Pool({ ...config.database, max: 1 }),
    controller = new AbortController(),
    stop = () => controller.abort();
  const worker = new ComputationPool(1, 1, 30 * 60_000);
  let workspace: StagingWorkspace | undefined;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const measurement = new TrainingMeasurement();
  try {
    if (!dryRun) workspace = await StagingWorkspace.open(config.workspacePath);
    const kind = winModel ? "win" : countModel ? "count" : "re24";
    const input = await new RunValueRepository(pool).training(through, controller.signal, kind);
    measurement.mark("read");
    controller.signal.throwIfAborted();
    const sourceHash = runTrainingHash(input.manifest);
    const rows: RunModelObservation[] = winModel
      ? input.winObservations.map((value) => ({ record: "win", value }))
      : input.observations.map((value) => ({ record: "pa", value }));
    if (countModel)
      for (const value of input.countObservations) rows.push({ record: "count", value });
    const result = await worker.run(
      { kind: "run_model", model: kind, through, sourceHash, rows },
      controller.signal,
    );
    if (result.kind !== "run_model") throw new Error("Unexpected model computation");
    measurement.mark("fit");
    const model = result.value;
    controller.signal.throwIfAborted();
    const modelHash =
      workspace === undefined
        ? null
        : model.kind === "home-win-draw-loss"
          ? await workspace.runExpectancy.saveWin(model, input.manifest, controller.signal)
          : model.kind === "decision-count-re"
            ? await workspace.runExpectancy.saveCount(model, input.manifest, controller.signal)
            : await workspace.runExpectancy.save(model, input.manifest, controller.signal);
    measurement.mark("save");
    process.stdout.write(
      JSON.stringify({
        dryRun,
        through,
        sourceHash,
        status: model.status,
        method: model.kind === "decision-count-re" ? model.shrinkage : model.method,
        trainingSamples:
          model.kind === "home-win-draw-loss" ? model.trainingStates : model.trainingSamples,
        trainingGames: model.trainingGames,
        validation: model.validation,
        evaluation: model.evaluation,
        modelHash,
        ...measurement.report(),
      }) + "\n",
    );
  } finally {
    measurement.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await workspace?.close();
    await worker.close();
    await pool.end();
  }
}
await main();
