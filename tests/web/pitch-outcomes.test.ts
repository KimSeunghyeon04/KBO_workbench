// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PitchOutcomeQuerySchema,
  resolveAnalysisScope,
  inAnalysisPeriod,
  type PitchOutcomeRow,
  type TerminalPaRow,
} from "@kbo/contracts";
import { analyzeBatterProfile, analyzePitchLocation } from "@kbo/game-core";
import { PitchOutcomesPage } from "../../apps/web/src/pages/pitch-outcomes-page.js";
import { outcomeRow, terminalPa } from "../helpers/pitch-outcomes.js";
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

function mockOutcomes(
  rows: PitchOutcomeRow[] = [outcomeRow()],
  pas: TerminalPaRow[] = [terminalPa()],
) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), "http://localhost");
    const raw = Object.fromEntries(u.searchParams);
    const query = Value.Decode(PitchOutcomeQuerySchema, {
      ...raw,
      season: Number(raw.season),
      ...(raw.balls === undefined ? {} : { balls: Number(raw.balls) }),
      ...(raw.strikes === undefined ? {} : { strikes: Number(raw.strikes) }),
    });
    const scope = resolveAnalysisScope({
      season: query.season,
      ...(query.competition === undefined ? {} : { competition: query.competition }),
      ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
      ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
    });
    if (u.pathname.endsWith("batter-discipline"))
      return Response.json({
        season: query.season,
        scope,
        batters: [{ batterId: "b1", name: "타자", pitches: rows.length }],
      });
    if (u.pathname.endsWith("pitch-shape"))
      return Response.json({
        season: query.season,
        scope,
        pitchers: [{ pitcherId: "hp1", name: "투수", pitches: rows.length }],
      });
    const scopedRows = rows.filter(
      (row) => row.season === scope.season && inAnalysisPeriod(row.gameDate, scope),
    );
    const scopedPas = pas.filter(
      (pa) => pa.gameDate.startsWith(`${scope.season}-`) && inAnalysisPeriod(pa.gameDate, scope),
    );
    return Response.json(
      u.pathname.includes("batter-profile")
        ? analyzeBatterProfile(query, "b1", scope, "a".repeat(64), scopedRows, scopedPas)
        : analyzePitchLocation(query, "hp1", scope, "a".repeat(64), scopedRows, scopedPas),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function Location() {
  return createElement("output", { "aria-label": "현재 주소" }, useLocation().search);
}

function show(role: "pitcher" | "batter", search = "season=2024&competition=all") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            `/analysis/${role === "pitcher" ? "pitch-location" : "batter-profile"}?${search}`,
          ],
        },
        createElement(PitchOutcomesPage, { role }),
        createElement(Location),
      ),
    ),
  );
}

function detailsFor(label: string | RegExp) {
  const trigger = screen.getByText(label);
  const details = trigger.closest("details");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("Missing details disclosure");
  return { trigger, details };
}

it("keeps pitch and PA denominators distinct while disclosing detailed metrics and revision-bound evidence", async () => {
  mockOutcomes();
  show("batter", "season=2024&competition=all&batter=b1");
  await screen.findByRole("table", { name: "종결 구종 성적" });
  const total = detailsFor("전체 반응 지표");
  expect(total.details.open).toBe(false);
  fireEvent.click(total.trigger);
  expect(total.details.open).toBe(true);
  const table = within(total.details).getByRole("table", { name: "전체 반응" });
  expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
  const evidence = detailsFor(/투구 기록 보기/);
  expect(evidence.details.open).toBe(false);
  fireEvent.click(evidence.trigger);
  expect(
    within(evidence.details).getByRole("link", { name: "경기 재생 r1" }).getAttribute("href"),
  ).toContain("revision=1");
  const buttons = within(screen.getByLabelText("실제 코스 지도")).getAllByRole("button");
  expect(buttons).toHaveLength(25);
  const first = buttons[0];
  if (first === undefined) throw new Error("Missing location cell");
  fireEvent.click(first);
  expect(screen.getByText(/선택 근거 0구/u)).toBeTruthy();
  expect(within(evidence.details).queryAllByRole("link")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "모든 코스", exact: true }));
  expect(within(evidence.details).getByRole("link", { name: "경기 재생 r1" })).toBeTruthy();
});

it.each(["pitcher", "batter"] as const)(
  "switches %s comparisons locally and expands detailed metrics on demand",
  async (role) => {
    const fetch = mockOutcomes();
    show(role);
    const comparison = await screen.findByRole("group", { name: "비교 기준" });
    await screen.findByRole("table", { name: "구종별 반응" });
    const calls = fetch.mock.calls.length;
    const choices = [
      ["구종별", "구종별 반응"],
      ["카운트별", "카운트별 반응"],
      ["타석 좌우별", "타석 좌우별 반응"],
      ...(role === "batter" ? [["구속대별", "구속대별 반응"]] : []),
    ] as const;
    if (role === "pitcher")
      expect(within(comparison).queryByRole("button", { name: "구속대별" })).toBeNull();
    for (const [label, title] of choices) {
      if (label === undefined || title === undefined) throw new Error("Missing comparison option");
      fireEvent.click(within(comparison).getByRole("button", { name: label, exact: true }));
      expect(
        within(comparison)
          .getByRole("button", { name: label, exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      const table = screen.getByRole("table", { name: title });
      for (const [, otherTitle] of choices) {
        if (otherTitle !== title)
          expect(screen.queryByRole("table", { name: otherTitle })).toBeNull();
      }
      const count = table.querySelector("thead tr")?.children.length ?? 0;
      expect(count).toBeGreaterThanOrEqual(7);
      expect(count).toBeLessThanOrEqual(8);
    }
    const table = screen.getByRole("table", {
      name: role === "batter" ? "구속대별 반응" : "타석 좌우별 반응",
    });
    const panel = table.closest("section");
    if (panel === null) throw new Error("Missing rate panel");
    const detail = within(panel).getByRole("button", { name: "상세 지표", exact: true });
    expect(detail.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(detail);
    expect(detail.getAttribute("aria-pressed")).toBe("true");
    expect(table.querySelector("thead tr")?.children.length).toBe(18);
    expect(within(table).getByText("인플레이 결과")).toBeTruthy();
    fireEvent.click(detail);
    expect(detail.getAttribute("aria-pressed")).toBe("false");
    expect(table.querySelector("thead tr")?.children.length).toBeLessThanOrEqual(8);
    expect(fetch).toHaveBeenCalledTimes(calls);
  },
);

it("restores advanced filters, preserves URL scope through disclosure and comparison, and resets dates on season change", async () => {
  const fetch = mockOutcomes([outcomeRow({ balls: 1, strikes: 2, pitchType: "슬라이더" })]);
  const initial = new URLSearchParams({
    season: "2024",
    competition: "regular",
    dateFrom: "2024-06-01",
    dateTo: "2024-06-30",
    pitcher: "hp1",
    balls: "1",
    strikes: "2",
    pitchType: "슬라이더",
    stance: "R",
    cohort: "discipline",
  });
  show("pitcher", initial.toString());
  await screen.findByRole("table", { name: "구종별 반응" });
  const filters = detailsFor("세부 조건");
  expect(filters.details.open).toBe(false);
  fireEvent.click(filters.trigger);
  expect(filters.details.open).toBe(true);
  expect(screen.getByLabelText("분석 시작일")).toHaveProperty("value", "2024-06-01");
  expect(screen.getByLabelText("분석 종료일")).toHaveProperty("value", "2024-06-30");
  expect(screen.getByLabelText("볼", { exact: true })).toHaveProperty("value", "1");
  expect(screen.getByLabelText("스트라이크", { exact: true })).toHaveProperty("value", "2");
  expect(screen.getByLabelText("구종", { exact: true })).toHaveProperty("value", "슬라이더");
  expect(screen.getByLabelText("타석 좌우", { exact: true })).toHaveProperty("value", "R");
  expect(screen.getByLabelText("표본", { exact: true })).toHaveProperty("value", "discipline");
  fireEvent.change(screen.getByLabelText("볼", { exact: true }), { target: { value: "2" } });
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([input]) => {
        const url = new URL(String(input), "http://localhost");
        return url.pathname.includes("pitch-location") && url.searchParams.get("balls") === "2";
      }),
    ).toBe(true),
  );
  const current = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
  expect(Object.fromEntries(current)).toEqual({ ...Object.fromEntries(initial), balls: "2" });
  fireEvent.click(filters.trigger);
  expect(filters.details.open).toBe(false);
  const comparison = await screen.findByRole("group", { name: "비교 기준" });
  fireEvent.click(
    within(comparison).getByRole("button", {
      name: "카운트별",
      exact: true,
    }),
  );
  expect(screen.getByLabelText("현재 주소").textContent).toBe(`?${current}`);
  fireEvent.change(screen.getByLabelText("투구 결과 시즌"), { target: { value: "2025" } });
  const next = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
  expect(next.get("season")).toBe("2025");
  expect(next.get("competition")).toBe("regular");
  expect(next.get("pitchType")).toBe("슬라이더");
  for (const key of ["dateFrom", "dateTo", "pitcher"]) expect(next.has(key)).toBe(false);
});

it("paginates disclosed evidence and resets the page when a map selection changes", async () => {
  mockOutcomes(
    Array.from({ length: 21 }, (_, index) =>
      outcomeRow({
        pitchId: `p-${String(index).padStart(2, "0")}`,
        pitchSequence: index,
        revision: 3,
      }),
    ),
    [],
  );
  show("pitcher");
  await screen.findByRole("table", { name: "구종별 반응" });
  const evidence = detailsFor(/투구 기록 보기/);
  expect(evidence.details.open).toBe(false);
  fireEvent.click(evidence.trigger);
  const records = within(evidence.details);
  expect(records.getAllByRole("link", { name: "경기 재생 r3" })).toHaveLength(20);
  expect(
    records.getAllByRole("link").every((link) => link.getAttribute("href")?.includes("revision=3")),
  ).toBe(true);
  fireEvent.click(records.getByRole("button", { name: "다음", exact: true }));
  expect(records.getAllByRole("link", { name: "경기 재생 r3" })).toHaveLength(1);
  const emptyCell = within(screen.getByLabelText("실제 코스 지도")).getAllByRole("button")[0];
  if (emptyCell === undefined) throw new Error("Missing map cell");
  fireEvent.click(emptyCell);
  expect(records.queryAllByRole("link")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "모든 코스", exact: true }));
  expect(records.getAllByRole("link", { name: "경기 재생 r3" })).toHaveLength(20);
  expect(records.getByRole("button", { name: "이전", exact: true })).toHaveProperty(
    "disabled",
    true,
  );
});

it("applies quick count presets atomically and clears only situation filters", async () => {
  const fetch = mockOutcomes();
  show(
    "pitcher",
    "season=2024&competition=all&pitcher=hp1&dateFrom=2024-06-01&dateTo=2024-06-30&balls=0&strikes=0&stance=R",
  );
  await screen.findByRole("table", { name: "구종별 반응" });
  const before = fetch.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "2스트라이크", exact: true }));
  await waitFor(() => {
    const requests = fetch.mock.calls
      .slice(before)
      .map(([input]) => new URL(String(input), "http://localhost"));
    expect(
      requests.some(
        (url) => url.pathname.includes("pitch-location") && url.searchParams.get("strikes") === "2",
      ),
    ).toBe(true);
    for (const url of requests) {
      if (url.pathname.includes("pitch-location")) {
        expect(url.searchParams.has("balls")).toBe(false);
        expect(url.searchParams.get("strikes")).toBe("2");
      }
    }
  });
  fireEvent.click(screen.getByRole("button", { name: "상황 조건 초기화", exact: true }));
  const actual = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
  expect(Object.fromEntries(actual)).toEqual({
    season: "2024",
    competition: "all",
    pitcher: "hp1",
    dateFrom: "2024-06-01",
    dateTo: "2024-06-30",
  });
});
