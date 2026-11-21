import Fastify from "fastify";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { StatisticsPeriodResponseSchema, resolveAnalysisScope } from "@kbo/contracts";
import { PlayerStatisticsRepository } from "@kbo/persistence";
import { playerStatisticsRoutes } from "../src/routes/player-statistics.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";
import { readAnalysisPeriodPair } from "../src/analysis-period-pair.js";

it("serves strict independent seasons and rejects invalid B before any reads", async () => {
  const batting = vi
    .spyOn(PlayerStatisticsRepository.prototype, "batting")
    .mockImplementation(async (query) => ({
      kind: "batting",
      query,
      scope: resolveAnalysisScope(
        {
          season: query.season,
          ...(query.competition === undefined ? {} : { competition: query.competition }),
          ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
          ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
        },
        "regular",
      ),
      sourceHash: "a".repeat(64),
      group: "player",
      total: 0,
      page: 1,
      limit: 200,
      rows: [],
    }));
  const pool = new Pool(),
    app = Fastify();
  installHttpErrorHandler(app);
  await app.register(playerStatisticsRoutes, { pool });
  try {
    const good = await app.inject(
      "/api/v2/analysis/statistics/b1/comparison?season=2024&dateFrom=2024-04-01&compareSeason=2025&role=batter&competition=postseason",
    );
    expect(good.statusCode, good.body).toBe(200);
    const data = Value.Decode(StatisticsPeriodResponseSchema, good.json());
    expect(data.first.scope).toMatchObject({ season: 2024, dateFrom: "2024-04-01" });
    expect(data.second.scope).toMatchObject({
      season: 2025,
      dateFrom: null,
      competition: "postseason",
    });
    expect(batting).toHaveBeenCalledTimes(3);
    expect(batting.mock.calls[1]?.[0]).not.toHaveProperty("dateFrom");
    batting.mockClear();
    for (const suffix of [
      "compareSeason=bad",
      "compareSeason=2025&compareDateFrom=2025-07-01&compareDateTo=2025-06-01",
      "compareSeason=2025&compareDateFrom=2024-01-01",
      "compareSeason=2025&role=unknown",
    ]) {
      expect(
        (
          await app.inject(
            `/api/v2/analysis/statistics/b1/comparison?season=2024&role=batter&${suffix}`,
          )
        ).statusCode,
      ).toBe(400);
    }
    expect(batting).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await pool.end();
    vi.restoreAllMocks();
  }
});
it("rejects a source update between period reads and permits distinct stable season hashes", async () => {
  const first = vi
    .fn()
    .mockResolvedValueOnce({ sourceHash: "a" })
    .mockResolvedValueOnce({ sourceHash: "c" });
  const second = vi.fn(async () => ({ sourceHash: "b" }));
  await expect(readAnalysisPeriodPair(first, second)).rejects.toThrow("갱신");
  const stable = vi.fn(async () => ({ sourceHash: "a" }));
  expect(await readAnalysisPeriodPair(stable, second)).toEqual({
    first: { sourceHash: "a" },
    second: { sourceHash: "b" },
  });
});
