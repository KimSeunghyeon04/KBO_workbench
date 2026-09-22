import { Worker } from "node:worker_threads";
import { setImmediate } from "node:timers/promises";
import { CorrectionCommandError } from "@kbo/correction";
import { NaverSourceFormatError, NaverSourceEvidenceError } from "@kbo/collection";
import type {
  Computation,
  ComputationReply,
  ComputationResult,
  ComputationRunner,
} from "./computation.js";

export class ComputationBusyError extends Error {}
interface Job {
  id: number;
  input: Computation;
  resolve(value: ComputationResult): void;
  reject(error: Error): void;
  cleanup(): void;
}
interface Slot {
  worker: Worker;
  job?: Job;
  timer?: ReturnType<typeof setTimeout>;
}

/** Persistent, bounded CPU workers; a failed/cancelled computation never commits caller state. */
export class ComputationPool implements ComputationRunner {
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private nextId = 0;
  private closed = false;
  public constructor(
    private readonly concurrency = 2,
    private readonly maxQueued = 32,
    private readonly timeoutMs = 60_000,
  ) {
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      !Number.isInteger(maxQueued) ||
      maxQueued < 1 ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    )
      throw new Error("Invalid computation pool limits");
  }

  public run(input: Computation, signal?: AbortSignal): Promise<ComputationResult> {
    if (this.closed) return Promise.reject(new Error("Computation pool is closed"));
    if (signal?.aborted) return Promise.reject(new Error("Computation cancelled"));
    if (this.queue.length >= this.maxQueued)
      return Promise.reject(
        new ComputationBusyError("계산 요청이 많습니다. 잠시 뒤 다시 시도하세요."),
      );
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: ++this.nextId,
        input,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      };
      const cancel = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) {
          this.queue.splice(index, 1);
          job.cleanup();
          reject(new Error("Computation cancelled"));
        } else {
          const slot = [...this.slots].find((item) => item.job === job);
          if (slot !== undefined) this.fail(slot, new Error("Computation cancelled"));
        }
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  public async warmup(): Promise<void> {
    await Promise.all(Array.from({ length: this.concurrency }, () => this.run({ kind: "warmup" })));
  }

  private pump(): void {
    while (!this.closed && this.queue.length > 0) {
      let slot = [...this.slots].find((item) => item.job === undefined);
      if (slot === undefined) {
        if (this.slots.size >= this.concurrency) return;
        try {
          slot = this.spawn();
        } catch (error: unknown) {
          const job = this.queue.shift();
          job?.cleanup();
          job?.reject(
            error instanceof Error ? error : new Error("Cannot start computation worker"),
          );
          continue;
        }
      }
      const job = this.queue.shift();
      if (job === undefined) return;
      slot.job = job;
      slot.worker.ref();
      const active = slot;
      slot.timer = setTimeout(
        () => this.fail(active, new Error(`Computation exceeded ${this.timeoutMs / 1000} seconds`)),
        this.timeoutMs,
      );
      void this.send(slot, job).catch((error: unknown) =>
        this.fail(active, error instanceof Error ? error : new Error("Cannot send computation")),
      );
    }
  }

  private async send(slot: Slot, job: Job): Promise<void> {
    const input = job.input;
    if (!("rows" in input) || input.rows.length <= 5000) {
      slot.worker.postMessage({ id: job.id, input, append: false, complete: true });
      return;
    }
    for (let offset = 0; offset < input.rows.length; offset += 5000) {
      if (!this.slots.has(slot) || slot.job !== job) return;
      slot.worker.postMessage({
        id: job.id,
        input: { ...input, rows: input.rows.slice(offset, offset + 5000) },
        append: offset > 0,
        complete: offset + 5000 >= input.rows.length,
      });
      await setImmediate();
    }
  }

  private spawn(): Slot {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const slot: Slot = {
      worker: new Worker(new URL(`./computation-worker.${extension}`, import.meta.url)),
    };
    this.slots.add(slot);
    slot.worker.on("message", (reply: ComputationReply) => {
      const job = slot.job;
      if (
        job === undefined ||
        reply.id !== job.id ||
        (reply.ok && reply.result.kind !== job.input.kind)
      ) {
        this.fail(slot, new Error("Unexpected computation response"));
        return;
      }
      clearTimeout(slot.timer);
      delete slot.timer;
      delete slot.job;
      job.cleanup();
      slot.worker.unref();
      if (reply.ok) job.resolve(reply.result);
      else
        job.reject(
          reply.errorKind === "command"
            ? new CorrectionCommandError(reply.error)
            : reply.errorKind === "evidence"
              ? new NaverSourceEvidenceError(reply.error)
              : reply.errorKind === "source"
                ? new NaverSourceFormatError(reply.error)
                : new Error(reply.error),
        );
      this.pump();
    });
    slot.worker.on("error", (error) => this.fail(slot, error));
    slot.worker.on("exit", (code) =>
      this.fail(slot, new Error(`Computation worker exited (${String(code)})`)),
    );
    slot.worker.unref();
    return slot;
  }

  private fail(slot: Slot, error: Error): void {
    if (!this.slots.delete(slot)) return;
    clearTimeout(slot.timer);
    slot.job?.cleanup();
    slot.job?.reject(error);
    void slot.worker.terminate().finally(() => this.pump());
  }

  public async close(): Promise<void> {
    this.closed = true;
    const error = new Error("Computation pool is closed");
    for (const job of this.queue.splice(0)) {
      job.cleanup();
      job.reject(error);
    }
    const slots = [...this.slots];
    this.slots.clear();
    await Promise.all(
      slots.map(async (slot) => {
        clearTimeout(slot.timer);
        slot.job?.cleanup();
        slot.job?.reject(error);
        await slot.worker.terminate();
      }),
    );
  }
}
