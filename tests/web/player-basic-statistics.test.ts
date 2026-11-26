// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisScopeQuerySchema,
  PlayerSeasonStatisticsQuerySchema,
  resolveAnalysisScope,
  type PlayerDirectoryEntry,
  type PlayerSeasonStatisticsResponse,
} from "@kbo/contracts";
import { battingStatistics, pitchingStatistics } from "@kbo/game-core";
import { PlayerBasicStatisticsPage } from "../../apps/web/src/pages/player-basic-statistics-page.js";
import { PlayerAnalysisFrame } from "../../apps/web/src/analysis/player-analysis-frame.js";
import { PlayerLeagueComparison } from "../../apps/web/src/analysis/player-league-comparison.js";
import { getPlayerSeasonStatistics } from "../../apps/web/src/api/player-statistics-client.js";
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { battingTotals, pitchingTotals } from "../helpers/player-statistics.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

function withoutIdentity<T extends typeof battingTotals | typeof pitchingTotals>(
  row: T,
): Omit<T, "identity" | "playerId" | "name" | "teamId" | "teamName"> {
  const { identity, playerId, name, teamId, teamName, ...totals } = row;
  void identity;
  void playerId;
  void name;
  void teamId;
  void teamName;
  return totals;
}
const battingRows = [2025, 2024].map((season) =>
  battingStatistics({
    ...withoutIdentity(battingTotals),
    season,
    teams: season === 2025 ? ["원정", "다른 팀"] : ["원정"],
  }),
);
const pitchingRows = [2025, 2024].map((season) =>
  pitchingStatistics({
    ...withoutIdentity(pitchingTotals),
    season,
    teams: ["홈"],
  }),
);
const path = "/api/v2/analysis/statistics/player-seasons";
const annualRequests = (fetch: ReturnType<typeof mockRecords>) =>
  fetch.mock.calls
    .map(([input]) => new URL(String(input), "http://localhost"))
    .filter((url) => url.pathname === path)
    .map((url) => Object.fromEntries(url.searchParams));

function mockRecords({
  batting = battingRows,
  pitching = pitchingRows,
  emptyCatalog = false,
  failStatistics = false,
}: Partial<Pick<PlayerSeasonStatisticsResponse, "batting" | "pitching">> & {
  emptyCatalog?: boolean;
  failStatistics?: boolean;
} = {}) {
  let failed = false;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const raw = Object.fromEntries(url.searchParams);
    const candidate = {
      ...raw,
      ...(raw.season === undefined ? {} : { season: Number(raw.season) }),
    };
    if (url.pathname === path) {
      if (failStatistics && !failed) {
        failed = true;
        return Response.json({}, { status: 503 });
      }
      const query = Value.Decode(PlayerSeasonStatisticsQuerySchema, candidate);
      const inSeason = (row: { season: number }) =>
        query.season === undefined || row.season === query.season;
      return Response.json({
        query,
        batting: query.sourceRole === "pitcher" ? [] : batting.filter(inSeason),
        pitching: query.sourceRole === "batter" ? [] : pitching.filter(inSeason),
      });
    }
    const scopeQuery = Value.Decode(AnalysisScopeQuerySchema, candidate);
    const scope = resolveAnalysisScope(scopeQuery, "regular");
    if (url.pathname === "/api/v2/analysis/pitch-shape")
      return Response.json({
        season: scopeQuery.season,
        scope,
        pitchers: emptyCatalog ? [] : [{ pitcherId: "hp1", name: "투수 A", pitches: 150 }],
      });
    if (url.pathname === "/api/v2/analysis/batter-discipline")
      return Response.json({
        season: scopeQuery.season,
        scope,
        batters: emptyCatalog ? [] : [{ batterId: "a1", name: "타자 A", pitches: 70 }],
      });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function Location() {
  const location = useLocation();
  return createElement(
    "output",
    { "aria-label": "현재 주소" },
    location.pathname + location.search,
  );
}

function show(
  search = "season=2025&playerRole=pitcher&pitcher=hp1",
  directory: PlayerDirectoryEntry[] = [],
) {
  const client = createAnalysisQueryClient(directory);
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [`/analysis/player-statistics?${search}`] },
        createElement(PlayerAnalysisFrame, null, createElement(PlayerBasicStatisticsPage)),
        createElement(Location),
      ),
    ),
  );
}

function currentParams() {
  return Object.fromEntries(
    new URL(screen.getByLabelText("현재 주소").textContent ?? "", "http://localhost").searchParams,
  );
}

const batter = {
  identity: "naver:a1",
  sourceIds: ["a1"],
  name: "타자 A",
  primaryPosition: "유격수",
  teams: ["원정", "다른 팀"],
  seasons: [2025, 2024].map((season) => ({
    season,
    battingPlayerId: "a1",
    pitchingPlayerId: null,
  })),
} satisfies PlayerDirectoryEntry;

it.each([
  ["시즌 시작 ~ 2025-11-01", { dateTo: "2025-11-01" }],
  ["2025-10-01 ~ 시즌 끝", { dateFrom: "2025-10-01" }],
] as const)("names the selected league scope and dates (%s) without fetching", (dates, range) => {
  const client = createAnalysisQueryClient();
  clients.push(client);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(PlayerLeagueComparison, {
          query: {
            season: 2025,
            player: "a1",
            role: "batter",
            competition: "postseason",
            ...range,
          },
        }),
      ),
    ),
  );
  expect(screen.getByText("2025년 포스트시즌 리그 평균과 비교")).toBeTruthy();
  expect(screen.getByText(dates)).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it("shows the newest season first and combines an in-season transfer into a single unexpandable row", async () => {
  const fetch = mockRecords({ pitching: [] });
  show("season=2024&player=naver%3Aa1", [batter]);
  const table = within(await screen.findByRole("table", { name: "연도별 타격 성적" }));
  expect(table.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
    "연도",
    "팀",
    "경기",
    "타석",
    "홈런",
    "타율",
    "출루율",
    "장타율",
    "OPS",
  ]);
  expect(table.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["2025", "2024"]);
  const transfer = within(table.getAllByRole("row")[1] ?? screen.getByRole("table"));
  expect(transfer.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    "원정 · 다른 팀",
    "2",
    "8",
    "1",
    "0.400",
    "0.500",
    "1.200",
    "1.700",
  ]);
  expect(table.queryByRole("button")).toBeNull();
  expect(screen.queryByText("상세 기록", { exact: true })).toBeNull();
  expect(annualRequests(fetch)).toEqual([{ player: "naver:a1", competition: "regular" }]);
  fireEvent.change(screen.getByLabelText("분석 시즌"), { target: { value: "2025" } });
  expect(currentParams().season).toBe("2025");
  expect(table.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["2025", "2024"]);
  expect(annualRequests(fetch)).toHaveLength(1);
});

it("opens an existing date-scoped link for the requested player and preserves incomplete ERA", async () => {
  const fetch = mockRecords();
  show(
    "season=2024&playerRole=pitcher&pitcher=hp1&competition=allstar&dateFrom=2024-04-01&dateTo=2024-04-30&pitchType=slider&balls=2&page=4",
  );
  const table = within(await screen.findByRole("table", { name: "연도별 투구 성적" }));
  expect(table.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["2024"]);
  expect(table.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    "홈",
    "2",
    "9",
    "40",
    "8",
    "2",
    "—",
    "1/2",
  ]);
  expect(screen.getByText(/자책점이 미확인된 경기가 있으면 평균자책점은 —/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "기본 기록" }).getAttribute("aria-current")).toBe("page");
  expect(annualRequests(fetch)).toEqual([
    {
      season: "2024",
      competition: "allstar",
      dateFrom: "2024-04-01",
      dateTo: "2024-04-30",
      player: "hp1",
      sourceRole: "pitcher",
    },
  ]);
  const toggle = screen.getByText("경기 종류·기간", { exact: true });
  expect(
    toggle.compareDocumentPosition(screen.getByRole("table", { name: "연도별 투구 성적" })) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(toggle.closest("details")?.open).toBe(false);
  fireEvent.click(toggle);
  expect(screen.getByLabelText("분석 시작일")).toHaveProperty("value", "2024-04-01");
  expect(annualRequests(fetch)).toHaveLength(1);
});

it.each(["pitcher", "batter"] as const)(
  "preserves an implicitly selected %s and clears the previous year's dates on season change",
  async (role) => {
    const fetch = mockRecords();
    show(`season=2024&playerRole=${role}&dateFrom=2024-04-01&dateTo=2024-04-30`);
    const name = role === "pitcher" ? "연도별 투구 성적" : "연도별 타격 성적";
    await screen.findByRole("table", { name });
    fireEvent.change(screen.getByLabelText("분석 시즌"), { target: { value: "2025" } });
    const playerId = role === "pitcher" ? "hp1" : "a1";
    expect(currentParams()).toEqual({ season: "2025", playerRole: role, [role]: playerId });
    await waitFor(() => {
      expect(annualRequests(fetch).at(-1)).toEqual({
        competition: "regular",
        player: playerId,
        sourceRole: role,
      });
    });
    expect(
      within(await screen.findByRole("table", { name })).getAllByRole("rowheader"),
    ).toHaveLength(2);
  },
);

it("keeps a requested ID absent from the catalog and reports an empty result", async () => {
  const fetch = mockRecords({ pitching: [] });
  show("season=2025&playerRole=pitcher&pitcher=outside");
  expect(await screen.findByText(/선택한 범위에 이 선수의 기본 기록이 없습니다/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByText("선수 outside", { exact: true })).toBeTruthy();
  expect(annualRequests(fetch)).toEqual([
    { player: "outside", sourceRole: "pitcher", competition: "regular" },
  ]);
});

it("does not request statistics when no player can be selected", async () => {
  const fetch = mockRecords({ emptyCatalog: true });
  show("season=2025&playerRole=pitcher");
  expect(
    await screen.findByRole("heading", { name: "선택한 범위에 분석할 선수가 없습니다" }),
  ).toBeTruthy();
  expect(annualRequests(fetch)).toEqual([]);
  expect(screen.queryByRole("table")).toBeNull();
});

it("changes the player identity while preserving the explicit period", async () => {
  const fetch = mockRecords({ batting: [] });
  show(
    "season=2024&playerRole=pitcher&pitcher=hp1&competition=allstar&dateFrom=2024-04-01&dateTo=2024-04-30",
    [
      {
        identity: "naver:hp2",
        name: "투수 B",
        sourceIds: ["hp2"],
        primaryPosition: "투수",
        teams: ["가상 팀"],
        seasons: [{ season: 2024, battingPlayerId: null, pitchingPlayerId: "hp2" }],
      },
    ],
  );
  await screen.findByRole("table", { name: "연도별 투구 성적" });
  fireEvent.change(screen.getByRole("searchbox", { name: "선수 검색" }), {
    target: { value: "hp2" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^투수 B, 출생연도 미확인, 투수/ }));
  await screen.findByRole("table", { name: "연도별 투구 성적" });
  const period = {
    season: "2024",
    competition: "allstar",
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
  };
  expect(currentParams()).toEqual({ ...period, player: "naver:hp2", playerRole: "pitcher" });
  expect(annualRequests(fetch)).toEqual([
    { ...period, player: "hp1", sourceRole: "pitcher" },
    { ...period, player: "naver:hp2" },
  ]);
});

it("shows both roles from one canonical request even when the selected analysis season has only one role", async () => {
  const fetch = mockRecords({ pitching: pitchingRows.filter(({ season }) => season === 2024) });
  show("player=naver%3Aa1&season=2025", [
    {
      ...batter,
      seasons: [
        { season: 2025, battingPlayerId: "a1", pitchingPlayerId: null },
        { season: 2024, battingPlayerId: "a1", pitchingPlayerId: "a1" },
      ],
    },
  ]);
  await screen.findByRole("table", { name: "연도별 타격 성적" });
  const pitch = within(await screen.findByRole("table", { name: "연도별 투구 성적" }));
  expect(pitch.getByRole("rowheader").textContent).toBe("2024");
  expect(annualRequests(fetch)).toEqual([{ player: "naver:a1", competition: "regular" }]);
});

it("distinguishes a failed record request from no records and retries the same request", async () => {
  const fetch = mockRecords({ failStatistics: true });
  show();
  expect((await screen.findByRole("alert")).textContent).toContain("기본 기록을 읽지 못했습니다.");
  expect(screen.queryByText(/선택한 범위에 이 선수의 기본 기록이 없습니다/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "기록 다시 시도" }));
  await screen.findByRole("table", { name: "연도별 투구 성적" });
  const requests = annualRequests(fetch);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

it.each(["dateFrom=2025-08-01&dateTo=2025-04-01", "competition="])(
  "does not request records for an invalid scope: %s",
  (scope) => {
    const fetch = mockRecords();
    show(`season=2025&playerRole=pitcher&pitcher=hp1&${scope}`);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(["another player", "duplicate season", "out-of-range season", "other role"] as const)(
  "rejects annual responses containing a %s",
  async (kind) => {
    const query = { player: "a1", sourceRole: "batter", season: 2025 } as const;
    const first = battingRows[0];
    const second = battingRows[1];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          query: kind === "another player" ? { ...query, player: "other" } : query,
          batting:
            kind === "duplicate season"
              ? [first, first]
              : kind === "out-of-range season"
                ? [second]
                : [first],
          pitching: kind === "other role" ? [pitchingRows[0]] : [],
        }),
      ),
    );
    await expect(getPlayerSeasonStatistics(query, new AbortController().signal)).rejects.toThrow(
      "연도별 성적 조회 범위가 요청과 다릅니다.",
    );
  },
);
