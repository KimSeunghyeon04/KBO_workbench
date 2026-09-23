// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { PlayerAnalysisFrame } from "../../apps/web/src/analysis/player-analysis-frame.js";
import {
  playerNavigationScope,
  playerAnalysisHref,
} from "../../apps/web/src/analysis/player-analysis-navigation.js";
import {
  pitcherCatalogQueryOptions,
  batterCatalogQueryOptions,
} from "../../apps/web/src/api/analysis-catalog-query-options.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

function CurrentLocation() {
  const location = useLocation();
  const navigate = useNavigate();
  return createElement(
    "div",
    null,
    createElement("output", { "aria-label": "현재 주소" }, location.pathname + location.search),
    createElement("button", { onClick: () => navigate(-1) }, "뒤로"),
  );
}

function show(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const location = new URL(url, "http://localhost");
  const scope = playerNavigationScope(location.pathname, location.searchParams);
  client.setQueryData(pitcherCatalogQueryOptions(scope.season, scope.options).queryKey, {
    season: scope.season,
    scope: resolveAnalysisScope({ season: scope.season, ...scope.options }),
    pitchers: [
      { pitcherId: "p1", name: "첫 투수", pitches: 120 },
      { pitcherId: "p2", name: "선택 투수", pitches: 90 },
    ],
  });
  client.setQueryData(batterCatalogQueryOptions(scope.season, scope.options).queryKey, {
    season: scope.season,
    scope: resolveAnalysisScope({ season: scope.season, ...scope.options }),
    batters: [{ batterId: "b1", name: "선택 타자", pitches: 80 }],
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [url] },
        createElement(PlayerAnalysisFrame, null, createElement(CurrentLocation)),
      ),
    ),
  );
  return fetch;
}

it("carries the selected player and explicit scope across features, drops feature filters and restores them on back", async () => {
  const original =
    "/analysis/pitch-shape?season=2024&pitcher=p2&competition=all&dateFrom=2024-04-01&dateTo=2024-04-30&color=cluster&cluster=2";
  const fetch = show(original);
  const user = userEvent.setup();
  const nav = screen.getByRole("navigation", { name: "선수 분석 항목" });
  expect(screen.getByText("선택 투수")).toBeTruthy();
  expect(within(nav).getAllByRole("link")).toHaveLength(7);
  expect(within(nav).getByRole("link", { name: "구질·움직임" }).getAttribute("href")).toBe(
    original,
  );
  await user.click(within(nav).getByRole("link", { name: "배합·궤적" }));
  const location = new URL(
    screen.getByLabelText("현재 주소").textContent ?? "",
    "http://localhost",
  );
  expect(location.pathname).toBe("/analysis/pitch-sequences");
  expect(Object.fromEntries(location.searchParams)).toEqual({
    season: "2024",
    competition: "all",
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
    pitcher: "p2",
  });
  expect(within(nav).getByRole("link", { name: "배합·궤적" }).getAttribute("aria-current")).toBe(
    "page",
  );
  const directory = new URL(
    screen.getByRole("link", { name: "선수 변경" }).getAttribute("href") ?? "",
    "http://localhost",
  );
  expect(directory.pathname).toBe("/analysis/players");
  expect(Object.fromEntries(directory.searchParams)).toEqual({
    season: "2024",
    competition: "all",
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
    role: "pitcher",
  });
  await user.click(screen.getByRole("button", { name: "뒤로" }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe(original);
  expect(fetch).not.toHaveBeenCalled();
});

it("retains the batter as the primary player when entering and leaving a matchup", async () => {
  const fetch = show("/analysis/batter-profile?season=2025&batter=b1");
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: "투수와 매치업" }));
  const location = new URL(
    screen.getByLabelText("현재 주소").textContent ?? "",
    "http://localhost",
  );
  expect(Object.fromEntries(location.searchParams)).toEqual({
    season: "2025",
    competition: "regular",
    batter: "b1",
    playerRole: "batter",
  });
  expect(screen.getByText("선택 타자")).toBeTruthy();
  await user.click(screen.getByRole("link", { name: "선구안", exact: true }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe(
    "/analysis/batter-discipline?season=2025&competition=regular&batter=b1",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["pitcher", "p2", "/analysis/pitch-location", "코스·결정구"],
  ["batter", "b1", "/analysis/batter-profile", "반응·성적"],
] as const)(
  "keeps the %s and common scope when opening basic statistics",
  async (role, id, path, label) => {
    const fetch = show(
      `${path}?season=2024&${role}=${id}&competition=all&dateFrom=2024-04-01&dateTo=2024-04-30&balls=2`,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "기본 기록" }));
    const location = new URL(
      screen.getByLabelText("현재 주소").textContent ?? "",
      "http://localhost",
    );
    expect(location.pathname).toBe("/analysis/player-statistics");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      season: "2024",
      competition: "all",
      dateFrom: "2024-04-01",
      dateTo: "2024-04-30",
      [role]: id,
      playerRole: role,
    });
    expect(screen.getByRole("link", { name: "기본 기록" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await user.click(screen.getByRole("link", { name: label }));
    expect(screen.getByLabelText("현재 주소").textContent).toBe(
      `${path}?season=2024&competition=all&dateFrom=2024-04-01&dateTo=2024-04-30&${role}=${id}`,
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([undefined, "missing"])(
  "matches the shape page's effective first-player fallback for %s",
  (id) => {
    show(`/analysis/pitch-shape?season=2025${id ? `&pitcher=${id}` : ""}`);
    expect(screen.getByText("첫 투수")).toBeTruthy();
    const link = screen.getByRole("link", { name: "코스·결정구" }).getAttribute("href");
    expect(link).toContain("pitcher=p1");
    expect(link).toContain("competition=all");
  },
);

it.each([
  ["/analysis/pitch-shape", "all"],
  ["/analysis/batter-discipline", "all"],
  ["/analysis/pitch-location", "regular"],
  ["/analysis/pitch-sequences", "regular"],
])("preserves the legacy %s scope in outgoing links", (path, competition) => {
  const scope = playerNavigationScope(path, new URLSearchParams("season=2024"));
  expect(scope.options.competition).toBe(competition);
  const link = playerAnalysisHref(
    "/analysis/pitch-location",
    "pitcher",
    "p1",
    scope.season,
    scope.options,
  );
  expect(new URL(link, "http://localhost").searchParams.get("competition")).toBe(competition);
});

it("keeps the change page's effective end date and rejects inconsistent dates", () => {
  const scope = playerNavigationScope(
    "/analysis/pitcher-changes",
    new URLSearchParams("season=2024"),
  );
  expect(scope.options.dateTo).toBe("2024-12-31");
  expect(
    playerNavigationScope(
      "/analysis/pitch-location",
      new URLSearchParams("season=2024&dateFrom=2024-08-01&dateTo=2024-04-01"),
    ).error,
  ).not.toBeNull();
});

it("does not show individual-player navigation on league rankings", () => {
  show("/analysis/statistics?season=2025");
  expect(screen.queryByRole("navigation", { name: "선수 분석 항목" })).toBeNull();
});
