import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { KboScheduleCollector, parseKboCompetitionPage } from "@kbo/collection";
import { parseGameCompetitionDataset } from "@kbo/contracts";
import { competitionFixture } from "../helpers/game-competition.js";

const body = (ids: string[]) =>
  JSON.stringify({
    rows: ids.map((id) => ({
      row: [
        {
          Text:
            `<a href="/Schedule/GameCenter/Main.aspx?gameDate=20250601&amp;gameId=${id}">리뷰</a>` +
            `<a href="/Schedule/GameCenter/Main.aspx?gameDate=20250601&amp;gameId=${id}">영상</a>`,
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
