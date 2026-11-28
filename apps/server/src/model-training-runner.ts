import { Worker } from "node:worker_threads";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AnalysisModelKind } from "@kbo/contracts";
import {
  ModelTrainingResultSchema,
  type ModelTrainingRequest,
  type ModelTrainingResult,
} from "./model-training-protocol.js";
const phaseSchema = Type.Object(
  { phase: Type.Literal("fitting") },
  { additionalProperties: false },
);
export class ModelTrainingSession {
  private worker: Worker | undefined;
  private failure: Error | undefined;
  private active = false;
  private closing: Promise<void> | undefined;

  public constructor(private readonly baseDirectory: string) {}

  public async run(
    request: ModelTrainingRequest,
    signal: AbortSignal,
    onFit: () => Promise<void>,
  ): Promise<ModelTrainingResult> {
    signal.throwIfAborted();
    if (this.failure !== undefined) throw this.failure;
    if (this.closing !== undefined || this.active)
      throw new Error("Training session is unavailable");
    const worker = (this.worker ??= this.openWorker());
    this.active = true;
    try {
      return await train(worker, request, signal, onFit, () => this.close());
    } finally {
      this.active = false;
    }
  }

  public close() {
    return (this.closing ??= (async () => {
      await this.worker?.terminate();
    })());
  }

  private openWorker() {
    const worker = new Worker(new URL("./maintenance/model-training-worker.js", import.meta.url), {
      workerData: this.baseDirectory,
    });
    worker.on("error", (error) => {
      this.failure = error;
    });
    worker.once("exit", (code) => {
      this.failure ??= new Error(`Training worker exited (${code})`);
    });
    return worker;
  }
}

async function train(
  worker: Worker,
  request: ModelTrainingRequest,
  signal: AbortSignal,
  onFit: () => Promise<void>,
  stop: () => Promise<void>,
) {
  const { kind, through } = request;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cleanup: (() => void)[] = [];
  let phases = Promise.resolve();
  try {
    return await new Promise<ModelTrainingResult>((resolve, reject) => {
      let received = false;
      const abort = () => reject(new Error("Model training cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      cleanup.push(() => signal.removeEventListener("abort", abort));
      timeout = setTimeout(() => reject(new Error("Model training timed out")), 30 * 60_000);
      const onMessage = (message: unknown) => {
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
      };
      const onExit = (code: number) => {
        if (!received) reject(new Error(`Training worker exited (${code}) before completion`));
      };
      worker.on("message", onMessage);
      worker.once("error", reject);
      worker.once("exit", onExit);
      cleanup.push(() => {
        worker.off("message", onMessage);
        worker.off("error", reject);
        worker.off("exit", onExit);
      });
      if (signal.aborted) abort();
      else worker.postMessage(request);
    });
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timeout);
    for (const release of cleanup) release();
    // A cancellation can arrive during an atomic progress write. Finish it before the
    // manager records the terminal state, otherwise an older phase could overwrite it.
    await phases.catch(() => {});
  }
}

export async function runModelTraining(
  kind: AnalysisModelKind,
  baseDirectory: string,
  signal: AbortSignal,
  onFit: () => Promise<void>,
  through = 2024,
): Promise<ModelTrainingResult> {
  const session = new ModelTrainingSession(baseDirectory);
  try {
    return await session.run({ kind, through }, signal, onFit);
  } finally {
    await session.close();
  }
}
