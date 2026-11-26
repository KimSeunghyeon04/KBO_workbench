// @vitest-environment jsdom
import { createElement } from "react";
import type { PlayerDirectoryEntry } from "@kbo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AnalysisPlayersPage } from "../../apps/web/src/pages/analysis-players-page.js";

const player: PlayerDirectoryEntry = {
  identity: "naver:dual",
  name: "동명 선수",
  primaryPosition: "외야수",
  birthYear: 1993,
  teams: ["첫 팀", "다른 팀"],
  sourceIds: ["dual", "old-dual"],
  seasons: [
    { season: 2026, battingPlayerId: "dual", pitchingPlayerId: "dual" },
    { season: 2023, battingPlayerId: "old-dual", pitchingPlayerId: null },
  ],
  career: {
    firstSeason: 2011,
    lastSeason: 2026,
    clubs: [
      { name: "처음 구단", joinedOn: null },
      { name: "첫 팀", joinedOn: "2019-11-20" },
      { name: "다른 팀", joinedOn: "2025-07-31" },
      { name: "첫 팀", joinedOn: "2026-02-01" },
    ],
  },
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.unstubAllGlobals();
});

function mockDirectory(players: PlayerDirectoryEntry[] = [player]) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    expect(input).toBe("/api/v2/analysis/players");
    return Response.json(players);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return createElement(
    "div",
    null,
    createElement("output", { "aria-label": "현재 주소" }, location.pathname + location.search),
    createElement("button", { onClick: () => navigate(-1) }, "이전 화면"),
  );
}

function show(search = "", previous = "/previous") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [previous, `/analysis/players?${search}`], initialIndex: 1 },
        createElement(AnalysisPlayersPage),
        createElement(Location),
      ),
    ),
  );
}

function destination(link: HTMLElement) {
  return new URL(link.getAttribute("href") ?? "", "http://localhost");
}

it("shows one result per identity across seasons and roles and distinguishes homonyms by position and teams", async () => {
  const fetch = mockDirectory([
    player,
    {
      identity: "naver:same-name",
      name: player.name,
      primaryPosition: "투수",
      teams: ["이전 팀"],
      sourceIds: ["same-name"],
      seasons: [{ season: 2020, battingPlayerId: null, pitchingPlayerId: "same-name" }],
    },
  ]);
  show("season=2024&role=batter&competition=allstar");
  const list = await screen.findByRole("list", { name: "선수 목록" });
  expect(within(list).getAllByRole("link", { name: "동명 선수 분석 보기" })).toHaveLength(2);
  const dual = within(list).getByRole("link", {
    description: "1993년생 외야수 처음 구단 → 첫 팀 → 다른 팀 → 첫 팀",
  });
  const other = within(list).getByRole("link", { description: "출생연도 미확인 투수 이전 팀" });
  expect(list.textContent).not.toMatch(/dual|same-name|ID|\d{4}[.-]\d{2}[.-]\d{2}/);
  expect(destination(dual).pathname).toBe("/analysis/player-statistics");
  expect(Object.fromEntries(destination(dual).searchParams)).toEqual({
    player: "naver:dual",
    season: "2026",
  });
  expect(Object.fromEntries(destination(other).searchParams)).toEqual({
    player: "naver:same-name",
    season: "2020",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("paginates the results and searches locally by any observed ID", async () => {
  const fetch = mockDirectory([
    ...Array.from({ length: 54 }, (_, index) => ({
      ...player,
      identity: `player-${index}`,
      name: `선수 ${index}`,
      sourceIds: [`id-${index}`],
    })),
    player,
  ]);
  show();
  const list = await screen.findByRole("list", { name: "선수 목록" });
  expect(within(list).getAllByRole("link")).toHaveLength(48);
  fireEvent.click(screen.getByRole("button", { name: "다음 선수" }));
  expect(within(list).getAllByRole("link")).toHaveLength(7);
  fireEvent.change(screen.getByRole("searchbox", { name: "선수 검색" }), {
    target: { value: "OLD-DUAL" },
  });
  expect(within(list).getAllByRole("link")).toHaveLength(1);
  expect(within(list).getByRole("link", { name: "동명 선수 분석 보기" })).toBeTruthy();
  expect(screen.getByLabelText("현재 주소").textContent).not.toContain("page=");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("restores a normalized name search and replaces edited query history", async () => {
  mockDirectory();
  show(`q=${encodeURIComponent(player.name.normalize("NFD"))}`);
  await screen.findByRole("link", { name: "동명 선수 분석 보기" });
  fireEvent.change(screen.getByRole("searchbox", { name: "선수 검색" }), {
    target: { value: "없는이름" },
  });
  await screen.findByRole("heading", { name: "검색 결과가 없습니다" });
  fireEvent.click(screen.getByRole("button", { name: "검색 초기화" }));
  expect(screen.getByRole("link", { name: "동명 선수 분석 보기" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "이전 화면" }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe("/previous");
});

it("keeps the URL and results stable until the Korean name is committed", async () => {
  mockDirectory([
    player,
    { ...player, identity: "naver:77637", name: "양현종", sourceIds: ["77637"] },
  ]);
  show("q=dual&page=1", "/analysis/players?q=old-dual");
  await screen.findByRole("link", { name: "동명 선수 분석 보기" });
  const search = screen.getByRole("searchbox", { name: "선수 검색" });
  const address = () => screen.getByLabelText("현재 주소").textContent;
  fireEvent.compositionStart(search);
  for (const value of ["ㅇ", "야", "양", "양혀", "양현", "양현종"]) {
    fireEvent.input(search, { target: { value }, isComposing: true });
    expect(search).toHaveProperty("value", value);
    expect(address()).toBe("/analysis/players?q=dual&page=1");
  }
  expect(screen.queryByRole("link", { name: "양현종 분석 보기" })).toBeNull();
  fireEvent.compositionEnd(search, { data: "종" });
  expect(search).toHaveProperty("value", "양현종");
  expect(address()).toBe(`/analysis/players?q=${encodeURIComponent("양현종")}`);
  expect(screen.getByRole("link", { name: "양현종 분석 보기" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "이전 화면" }));
  expect(search).toHaveProperty("value", "old-dual");
  expect(screen.getByRole("link", { name: "동명 선수 분석 보기" })).toBeTruthy();
});

it("retries failure and distinguishes an empty directory from an unmatched search", async () => {
  const fetch = mockDirectory([]);
  fetch.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  show("q=없는이름");
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await screen.findByText("분석할 선수 기록이 아직 없습니다.");
  expect(screen.queryByRole("heading", { name: "검색 결과가 없습니다" })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});
