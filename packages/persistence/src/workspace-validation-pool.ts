import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { Value } from "@sinclair/typebox/value";
import type { CurrentWorkspaceEntry } from "@kbo/contracts";
import {
  validateWorkspaceEntry,
  WorkspaceValidationResponseSchema,
  type WorkspaceValidation,
} from "./workspace-validation.js";

class ValidationWorker {
  private readonly worker: Worker;
  private tail: Promise<unknown> = Promise.resolve();
  private failure: Error | undefined;
  private reject: ((error: Error) => void) | undefined;

  public constructor() {
    this.worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./workspace-validation-worker.ts"
          : "./workspace-validation-worker.js",
        import.meta.url,
      ),
    );
    this.worker.on("error", (error) => {
      this.failure = error;
      this.reject?.(error);
    });
    this.worker.on("exit", (code) => {
      const error = new Error(`Workspace validation worker exited (${String(code)})`);
      this.failure = error;
      this.reject?.(error);
    });
  }
  public validate(root: string, current: CurrentWorkspaceEntry): Promise<WorkspaceValidation> {
    const next = this.tail
      .catch(() => undefined)
      .then(
        () =>
          new Promise<WorkspaceValidation>((resolve, reject) => {
            if (this.failure !== undefined) {
              reject(this.failure);
              return;
            }
            const receive = (value: unknown) => {
              this.reject = undefined;
              try {
                const message = Value.Decode(WorkspaceValidationResponseSchema, value);
                if (message.ok) resolve(message.result);
                else reject(new Error(message.error));
              } catch (error: unknown) {
                reject(error);
              }
            };
            this.reject = (error) => {
              this.worker.off("message", receive);
              reject(error);
            };
            this.worker.once("message", receive);
            try {
              this.worker.postMessage({ root, current });
            } catch (error: unknown) {
              this.worker.off("message", receive);
              this.reject = undefined;
              reject(error);
            }
          }),
      );
    this.tail = next;
    return next;
  }
  public async close(): Promise<void> {
    await this.tail.catch(() => undefined);
    await this.worker.terminate();
  }
}

export class WorkspaceValidationPool {
  private readonly workers: ValidationWorker[];
  private next = 0;
  public constructor(parallel: boolean) {
    this.workers = parallel
      ? Array.from(
          { length: Math.min(4, Math.max(1, availableParallelism() - 1)) },
          () => new ValidationWorker(),
        )
      : [];
  }
  public validate(root: string, current: CurrentWorkspaceEntry): Promise<WorkspaceValidation> {
    if (this.workers.length === 0) return validateWorkspaceEntry(root, current);
    const worker = this.workers[this.next++ % this.workers.length];
    return worker === undefined
      ? validateWorkspaceEntry(root, current)
      : worker.validate(root, current);
  }
  public async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
