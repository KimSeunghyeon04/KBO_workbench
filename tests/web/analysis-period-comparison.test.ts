// @vitest-environment jsdom
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  analysisPeriodQueries,
  resolveAnalysisScope,
  type AnalysisPeriodQuery,
  type AnalysisPreparation,
} from "@kbo/contracts";
import { AnalysisRefreshBoundary } from "../../apps/web/src/analysis/analysis-seasons.js";
import { PlayerPeriodComparison } from "../../apps/web/src/analysis/player-period-comparison.js";
import { PeriodComparisonResults } from "../../apps/web/src/analysis/period-comparison-results.js";
import {
  getAnalysisPeriodComparison,
  type PeriodComparisonKind,
} from "../../apps/web/src/api/analysis-period-client.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((c) => c.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});
function Location() {
  const location = useLocation(),
    navigate = useNavigate();
  return createElement(
    "div",
    {},
    createElement("output", { "aria-label": "현재 주소" }, location.search),
    createElement("button", { onClick: () => void navigate(-1) }, "뒤로"),
  );
}
function response(query: AnalysisPeriodQuery) {
  const periods = analysisPeriodQueries(query);
  const snapshot = ({ season, competition, dateFrom, dateTo }: typeof periods.first) => ({
    scope: resolveAnalysisScope({
      season,
      competition: competition ?? "regular",
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    }),
    sourceHash: "a".repeat(64),
    samples: [{ label: "실제 투구", count: 10 }],
  });
  return {
    playerId: "p1",
    query,
    first: snapshot(periods.first),
    second: snapshot(periods.second),
    warnings: [],
    metrics: [
      {
        key: "whiff",
        group: "전체",
        label: "Whiff%",
        unit: "rate",
        first: { value: 0, numerator: 0, denominator: 5 },
        second: { value: 0.2, numerator: 2, denominator: 10 },
        difference: 0.2,
      },
      {
        key: "chase",
        group: "전체",
        label: "Chase%",
        unit: "rate",
        first: { value: null, numerator: 0, denominator: 0 },
        second: { value: 0, numerator: 0, denominator: 5 },
        difference: null,
      },
    ],
  };
}
function mock() {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const raw = Object.fromEntries(url.searchParams);
    return Response.json(
      response({
        ...raw,
        season: Number(raw.season),
        compareSeason: Number(raw.compareSeason),
        ...(raw.balls === undefined ? {} : { balls: Number(raw.balls) }),
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function show(kind: PeriodComparisonKind, search = "", dates = false, seasons?: number[]) {
  const client = createAnalysisQueryClient();
  if (seasons !== undefined)
    client.setQueryData(["analysis-seasons"], {
      sourceHash: "a".repeat(64),
      seasons,
      preparation: [],
    });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [`/?${search}`] },
        createElement(
          AnalysisRefreshBoundary,
          null,
          createElement(PlayerPeriodComparison, {
            kind,
            playerId: "p1",
            role: "batter",
            query: {
              season: 2025,
              competition: "regular",
              ...(dates ? { dateFrom: "2025-04-01", dateTo: "2025-08-01" } : {}),
              ...(kind === "batter-profile" || kind === "batter-discipline"
                ? { balls: 2, pitchType: "직구", stance: "L" }
                : {}),
            },
          }),
        ),
        createElement(Location),
      ),
    ),
  );
  return client;
}

it("refreshes an applied comparison for changes in either selected season", async () => {
  const fetch = mock();
  const client = show("pitch-shape", "season=2025&periodASeason=2025&periodBSeason=2024");
  const seasons = [2026, 2025, 2024];
  let rows: AnalysisPreparation[] = seasons.map((season) => ({
    version: 1,
    season,
    sourceHash: "a".repeat(64),
    competitionHash: null,
    state: "ready",
    unclassified: 0,
    updatedAt: "2026-11-21T00:00:00Z",
    error: null,
  }));
  async function publish(sourceHash: string) {
    await act(async () => {
      client.setQueryData(["analysis-seasons"], { sourceHash, seasons, preparation: rows });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  await publish("a".repeat(64));
  fireEvent.click(screen.getByRole("button", { name: "기간 비교 열기" }));
  fireEvent.click(screen.getByRole("button", { name: "두 기간 비교 적용" }));
  await screen.findByRole("table", { name: "두 기간 지표 비교" });
  expect(fetch).toHaveBeenCalledTimes(1);
  for (const [season, count] of [
    [2026, 1],
    [2024, 2],
    [2025, 3],
  ] as const) {
    rows = rows.map((row) =>
      row.season === season ? { ...row, sourceHash: "b".repeat(64) } : row,
    );
    await publish(String(season % 10).repeat(64));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(count));
  }
  for (const [input] of fetch.mock.calls) {
    const params = new URL(String(input), "http://localhost").searchParams;
    expect(params.get("season")).toBe("2025");
    expect(params.get("compareSeason")).toBe("2024");
  }
});
it.each<PeriodComparisonKind>(["statistics", "pitch-shape", "batter-profile", "batter-discipline"])(
  "applies common A/B selection lazily and retains filters for %s",
  async (kind) => {
    const fetch = mock();
    show(kind);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "기간 비교 열기" }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("기간 A 시작일"), { target: { value: "2024-04-01" } });
    fireEvent.click(screen.getByRole("button", { name: "두 기간 비교 적용" }));
    const table = await screen.findByRole("table", { name: "두 기간 지표 비교" });
    expect(within(table).getByText("+20.0%p")).toBeTruthy();
    expect(within(table).getAllByText("0.0%")).toHaveLength(2);
    expect(within(table).getAllByText("—")).toHaveLength(2);
    const url = new URL(String(fetch.mock.calls[0]?.[0]), "http://localhost");
    expect(url.pathname).toBe(`/api/v2/analysis/${kind}/p1/comparison`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      season: "2024",
      dateFrom: "2024-04-01",
      compareSeason: "2025",
      competition: "regular",
    });
    if (kind.startsWith("batter-"))
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        balls: "2",
        pitchType: "직구",
        stance: "L",
      });
    if (kind === "statistics") expect(url.searchParams.get("role")).toBe("batter");
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("기간 B 시즌"), { target: { value: "2024" } });
    expect(screen.queryByRole("table", { name: "두 기간 지표 비교" })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it("preserves cleared B dates and restores A/B selection with browser history", async () => {
  mock();
  show("statistics", "", true);
  fireEvent.click(screen.getByRole("button", { name: "기간 비교 열기" }));
  fireEvent.change(screen.getByLabelText("기간 B 시작일"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("기간 B 종료일"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "두 기간 비교 적용" }));
  await screen.findByRole("table", { name: "두 기간 지표 비교" });
  expect(screen.getByLabelText<HTMLInputElement>("기간 B 시작일").value).toBe("");
  expect(screen.getByLabelText("현재 주소").textContent).toContain("periodBFrom=&periodBTo=");
  fireEvent.change(screen.getByLabelText("기간 A 시작일"), { target: { value: "2024-07-01" } });
  fireEvent.click(screen.getByRole("button", { name: "두 기간 비교 적용" }));
  await waitFor(() =>
    expect(screen.getByLabelText("현재 주소").textContent).toContain("2024-07-01"),
  );
  fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
  await waitFor(() =>
    expect(screen.getByLabelText<HTMLInputElement>("기간 A 시작일").value).toBe(""),
  );
  expect(screen.getByLabelText<HTMLInputElement>("기간 B 종료일").value).toBe("");
});
it("rejects invalid deep links before fetching and validates returned scopes and differences", async () => {
  const fetch = mock();
  show(
    "statistics",
    "periodCompare=1&periodASeason=2024&periodBSeason=2025&periodBFrom=2024-04-01",
  );
  expect(screen.getByRole("alert").textContent).toContain("선택 시즌");
  expect(fetch).not.toHaveBeenCalled();
  const query = {
    season: 2024,
    competition: "regular" as const,
    compareSeason: 2025,
    role: "batter" as const,
  };
  const data = response(query);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ...data, second: { ...data.second, scope: data.first.scope } }),
    ),
  );
  await expect(
    getAnalysisPeriodComparison("statistics", query, "p1", new AbortController().signal),
  ).rejects.toThrow("요청 범위");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ...data, metrics: data.metrics.map((m) => ({ ...m, difference: 0.9 })) }),
    ),
  );
  await expect(
    getAnalysisPeriodComparison("statistics", query, "p1", new AbortController().signal),
  ).rejects.toThrow("차이");
});
it("keeps negative K−BB values within the common axis and omits connectors for incomparable coordinates", () => {
  const data = response({ season: 2024, compareSeason: 2025 });
  render(
    createElement(PeriodComparisonResults, {
      defaultMetric: "K−BB%",
      data: {
        ...data,
        metrics: [
          {
            key: "kbb",
            group: "전체",
            label: "K−BB%",
            unit: "rate",
            first: { value: -0.25, numerator: -1, denominator: 4 },
            second: { value: -0.5, numerator: -2, denominator: 4 },
            difference: -0.25,
          },
        ],
      },
    }),
  );
  const chart = screen.getByRole("img", { name: "K−BB% 기간 A B 비교 차트" });
  const circle = chart.querySelector("circle");
  expect(Number(circle?.getAttribute("cx"))).toBeGreaterThanOrEqual(160);
  expect(Number(circle?.getAttribute("cx"))).toBeLessThanOrEqual(500);
  cleanup();
  render(
    createElement(PeriodComparisonResults, {
      defaultMetric: "보정 가로",
      data: {
        ...data,
        metrics: [
          {
            key: "x",
            group: "직구",
            label: "보정 가로",
            unit: "cm",
            first: { value: 1, numerator: null, denominator: 5 },
            second: { value: 2, numerator: null, denominator: 5 },
            difference: null,
          },
        ],
      },
    }),
  );
  expect(
    screen.getByRole("img", { name: "보정 가로 기간 A B 비교 차트" }).querySelectorAll("line"),
  ).toHaveLength(1);
});
it("uses a supported chart metric when switching from reaction to terminal PA groups", () => {
  const data = response({ season: 2024, compareSeason: 2025 });
  render(
    createElement(PeriodComparisonResults, {
      defaultMetric: "Whiff%",
      data: {
        ...data,
        metrics: [
          ...data.metrics,
          {
            key: "avg",
            group: "종결 투구 전체",
            label: "AVG",
            unit: "number",
            first: { value: 0.25, numerator: 1, denominator: 4 },
            second: { value: 0.5, numerator: 2, denominator: 4 },
            difference: 0.25,
          },
        ],
      },
    }),
  );
  fireEvent.change(screen.getByLabelText("기간 비교 그룹"), {
    target: { value: "종결 투구 전체" },
  });
  expect(screen.getByLabelText<HTMLSelectElement>("기간 비교 차트 지표").value).toBe("AVG");
  expect(screen.getByRole("img", { name: "AVG 기간 A B 비교 차트" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Whiff% 기간 A B 비교 차트" })).toBeNull();
});
it("supports newly imported seasons in shape comparison", async () => {
  const fetch = mock();
  show("pitch-shape", "periodCompare=1&periodASeason=2024&periodBSeason=2026");
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(String(fetch.mock.calls[0]?.[0])).toContain("compareSeason=2026");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("applies and restores a newly imported discipline season with its own dates", async () => {
  const fetch = mock();
  const seasons = [2027, 2025, 2024];
  show("batter-discipline", "", false, seasons);
  fireEvent.click(screen.getByRole("button", { name: "기간 비교 열기" }));
  const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "기간 B 시즌" });
  expect(within(select).getByRole("option", { name: "2027" })).toBeTruthy();
  fireEvent.change(select, { target: { value: "2027" } });
  fireEvent.change(screen.getByLabelText("기간 B 시작일"), { target: { value: "2027-06-01" } });
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "두 기간 비교 적용" }));
  await screen.findByRole("heading", { name: "기간 B · 2027" });

  const applied = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
  expect(applied.get("periodBSeason")).toBe("2027");
  expect(applied.get("periodBFrom")).toBe("2027-06-01");
  cleanup();
  show("batter-discipline", applied.toString(), false, seasons);
  await screen.findByRole("heading", { name: "기간 B · 2027" });
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "기간 B 시즌" }).value).toBe(
    "2027",
  );
  expect(screen.getByLabelText<HTMLInputElement>("기간 B 시작일").value).toBe("2027-06-01");
  expect(
    fetch.mock.calls.map(([input]) => {
      const url = new URL(String(input), "http://localhost");
      return [url.searchParams.get("compareSeason"), url.searchParams.get("compareDateFrom")];
    }),
  ).toEqual([
    ["2027", "2027-06-01"],
    ["2027", "2027-06-01"],
  ]);
});

it("rejects a restored season outside the analysis contract without a request", () => {
  const fetch = mock();
  show("batter-discipline", "periodCompare=1&periodASeason=2026&periodBSeason=2201");
  expect(screen.getByRole("alert").textContent).toContain("분석 범위");
  expect(fetch).not.toHaveBeenCalled();
});
