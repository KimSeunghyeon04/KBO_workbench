import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Client, Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  BattingStatisticsResponseSchema,
  PitchingStatisticsResponseSchema,
  canonicalStringify,
  type BattingStatisticsResponse,
  type PitchingStatisticsResponse,
} from "@kbo/contracts";
import type { createApp } from "../../apps/server/src/app.js";
import { installHttpErrorHandler } from "../../apps/server/src/http-error-handler.js";
import { playerStatisticsRoutes } from "../../apps/server/src/routes/player-statistics.js";

const Fastify: () => ReturnType<typeof createApp> = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
)("fastify");
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");

afterEach(() => vi.restoreAllMocks());

function connection() {
  const pool = new Pool();
  const client = Object.assign(new Client(), { release: vi.fn() });
  const connect = vi.spyOn(pool, "connect").mockResolvedValue(client);
  const query = vi.spyOn(client, "query").mockResolvedValue({
    rows: [],
    command: "",
    rowCount: 0,
    fields: [],
    oid: 0,
  });
  return { pool, connect, query };
}

it.each(["batting", "pitching"] as const)(
  "%s forwards a selected player into the snapshot SQL and preserves the requested scope",
  async (kind) => {
    const db = connection();
    const app = Fastify();
    installHttpErrorHandler(app);
    await app.register(playerStatisticsRoutes, { pool: db.pool });
    try {
      const response = await app.inject(
        `/api/v2/analysis/statistics/${kind}?season=2025&competition=all&dateFrom=2025-04-01&dateTo=2025-05-01&playerId=anon-player&limit=200`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<BattingStatisticsResponse | PitchingStatisticsResponse>();
      expect(
        Value.Check(
          kind === "batting" ? BattingStatisticsResponseSchema : PitchingStatisticsResponseSchema,
          body,
        ),
      ).toBe(true);
      expect(body.query).toEqual({
        season: 2025,
        competition: "all",
        dateFrom: "2025-04-01",
        dateTo: "2025-05-01",
        playerId: "anon-player",
        limit: 200,
      });
      expect(body.scope).toEqual({
        season: 2025,
        competition: "all",
        dateFrom: "2025-04-01",
        dateTo: "2025-05-01",
      });
      expect(body.rows).toEqual([]);
      expect(db.query).toHaveBeenCalledWith(expect.stringContaining("f.player_id=$6"), [
        2025,
        "all",
        "2025-04-01",
        "2025-05-01",
        "player",
        "anon-player",
      ]);
    } finally {
      await app.close();
      await db.pool.end();
    }
  },
);

it.each(["batting", "pitching"] as const)(
  "%s rejects partial team aggregates and invalid player IDs before connecting to PostgreSQL",
  async (kind) => {
    const db = connection();
    const app = Fastify();
    installHttpErrorHandler(app);
    await app.register(playerStatisticsRoutes, { pool: db.pool });
    try {
      const response = await app.inject(
        `/api/v2/analysis/statistics/${kind}?season=2025&group=team&playerId=anon-player`,
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "invalid_analysis_scope",
        category: "domain",
      });
      for (const playerId of ["", "a".repeat(201)]) {
        const invalid = await app.inject(
          `/api/v2/analysis/statistics/${kind}?season=2025&playerId=${playerId}`,
        );
        expect(invalid.statusCode).toBe(400);
      }
      expect(db.connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await db.pool.end();
    }
  },
);

it("keeps the unfiltered source hash stable and binds empty results to the selected player", async () => {
  const db = connection();
  const app = Fastify();
  installHttpErrorHandler(app);
  await app.register(playerStatisticsRoutes, { pool: db.pool });
  try {
    const path = "/api/v2/analysis/statistics/batting?season=2025";
    const all = (await app.inject(path)).json<BattingStatisticsResponse>();
    const first = (await app.inject(`${path}&playerId=first`)).json<BattingStatisticsResponse>();
    const second = (await app.inject(`${path}&playerId=second`)).json<BattingStatisticsResponse>();
    const manifest = hash({ version: 1, scope: all.scope, sources: [], dataset: [] });
    expect(all.sourceHash).toBe(hash({ version: 1, manifest, group: "player", rows: [] }));
    expect(new Set([all.sourceHash, first.sourceHash, second.sourceHash]).size).toBe(3);
  } finally {
    await app.close();
    await db.pool.end();
  }
});
