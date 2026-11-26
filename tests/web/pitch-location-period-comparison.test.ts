// @vitest-environment jsdom
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PitchLocationComparisonQuerySchema,
  pitchLocationComparisonQueries,
  resolveAnalysisScope,
  type PitchOutcomeQuery,
} from "@kbo/contracts";
import { analyzePitchLocation, comparePitchLocations } from "@kbo/game-core";
import { PitchLocationPeriodComparison } from "../../apps/web/src/analysis/pitch-location-period-comparison.js";
import { getPitchLocationComparison } from "../../apps/web/src/api/pitch-location-comparison-client.js";
import { outcomeRow } from "../helpers/pitch-outcomes.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});
const query: PitchOutcomeQuery = {
  season: 2025,
  competition: "regular",
  pitchType: "체인지업",
  stance: "L",
  strikes: 2,
  cohort: "discipline",
};
function response(request: Parameters<typeof comparePitchLocations>[0]) {
  const queries = pitchLocationComparisonQueries(request);
  const period = (q: PitchOutcomeQuery, first: boolean) => {
    const { season, competition, dateFrom, dateTo } = q;
    const scope = resolveAnalysisScope({
      season,
      ...(competition === undefined ? {} : { competition }),
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
    });
    return analyzePitchLocation(
      q,
      "p1",
      scope,
      "a".repeat(64),
      [
        outcomeRow({
          season,
          pitchType: "체인지업",
          stance: q.stance ?? "L",
          strikes: 2,
          swing: true,
          whiff: first,
        }),
      ],
      [],
    );
  };
  return comparePitchLocations(
    request,
    "p1",
    period(queries.first, true),
    period(queries.second, false),
  );
}
function show(baseQuery = query, initialParams = "") {
  const client = createAnalysisQueryClient();
  clients.push(client);
  function Host() {
    const [params, setParams] = useState(new URLSearchParams(initialParams));
    return createElement(PitchLocationPeriodComparison, {
      key: params.toString(),
      query: baseQuery,
      id: "p1",
      params,
      onChange: setParams,
    });
  }
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, {}, createElement(Host)),
    ),
  );
}
function mockComparison() {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const raw = Object.fromEntries(url.searchParams);
    const request = Value.Decode(PitchLocationComparisonQuerySchema, {
      ...raw,
      season: Number(raw.season),
      compareSeason: Number(raw.compareSeason),
      ...(raw.strikes === undefined ? {} : { strikes: Number(raw.strikes) }),
    });
    return Response.json(response(request));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("loads two explicit periods only after apply, uses common filters and shares the map selection", async () => {
  const fetch = mockComparison();
  show();
  expect(fetch).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("기간 A 시작일"), { target: { value: "2024-04-01" } });
  fireEvent.change(screen.getByLabelText("기간 A 종료일"), { target: { value: "2024-06-30" } });
  fireEvent.change(screen.getByLabelText("기간 B 시작일"), { target: { value: "2025-07-01" } });
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "두 기간 비교 적용" }));
  await screen.findByRole("group", { name: "기간 A 코스 지도" });
  expect(fetch).toHaveBeenCalledTimes(1);
  const url = new URL(String(fetch.mock.calls[0]?.[0]), "http://localhost");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    season: "2024",
    dateFrom: "2024-04-01",
    dateTo: "2024-06-30",
    compareSeason: "2025",
    compareDateFrom: "2025-07-01",
    pitchType: "체인지업",
    stance: "L",
    strikes: "2",
    cohort: "discipline",
    competition: "regular",
  });
  expect(screen.getByRole("note").textContent).toContain("존 규칙이 다릅니다");
  const a = screen.getByRole("group", { name: "기간 A 코스 지도" });
  const b = screen.getByRole("group", { name: "기간 B 코스 지도" });
  expect(
    within(a).getByRole("button", {
      name: "코스 20, 포수 시점 존 위 왼쪽 바깥, 투구 사용 비중 0.0%, 이 구역 투구 0 / 위치 확인 투구 1, 소표본, 투구 0구",
    }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("지도 지표"), { target: { value: "whiffRate" } });
  const occupied = within(a).getByRole("button", {
    name: "코스 12, 포수 시점 존 중단 가운데, 헛스윙률 Whiff% 100.0%, 헛스윙 1 / 스윙 1, 소표본, 투구 1구",
  });
  fireEvent.click(occupied);
  const counterpart = within(b).getByRole("button", {
    name: "코스 12, 포수 시점 존 중단 가운데, 헛스윙률 Whiff% 0.0%, 헛스윙 0 / 스윙 1, 소표본, 투구 1구",
  });
  expect(counterpart.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getAllByText("-100.0%p").length).toBeGreaterThanOrEqual(2);
  expect(
    screen.getAllByRole("link", { name: "이 기간 코스·투구 근거 보기" })[0]?.getAttribute("href"),
  ).toContain("locationCell=");
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("기간 B 종료일"), { target: { value: "2025-08-31" } });
  expect(screen.queryByRole("group", { name: "기간 A 코스 지도" })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("preserves explicitly cleared dates across the applied URL remount", async () => {
  const fetch = mockComparison();
  show({ ...query, dateFrom: "2025-07-01", dateTo: "2025-08-31" });
  fireEvent.change(screen.getByLabelText("기간 B 시작일"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("기간 B 종료일"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "두 기간 비교 적용" }));
  await screen.findByRole("group", { name: "기간 B 코스 지도" });
  expect(screen.getByLabelText<HTMLInputElement>("기간 B 시작일").value).toBe("");
  expect(screen.getByLabelText<HTMLInputElement>("기간 B 종료일").value).toBe("");
  const url = new URL(String(fetch.mock.calls[0]?.[0]), "http://localhost");
  expect(url.searchParams.has("compareDateFrom")).toBe(false);
  expect(url.searchParams.has("compareDateTo")).toBe(false);
});

it("shows an invalid shared comparison range immediately without querying", () => {
  const fetch = mockComparison();
  show(query, "periodCompare=1&periodASeason=2024&periodAFrom=2024-07-01&periodATo=2024-06-01");
  expect(screen.getByRole("alert").textContent).toContain("시작일");
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects reversed dates without fetching or showing an old result", async () => {
  const fetch = mockComparison();
  show();
  fireEvent.change(screen.getByLabelText("기간 A 시작일"), { target: { value: "2024-07-01" } });
  fireEvent.change(screen.getByLabelText("기간 A 종료일"), { target: { value: "2024-06-01" } });
  fireEvent.submit(
    screen.getByRole("button", { name: "두 기간 비교 적용" }).closest("form") ?? document.body,
  );
  expect(screen.getByRole("alert").textContent).toContain("시작일");
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps query errors actionable and retries only the requested comparison", async () => {
  const fetch = mockComparison();
  fetch.mockImplementationOnce(async () => new Response("failed", { status: 500 }));
  show();
  fireEvent.click(screen.getByRole("button", { name: "두 기간 비교 적용" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await screen.findByRole("group", { name: "기간 A 코스 지도" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("rejects a response for different filters or duplicate cells at the client boundary", async () => {
  const request = { ...query, compareSeason: 2024 };
  const result = response(request);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        ...result,
        first: { ...result.first, query: { ...result.first.query, stance: "R" } },
      }),
    ),
  );
  await expect(
    getPitchLocationComparison(request, "p1", new AbortController().signal),
  ).rejects.toThrow("요청 범위");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        ...result,
        differences: result.differences.map((row) => ({ ...row, cell: 0 })),
      }),
    ),
  );
  await expect(
    getPitchLocationComparison(request, "p1", new AbortController().signal),
  ).rejects.toThrow("요청 범위");
  await waitFor(() => expect(screen.queryByRole("group", { name: "기간 A 코스 지도" })).toBeNull());
});
