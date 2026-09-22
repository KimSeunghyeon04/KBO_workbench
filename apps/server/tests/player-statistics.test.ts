import Fastify from "fastify";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { PlayerStatisticsRepository } from "@kbo/persistence";
import { resolveAnalysisScope } from "@kbo/contracts";
import { playerStatisticsRoutes } from "../src/routes/player-statistics.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";
it("exposes bounded, separate batting and pitching queries", async () => {
  const batting = vi
    .spyOn(PlayerStatisticsRepository.prototype, "batting")
    .mockImplementation(async (query) => ({
      kind: "batting",
      query,
      scope: resolveAnalysisScope({ season: query.season }, "regular"),
      sourceHash: "a".repeat(64),
      group: "player",
      total: 0,
      page: 1,
      limit: 50,
      rows: [],
    }));
  const app = Fastify(),
    pool = new Pool();
  installHttpErrorHandler(app);
  await app.register(playerStatisticsRoutes, { pool });
  try {
    expect((await app.inject("/api/v2/analysis/statistics/batting?season=2025")).statusCode).toBe(
      200,
    );
    expect(batting).toHaveBeenCalledWith({ season: 2025 });
    for (const suffix of [
      "season=bad",
      "season=2025&limit=201",
      "season=2025&sort=era",
      "season=2025&minPA=-1",
    ])
      expect((await app.inject(`/api/v2/analysis/statistics/batting?${suffix}`)).statusCode).toBe(
        400,
      );
  } finally {
    await app.close();
    await pool.end();
    vi.restoreAllMocks();
  }
});
