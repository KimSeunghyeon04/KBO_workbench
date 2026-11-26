// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlayerGamesPage } from "../../apps/web/src/pages/player-games-page.js";
import { readAnalysisReturnTo } from "../../apps/web/src/analysis/analysis-evidence-link.js";
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows both games of a doubleheader and sends each exact revision to replay", async () => {
  const scope = { season: 2025, competition: "regular" as const, dateFrom: null, dateTo: null };
  const query = { season: 2025, competition: "regular", player: "kbo:123", role: "batter" };
  const game = {
    teams: ["팀 A"],
    opponents: ["팀 B"],
    side: "away",
    gameDate: "2025-06-02",
    plateAppearances: 4,
    atBats: 3,
    hits: 1,
    homeRuns: 0,
    walks: 1,
    strikeouts: 1,
    runs: 0,
  };
  const request = vi.fn(async () =>
    Response.json({
      query,
      scope,
      role: "batter",
      rows: [
        { ...game, gameId: "g2", revision: 2, hits: 2 },
        { ...game, gameId: "g1", revision: 1 },
      ],
    }),
  );
  vi.stubGlobal("fetch", request);
  const source = "/analysis/player-games?season=2025&player=kbo%3A123&playerRole=batter";
  const client = createAnalysisQueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: [source] }, createElement(PlayerGamesPage)),
    ),
  );
  const table = within(await screen.findByRole("table", { name: "경기별 타격 성적" }));
  const replay = table.getAllByRole("link", { name: /2025-06-02.*경기 재생/ });
  expect(replay.map((link) => link.getAttribute("href"))).toEqual([
    "/replay?gameId=g2&revision=2&open=1",
    "/replay?gameId=g1&revision=1&open=1",
  ]);
  expect(table.getAllByRole("row")).toHaveLength(3);
  expect(request).toHaveBeenCalledTimes(1);
  expect(readAnalysisReturnTo({ analysisReturnTo: source })).toBe(source);
});

it("keeps unconfirmed earned runs separate from a confirmed zero", async () => {
  const query = { season: 2025, competition: "regular", player: "kbo:456", role: "pitcher" };
  const scope = { season: 2025, competition: "regular", dateFrom: null, dateTo: null };
  const game = {
    teams: ["팀 A"],
    opponents: ["팀 B"],
    side: "home",
    revision: 1,
    battersFaced: 7,
    outsRecorded: 5,
    hits: 1,
    runs: 0,
    walks: 1,
    strikeouts: 2,
    pitches: 28,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        query,
        scope,
        role: "pitcher",
        rows: [
          { ...game, gameId: "g2", gameDate: "2025-06-03", earnedRuns: null },
          { ...game, gameId: "g1", gameDate: "2025-06-01", earnedRuns: 0 },
        ],
      }),
    ),
  );
  render(
    createElement(
      QueryClientProvider,
      { client: createAnalysisQueryClient() },
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            "/analysis/player-games?season=2025&player=kbo%3A456&playerRole=pitcher&pitcher=hp1",
          ],
        },
        createElement(PlayerGamesPage),
      ),
    ),
  );
  const tableElement = await screen.findByRole("table", { name: "경기별 등판 성적" });
  const deeper = screen.getByRole("region", { name: "등판 심화 분석" });
  expect(deeper.compareDocumentPosition(tableElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const table = within(tableElement);
  const data = table.getAllByRole("row").slice(1);
  expect(data.map((row) => within(row).getAllByRole("cell")[7]?.textContent)).toEqual(["—", "0"]);
  expect(table.getAllByRole("cell", { name: "1⅔" })).toHaveLength(2);
});
