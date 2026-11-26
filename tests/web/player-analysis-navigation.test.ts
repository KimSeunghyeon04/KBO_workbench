// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope, type PlayerDirectoryEntry } from "@kbo/contracts";
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
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

const players: PlayerDirectoryEntry[] = [
  {
    identity: "naver:p1",
    sourceIds: ["p1"],
    name: "첫 투수",
    primaryPosition: "투수",
    teams: ["가상 홈"],
    seasons: [
      { season: 2025, battingPlayerId: null, pitchingPlayerId: "p1" },
      { season: 2024, battingPlayerId: null, pitchingPlayerId: "p1" },
    ],
  },
  {
    identity: "naver:p2",
    sourceIds: ["p2", "p2-old"],
    name: "선택 투수",
    primaryPosition: "투수",
    teams: ["가상 홈", "가상 원정"],
    seasons: [
      { season: 2025, battingPlayerId: null, pitchingPlayerId: "p2" },
      { season: 2024, battingPlayerId: "p2", pitchingPlayerId: "p2" },
      { season: 2023, battingPlayerId: "p2-old", pitchingPlayerId: null },
    ],
  },
  ...(
    [
      ["b1", "선택 타자"],
      ["b2", "다른 타자"],
    ] as const
  ).map(([id, name]) => ({
    identity: `naver:${id}`,
    sourceIds: [id],
    name: name,
    primaryPosition: "포수",
    teams: ["가상 원정"],
    seasons: [2025, 2024].map((season) => ({
      season,
      battingPlayerId: id,
      pitchingPlayerId: null,
    })),
  })),
];

function show(url: string) {
  const client = createAnalysisQueryClient(players);
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
    batters: [
      { batterId: "b1", name: "선택 타자", pitches: 80 },
      { batterId: "b2", name: "다른 타자", pitches: 50 },
    ],
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
    "/analysis/pitch-shape?season=2024&pitcher=p2&competition=allstar&dateFrom=2024-04-01&dateTo=2024-04-30&color=cluster&cluster=2";
  const fetch = show(original);
  const user = userEvent.setup();
  const nav = screen.getByRole("navigation", { name: "선수 기록 보기" });
  expect(screen.getByText("선택 투수")).toBeTruthy();
  expect(
    within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual(["기본 기록", "경기별", "상황별", "구종·코스", "맞대결"]);
  expect(within(nav).getByRole("link", { name: "구종·코스" }).getAttribute("aria-current")).toBe(
    "location",
  );
  await user.click(within(nav).getByRole("link", { name: "경기별" }));
  const location = new URL(
    screen.getByLabelText("현재 주소").textContent ?? "",
    "http://localhost",
  );
  expect(location.pathname).toBe("/analysis/player-games");
  expect(Object.fromEntries(location.searchParams)).toEqual({
    season: "2024",
    competition: "allstar",
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
    pitcher: "p2",
    player: "naver:p2",
    playerRole: "pitcher",
  });
  expect(within(nav).getByRole("link", { name: "경기별" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(screen.getByRole("searchbox", { name: "선수 검색" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "뒤로" }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe(original);
  expect(fetch).not.toHaveBeenCalled();
});

it("edits the common scope above the report tabs and retains it when moving between them", async () => {
  show("/analysis/player-statistics?season=2025&player=naver%3Ab1&playerRole=batter");
  const user = userEvent.setup();
  const scope = screen.getByText("경기 종류·기간", { exact: true });
  const nav = screen.getByRole("navigation", { name: "선수 기록 보기" });
  expect(scope.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  await user.click(scope);
  await user.selectOptions(screen.getByLabelText("경기 종류"), "postseason");
  fireEvent.change(screen.getByLabelText("분석 시작일"), { target: { value: "2025-10-01" } });
  for (const name of ["경기별", "상황별", "구종·코스", "맞대결", "기본 기록"]) {
    await user.click(within(nav).getByRole("link", { name }));
    const url = new URL(screen.getByLabelText("현재 주소").textContent ?? "", "http://localhost");
    expect(url.searchParams.get("competition")).toBe("postseason");
    expect(url.searchParams.get("dateFrom")).toBe("2025-10-01");
    expect(screen.getByLabelText("분석 시작일")).toHaveProperty("value", "2025-10-01");
  }
});

it("changes the pitcher and season in place, including the active outcome subtab", async () => {
  const path = "/analysis/pitch-location";
  const original = `${path}?season=2024&pitcher=p1&competition=allstar&dateFrom=2024-04-01&dateTo=2024-04-30&outcomeView=arsenal&balls=2`;
  const fetch = show(original);
  const user = userEvent.setup();
  const search = screen.getByRole("searchbox", { name: "선수 검색" });
  expect(screen.queryByRole("list", { name: "선수 검색 결과" })).toBeNull();
  await user.type(search, "P2");
  expect(
    screen.getByRole("button", {
      name: "선택 투수, 출생연도 미확인, 투수, 가상 홈 → 가상 원정",
    }),
  ).toBeTruthy();
  await user.keyboard("{ArrowDown}{Enter}");
  const readLocation = () =>
    new URL(screen.getByLabelText("현재 주소").textContent ?? "", "http://localhost");
  expect(readLocation().pathname).toBe(path);
  expect(Object.fromEntries(readLocation().searchParams)).toEqual({
    season: "2024",
    pitcher: "p2",
    competition: "allstar",
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
    outcomeView: "arsenal",
    balls: "2",
    player: "naver:p2",
  });
  expect(search).toHaveProperty("value", "");
  expect(document.activeElement).toBe(search);

  await user.selectOptions(screen.getByRole("combobox", { name: "분석 시즌" }), "2025");
  expect(readLocation().pathname).toBe(path);
  expect(Object.fromEntries(readLocation().searchParams)).toEqual({
    season: "2025",
    pitcher: "p2",
    competition: "allstar",
    outcomeView: "arsenal",
    balls: "2",
    player: "naver:p2",
  });
  expect(screen.getByText("선택 투수")).toBeTruthy();
  expect(screen.getByRole("link", { name: "구종·코스" }).getAttribute("aria-current")).toBe("page");
  await user.click(screen.getByRole("button", { name: "뒤로" }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe(
    original.replace("p1", "p2") + "&player=naver%3Ap2",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("waits for Korean composition before offering a report search result", () => {
  const initial = "/analysis/pitch-location?season=2024&pitcher=p1";
  show(initial);
  const search = screen.getByRole("searchbox", { name: "선수 검색" });
  const address = () => screen.getByLabelText("현재 주소").textContent;
  fireEvent.compositionStart(search);
  fireEvent.input(search, { target: { value: "선택 투수" }, isComposing: true });
  expect(search).toHaveProperty("value", "선택 투수");
  expect(screen.queryByRole("list", { name: "선수 검색 결과" })).toBeNull();
  fireEvent.keyDown(search, { key: "Enter", isComposing: true });
  expect(address()).toBe(initial);

  fireEvent.compositionEnd(search, { data: "수" });
  expect(screen.getByRole("button", { name: /^선택 투수,/u })).toBeTruthy();
  fireEvent.compositionStart(search);
  fireEvent.keyDown(search, { key: "Enter" });
  expect(address()).toBe(initial);
  fireEvent.compositionEnd(search);
  fireEvent.keyDown(search, { key: "Enter" });
  expect(new URL(address() ?? "", "http://localhost").searchParams.get("pitcher")).toBe("p2");
  expect(search).toHaveProperty("value", "");
});

it("searches both roles in a matchup and pins its implicit opponent across seasons", async () => {
  const fetch = show("/analysis/matchups?season=2024&playerRole=batter");
  const user = userEvent.setup();
  const search = screen.getByRole("searchbox", { name: "선수 검색" });
  await user.type(search, "투수");
  const result = screen.getByRole("list", { name: "선수 검색 결과" });
  expect(within(result).getAllByRole("button")).toHaveLength(2);
  expect(result.textContent).not.toMatch(/ID|p1|p2/);
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(within(result).getAllByRole("button")[0]);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("list", { name: "선수 검색 결과" })).toBeNull();
  await user.clear(search);
  await user.type(search, "다른 타");
  await user.click(
    screen.getByRole("button", { name: "다른 타자, 출생연도 미확인, 포수, 가상 원정" }),
  );
  const readLocation = () =>
    new URL(screen.getByLabelText("현재 주소").textContent ?? "", "http://localhost");
  expect(readLocation().pathname).toBe("/analysis/matchups");
  expect(Object.fromEntries(readLocation().searchParams)).toEqual({
    season: "2024",
    playerRole: "batter",
    batter: "b2",
    player: "naver:b2",
  });
  await user.selectOptions(screen.getByRole("combobox", { name: "분석 시즌" }), "2025");
  expect(readLocation().pathname).toBe("/analysis/matchups");
  expect(Object.fromEntries(readLocation().searchParams)).toEqual({
    season: "2025",
    playerRole: "batter",
    batter: "b2",
    player: "naver:b2",
    pitcher: "p1",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("retains the batter as the primary player when entering and leaving a matchup", async () => {
  const fetch = show("/analysis/batter-profile?season=2025&batter=b1");
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: "맞대결" }));
  const location = new URL(
    screen.getByLabelText("현재 주소").textContent ?? "",
    "http://localhost",
  );
  expect(Object.fromEntries(location.searchParams)).toEqual({
    season: "2025",
    competition: "regular",
    batter: "b1",
    playerRole: "batter",
    player: "naver:b1",
  });
  expect(screen.getByText("선택 타자")).toBeTruthy();
  await user.click(screen.getByRole("link", { name: "구종·코스", exact: true }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe(
    "/analysis/batter-profile?season=2025&competition=regular&batter=b1&player=naver%3Ab1",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["pitcher", "p2", "/analysis/pitch-location"],
  ["batter", "b1", "/analysis/batter-profile"],
] as const)(
  "keeps the %s and common scope when opening basic statistics",
  async (role, id, path) => {
    const fetch = show(
      `${path}?season=2024&${role}=${id}&competition=allstar&dateFrom=2024-04-01&dateTo=2024-04-30&balls=2`,
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
      competition: "allstar",
      dateFrom: "2024-04-01",
      dateTo: "2024-04-30",
      player: `naver:${id}`,
      playerRole: role,
    });
    expect(screen.getByRole("link", { name: "기본 기록" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await user.click(screen.getByRole("link", { name: "구종·코스" }));
    expect(screen.getByLabelText("현재 주소").textContent).toBe(
      `${path}?season=2024&competition=allstar&dateFrom=2024-04-01&dateTo=2024-04-30&${role}=${id}&player=naver%3A${id}`,
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("uses the first shape player only when no player is requested", () => {
  show("/analysis/pitch-shape?season=2025");
  expect(screen.getByText("첫 투수")).toBeTruthy();
  const link = screen.getByRole("link", { name: "구종·코스" }).getAttribute("href");
  expect(link).toContain("pitcher=p1");
  expect(link).toContain("competition=regular");
});

it("keeps a requested player missing from the catalog in the frame and leaves unconfirmed roles hidden", () => {
  const fetch = show("/analysis/pitch-shape?season=2025&pitcher=missing");
  expect(screen.getByText("선수 missing")).toBeTruthy();
  expect(screen.queryByText("첫 투수")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "선수 역할" })).toBeNull();
  expect(screen.getByRole("link", { name: "기본 기록" }).getAttribute("href")).toContain(
    "pitcher=missing",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["/analysis/pitch-shape", "regular"],
  ["/analysis/batter-discipline", "regular"],
  ["/analysis/pitch-location", "regular"],
  ["/analysis/pitch-sequences", "regular"],
])("preserves the %s default scope in outgoing links", (path, competition) => {
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
  expect(screen.queryByRole("navigation", { name: "선수 기록 보기" })).toBeNull();
});
it("carries explicit A/B periods between analysis tabs without leaking situation filters", () => {
  const comparison = new URLSearchParams(
    "periodCompare=1&periodASeason=2024&periodAFrom=&periodATo=&periodBSeason=2025&periodBFrom=2025-06-01&periodBTo=&balls=2&sort=ops",
  );
  const href = playerAnalysisHref(
    "/analysis/pitch-shape",
    "pitcher",
    "p1",
    2025,
    { competition: "regular" },
    comparison,
  );
  const params = new URL(href, "http://localhost").searchParams;
  expect(params.get("periodAFrom")).toBe("");
  expect(params.get("periodBFrom")).toBe("2025-06-01");
  expect(params.get("periodCompare")).toBe("1");
  expect(params.has("balls")).toBe(false);
  expect(params.has("sort")).toBe(false);
});
it("preserves new season scope across shape and discipline navigation", () => {
  const params = new URLSearchParams("season=2026&competition=allstar&pitcher=anonymous");
  expect(playerNavigationScope("/analysis/pitch-shape", params).season).toBe(2026);
  expect(
    playerNavigationScope("/analysis/batter-discipline", new URLSearchParams("season=2027")).season,
  ).toBe(2027);
});

it("reveals only the selected season's modes and falls back to basic records if the active mode has no data", async () => {
  show("/analysis/player-statistics?player=naver%3Ap2&season=2024");
  const user = userEvent.setup();
  const nav = screen.getByRole("navigation", { name: "선수 기록 보기" });
  expect(
    within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual(["기본 기록", "경기별", "상황별", "구종·코스", "맞대결"]);
  await user.click(
    within(screen.getByRole("navigation", { name: "선수 역할" })).getByRole("link", {
      name: "타격",
    }),
  );
  await user.click(within(nav).getByRole("link", { name: "구종·코스" }));
  expect(screen.getByRole("link", { name: "구종·코스" }).getAttribute("aria-current")).toBe("page");
  const season = screen.getByRole("combobox", { name: "분석 시즌" });
  await user.selectOptions(season, "2023");
  expect(screen.getByLabelText("현재 주소").textContent).toContain("batter=p2-old");
  expect(screen.queryByRole("navigation", { name: "선수 역할" })).toBeNull();
  await user.selectOptions(season, "2025");
  expect(screen.getByText("선택 투수")).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "선수 역할" })).toBeNull();
  expect(within(nav).getByRole("link", { name: "구종·코스" }).getAttribute("href")).toContain(
    "/analysis/pitch-location?",
  );
  expect(within(nav).getByRole("link", { name: "기본 기록" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(
    new URL(screen.getByLabelText("현재 주소").textContent ?? "", "http://localhost").pathname,
  ).toBe("/analysis/player-statistics");
});

it("can move from batting analysis to a pitcher with no records in the active season", async () => {
  show("/analysis/batter-profile?season=2023&batter=p2-old&player=naver%3Ap2");
  const user = userEvent.setup();
  await user.type(screen.getByRole("searchbox", { name: "선수 검색" }), "첫 투수");
  await user.click(screen.getByRole("button", { name: /^첫 투수, 출생연도 미확인, 투수/ }));
  const location = new URL(
    screen.getByLabelText("현재 주소").textContent ?? "",
    "http://localhost",
  );
  expect(location.pathname).toBe("/analysis/player-statistics");
  expect(Object.fromEntries(location.searchParams)).toEqual({ season: "2025", player: "naver:p1" });
  expect(screen.queryByRole("navigation", { name: "선수 역할" })).toBeNull();
  expect(screen.getByRole("link", { name: "구종·코스" }).getAttribute("href")).toContain(
    "/analysis/pitch-location?",
  );
});
