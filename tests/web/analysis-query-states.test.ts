// @vitest-environment jsdom
import { createElement, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { AnalysisCoveragePage } from "../../apps/web/src/pages/analysis-coverage-page.js";
import { PitchAnalysisPage } from "../../apps/web/src/pages/pitch-analysis-page.js";
import { PitchOutcomesPage } from "../../apps/web/src/pages/pitch-outcomes-page.js";
import { MatchupPage } from "../../apps/web/src/pages/matchup-page.js";
import { PitcherWorkloadPage } from "../../apps/web/src/pages/pitcher-workload-page.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});
function show(page: ReactElement, search: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: [search] }, page),
    ),
  );
}
it.each([
  ["coverage", createElement(AnalysisCoveragePage)],
  ["shape", createElement(PitchAnalysisPage)],
  ["outcomes", createElement(PitchOutcomesPage, { role: "pitcher" })],
  ["matchups", createElement(MatchupPage)],
  ["workload", createElement(PitcherWorkloadPage)],
])("does not present invalid disabled %s queries as loading", (_name, page) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  show(page, "/?season=2025&dateFrom=2025-08-01&dateTo=2025-04-01");
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["outcomes", createElement(PitchOutcomesPage, { role: "pitcher" })],
  ["matchups", createElement(MatchupPage)],
  ["workload", createElement(PitcherWorkloadPage)],
])("shows an actionable empty %s state without losing the selected scope", async (_name, page) => {
  const options = {
    season: 2024,
    competition: "regular" as const,
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json({
        season: 2024,
        scope: resolveAnalysisScope(options),
        ...(String(input).includes("batter-discipline") ? { batters: [] } : { pitchers: [] }),
      }),
    ),
  );
  show(
    page,
    `/?${new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]))}`,
  );
  expect(
    await screen.findByRole("heading", { name: "선택한 범위에 분석할 선수가 없습니다" }),
  ).toBeTruthy();
  expect(screen.queryByText(/읽고 있습니다/)).toBeNull();
  const link = screen.getByRole("link", { name: "이 범위의 자료 품질 확인 →" });
  const destination = new URL(link.getAttribute("href") ?? "", "http://localhost");
  expect(Object.fromEntries(destination.searchParams)).toEqual({ ...options, season: "2024" });
});
