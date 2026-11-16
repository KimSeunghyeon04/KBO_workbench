// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope, type BaserunningResponse } from "@kbo/contracts";
import { BaserunningPage } from "../../apps/web/src/pages/baserunning-page.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "distinguishes movement totals and unresolved opportunities (unknown: %s)",
  async (unknown) => {
    const query = { season: 2025, competition: "regular" } as const;
    const runner = {
      identity: "naver:r",
      playerId: "r",
      name: "주자 A",
      teamId: "AWAY",
      teamName: "원정",
      games: 1,
      advances: 2,
      extraBases: 1,
      runs: 1,
      stolenBases: 0,
      caughtStealing: 0,
      pickoffs: 0,
      stealRate: null,
    };
    const response: BaserunningResponse = {
      query,
      scope: resolveAnalysisScope(query),
      sourceHash: "a".repeat(64),
      playerId: "r",
      players: [runner],
      teams: [{ ...runner, identity: "team:AWAY", playerId: null, name: "원정" }],
      opportunities: [
        {
          gameId: "game",
          revision: 1,
          gameDate: "2025-05-01",
          playId: "play",
          runnerId: "r",
          fromBase: 1,
          outcome: "extra_base",
          finalBase: 3,
          reason: null,
        },
      ],
      opportunitySummary: {
        candidates: unknown ? 2 : 1,
        eligible: unknown ? 2 : 1,
        extraBase: 1,
        noExtraBase: 0,
        out: 0,
        unknown: unknown ? 1 : 0,
        excludedComplex: 0,
        extraBaseRate: unknown ? null : 1,
      },
    };
    if (unknown) {
      response.opportunities.push({
        gameId: "game-2",
        revision: 1,
        gameDate: "2025-05-02",
        playId: "play-2",
        runnerId: "r",
        fromBase: 2,
        outcome: "unknown",
        finalBase: null,
        reason: "인정 득점 미확인",
      });
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response))));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: ["/analysis/baserunning?season=2025&competition=regular&player=r"] },
          createElement(BaserunningPage),
        ),
      ),
    );
    const table = within(await screen.findByRole("table", { name: "선수별 주루" }));
    for (const label of ["기존 주자 진루 횟수", "초과 이동 베이스", "기존 주자 득점"]) {
      expect(table.getByRole("columnheader", { name: label })).toBeTruthy();
    }
    expect(table.getByRole("cell", { name: "2", exact: true })).toBeTruthy();
    expect(screen.getAllByText(/타자 자신의 홈런 득점은 제외/)).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "주자 A · 단타 추가 진루" })).toBeTruthy();
    expect(screen.getByText(unknown ? "1 / 2회" : "1 / 1회")).toBeTruthy();
    const summary = screen.getByRole("region", { name: "선수의 추가 진루" });
    expect(
      within(summary).getByText(unknown ? "—" : "100.0%", { exact: true, selector: "dd" }),
    ).toBeTruthy();
    if (unknown)
      expect(
        within(summary).getByText(/해석 불가 기회가 있어 성공률을 확정하지 않습니다/),
      ).toBeTruthy();
    fireEvent.click(screen.getByText("추가 진루 기회와 성공 기준"));
    expect(screen.getByText(/단타 플레이당 주자 한 명을 한 기회로/)).toBeTruthy();
    fireEvent.click(screen.getByText(`경기별 주루 장면 · ${unknown ? 2 : 1}기회`));
    expect(
      screen.getByRole("link", { name: "2025-05-01 · 주루 장면 · r1" }).getAttribute("href"),
    ).toContain("revision=1");
  },
);
