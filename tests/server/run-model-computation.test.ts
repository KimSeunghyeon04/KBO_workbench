import { expect, it } from "vitest";
import { trainRunExpectancy } from "@kbo/game-core";
import { ComputationPool } from "../../apps/server/src/computation-pool.js";
import type { RunModelObservation } from "../../apps/server/src/run-model-computation.js";
it("chunks observations without losing rows and supports cancellation and bounded execution", async () => {
  const rows: RunModelObservation[] = Array.from({ length: 5001 }, (_, i) => ({
      record: "pa",
      value: {
        gameId: `g${i}`,
        revision: 1,
        season: 2022,
        gameDate: "2022-06-01",
        inning: 1,
        half: "top",
        outs: 0,
        bases: 0,
        remainingRuns: i % 2,
      },
    })),
    pool = new ComputationPool(1, 1),
    hash = "a".repeat(64);
  try {
    const result = await pool.run({
      kind: "run_model",
      model: "re24",
      rows,
      through: 2024,
      sourceHash: hash,
    });
    const values = rows.flatMap((r) => (r.record === "pa" ? [r.value] : []));
    expect(result).toEqual({ kind: "run_model", value: trainRunExpectancy(values, hash) });
    const controller = new AbortController(),
      pending = pool.run(
        { kind: "run_model", model: "win", rows: [], through: 2024, sourceHash: hash },
        controller.signal,
      );
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  } finally {
    await pool.close();
  }
  const timed = new ComputationPool(1, 1, 1);
  try {
    await expect(
      timed.run({ kind: "run_model", model: "re24", rows, through: 2024, sourceHash: hash }),
    ).rejects.toThrow("exceeded");
  } finally {
    await timed.close();
  }
});
