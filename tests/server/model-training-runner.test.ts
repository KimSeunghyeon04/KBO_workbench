import { afterEach, expect, it, vi } from "vitest";
import { trainRunExpectancy } from "@kbo/game-core";
import { runModelTraining } from "../../apps/server/src/model-training-runner.js";
const harness = vi.hoisted(() => {
  const workers: { emit(event: string, value: unknown): boolean; terminate(): Promise<number> }[] =
    [];
  return { workers };
});
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      public constructor() {
        super();
        harness.workers.push(this);
      }
      public terminate = vi.fn(async () => 0);
    },
  };
});
afterEach(() => {
  harness.workers.length = 0;
});
it("waits for an in-flight durable progress write before reporting cancellation", async () => {
  const controller = new AbortController();
  let finish = () => {};
  const phase = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = runModelTraining("re24", "unused", controller.signal, phase);
  const settled = vi.fn();
  void pending.then(
    () => settled(),
    () => settled(),
  );
  const worker = harness.workers[0];
  if (worker === undefined) throw new Error("Missing worker");
  worker.emit("message", { phase: "fitting" });
  await vi.waitFor(() => expect(phase).toHaveBeenCalledOnce());
  controller.abort();
  await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
  expect(settled).not.toHaveBeenCalled();
  finish();
  await expect(pending).rejects.toThrow("cancelled");
});
it("accepts a final result even when the worker exits while its progress write is pending", async () => {
  let finish = () => {};
  const pending = runModelTraining(
    "re24",
    "unused",
    new AbortController().signal,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const worker = harness.workers[0];
  if (worker === undefined) throw new Error("Missing worker");
  worker.emit("message", { phase: "fitting" });
  await Promise.resolve();
  const result = {
    kind: "re24",
    model: trainRunExpectancy([], "a".repeat(64), 2024),
    manifest: { version: 1, through: 2024, games: [], scopeHashes: [] },
  };
  worker.emit("message", result);
  worker.emit("exit", 0);
  finish();
  await expect(pending).resolves.toEqual(result);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("rejects worker artifacts trained for a different season", async () => {
  const pending = runModelTraining(
    "re24",
    "unused",
    new AbortController().signal,
    async () => {},
    2022,
  );
  const worker = harness.workers[0];
  if (worker === undefined) throw new Error("Missing worker");
  worker.emit("message", {
    kind: "re24",
    model: trainRunExpectancy([], "a".repeat(64), 2024),
    manifest: { version: 1, through: 2024, games: [], scopeHashes: [] },
  });
  await expect(pending).rejects.toThrow("period mismatch");
});
