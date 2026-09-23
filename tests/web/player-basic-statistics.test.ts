// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisScopeQuerySchema,
  BattingStatisticsQuerySchema,
  PitchingStatisticsQuerySchema,
  resolveAnalysisScope,
  type BattingStatisticsRow,
  type PitchingStatisticsRow,
} from "@kbo/contracts";
import { battingStatistics, pitchingStatistics } from "@kbo/game-core";
import { PlayerBasicStatisticsPage } from "../../apps/web/src/pages/player-basic-statistics-page.js";
import { PlayerAnalysisFrame } from "../../apps/web/src/analysis/player-analysis-frame.js";
import {
  getBattingStatistics,
  getPitchingStatistics,
} from "../../apps/web/src/api/player-statistics-client.js";
import { battingTotals, pitchingTotals } from "../helpers/player-statistics.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

function mockRecords({
  batting = [battingStatistics(battingTotals)],
  pitching = [pitchingStatistics(pitchingTotals)],
  emptyCatalog = false,
  failStatistics = false,
}: {
  batting?: BattingStatisticsRow[];
  pitching?: PitchingStatisticsRow[];
  emptyCatalog?: boolean;
  failStatistics?: boolean;
} = {}) {
  let failed = false;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const raw = Object.fromEntries(url.searchParams);
    const scopeQuery = Value.Decode(AnalysisScopeQuerySchema, {
      season: Number(raw.season),
      ...Object.fromEntries(
        ["competition", "dateFrom", "dateTo"].flatMap((key) =>
          raw[key] === undefined ? [] : [[key, raw[key]]],
        ),
      ),
    });
    const scope = resolveAnalysisScope(scopeQuery, "regular");
    if (url.pathname === "/api/v2/analysis/pitch-shape")
      return Response.json({
        season: scopeQuery.season,
        scope,
        pitchers: emptyCatalog
          ? []
          : [
              { pitcherId: "hp1", name: "투수 A", pitches: 150 },
              { pitcherId: "hp2", name: "투수 B", pitches: 40 },
            ],
      });
    if (url.pathname === "/api/v2/analysis/batter-discipline")
      return Response.json({
        season: scopeQuery.season,
        scope,
        batters: emptyCatalog ? [] : [{ batterId: "a1", name: "타자 A", pitches: 70 }],
      });
    if (!url.pathname.startsWith("/api/v2/analysis/statistics/"))
      throw new Error(`Unexpected request: ${url.pathname}`);
    if (failStatistics && !failed) {
      failed = true;
      return Response.json({}, { status: 503 });
    }
    const pitch = url.pathname.endsWith("pitching");
    const candidate = {
      ...raw,
      season: Number(raw.season),
      page: Number(raw.page),
      limit: Number(raw.limit),
    };
    const query = pitch
      ? Value.Decode(PitchingStatisticsQuerySchema, candidate)
      : Value.Decode(BattingStatisticsQuerySchema, candidate);
    const rows = pitch ? pitching : batting;
    return Response.json({
      kind: pitch ? "pitching" : "batting",
      query,
      scope,
      sourceHash: "a".repeat(64),
      group: query.group ?? "player",
      total: rows.length,
      page: query.page ?? 1,
      limit: query.limit ?? 50,
      rows,
    });
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

function show(search = "season=2025&playerRole=pitcher&pitcher=hp1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

it("requests one bounded player page with only common scope and preserves team rows and incomplete ERA", async () => {
  const fetch = mockRecords({
    pitching: [
      pitchingStatistics(pitchingTotals),
      pitchingStatistics({
        ...pitchingTotals,
        teamId: "OTHER",
        teamName: "이적 후 팀",
        runs: 0,
        knownErGames: 0,
        knownErOuts: 0,
        knownEarnedRuns: 0,
      }),
    ],
  });
  show(
    "season=2024&playerRole=pitcher&pitcher=hp1&competition=all&dateFrom=2024-04-01&dateTo=2024-04-30&pitchType=slider&balls=2&minimum=999&page=4",
  );
  const table = await screen.findByRole("table", { name: "투구 성적" });
  const rows = within(table).getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(within(table).getByRole("columnheader", { name: "IP", exact: true })).toBeTruthy();
  expect(within(table).queryByRole("columnheader", { name: "K%", exact: true })).toBeNull();
  expect(rows[1]?.textContent).toContain("1/2");
  expect(rows[1]?.textContent).toContain("3.00");
  expect(rows[2]?.textContent).toContain("0/2");
  expect(within(rows[2] ?? table).getAllByText("—")).toHaveLength(3);
  expect(within(table).getByText("이적 후 팀")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2);
  const request = fetch.mock.calls
    .map(([input]) => new URL(String(input), "http://localhost"))
    .find((url) => url.pathname.endsWith("/statistics/pitching"));
  expect(Object.fromEntries(request?.searchParams ?? [])).toEqual({
    season: "2024",
    competition: "all",
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
    playerId: "hp1",
    group: "player",
    page: "1",
    limit: "200",
  });
  expect(screen.getByRole("link", { name: "기본 기록" }).getAttribute("aria-current")).toBe("page");
});

it("shows basic batting columns and each team's returned rates without combining them", async () => {
  const fetch = mockRecords({
    batting: [
      battingStatistics(battingTotals),
      battingStatistics({
        ...battingTotals,
        teamId: "SECOND",
        teamName: "다른 팀",
        hits: 1,
        doubles: 0,
        homeRuns: 0,
      }),
    ],
  });
  show("season=2025&playerRole=batter&batter=a1");
  const table = await screen.findByRole("table", { name: "타격 성적" });
  expect(within(table).getAllByRole("row")).toHaveLength(3);
  for (const metric of [
    "G",
    "PA",
    "AB",
    "H",
    "2B",
    "3B",
    "HR",
    "HBP",
    "SO",
    "R",
    "AVG",
    "OBP",
    "SLG",
    "OPS",
  ])
    expect(within(table).getByRole("columnheader", { name: metric, exact: true })).toBeTruthy();
  expect(within(table).queryByRole("columnheader", { name: "SF", exact: true })).toBeNull();
  expect(within(table).getByText("1.700")).toBeTruthy();
  expect(within(table).getByText("0.575")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([input]) => !String(input).includes("/pitch-shape"))).toBe(true);
});

it("keeps a requested ID absent from the pitch catalog and reports a loaded empty record", async () => {
  const fetch = mockRecords({ pitching: [] });
  show("season=2025&playerRole=pitcher&pitcher=outside");
  expect(await screen.findByText(/선택한 범위에 이 선수의 기본 기록이 없습니다/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByRole("option", { name: "선수 outside" })).toHaveProperty("selected", true);
  expect(fetch.mock.calls.some(([input]) => String(input).includes("playerId=outside"))).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not fall back to an unfiltered statistics request when no player can be selected", async () => {
  const fetch = mockRecords({ emptyCatalog: true });
  show("season=2025&playerRole=pitcher");
  expect(
    await screen.findByRole("heading", { name: "선택한 범위에 분석할 선수가 없습니다" }),
  ).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toContain("/analysis/pitch-shape");
  expect(screen.queryByRole("table")).toBeNull();
});

it("changes only the selected player and requests that player's statistics in the same scope", async () => {
  const fetch = mockRecords();
  show(
    "season=2024&playerRole=pitcher&pitcher=hp1&competition=all&dateFrom=2024-04-01&dateTo=2024-04-30",
  );
  await screen.findByRole("table", { name: "투구 성적" });
  const query = {
    season: 2024,
    competition: "all",
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
    playerId: "hp2",
    group: "player",
    page: 1,
    limit: 200,
  };
  fetch.mockResolvedValueOnce(
    Response.json({
      kind: "pitching",
      query,
      scope: resolveAnalysisScope({
        season: 2024,
        competition: "all",
        dateFrom: "2024-04-01",
        dateTo: "2024-04-30",
      }),
      sourceHash: "a".repeat(64),
      group: "player",
      total: 1,
      page: 1,
      limit: 200,
      rows: [
        pitchingStatistics({
          ...pitchingTotals,
          identity: "naver:hp2",
          playerId: "hp2",
          name: "투수 B",
        }),
      ],
    }),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "투수" }), { target: { value: "hp2" } });
  const table = await screen.findByRole("table", { name: "투구 성적" });
  expect(within(table).getByRole("rowheader", { name: "투수 B" })).toBeTruthy();
  expect(screen.getByLabelText("현재 주소").textContent).toBe(
    "/analysis/player-statistics?season=2024&playerRole=pitcher&pitcher=hp2&competition=all&dateFrom=2024-04-01&dateTo=2024-04-30",
  );
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(String(fetch.mock.calls[2]?.[0])).toContain("playerId=hp2");
});

it("distinguishes a failed record request from no records and retries the selected player's query", async () => {
  const fetch = mockRecords({ failStatistics: true });
  show();
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("기본 기록을 읽지 못했습니다."),
  );
  expect(screen.queryByText(/선택한 범위에 이 선수의 기본 기록이 없습니다/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "기록 다시 시도" }));
  expect(await screen.findByRole("table", { name: "투구 성적" })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("preserves the player and role when changing season and removes dates from the old season", async () => {
  const fetch = mockRecords();
  show(
    "season=2024&playerRole=pitcher&pitcher=hp1&competition=all&dateFrom=2024-04-01&dateTo=2024-04-30",
  );
  await screen.findByRole("table", { name: "투구 성적" });
  fireEvent.change(screen.getByRole("combobox", { name: "성적 시즌" }), {
    target: { value: "2025" },
  });
  await screen.findByRole("table", { name: "투구 성적" });
  expect(screen.getByLabelText("현재 주소").textContent).toBe(
    "/analysis/player-statistics?season=2025&playerRole=pitcher&pitcher=hp1&competition=all",
  );
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("does not query an invalid date range", () => {
  const fetch = mockRecords();
  show("season=2025&playerRole=pitcher&pitcher=hp1&dateFrom=2025-08-01&dateTo=2025-04-01");
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects an empty competition instead of mixing all-game catalog and regular-season records", () => {
  const fetch = mockRecords();
  show("season=2025&playerRole=pitcher&pitcher=hp1&competition=");
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["batting", "pitching"] as const)(
  "rejects a %s response containing another player",
  async (kind) => {
    mockRecords();
    const get = kind === "batting" ? getBattingStatistics : getPitchingStatistics;
    await expect(
      get(
        {
          season: 2025,
          competition: "regular",
          playerId: "different",
          group: "player",
          page: 1,
          limit: 200,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("성적 조회 범위가 요청과 다릅니다.");
  },
);
