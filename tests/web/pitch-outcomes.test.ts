// @vitest-environment jsdom
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { cleanup, render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PitchOutcomeQuerySchema,
  PitchCountFlowQuerySchema,
  pitchOutcomeScope,
  resolveAnalysisScope,
  inAnalysisPeriod,
  type PitchOutcomeRow,
  type TerminalPaRow,
} from "@kbo/contracts";
import { analyzeBatterProfile, analyzePitchCountFlow, analyzePitchLocation } from "@kbo/game-core";
import { getPitchCountFlow } from "../../apps/web/src/api/pitch-count-flow-client.js";
import { PitchOutcomesPage } from "../../apps/web/src/pages/pitch-outcomes-page.js";
import { countFlowRow, outcomeRow, terminalPa } from "../helpers/pitch-outcomes.js";
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
  flowResponse?: () => Response | undefined,
) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), "http://localhost");
    if (u.pathname.endsWith("/comparison")) return Response.json(null, { status: 400 });
    const { include, ...raw } = Object.fromEntries(u.searchParams);
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
    if (u.pathname.endsWith("/count-flow")) {
      return (
        flowResponse?.() ??
        Response.json(
          analyzePitchCountFlow(
            Value.Decode(PitchCountFlowQuerySchema, {
              ...query,
              ...(include === undefined ? {} : { include }),
            }),
            "hp1",
            scope,
            "f".repeat(64),
            scopedRows.map((row) =>
              countFlowRow({
                pitchId: row.pitchId,
                stance: row.stance,
                pitchType: row.pitchType,
                balls: row.balls,
                strikes: row.strikes,
                eligible: row.eligible,
              }),
            ),
          ),
        )
      );
    }
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
  const location = useLocation();
  const navigate = useNavigate();
  return createElement(
    "div",
    null,
    createElement("output", { "aria-label": "현재 주소" }, location.search),
    createElement("button", { onClick: () => navigate(-1) }, "이전 주소"),
  );
}

function show(role: "pitcher" | "batter", search = "season=2024&competition=unknown") {
  const client = createAnalysisQueryClient();
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
  return client;
}

function detailsFor(label: string | RegExp) {
  const trigger = screen.getByText(label);
  const details = trigger.closest("details");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("Missing details disclosure");
  return { trigger, details };
}

it("loads the count tree only on its tab and drills back to the map with exact filters", async () => {
  const fetch = mockOutcomes([
    outcomeRow({ pitchId: "l-fast", stance: "L", strikes: 2, pitchType: "직구" }),
    outcomeRow({
      pitchId: "l-slide",
      stance: "L",
      strikes: 2,
      pitchType: "슬라이더",
      trackingId: null,
    }),
    outcomeRow({ pitchId: "r-fast", stance: "R", strikes: 2, pitchType: "직구" }),
  ]);
  show(
    "pitcher",
    "season=2024&competition=unknown&pitcher=hp1&dateFrom=2024-06-01&dateTo=2024-06-30",
  );
  await screen.findByRole("table", { name: "구종별 반응" });
  const before = fetch.mock.calls.length;
  expect(screen.queryByRole("heading", { name: "카운트별 구종과 전이" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "구종 배합" }));
  const panel = screen.getByRole("tabpanel", { name: "구종 배합" });
  expect(screen.queryByRole("group", { name: "실제 코스 지도" })).toBeNull();
  const left = await within(panel).findByRole("figure", { name: "좌타자 상대" });
  fireEvent.click(
    within(left).getByRole("button", { name: "좌타자 상대 0볼 2스트라이크 구종 비중" }),
  );
  fireEvent.click(within(left).getByRole("button", { name: /슬라이더 50.0%/ }));
  expect(fetch).toHaveBeenCalledTimes(before + 1);
  const path = new URL(String(fetch.mock.calls.at(-1)?.[0]), "http://localhost");
  expect(path.pathname).toBe("/api/v2/analysis/pitch-location/hp1/count-flow");
  expect(Object.fromEntries(path.searchParams)).toEqual({
    season: "2024",
    competition: "unknown",
    dateFrom: "2024-06-01",
    dateTo: "2024-06-30",
    cohort: "all",
    include: "terminal-details",
  });
  fireEvent.click(screen.getByRole("button", { name: "좌타자 상대 코스 보기" }));
  await waitFor(() =>
    expect(screen.getByLabelText("현재 주소").textContent).toContain("pitchType="),
  );
  const params = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
  expect(Object.fromEntries(params)).toMatchObject({
    season: "2024",
    competition: "unknown",
    pitcher: "hp1",
    dateFrom: "2024-06-01",
    dateTo: "2024-06-30",
    pitchType: "슬라이더",
    stance: "L",
    balls: "0",
    strikes: "2",
    outcomeView: "overview",
  });
  await screen.findByRole("group", { name: "실제 코스 지도" });
  fireEvent.click(screen.getByRole("button", { name: "이전 주소" }));
  expect(screen.getByRole("tab", { name: "구종 배합", selected: true })).toBeTruthy();
  expect(screen.getByLabelText("현재 주소").textContent).not.toContain("pitchType=");
});

it("loads a direct count-tree link independently of old location filters", async () => {
  const fetch = mockOutcomes();
  show("pitcher", "season=2024&competition=unknown&pitcher=hp1&balls=4&outcomeView=arsenal");
  await screen.findByRole("heading", { name: "카운트별 구종과 전이" });
  const paths = fetch.mock.calls.map(([input]) => new URL(String(input), "http://localhost"));
  expect(paths.map((url) => url.pathname).sort()).toEqual([
    "/api/v2/analysis/pitch-location/hp1/count-flow",
    "/api/v2/analysis/pitch-shape",
  ]);
  expect(paths.every((url) => !url.searchParams.has("balls"))).toBe(true);
});

it("shows result counts even when an earlier count-flow API omits terminal details", async () => {
  const legacyQuery = { season: 2024, competition: "unknown", cohort: "all" } as const;
  const legacy = analyzePitchCountFlow(
    legacyQuery,
    "hp1",
    pitchOutcomeScope(legacyQuery),
    "f".repeat(64),
    [
      countFlowRow({
        pitchCall: "in_play",
        inPlay: true,
        afterStrikes: 0,
        terminalResult: "home_run",
      }),
    ],
  );
  mockOutcomes(undefined, undefined, () => Response.json(legacy));
  show("pitcher", "season=2024&competition=unknown&pitcher=hp1&outcomeView=arsenal");
  const table = await screen.findByRole("table", { name: "선택 카운트의 한 공 뒤 결과" });
  expect(within(table).getByRole("row", { name: /인플레이.*1구.*100.0%/ })).toBeTruthy();
  expect(within(table).queryByRole("button", { name: "인플레이" })).toBeNull();
});

it("rejects terminal details that disagree with their physical-pitch sample or pitch types", async () => {
  const query = { season: 2024, competition: "unknown", include: "terminal-details" } as const;
  const data = analyzePitchCountFlow(query, "hp1", pitchOutcomeScope(query), "f".repeat(64), [
    countFlowRow({ strikes: 2, terminalResult: "strikeout", pitchCall: "swinging_strike" }),
    countFlowRow({ pitchId: "foul", strikes: 2, afterStrikes: 2, pitchCall: "foul" }),
  ]);
  const { signal } = new AbortController();
  mockOutcomes(undefined, undefined, () => Response.json(data));
  await expect(getPitchCountFlow(query, "hp1", signal)).resolves.toEqual(data);
  for (const terminalDetails of [
    [{ outcome: "swingingStrikeout", pitches: 1, rate: 1 }],
    [{ outcome: "lookingStrikeout", pitches: 1, rate: 0.5 }],
  ]) {
    const groups = data.groups.map((group) =>
      group.stance === "all" ? { ...group, terminalDetails } : group,
    );
    mockOutcomes(undefined, undefined, () => Response.json({ ...data, groups }));
    await expect(getPitchCountFlow(query, "hp1", signal)).rejects.toThrow("표본 합계가 다릅니다");
  }
});

it("isolates an old API's missing route even after the count tree has been cached", async () => {
  let oldApi = false;
  const fetch = mockOutcomes(undefined, undefined, () =>
    oldApi
      ? Response.json(
          { message: "Route not found", error: "Not Found", statusCode: 404 },
          { status: 404 },
        )
      : undefined,
  );
  const client = show("pitcher", "season=2024&competition=unknown&pitcher=hp1&outcomeView=arsenal");
  await screen.findByRole("heading", { name: "카운트별 구종과 전이" });
  oldApi = true;
  void client.invalidateQueries({ queryKey: ["pitch-count-flow"] });
  await screen.findByText("이 서버에서 구종 전이 자료를 사용할 수 없습니다.");
  expect(screen.queryByRole("heading", { name: "카운트별 구종과 전이" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "코스·반응" }));
  await screen.findByRole("table", { name: "구종별 반응" });
  expect(screen.queryByText("이 서버에서 구종 전이 자료를 사용할 수 없습니다.")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "구종 배합" }));
  await screen.findByRole("button", { name: "구종 배합 다시 시도" });
  oldApi = false;
  fireEvent.click(screen.getByRole("button", { name: "구종 배합 다시 시도" }));
  await screen.findByRole("heading", { name: "카운트별 구종과 전이" });
  expect(fetch.mock.calls.some(([input]) => String(input).includes("/hp1/count-flow"))).toBe(true);
});

it("keeps evidence map selection in the URL while preserving the comparison and fetched data", async () => {
  const fetch = mockOutcomes();
  show(
    "pitcher",
    "season=2024&competition=unknown&pitcher=hp1&periodCompare=1&periodASeason=2023&locationCell=12",
  );
  const map = await screen.findByRole("group", { name: "실제 코스 지도" });
  expect(within(map).getByRole("button", { name: /^코스 12:/, pressed: true })).toBeTruthy();
  const before = fetch.mock.calls.length;
  fireEvent.click(within(map).getByRole("button", { name: /^코스 0:/ }));
  const currentParams = () =>
    new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
  expect(currentParams().get("locationCell")).toBe("0");
  expect(within(map).getByRole("button", { name: /^코스 0:/, pressed: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "모든 코스" }));
  expect(currentParams().get("locationCell")).toBeNull();
  expect(currentParams().get("pitcher")).toBe("hp1");
  expect(currentParams().get("periodASeason")).toBe("2023");
  expect(screen.getByRole("tab", { name: "코스·반응", selected: true })).toBeTruthy();
  expect(screen.getByRole("button", { name: "모든 코스", pressed: true })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(before);
});

it("keeps pitch and PA denominators distinct while disclosing detailed metrics and revision-bound evidence", async () => {
  mockOutcomes();
  show("batter", "season=2024&competition=unknown&batter=b1");
  fireEvent.click(screen.getByRole("tab", { name: "종결 성적" }));
  await screen.findByRole("table", { name: "종결 구종 성적" });
  expect(screen.queryByRole("tab", { name: "구종 배합" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "코스·반응" }));
  fireEvent.click(screen.getByRole("button", { name: "전체", exact: true }));
  const table = screen.getByRole("table", { name: "전체 반응" });
  expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
  const evidence = detailsFor(/투구 기록 보기/);
  expect(evidence.details.open).toBe(false);
  fireEvent.click(evidence.trigger);
  expect(
    within(evidence.details).getByRole("link", { name: "투구 장면 r1" }).getAttribute("href"),
  ).toContain("revision=1");
  const buttons = within(screen.getByLabelText("실제 코스 지도")).getAllByRole("button");
  expect(buttons).toHaveLength(25);
  const first = buttons[0];
  if (first === undefined) throw new Error("Missing location cell");
  fireEvent.click(first);
  expect(screen.getByText(/선택 근거 0구/u)).toBeTruthy();
  expect(within(evidence.details).queryAllByRole("link")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "모든 코스", exact: true }));
  expect(within(evidence.details).getByRole("link", { name: "투구 장면 r1" })).toBeTruthy();
});

it("restores selected tabs from the URL and opens A/B controls without issuing a comparison request", async () => {
  const fetch = mockOutcomes();
  show("pitcher", "season=2024&competition=unknown&pitcher=hp1&outcomeView=sample");
  const sampleTab = screen.getByRole("tab", { name: "표본 기준", selected: true });
  await screen.findByRole("heading", { name: "표본과 계산 기준" });
  expect(screen.queryByRole("group", { name: "실제 코스 지도" })).toBeNull();
  fireEvent.keyDown(sampleTab, { key: "ArrowLeft" });
  expect(screen.getByRole("tab", { name: "기간 비교", selected: true })).toBe(
    document.activeElement,
  );
  expect(screen.getByRole("tabpanel", { name: "기간 비교" })).toBeTruthy();
  expect(screen.getByLabelText("기간 A 시즌")).toBeTruthy();
  expect(screen.getByLabelText("기간 B 시즌")).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => String(url).includes("/comparison"))).toBe(false);
});

it.each([
  ["pitcher", "/api/v2/analysis/pitch-location/hp1"],
  ["batter", "/api/v2/analysis/batter-profile/b1"],
] as const)("requests only the %s comparison after apply", async (role, path) => {
  const fetch = mockOutcomes();
  const analysisRequests = () =>
    fetch.mock.calls
      .map(([url]) => new URL(String(url), "http://localhost").pathname)
      .filter((pathname) => pathname === path || pathname === `${path}/comparison`);
  show(role, "season=2025&competition=unknown&outcomeView=period");

  const apply = await screen.findByRole("button", { name: "두 기간 비교 적용" });
  expect(analysisRequests()).toEqual([]);

  fireEvent.click(apply);
  expect((await screen.findByRole("alert")).textContent).toContain("요청에 실패했습니다 (400)");
  expect(analysisRequests()).toEqual([`${path}/comparison`]);

  fireEvent.click(screen.getByRole("tab", { name: "코스·반응" }));
  await screen.findByRole("table", { name: "구종별 반응" });
  expect(analysisRequests()).toEqual([`${path}/comparison`, path]);
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
  const filters = detailsFor("조회 조건 변경");
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
  expect(next.get("pitcher")).toBe("hp1");
  for (const key of ["dateFrom", "dateTo"]) expect(next.has(key)).toBe(false);
});

it("carries only supported situation conditions into the discipline comparison link", async () => {
  mockOutcomes();
  show(
    "batter",
    "season=2024&competition=regular&batter=b1&dateFrom=2024-06-01&dateTo=2024-06-30&balls=0&strikes=2&pitchType=직구&stance=R&cohort=discipline&map=difference",
  );
  const link = await screen.findByRole("link", { name: /조건 일치 선구안 비교/ });
  const target = new URL(link.getAttribute("href") ?? "", "http://localhost");
  expect(target.pathname).toBe("/analysis/batter-discipline");
  expect(Object.fromEntries(target.searchParams)).toEqual({
    season: "2024",
    competition: "regular",
    dateFrom: "2024-06-01",
    dateTo: "2024-06-30",
    batter: "b1",
    balls: "0",
    strikes: "2",
    pitchType: "직구",
    stance: "R",
  });
  expect(screen.getByText(/선구안은 자체 상황 제외 기준/)).toBeTruthy();
});

it.each(["pitcher", "batter"] as const)(
  "pins the implicitly selected %s when the season changes",
  async (role) => {
    mockOutcomes();
    show(role);
    await screen.findByRole("table", { name: "구종별 반응" });
    fireEvent.change(screen.getByLabelText("투구 결과 시즌"), { target: { value: "2025" } });
    const params = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
    expect(params.get(role)).toBe(role === "pitcher" ? "hp1" : "b1");
  },
);

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
  expect(records.getAllByRole("link", { name: "투구 장면 r3" })).toHaveLength(20);
  expect(
    records.getAllByRole("link").every((link) => link.getAttribute("href")?.includes("revision=3")),
  ).toBe(true);
  fireEvent.click(records.getByRole("button", { name: "다음", exact: true }));
  expect(records.getAllByRole("link", { name: "투구 장면 r3" })).toHaveLength(1);
  const emptyCell = within(screen.getByLabelText("실제 코스 지도")).getAllByRole("button")[0];
  if (emptyCell === undefined) throw new Error("Missing map cell");
  fireEvent.click(emptyCell);
  expect(records.queryAllByRole("link")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "모든 코스", exact: true }));
  expect(records.getAllByRole("link", { name: "투구 장면 r3" })).toHaveLength(20);
  expect(records.getByRole("button", { name: "이전", exact: true })).toHaveProperty(
    "disabled",
    true,
  );
});

it("applies quick count presets atomically and clears only situation filters", async () => {
  const fetch = mockOutcomes();
  show(
    "pitcher",
    "season=2024&competition=unknown&pitcher=hp1&dateFrom=2024-06-01&dateTo=2024-06-30&balls=0&strikes=0&stance=R",
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
    competition: "unknown",
    pitcher: "hp1",
    dateFrom: "2024-06-01",
    dateTo: "2024-06-30",
  });
});
