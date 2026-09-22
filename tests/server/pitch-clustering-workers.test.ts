import { describe, expect, it } from "vitest";
import { PitchClusteringWorkers } from "../../apps/server/src/pitch-clustering-workers.js";

const points = Array.from({ length: 4000 }, (_, i) => ({
  xCm: Math.sin(i) + (i % 12) * 10,
  zCm: Math.cos(i) - (i % 12) * 5,
  distanceToPlateCm: Math.sin(i * 3) + (i % 12) * 40,
}));

describe("bounded GMM worker lifecycle", () => {
  it("fits 4000 pitches with K=12 while the main event loop remains available", async () => {
    const runner = new PitchClusteringWorkers();
    try {
      let finished = false;
      const fit = runner.fit({ points, componentCount: 12 }).then((result) => {
        finished = true;
        return result;
      });
      let ticked = false;
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          ticked = true;
          resolve();
        }, 5),
      );
      expect(ticked).toBe(true);
      expect(finished).toBe(false);
      const result = await fit;
      expect(result).toMatchObject({ status: "ready", componentCount: 12, unassignedCount: 0 });
      expect(result.labels).toHaveLength(4000);
    } finally {
      await runner.close();
    }
  }, 15000);
  it("closes active and queued work and refuses subsequent requests", async () => {
    const runner = new PitchClusteringWorkers();
    const pending = Array.from({ length: 4 }, () => runner.fit({ points, componentCount: 12 }));
    const settled = Promise.allSettled(pending);
    await runner.close();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    await expect(runner.fit({ points, componentCount: 12 })).rejects.toThrow("closed");
  });
});
