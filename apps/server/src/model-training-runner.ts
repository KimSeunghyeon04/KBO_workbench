import { Worker } from "node:worker_threads";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AnalysisModelKind } from "@kbo/contracts";
import { ModelTrainingResultSchema, type ModelTrainingResult } from "./model-training-protocol.js";
const phaseSchema = Type.Object(
  { phase: Type.Literal("fitting") },
  { additionalProperties: false },
);
export async function runModelTraining(
  kind: AnalysisModelKind,
  baseDirectory: string,
  signal: AbortSignal,
  onFit: () => Promise<void>,
  through = 2024,
): Promise<ModelTrainingResult> {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./maintenance/model-training-worker.js", import.meta.url), {
    workerData: { kind, through, baseDirectory },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  let phases = Promise.resolve();
  try {
    return await new Promise<ModelTrainingResult>((resolve, reject) => {
      let received = false;
      abort = () => reject(new Error("Model training cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      timeout = setTimeout(() => reject(new Error("Model training timed out")), 30 * 60_000);
      worker.on("message", (message: unknown) => {
        if (Value.Check(phaseSchema, message)) {
          phases = phases.then(onFit);
          void phases.catch(reject);
        } else {
          received = true;
          void phases
            .then(() => {
              const result = Value.Decode(ModelTrainingResultSchema, message);
              if (result.kind !== kind) throw new Error("Training kind mismatch");
              if (result.model.trainedThrough !== through || result.manifest.through !== through)
                throw new Error("Training period mismatch");
              resolve(result);
            })
            .catch(reject);
        }
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (!received) reject(new Error(`Training worker exited (${code}) before completion`));
      });
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    await worker.terminate();
    // A cancellation can arrive during an atomic progress write. Finish it before the
    // manager records the terminal state, otherwise an older phase could overwrite it.
    await phases.catch(() => {});
  }
}
