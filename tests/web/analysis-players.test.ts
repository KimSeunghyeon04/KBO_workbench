// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { AnalysisPlayersPage } from "../../apps/web/src/pages/analysis-players-page.js";

interface CatalogPlayer {
  id: string;
  name: string;
  pitches: number;
}
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

function mockCatalogs(
  pitchers: CatalogPlayer[] = [{ id: "p1", name: "가상 투수", pitches: 1234 }],
  batters: CatalogPlayer[] = [{ id: "b1", name: "가상 타자", pitches: 567 }],
) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const { season, ...options } = Object.fromEntries(url.searchParams);
    const scope = resolveAnalysisScope({ season: Number(season), ...options });
    if (url.pathname === "/api/v2/analysis/pitch-shape")
      return Response.json({
        season: Number(season),
        scope,
        pitchers: pitchers.map(({ id, ...player }) => ({ pitcherId: id, ...player })),
      });
    if (url.pathname === "/api/v2/analysis/batter-discipline")
      return Response.json({
        season: Number(season),
        scope,
        batters: batters.map(({ id, ...player }) => ({ batterId: id, ...player })),
      });
    throw new Error(`선수 탐색에서 상세 분석을 요청했습니다: ${url.pathname}`);
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

function show(search = "season=2024") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/previous", `/analysis/players?${search}`], initialIndex: 1 },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/analysis/players",
            element: createElement(AnalysisPlayersPage),
          }),
          createElement(Route, { path: "*", element: createElement("p", null, "이전 페이지") }),
        ),
        createElement(Location),
      ),
    ),
  );
}

function destination(link: HTMLElement) {
  return new URL(link.getAttribute("href") ?? "", "http://localhost");
}

it("loads only the selected role's catalog and links to the player's analysis with the regular default", async () => {
  const fetch = mockCatalogs();
  show();
  const pitcher = await screen.findByRole("link", { name: "가상 투수 분석 보기" });
  expect(screen.getByRole("heading", { name: "선수 분석", level: 1 })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toContain("competition=regular");
  const pitchingUrl = destination(pitcher);
  expect(pitchingUrl.pathname).toBe("/analysis/pitch-location");
  expect(Object.fromEntries(pitchingUrl.searchParams)).toEqual({
    season: "2024",
    competition: "regular",
    pitcher: "p1",
  });
  expect(within(pitcher).getByText("1,234구")).toBeTruthy();
  const roles = screen.getByRole("group", { name: "선수 유형" });
  fireEvent.click(within(roles).getByRole("button", { name: "타자" }));
  const batter = await screen.findByRole("link", { name: "가상 타자 분석 보기" });
  expect(within(roles).getByRole("button", { name: "타자" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(destination(batter).pathname).toBe("/analysis/batter-profile");
  expect(destination(batter).searchParams.get("batter")).toBe("b1");
  expect(screen.queryByRole("link", { name: "가상 투수 분석 보기" })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1]?.[0])).toContain("/api/v2/analysis/batter-discipline?");
});

it("limits the rendered list to 48 players and searches locally by ID while resetting the page", async () => {
  const players = Array.from({ length: 55 }, (_, index) => ({
    id: `P${String(index + 1).padStart(3, "0")}`,
    name: `투수 ${String(index + 1).padStart(3, "0")}`,
    pitches: 5500 - index,
  }));
  const fetch = mockCatalogs(players);
  show();
  const list = await screen.findByRole("list", { name: "투수 목록" });
  expect(within(list).getAllByRole("link")).toHaveLength(48);
  fireEvent.click(screen.getByRole("button", { name: "다음 선수" }));
  expect(within(list).getAllByRole("link")).toHaveLength(7);
  expect(screen.getByLabelText("현재 주소").textContent).toContain("page=2");
  fireEvent.change(screen.getByRole("searchbox", { name: "선수 검색" }), {
    target: { value: "p055" },
  });
  expect(within(list).getAllByRole("link")).toHaveLength(1);
  expect(within(list).getByRole("link", { name: "투수 055 분석 보기" })).toBeTruthy();
  expect(screen.getByLabelText("현재 주소").textContent).not.toContain("page=");
  expect(screen.getByRole("button", { name: "이전 선수" }).hasAttribute("disabled")).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("distinguishes same-name players by their actual ID in the link description", async () => {
  mockCatalogs([
    { id: "first id", name: "동명 선수", pitches: 80 },
    { id: "second/id", name: "동명 선수", pitches: 60 },
  ]);
  show();
  const first = await screen.findByRole("link", {
    name: "동명 선수 분석 보기",
    description: "ID first id",
  });
  const second = screen.getByRole("link", {
    name: "동명 선수 분석 보기",
    description: "ID second/id",
  });
  expect(destination(first).searchParams.get("pitcher")).toBe("first id");
  expect(destination(second).searchParams.get("pitcher")).toBe("second/id");
});

it("restores the role and name search, preserves explicit scope in links, and replaces search history", async () => {
  const fetch = mockCatalogs(undefined, [
    { id: "b1", name: "김가상", pitches: 300 },
    { id: "b2", name: "이가상", pitches: 200 },
  ]);
  show(
    `season=2024&competition=postseason&dateFrom=2024-10-01&dateTo=2024-10-31&role=batter&q=${encodeURIComponent("김가상".normalize("NFD"))}&page=999`,
  );
  const player = await screen.findByRole("link", { name: "김가상 분석 보기" });
  expect(screen.queryByRole("link", { name: "이가상 분석 보기" })).toBeNull();
  expect(Object.fromEntries(destination(player).searchParams)).toEqual({
    season: "2024",
    competition: "postseason",
    dateFrom: "2024-10-01",
    dateTo: "2024-10-31",
    batter: "b1",
  });
  const search = screen.getByRole("searchbox", { name: "선수 검색" });
  fireEvent.change(search, { target: { value: "이" } });
  fireEvent.change(search, { target: { value: "이가상" } });
  expect(screen.getByRole("link", { name: "이가상 분석 보기" })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "이전 화면" }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe("/previous");
});

it("distinguishes no matching name from an empty scoped catalog", async () => {
  const fetch = mockCatalogs(undefined, []);
  show("season=2024&competition=unknown&dateFrom=2024-04-01&q=없는이름");
  expect(await screen.findByRole("heading", { name: "검색 결과가 없습니다" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "검색 초기화" }));
  expect(screen.getByRole("link", { name: "가상 투수 분석 보기" })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(within(screen.getByRole("group", { name: "선수 유형" })).getByText("타자"));
  expect(
    await screen.findByRole("heading", { name: "선택한 범위에 분석할 선수가 없습니다" }),
  ).toBeTruthy();
  const coverage = screen.getByRole("link", { name: "이 범위의 자료 품질 확인 →" });
  expect(Object.fromEntries(destination(coverage).searchParams)).toEqual({
    season: "2024",
    competition: "unknown",
    dateFrom: "2024-04-01",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(["season=2024&dateFrom=2024-09-01&dateTo=2024-04-01", "season=2026"])(
  "does not request a catalog for invalid scope %s",
  (search) => {
    const fetch = mockCatalogs();
    show(search);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("선수 목록을 읽고 있습니다.")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("retries a failed catalog request and clears obsolete dates when the season changes", async () => {
  const fetch = mockCatalogs();
  fetch.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  show("season=2024&competition=all&dateFrom=2024-04-01&dateTo=2024-04-30&page=2");
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await screen.findByRole("link", { name: "가상 투수 분석 보기" });
  expect(fetch).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByRole("combobox", { name: "선수 분석 시즌" }), {
    target: { value: "2025" },
  });
  const player = await screen.findByRole("link", { name: "가상 투수 분석 보기" });
  expect(Object.fromEntries(destination(player).searchParams)).toEqual({
    season: "2025",
    competition: "all",
    pitcher: "p1",
  });
  expect(screen.getByLabelText("현재 주소").textContent).not.toMatch(/dateFrom|dateTo|page=/);
  expect(fetch).toHaveBeenCalledTimes(3);
});
