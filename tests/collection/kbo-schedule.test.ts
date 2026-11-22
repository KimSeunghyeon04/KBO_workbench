import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  KboScheduleCollector,
  linkKboCompetitionGames,
  parseKboCompetitionPage,
} from "@kbo/collection";
import { parseGameCompetitionDataset } from "@kbo/contracts";
import { competitionFixture } from "../helpers/game-competition.js";

const body = (ids: string[], date = "20250601") =>
  JSON.stringify({
    rows: ids.map((id) => ({
      row: [
        {
          Text:
            `<a href="/Schedule/GameCenter/Main.aspx?gameDate=${date}&amp;gameId=${id}">리뷰</a>` +
            `<a href="/Schedule/GameCenter/Main.aspx?gameDate=${date}&amp;gameId=${id}">영상</a>`,
        },
      ],
    })),
  });
describe("official competition evidence", () => {
  it("deduplicates links, preserves doubleheaders, and does not invent cancelled games", () => {
    const rows = parseKboCompetitionPage(
      body(["20250601AABB1", "20250601AABB2"]),
      2025,
      6,
      "regular",
    );
    expect(rows.map((r) => r.sourceGameId)).toEqual(["20250601AABB1", "20250601AABB2"]);
    expect(
      parseKboCompetitionPage(
        JSON.stringify({ rows: [{ row: [{ Text: "우천취소" }] }] }),
        2025,
        6,
        "regular",
      ),
    ).toEqual([]);
    expect(() => parseKboCompetitionPage(body(["g1"]), 2025, 7, "regular")).toThrow();
    expect(() => parseKboCompetitionPage("<html>error</html>", 2025, 6, "regular")).toThrow();
  });
  it("requires a complete season, valid dates, and unambiguous IDs", () => {
    const dataset = competitionFixture(2025, [
      { sourceGameId: "g1", gameDate: "2025-06-01", competition: "regular" },
    ]);
    expect(() =>
      parseGameCompetitionDataset({ ...dataset, pages: dataset.pages.slice(1) }),
    ).toThrow();
    expect(() =>
      parseGameCompetitionDataset({
        ...dataset,
        entries: [...dataset.entries, ...dataset.entries],
      }),
    ).toThrow();
    expect(() =>
      parseGameCompetitionDataset({
        ...dataset,
        entries: dataset.entries.map((r) => ({ ...r, gameDate: "2025-06-31" })),
      }),
    ).toThrow();
  });
  it("collects all 36 pages with session headers before returning a dataset", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === "GET")
        return new Response("page", { headers: { "Set-Cookie": "session=test; Path=/" } });
      const params = new URLSearchParams(String(init?.body));
      expect(new Headers(init?.headers).get("Cookie")).toBe("session=test");
      expect(new Headers(init?.headers).get("X-Requested-With")).toBe("XMLHttpRequest");
      return new Response(
        params.get("gameMonth") === "06" && params.get("srIdList") === "0,9,6"
          ? body(["g1"])
          : '{"rows":[]}',
      );
    });
    const collector = new KboScheduleCollector({
      fetch: fetcher,
      sleep: async () => {},
      now: () => 0,
      maxAttempts: 1,
    });
    const result = await collector.collect(2025, async (p) => ({
      artifactKey: `test/${p.month}/${p.competition}`,
      contentHash: createHash("sha256").update(p.body).digest("hex"),
    }));
    expect(fetcher).toHaveBeenCalledTimes(37);
    expect(result.pages).toHaveLength(36);
    expect(result.entries).toHaveLength(1);
  });
  it("uses official daily identities to separate the all-star game and known tiebreak", async () => {
    const games = [
      { sourceGameId: "20241001LTNC02024", gameDate: "2024-10-01" },
      { sourceGameId: "66661001SKKT02024", gameDate: "2024-10-01" },
      { sourceGameId: "66661001SSKT02024", gameDate: "2024-10-01" },
      { sourceGameId: "99990706WEEA02024", gameDate: "2024-07-06" },
    ];
    const collector = new KboScheduleCollector({
      sleep: async () => {},
      maxAttempts: 1,
      fetch: async (url, init) => {
        if (init?.method === "GET") return new Response("page");
        const params = new URLSearchParams(String(init?.body));
        const date = params.get("date");
        if (String(url).endsWith("GetKboGameList")) {
          expect(["20240706", "20241001"]).toContain(date);
          const rows =
            date === "20240706"
              ? [
                  ["20240706WEEA0", 9, 5],
                  ["20240706EAWE0", 9, 32],
                ]
              : [
                  ["20241001SKKT0", 6, 32],
                  ["20241001SSKT0", 6, 32],
                ];
          return Response.json({
            code: "100",
            game: rows.map(([G_ID, SR_ID, GAME_SC_ID]) => ({
              G_ID,
              G_DT: date,
              SEASON_ID: 2024,
              SR_ID,
              GAME_SC_ID,
            })),
          });
        }
        return new Response(
          params.get("gameMonth") === "10" && params.get("srIdList") === "0,9,6"
            ? body(["20241001LTNC0", "20241001SKKT0"], "20241001")
            : '{"rows":[]}',
        );
      },
    });
    const dataset = await collector.collect(
      2024,
      async (page) => ({
        artifactKey: `test/${page.month}/${page.day ?? 0}/${page.competition}`,
        contentHash: createHash("sha256").update(page.body).digest("hex"),
      }),
      undefined,
      games,
    );
    expect(dataset.version).toBe(2);
    expect(
      dataset.pages
        .filter((page) => page.day !== undefined)
        .map((page) => [page.month, page.day, page.competition]),
    ).toEqual([
      [7, 6, "allstar"],
      [10, 1, "postseason"],
    ]);
    expect(
      dataset.entries.map(({ sourceGameId, competition }) => [sourceGameId, competition]),
    ).toEqual([
      ["20240706WEEA0", "allstar"],
      ["20241001LTNC0", "regular"],
      ["20241001SKKT0", "postseason"],
    ]);
    expect(linkKboCompetitionGames(dataset, games).map((link) => link.matchedSourceGameId)).toEqual(
      ["99990706WEEA02024", "20241001LTNC02024", "66661001SKKT02024"],
    );
  });
  it("rejects partial acquisition and propagates cancellation", async () => {
    const collector = new KboScheduleCollector({
      fetch: async (_url, init) => new Response(init?.method === "GET" ? "page" : "broken"),
      sleep: async () => {},
      maxAttempts: 1,
    });
    const sink = vi.fn();
    await expect(collector.collect(2025, sink)).rejects.toThrow();
    expect(sink).not.toHaveBeenCalled();
    await expect(collector.collect(2025, sink, AbortSignal.abort())).rejects.toThrow();
  });
});
