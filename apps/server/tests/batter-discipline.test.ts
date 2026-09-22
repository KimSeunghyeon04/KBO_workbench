import { resolveAnalysisScope } from "@kbo/contracts";
import Fastify from "fastify";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { BatterDisciplineRepository } from "@kbo/persistence";
import { BatterDisciplineService } from "../src/batter-discipline-service.js";
import { batterDisciplineRoutes } from "../src/routes/batter-discipline.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";
import { disciplineRow, disciplineSnapshot } from "../../../tests/helpers/batter-discipline.js";

describe("batter discipline API and worker", () => {
  it("shares pending requests, reuses the season, invalidates on source changes and closes", async () => {
    let source = disciplineSnapshot(
      Array.from({ length: 12001 }, (_, i) => disciplineRow({ pitchId: `p${i}` })),
    );
    const snapshot = vi.fn(async (season: number, hash?: string) => ({
      ...source,
      season,
      rows: hash === source.sourceHash ? null : source.rows,
    }));
    const service = new BatterDisciplineService({ snapshot });
    try {
      const first = service.analyze({ season: 2024 }, "b1");
      const second = service.analyze({ season: 2024 }, "b1");
      expect(first).toBe(second);
      let ticked = false;
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          ticked = true;
          resolve();
        }, 5),
      );
      expect(ticked).toBe(true);
      expect((await first).points).toHaveLength(12001);
      expect(snapshot).toHaveBeenCalledTimes(1);
      await service.analyze({ season: 2024, balls: 1 }, "b1");
      expect(snapshot).toHaveBeenLastCalledWith(2024, "a".repeat(64), {});
      source = { ...disciplineSnapshot(), sourceHash: "b".repeat(64) };
      expect((await service.analyze({ season: 2024 }, "b1")).points).toHaveLength(1);
      expect((await service.analyze({ season: 2025 }, "b1")).query.season).toBe(2025);
      expect(snapshot).toHaveBeenLastCalledWith(2025, undefined, {});
    } finally {
      await service.close();
    }
    await expect(service.analyze({ season: 2024 }, "b1")).rejects.toThrow("closed");
  }, 15000);
  it("rejects active and queued requests on shutdown", async () => {
    const snapshot = vi.fn(async () => disciplineSnapshot());
    const service = new BatterDisciplineService({ snapshot });
    const pending = Promise.allSettled([
      service.analyze({ season: 2024 }, "b1"),
      service.analyze({ season: 2025 }, "b1"),
    ]);
    await service.close();
    expect((await pending).every((p) => p.status === "rejected")).toBe(true);
  });
  it("validates filters and returns a strict API response", async () => {
    const read = vi
      .spyOn(BatterDisciplineRepository.prototype, "snapshot")
      .mockImplementation(async () => disciplineSnapshot());
    const catalog = vi.spyOn(BatterDisciplineRepository.prototype, "catalog").mockResolvedValue({
      season: 2024,
      scope: resolveAnalysisScope({ season: 2024 }),
      batters: [],
    });
    const app = Fastify();
    const pool = new Pool();
    installHttpErrorHandler(app);
    await app.register(batterDisciplineRoutes, { pool, references: { getOrCreate: vi.fn() } });
    try {
      for (const query of [
        "",
        "season=bad",
        "season=2027",
        "season=2024&balls=4",
        "season=2024&strikes=-1",
        "season=2024&stance=bad",
      ])
        expect(
          (await app.inject(`/api/v2/analysis/batter-discipline/b1?${query}`)).statusCode,
        ).toBe(400);
      expect((await app.inject("/api/v2/analysis/batter-discipline?season=2024")).statusCode).toBe(
        200,
      );
      const response = await app.inject(
        "/api/v2/analysis/batter-discipline/b1?season=2024&balls=0",
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().coverage.locationPitches).toBe(1);
      expect(response.json().courseComparison.conventional.batter).toMatchObject({
        pitches: 1,
        outsidePitches: 0,
        chaseRate: null,
      });
      expect(response.json().courseComparison.paired).toHaveLength(3);
    } finally {
      await app.close();
      await pool.end();
      read.mockRestore();
      catalog.mockRestore();
    }
  });
});
