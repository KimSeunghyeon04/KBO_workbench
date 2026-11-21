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
    .spyOn(PlayerStatisticsRepository.prototype, "battingWithManifest")
    .mockImplementation(async (query) => ({
      sourceHash: "a".repeat(64),
      response: {
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
        sourceHash: (query.season === 2024 ? "b" : "d").repeat(64),
        group: "player",
        total: 0,
        page: 1,
        limit: 200,
        rows: [],
      },
    }));
  const manifest = vi
    .spyOn(PlayerStatisticsRepository.prototype, "readSourceHash")
    .mockResolvedValue("a".repeat(64));
  const pool = new Pool(),
    app = Fastify();
  installHttpErrorHandler(app);
  await app.register(playerStatisticsRoutes, { pool });
  try {
    const url =
      "/api/v2/analysis/statistics/b1/comparison?season=2024&dateFrom=2024-04-01&compareSeason=2025&role=batter&competition=postseason";
    const good = await app.inject(url);
    expect(good.statusCode, good.body).toBe(200);
    const data = Value.Decode(StatisticsPeriodResponseSchema, good.json());
    expect(data.first.scope).toMatchObject({ season: 2024, dateFrom: "2024-04-01" });
    expect(data.second.scope).toMatchObject({
      season: 2025,
      dateFrom: null,
      competition: "postseason",
    });
    expect(data.first.sourceHash).toBe("b".repeat(64));
    expect(data.second.sourceHash).toBe("d".repeat(64));
    expect(batting).toHaveBeenCalledTimes(2);
    expect(manifest).toHaveBeenCalledExactlyOnceWith({
      season: 2024,
      dateFrom: "2024-04-01",
      competition: "postseason",
    });
    expect(batting.mock.calls.map(([query]) => query)).toEqual([
      {
        season: 2024,
        dateFrom: "2024-04-01",
        competition: "postseason",
        group: "player",
        playerId: "b1",
        page: 1,
        limit: 200,
      },
      {
        season: 2025,
        competition: "postseason",
        group: "player",
        playerId: "b1",
        page: 1,
        limit: 200,
      },
    ]);
    manifest.mockResolvedValueOnce("c".repeat(64));
    expect((await app.inject(url)).statusCode).toBe(400);
    expect(batting).toHaveBeenCalledTimes(4);
    batting.mockClear();
    manifest.mockClear();
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
    expect(manifest).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await pool.end();
    vi.restoreAllMocks();
  }
});
it("rejects a source update between period reads and permits distinct stable season hashes", async () => {
  const first = vi.fn(async () => ({ sourceHash: "a" }));
  const second = vi.fn(async () => ({ sourceHash: "b" }));
  await expect(readAnalysisPeriodPair(first, second, async () => "c")).rejects.toThrow("갱신");
  expect(await readAnalysisPeriodPair(first, second, async () => "a")).toEqual({
    first: { sourceHash: "a" },
    second: { sourceHash: "b" },
  });
  expect(first).toHaveBeenCalledTimes(2);
});
