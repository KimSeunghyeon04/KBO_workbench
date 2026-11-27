import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { OfficialCareerWorkspace } from "@kbo/persistence";
import {
  BattingStatisticsResponseSchema,
  PitchingStatisticsResponseSchema,
  PlayerDirectorySchema,
  PlayerSeasonStatisticsResponseSchema,
  PlayerGameRecordsResponseSchema,
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
  const query = vi.spyOn(client, "query").mockImplementation((statement) => {
    const rows = String(statement).includes("SELECT dataset.hash, sources.*")
      ? [{ hash: null, gameId: null }]
      : [];
    return Promise.resolve({ rows, command: "SELECT", rowCount: rows.length, fields: [], oid: 0 });
  });
  return { pool, connect, query };
}

it("serves the unscoped player directory with identity, history and season availability", async () => {
  const db = connection();
  await using temporary = await mkdtempDisposable(path.join(tmpdir(), "official-careers-"));
  const career = {
    firstSeason: 2010,
    lastSeason: 2026,
    clubs: [
      { name: "이전 팀", joinedOn: null },
      { name: "현재 팀", joinedOn: "2016-12-22" },
    ],
  };
  await new OfficialCareerWorkspace(temporary.path, "fixture").publish({
    version: 1,
    records: [
      {
        playerId: "10101",
        name: "가상 선수",
        career,
        sources: [
          {
            url: "https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=10101",
            artifactKey: "registry/player-careers/source/fixture/profile/10101-batter.html.gz",
            contentHash: "a".repeat(64),
          },
          {
            url: "https://www.koreabaseball.com/Player/Trade.aspx",
            artifactKey: "registry/player-careers/source/fixture/movement/2016-1.json.gz",
            contentHash: "b".repeat(64),
          },
        ],
      },
    ],
  });
  await new OfficialCareerWorkspace(temporary.path, "fixture").publishBirthYears({
    version: 1,
    records: [
      {
        playerId: "10101",
        name: "가상 선수",
        officialName: "등록 선수",
        birthYear: 1991,
        profile: {
          url: "https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=10101",
          artifactKey: "registry/player-careers/source/fixture/profile/10101-batter.html.gz",
          contentHash: "c".repeat(64),
        },
        alias: {
          url: `https://www.koreabaseball.com/Player/Search.aspx?searchWord=${encodeURIComponent("가상 선수")}`,
          artifactKey: "registry/player-careers/source/fixture/alias/10101-sample.html.gz",
          contentHash: "d".repeat(64),
        },
      },
    ],
  });
  const query = db.query.getMockImplementation();
  db.query.mockImplementation((...args) => {
    if (String(args[0]).startsWith("WITH appearances")) {
      return Promise.resolve({
        rows: ["10101", "10102"].map((id) => ({
          identity: `player:${id}`,
          sourceId: id,
          season: 2024,
          name: "가상 선수",
          teams: ["이전 팀", "현재 팀"],
          pa: 2,
          pitches: 0,
          primaryPosition: "포수",
        })),
        command: "SELECT",
        rowCount: 2,
        fields: [],
        oid: 0,
      });
    }
    return query?.(...args);
  });
  const app = Fastify();
  installHttpErrorHandler(app);
  await app.register(playerStatisticsRoutes, { pool: db.pool, careerRoot: temporary.path });
  try {
    const result = await app.inject("/api/v2/analysis/players");
    expect(result.statusCode, result.body).toBe(200);
    expect(Value.Decode(PlayerDirectorySchema, result.json())).toEqual(
      ["10101", "10102"].map((id) => ({
        identity: `player:${id}`,
        sourceIds: [id],
        name: "가상 선수",
        teams: ["이전 팀", "현재 팀"],
        primaryPosition: "포수",
        seasons: [{ season: 2024, battingPlayerId: id, pitchingPlayerId: null }],
        ...(id === "10101" ? { career, birthYear: 1991 } : {}),
      })),
    );
  } finally {
    await app.close();
    await db.pool.end();
  }
});

it("validates game log queries and returns the requested role's row shape", async () => {
  const db = connection();
  const original = db.query.getMockImplementation();
  db.query.mockImplementation((...args) =>
    String(args[0]).includes("current_player_game_batting")
      ? Promise.resolve({
          rows: [
            {
              gameId: "game-1",
              revision: 2,
              gameDate: "2025-04-01",
              teams: ["홈"],
              opponents: ["원정"],
              side: "home",
              plateAppearances: 4,
              atBats: 3,
              hits: 2,
              homeRuns: 1,
              walks: 1,
              strikeouts: 1,
              runs: 1,
            },
          ],
          command: "SELECT",
          rowCount: 1,
          fields: [],
          oid: 0,
        })
      : original?.(...args),
  );
  const app = Fastify();
  installHttpErrorHandler(app);
  await app.register(playerStatisticsRoutes, { pool: db.pool });
  try {
    const path = "/api/v2/analysis/statistics/player-games";
    const invalid = await app.inject(
      `${path}?player=kbo:10101&role=batter&season=2025&dateFrom=2024-04-01`,
    );
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
    const response = await app.inject(`${path}?player=kbo:10101&role=batter&season=2025`);
    expect(response.statusCode, response.body).toBe(200);
    expect(Value.Decode(PlayerGameRecordsResponseSchema, response.json())).toMatchObject({
      query: { player: "kbo:10101", role: "batter", season: 2025 },
      rows: [{ gameId: "game-1", revision: 2, homeRuns: 1 }],
    });
  } finally {
    await app.close();
    await db.pool.end();
  }
});

it("returns both annual record groups in one snapshot and rejects unscoped dates", async () => {
  const db = connection();
  const app = Fastify();
  installHttpErrorHandler(app);
  await app.register(playerStatisticsRoutes, { pool: db.pool });
  try {
    const path = "/api/v2/analysis/statistics/player-seasons";
    const invalid = await app.inject(`${path}?player=kbo:10101&dateFrom=2025-04-01`);
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
    const response = await app.inject(`${path}?player=kbo:10101`);
    expect(response.statusCode, response.body).toBe(200);
    expect(Value.Decode(PlayerSeasonStatisticsResponseSchema, response.json())).toEqual({
      query: { player: "kbo:10101" },
      batting: [],
      pitching: [],
    });
    expect(db.connect).toHaveBeenCalledTimes(1);
    for (const kind of ["batting", "pitching"]) {
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining(`current_player_game_${kind}`),
        [null, "regular", null, null, "kbo:10101"],
      );
    }
  } finally {
    await app.close();
    await db.pool.end();
  }
});

it.each(["batting", "pitching"] as const)(
  "%s forwards a selected player into the snapshot SQL and preserves the requested scope",
  async (kind) => {
    const db = connection();
    const app = Fastify();
    installHttpErrorHandler(app);
    await app.register(playerStatisticsRoutes, { pool: db.pool });
    try {
      const response = await app.inject(
        `/api/v2/analysis/statistics/${kind}?season=2025&competition=allstar&dateFrom=2025-04-01&dateTo=2025-05-01&playerId=anon-player&limit=200`,
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
        competition: "allstar",
        dateFrom: "2025-04-01",
        dateTo: "2025-05-01",
        playerId: "anon-player",
        limit: 200,
      });
      expect(body.scope).toEqual({
        season: 2025,
        competition: "allstar",
        dateFrom: "2025-04-01",
        dateTo: "2025-05-01",
      });
      expect(body.rows).toEqual([]);
      expect(db.query).toHaveBeenCalledWith(expect.stringContaining("f.player_id=$6"), [
        2025,
        "allstar",
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
      const combined = await app.inject(
        `/api/v2/analysis/statistics/${kind}?season=2025&competition=all`,
      );
      expect(combined.statusCode).toBe(400);
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
