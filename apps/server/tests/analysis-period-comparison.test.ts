import Fastify from "fastify";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { StatisticsPeriodResponseSchema } from "@kbo/contracts";
import { playerStatisticsRoutes } from "../src/routes/player-statistics.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";

const isSource = (sql: string) => sql.includes("SELECT dataset.hash, sources.*");

it("shares an identical aggregate, keeps independent scopes, and rejects a changed first source", async () => {
  let changed = false;
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    void params;
    return { rows: isSource(sql) ? [{ gameId: null, hash: changed ? "1".repeat(64) : null }] : [] };
  });
  const pool = {
    connect: async () => ({ query, release() {} }),
    query,
  } as unknown as Pool;
  const app = Fastify();
  installHttpErrorHandler(app);
  await app.register(playerStatisticsRoutes, { pool });
  try {
    const url =
      "/api/v2/analysis/statistics/b1/comparison?season=2024&role=batter&competition=postseason";
    const sameResponse = await app.inject(url + "&compareSeason=2024");
    expect(sameResponse.statusCode, sameResponse.body).toBe(200);
    const same = Value.Decode(StatisticsPeriodResponseSchema, sameResponse.json());
    expect(same.first).toEqual(same.second);
    expect(query.mock.calls.filter(([sql]) => isSource(sql))).toHaveLength(2);
    const statistics = () =>
      query.mock.calls.filter(([sql]) => sql.includes("current_player_game_batting"));
    expect(statistics().map(([, params]) => params)).toEqual([
      [2024, "postseason", null, null, "player", "b1"],
    ]);
    query.mockClear();

    const distinct = url + "&dateFrom=2024-04-01&compareSeason=2025";
    const good = await app.inject(distinct);
    expect(good.statusCode, good.body).toBe(200);
    const data = Value.Decode(StatisticsPeriodResponseSchema, good.json());
    expect(data.first.scope).toMatchObject({ season: 2024, dateFrom: "2024-04-01" });
    expect(data.second.scope).toMatchObject({
      season: 2025,
      dateFrom: null,
      competition: "postseason",
    });
    expect(data.first.sourceHash).not.toBe(data.second.sourceHash);
    expect(statistics().map(([, params]) => params)).toEqual([
      [2024, "postseason", "2024-04-01", null, "player", "b1"],
      [2025, "postseason", null, null, "player", "b1"],
    ]);

    const fresh = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      changed = true;
      return query(sql, params);
    });
    Object.assign(pool, { query: fresh });
    const conflict = await app.inject(distinct);
    expect(conflict.statusCode, conflict.body).toBe(400);
    expect(fresh.mock.calls.map(([, params]) => params)).toEqual([
      [2024, "postseason", "2024-04-01", null],
    ]);
    query.mockClear();
    fresh.mockClear();
    for (const suffix of [
      "compareSeason=bad",
      "compareSeason=2025&compareDateFrom=2025-07-01&compareDateTo=2025-06-01",
      "compareSeason=2025&compareDateFrom=2024-01-01",
      "compareSeason=2025&role=unknown",
    ]) {
      expect((await app.inject(url + "&" + suffix)).statusCode).toBe(400);
    }
    expect(query).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
