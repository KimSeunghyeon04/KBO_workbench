import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { sendWorkerRows } from "../../apps/server/src/worker-row-transport.js";

describe("bounded worker row transport", () => {
  it.each([0, 1, 5000, 5001, 10000, 10001])(
    "preserves the order and completion boundary of %i rows",
    async (size) => {
      const rows = Array.from({ length: size }, (_, index) => index);
      const send = vi.fn<Parameters<typeof sendWorkerRows<number>>[1]>();
      await sendWorkerRows(rows, send, () => true);
      const chunks = send.mock.calls.map(([chunk]) => chunk);
      expect(chunks).toHaveLength(Math.max(1, Math.ceil(size / 5000)));
      expect(chunks.flatMap((chunk) => chunk.rows)).toEqual(rows);
      expect(chunks.every((chunk) => chunk.rows.length <= 5000)).toBe(true);
      expect(chunks.map((chunk) => chunk.append)).toEqual(chunks.map((_, index) => index > 0));
      expect(chunks.map((chunk) => chunk.complete)).toEqual(
        chunks.map((_, index) => index === chunks.length - 1),
      );
    },
  );

  it("yields after the first chunk and stops sending when the job is cancelled", async () => {
    let active = true;
    const sent: number[] = [];
    // This check runs before the sender can enqueue the second chunk.
    const cancel = setImmediate().then(() => {
      expect(sent).toEqual([5000]);
      active = false;
    });
    await sendWorkerRows(
      Array.from({ length: 15001 }, (_, index) => index),
      (chunk) => sent.push(chunk.rows.length),
      () => active,
    );
    await cancel;
    expect(sent).toEqual([5000]);
  });

  it("does not start an inactive job and propagates send errors", async () => {
    const send = vi.fn();
    await sendWorkerRows([], send, () => false);
    expect(send).not.toHaveBeenCalled();
    const failure = new Error("Worker closed");
    await expect(
      sendWorkerRows(
        [1],
        () => {
          throw failure;
        },
        () => true,
      ),
    ).rejects.toBe(failure);
  });
});
