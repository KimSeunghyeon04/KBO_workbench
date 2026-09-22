import { Worker } from "node:worker_threads";
import {
  PitchClusterResultSchema,
  type PitchClusterInput,
  type PitchClusterResult,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

interface Job {
  input: PitchClusterInput;
  resolve: (result: PitchClusterResult) => void;
  reject: (error: Error) => void;
}
export class PitchAnalysisBusyError extends Error {}

export class PitchClusteringWorkers {
  private readonly queue: Job[] = [];
  private readonly active = new Map<Worker, (error: Error) => void>();
  private closed = false;

  public fit(input: PitchClusterInput): Promise<PitchClusterResult> {
    if (this.closed) return Promise.reject(new Error("Pitch analysis is closed"));
    if (this.queue.length >= 32)
      return Promise.reject(
        new PitchAnalysisBusyError("분석 요청이 많습니다. 잠시 뒤 다시 시도해 주세요."),
      );
    return new Promise((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (!this.closed && this.active.size < 2 && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job === undefined) break;
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      let worker: Worker;
      try {
        worker = new Worker(new URL(`./pitch-clustering-worker.${extension}`, import.meta.url), {
          workerData: job.input,
        });
      } catch (error: unknown) {
        job.reject(error instanceof Error ? error : new Error("Cannot start pitch worker"));
        continue;
      }
      this.active.set(worker, job.reject);
      let result: PitchClusterResult | undefined;
      let failure: Error | undefined;
      const timeout = setTimeout(() => {
        failure = new Error("Pitch clustering exceeded 30 seconds");
        void worker.terminate();
      }, 30_000);
      worker.once("message", (message: unknown) => {
        try {
          result = Value.Decode(PitchClusterResultSchema, message);
        } catch {
          failure = new Error("Invalid pitch worker response");
          void worker.terminate();
        }
      });
      worker.once("error", (error) => {
        failure = error;
      });
      worker.once("exit", (code) => {
        clearTimeout(timeout);
        this.active.delete(worker);
        if (failure !== undefined) job.reject(failure);
        else if (code !== 0 || result === undefined)
          job.reject(new Error("Pitch clustering worker stopped"));
        else job.resolve(result);
        this.pump();
      });
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    const error = new Error("Pitch analysis is closed");
    for (const job of this.queue.splice(0)) job.reject(error);
    await Promise.all(
      [...this.active].map(async ([worker, reject]) => {
        reject(error);
        await worker.terminate();
      }),
    );
  }
}
