import { modelTrainingPeriod } from "@kbo/game-core";
import { Pool } from "pg";
import { StagingWorkspace, PitchQualityRepository, pitchQualitySourceHash } from "@kbo/persistence";
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
  if (modelTrainingPeriod("quality", through + 1).support !== "eligible")
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
    const input = await new PitchQualityRepository(pool).training(through, controller.signal);
    measurement.mark("read");
    const sourceHash = pitchQualitySourceHash(input.manifest),
      result = await worker.run(
        { kind: "pitch_quality_model", rows: input.rows, through, sourceHash },
        controller.signal,
      );
    if (result.kind !== "pitch_quality_model") throw new Error("Unexpected model result");
    measurement.mark("fit");
    controller.signal.throwIfAborted();
    const modelHash =
      workspace === undefined
        ? null
        : await workspace.pitchQuality.save(result.value, input.manifest, controller.signal);
    measurement.mark("save");
    process.stdout.write(
      JSON.stringify({
        dryRun,
        through,
        sourceHash,
        modelHash,
        rows: input.rows.length,
        targets: result.value.targets.map((m) => ({
          target: m.target,
          adopted: m.adopted,
          selectedKind: m.fitted.kind,
          selectedLambda: m.fitted.lambda,
          trainingPitches: m.fitted.samples,
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
