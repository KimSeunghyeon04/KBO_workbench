// @vitest-environment jsdom
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  BattingStatisticsQuerySchema,
  PitchingStatisticsQuerySchema,
  resolveAnalysisScope,
} from "@kbo/contracts";
import { battingStatistics, pitchingStatistics } from "@kbo/game-core";
import { PlayerStatisticsPage } from "../../apps/web/src/pages/player-statistics-page.js";
import { battingTotals, pitchingTotals } from "../helpers/player-statistics.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function statisticsFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost"),
      pitch = url.pathname.endsWith("pitching");
    const raw = Object.fromEntries(url.searchParams);
    const candidate = {
      ...raw,
      season: Number(raw.season),
      page: Number(raw.page),
      limit: Number(raw.limit),
      ...(pitch ? { minBF: Number(raw.minBF) } : { minPA: Number(raw.minPA) }),
    };
    const query = pitch
      ? Value.Decode(PitchingStatisticsQuerySchema, candidate)
      : Value.Decode(BattingStatisticsQuerySchema, candidate);
    const empty = pitch
      ? Number(raw.minBF) > pitchingTotals.battersFaced
      : Number(raw.minPA) > battingTotals.plateAppearances;
    return new Response(
      JSON.stringify({
        kind: pitch ? "pitching" : "batting",
        query,
        scope: resolveAnalysisScope({
          season: query.season,
          competition: query.competition ?? "regular",
          ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
          ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
        }),
        sourceHash: "a".repeat(64),
        group: query.group ?? "player",
        total: empty ? 0 : 1,
        page: query.page ?? 1,
        limit: 50,
        rows: empty
          ? []
          : [pitch ? pitchingStatistics(pitchingTotals) : battingStatistics(battingTotals)],
      }),
    );
  });
}

it("defaults new statistics to confirmed regular games and distinguishes incomplete ERA", async () => {
  const fetch = statisticsFetch();
  vi.stubGlobal("fetch", fetch);
  render(
    createElement(
      QueryClientProvider,
      { client: createAnalysisQueryClient() },
      createElement(MemoryRouter, null, createElement(PlayerStatisticsPage)),
    ),
  );
  const batting = await screen.findByRole("table", { name: "타격 성적" });
  expect(within(batting).getByText("1.700")).toBeTruthy();
  expect(fetch.mock.calls[0]?.[0]).toContain("competition=regular");
  expect(fetch.mock.calls[0]?.[0]).toContain("minPA=0");
  expect(within(batting).queryByRole("columnheader", { name: "2B" })).toBeNull();
  const requests = fetch.mock.calls.length;
  fireEvent.click(screen.getByRole("checkbox", { name: "전체 세부 기록" }));
  expect(within(batting).getByRole("columnheader", { name: "2B" })).toBeTruthy();
  expect(fetch.mock.calls).toHaveLength(requests);
  fireEvent.change(screen.getByLabelText("성적 종류"), { target: { value: "pitching" } });
  const pitching = await screen.findByRole("table", { name: "투구 성적" });
  expect(within(pitching).getByText("—")).toBeTruthy();
  expect(within(pitching).getByText("3.00")).toBeTruthy();
  expect(within(pitching).getByText("1/2")).toBeTruthy();
});

function CurrentLocation() {
  return createElement("output", { "aria-label": "현재 주소" }, useLocation().search);
}

it.each(["batting", "pitching"] as const)(
  "recovers an empty %s result by clearing only minimum and page",
  async (kind) => {
    const fetch = statisticsFetch();
    vi.stubGlobal("fetch", fetch);
    const client = createAnalysisQueryClient();
    const sort = kind === "batting" ? "avg" : "era";
    const search = `?season=2025&competition=allstar&kind=${kind}&dateFrom=2025-04-01&dateTo=2025-10-01&group=player&minimum=1000&sort=${sort}&page=2`;
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [`/analysis/statistics${search}`] },
          createElement(PlayerStatisticsPage),
          createElement(CurrentLocation),
        ),
      ),
    );
    await screen.findByText("현재 조건에 맞는 기록이 없습니다. 세부 조건을 조정해 확인하세요.");
    await userEvent.setup().click(screen.getByRole("button", { name: "최소 표본 해제" }));
    await screen.findByRole("link", { name: kind === "batting" ? "타자 A" : "투수 A" });
    const next = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
    expect(next.has("minimum")).toBe(false);
    expect(next.has("page")).toBe(false);
    for (const key of ["season", "competition", "kind", "dateFrom", "dateTo", "group", "sort"]) {
      expect(next.get(key)).toBe(new URLSearchParams(search).get(key));
    }
    expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch.mock.calls.at(-1)?.[0]).toContain(kind === "batting" ? "minPA=0" : "minBF=0");
    expect(screen.queryByRole("button", { name: "최소 표본 해제" })).toBeNull();
    client.clear();
  },
);

it.each(["batting", "pitching"] as const)(
  "keeps applied %s conditions visible and preserves URL/query while folding filters",
  async (kind) => {
    const fetch = statisticsFetch();
    vi.stubGlobal("fetch", fetch);
    const sort = kind === "batting" ? "avg" : "era";
    const sortLabel = kind === "batting" ? "타율" : "ERA";
    const search = `?season=2024&competition=allstar&kind=${kind}&dateFrom=2024-04-01&dateTo=2024-04-30&group=team&minimum=25&sort=${sort}&page=2`;
    const client = createAnalysisQueryClient();
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [`/analysis/statistics${search}`] },
          createElement(PlayerStatisticsPage),
          createElement(CurrentLocation),
        ),
      ),
    );
    await screen.findByRole("table", { name: kind === "batting" ? "타격 성적" : "투구 성적" });
    const summary = screen.getByText("세부 조건").closest("summary");
    const disclosure = summary?.parentElement;
    if (!(disclosure instanceof HTMLDetailsElement) || summary === null)
      throw new Error("Missing filter disclosure");
    expect(disclosure.open).toBe(false);
    expect(summary.textContent).toContain("2024-04-01 ~ 2024-04-30 · 팀 · 최소 25");
    expect(summary.textContent).toContain(kind === "batting" ? "25타석" : "25상대 타자");
    expect(summary.textContent).toContain(`${sortLabel}순`);
    const primary = screen
      .getByRole("region", { name: "성적 조건" })
      .querySelector(".analysis-primary-filters");
    if (!(primary instanceof HTMLElement)) throw new Error("Missing primary filters");
    expect(within(primary).getAllByRole("combobox")).toHaveLength(3);
    const requestCount = fetch.mock.calls.length;
    const user = userEvent.setup();
    await user.click(summary);
    expect(disclosure.open).toBe(true);
    expect(screen.getByLabelText("분석 시작일")).toHaveProperty("value", "2024-04-01");
    expect(screen.getByLabelText("성적 집계")).toHaveProperty("value", "team");
    expect(screen.getByLabelText("최소 표본")).toHaveProperty("value", "25");
    expect(screen.getByLabelText("성적 정렬")).toHaveProperty("value", sort);
    await user.click(summary);
    expect(disclosure.open).toBe(false);
    expect(screen.getByLabelText("현재 주소").textContent).toBe(search);
    expect(fetch.mock.calls).toHaveLength(requestCount);
    await user.click(summary);
    await user.selectOptions(
      screen.getByLabelText("성적 정렬"),
      kind === "batting" ? "homeRuns" : "outsRecorded",
    );
    await waitFor(() => expect(fetch.mock.calls.length).toBe(requestCount + 1));
    const changed = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
    expect(changed.get("page")).toBeNull();
    expect(changed.get("season")).toBe("2024");
    expect(changed.get("competition")).toBe("allstar");
    expect(changed.get("dateFrom")).toBe("2024-04-01");
    expect(changed.get("dateTo")).toBe("2024-04-30");
    expect(changed.get("group")).toBe("team");
    expect(changed.get("minimum")).toBe("25");
    expect(fetch.mock.calls.at(-1)?.[0]).toContain(kind === "batting" ? "minPA=25" : "minBF=25");
    await user.selectOptions(
      screen.getByLabelText("성적 종류"),
      kind === "batting" ? "pitching" : "batting",
    );
    await screen.findByRole("table", { name: kind === "batting" ? "투구 성적" : "타격 성적" });
    const switched = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
    expect(switched.has("sort")).toBe(false);
    expect(switched.has("minimum")).toBe(false);
    expect(switched.get("dateFrom")).toBe("2024-04-01");
    expect(summary.textContent).toContain(
      kind === "batting" ? "최소 0상대 타자 · K−BB%순" : "최소 0타석 · OPS순",
    );
    client.clear();
  },
);

it("keeps invalid folded conditions discoverable without sending a request", async () => {
  const fetch = statisticsFetch();
  vi.stubGlobal("fetch", fetch);
  const client = createAnalysisQueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/statistics?sort=unsupported"] },
        createElement(PlayerStatisticsPage),
      ),
    ),
  );
  expect(screen.getByRole("alert").textContent).toContain("조회 조건이 올바르지 않습니다");
  expect(screen.getByText("정렬 확인 필요", { exact: false }).closest("summary")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  client.clear();
});
