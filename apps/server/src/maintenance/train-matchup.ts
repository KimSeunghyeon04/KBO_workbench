import { modelTrainingPeriod } from "@kbo/game-core";
import { Worker } from "node:worker_threads";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { MatchupModelSchema } from "@kbo/contracts";
import { StagingWorkspace, PitchQualityManifestSchema } from "@kbo/persistence";
import { loadConfig } from "../config.js";
import { TrainingMeasurement } from "./training-measurement.js";
async function main() {
  let through = 2024,
    dryRun = false,
    baseDirectory: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--through") through = Number(args[++i]);
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--base-workspace") {
      baseDirectory = args[++i];
      if (!baseDirectory) throw new Error("Missing base workspace");
    } else
      throw new Error("허용 인자: --through <2020–2024> [--dry-run] [--base-workspace <path>]");
  }
  if (!Number.isInteger(through) || through < 2020 || through > 2024)
    throw new Error("훈련 마지막 시즌은 2020–2024여야 합니다.");
  if (modelTrainingPeriod("matchup", through + 1).support !== "eligible")
    throw new Error("적용 시즌 이전의 학습 자료와 두 검증 시즌이 필요합니다.");
  const config = loadConfig(),
    controller = new AbortController(),
    stop = () => controller.abort(),
    measurement = new TrainingMeasurement();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let workspace: StagingWorkspace | undefined;
  let worker: Worker | undefined;
  try {
    if (!dryRun) workspace = await StagingWorkspace.open(config.workspacePath);
    controller.signal.throwIfAborted();
    worker = new Worker(new URL("./matchup-training-worker.js", import.meta.url), {
      workerData: { through, baseDirectory: baseDirectory ?? config.workspacePath },
    });
    const resultSchema = Type.Object(
      {
        model: MatchupModelSchema,
        manifest: PitchQualityManifestSchema,
        rows: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    );
    const phaseSchema = Type.Object(
      { phase: Type.Literal("read") },
      { additionalProperties: false },
    );
    const activeWorker = worker;
    const result = await new Promise<ReturnType<typeof decodeResult>>((resolve, reject) => {
      const timeout = setTimeout(
          () => reject(new Error("Matchup training timed out")),
          30 * 60_000,
        ),
        abort = () => reject(new Error("Matchup training cancelled"));
      const cleanup = () => {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      activeWorker.on("message", (message: unknown) => {
        try {
          if (Value.Check(phaseSchema, message)) measurement.mark("read");
          else {
            const decoded = decodeResult(message);
            cleanup();
            resolve(decoded);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      activeWorker.once("error", (error) => {
        cleanup();
        reject(error);
      });
      activeWorker.once("exit", (code) => {
        cleanup();
        reject(new Error(`Training worker exited (${code}) before publishing a result`));
      });
    });
    function decodeResult(message: unknown) {
      return Value.Decode(resultSchema, message);
    }
    measurement.mark("fit");
    controller.signal.throwIfAborted();
    const modelHash =
      workspace === undefined
        ? null
        : await workspace.matchupModels.save(result.model, result.manifest, controller.signal);
    measurement.mark("save");
    process.stdout.write(
      JSON.stringify({
        dryRun,
        through,
        sourceHash: result.model.sourceHash,
        modelHash,
        rows: result.rows,
        similarity: result.model.similarity,
        targets: result.model.targets.map(({ effects, ...t }) => ({
          ...t,
          batters: effects.length,
        })),
        ...measurement.report(),
      }) + "\n",
    );
  } finally {
    measurement.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await worker?.terminate();
    await workspace?.close();
  }
}
await main();
