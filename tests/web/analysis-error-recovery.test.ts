// @vitest-environment jsdom
import { createElement, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope, type PitchOutcomeQuery } from "@kbo/contracts";
import { analyzeBatterProfile } from "@kbo/game-core";
import { AnalysisQueryError } from "../../apps/web/src/analysis/analysis-query-error.js";
import { AnalysisCoveragePage } from "../../apps/web/src/pages/analysis-coverage-page.js";
import { AnalysisModelsPage } from "../../apps/web/src/pages/analysis-models-page.js";
import { BaserunningPage } from "../../apps/web/src/pages/baserunning-page.js";
import { BatterDisciplinePage } from "../../apps/web/src/pages/batter-discipline-page.js";
import { MatchupPage } from "../../apps/web/src/pages/matchup-page.js";
import { ParkEnvironmentPage } from "../../apps/web/src/pages/park-environment-page.js";
import { PitchAnalysisPage } from "../../apps/web/src/pages/pitch-analysis-page.js";
import { PitchOutcomesPage } from "../../apps/web/src/pages/pitch-outcomes-page.js";
import { PitcherChangesPage } from "../../apps/web/src/pages/pitcher-changes-page.js";
import { PitcherWorkloadPage } from "../../apps/web/src/pages/pitcher-workload-page.js";
import { PitchSequencesPage } from "../../apps/web/src/pages/pitch-sequences-page.js";
import { PlayerStatisticsPage } from "../../apps/web/src/pages/player-statistics-page.js";
import { outcomeRow, terminalPa } from "../helpers/pitch-outcomes.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.unstubAllGlobals();
});

function CurrentLocation() {
  return createElement("output", { "aria-label": "현재 주소" }, useLocation().search);
}

function show(page: ReactElement, search: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [`/?${search}`] },
        page,
        createElement(CurrentLocation),
      ),
    ),
  );
}

it.each([
  ["coverage", createElement(AnalysisCoveragePage)],
  ["models", createElement(AnalysisModelsPage)],
  ["baserunning", createElement(BaserunningPage)],
  ["discipline", createElement(BatterDisciplinePage)],
  ["matchups", createElement(MatchupPage)],
  ["parks", createElement(ParkEnvironmentPage)],
  ["shape", createElement(PitchAnalysisPage)],
  ["pitcher outcomes", createElement(PitchOutcomesPage, { role: "pitcher" })],
  ["batter outcomes", createElement(PitchOutcomesPage, { role: "batter" })],
  ["changes", createElement(PitcherChangesPage)],
  ["workload", createElement(PitcherWorkloadPage)],
  ["sequences", createElement(PitchSequencesPage)],
  ["statistics", createElement(PlayerStatisticsPage)],
])("offers explicit recovery for failed %s reads without changing the URL", async (_name, page) => {
  const fetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () =>
    Response.json({}, { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  const search =
    "season=2024&competition=regular&dateFrom=2024-04-01&dateTo=2024-04-30&pitcher=hp1&batter=b1";
  show(page, search);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("요청에 실패했습니다 (503)");
  expect(alert.textContent).not.toContain("ApiClientError");
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "다시 시도" }).disabled).toBe(
      false,
    );
  });
  const requests = fetch.mock.calls.map((call) => String(call[0])).sort();
  expect(requests.length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(requests.length * 2));
  await waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "다시 시도" }).disabled).toBe(
      false,
    );
  });
  expect(fetch.mock.calls.map((call) => String(call[0])).sort()).toEqual(
    [...requests, ...requests].sort(),
  );
  expect(screen.getByLabelText("현재 주소").textContent).toBe(`?${search}`);
});

it("recovers a failed batter profile without refetching its successful catalog or clearing conditions", async () => {
  const scopeQuery = {
    season: 2024,
    competition: "regular" as const,
    dateFrom: "2024-01-01",
    dateTo: "2024-12-31",
  };
  const query: PitchOutcomeQuery = {
    ...scopeQuery,
    balls: 1,
    strikes: 2,
    pitchType: "직구",
    stance: "R",
    cohort: "all",
  };
  const scope = resolveAnalysisScope(scopeQuery);
  const result = analyzeBatterProfile(
    query,
    "b1",
    scope,
    "a".repeat(64),
    [outcomeRow()],
    [terminalPa()],
  );
  let completeRetry: ((response: Response) => void) | undefined;
  const pendingResponse = new Promise<Response>((resolve) => {
    completeRetry = resolve;
  });
  let profileRequests = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("batter-discipline")) {
      return Response.json({
        season: query.season,
        scope,
        batters: [{ batterId: "b1", name: "가상 타자", pitches: 1 }],
      });
    }
    profileRequests++;
    return profileRequests === 1 ? Response.json({}, { status: 503 }) : pendingResponse;
  });
  vi.stubGlobal("fetch", fetch);
  const params = new URLSearchParams(
    Object.entries({ ...query, batter: "b1" }).map(([key, value]) => [key, String(value)]),
  );
  show(createElement(PitchOutcomesPage, { role: "batter" }), params.toString());
  await screen.findByRole("alert");
  expect(fetch).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  const retryButton = screen.queryByRole<HTMLButtonElement>("button", { name: "다시 시도" });
  expect(retryButton === null || retryButton.disabled).toBe(true);
  expect(screen.getByLabelText("현재 주소").textContent).toBe(`?${params}`);
  if (completeRetry === undefined) throw new Error("Retry response was not requested");
  completeRetry(Response.json(result));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(fetch).toHaveBeenCalledTimes(3);
  const profileUrls = fetch.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes("batter-profile"));
  expect(profileUrls).toHaveLength(2);
  expect(profileUrls[1]).toBe(profileUrls[0]);
  expect(screen.getByLabelText("현재 주소").textContent).toBe(`?${params}`);
});

it("does not dispatch retries while a request is in flight or the conditions are invalid", () => {
  const failed = {
    error: new Error("자료 확인 필요"),
    isFetching: false,
    refetch: vi.fn(async () => undefined),
  };
  const successful = { error: null, isFetching: false, refetch: vi.fn(async () => undefined) };
  const view = render(createElement(AnalysisQueryError, { queries: [failed, successful] }));
  expect(failed.refetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(failed.refetch).toHaveBeenCalledTimes(1);
  expect(successful.refetch).not.toHaveBeenCalled();

  view.rerender(
    createElement(AnalysisQueryError, { queries: [{ ...failed, isFetching: true }, successful] }),
  );
  const pending = screen.getByRole<HTMLButtonElement>("button", { name: "다시 불러오는 중" });
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  view.rerender(
    createElement(AnalysisQueryError, { queries: [failed, successful], enabled: false }),
  );
  const invalid = screen.getByRole<HTMLButtonElement>("button", { name: "다시 시도" });
  expect(invalid.disabled).toBe(true);
  fireEvent.click(invalid);
  expect(failed.refetch).toHaveBeenCalledTimes(1);
  expect(successful.refetch).not.toHaveBeenCalled();
});
