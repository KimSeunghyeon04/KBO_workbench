// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { AnalysisPlayersPage } from "../../apps/web/src/pages/analysis-players-page.js";
import { AnalysisRefreshBoundary } from "../../apps/web/src/analysis/analysis-seasons.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.unstubAllGlobals();
});
it("discovers imported seasons, defaults to the latest and refreshes active analysis when a new source arrives", async () => {
  let version = 1;
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/seasons"))
      return Response.json({
        sourceHash: String(version).repeat(64),
        seasons: version === 1 ? [2026, 2024] : [2027, 2026, 2024],
        preparation: [],
      });
    if (url.pathname === "/api/v2/analysis/pitch-shape") {
      calls.push(url.search);
      const season = Number(url.searchParams.get("season"));
      return Response.json({
        season,
        scope: resolveAnalysisScope({ season, competition: "regular" }),
        pitchers: [{ pitcherId: "anonymous", name: "가상 투수", pitches: version * 100 }],
      });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/players"] },
        createElement(AnalysisRefreshBoundary),
        createElement(AnalysisPlayersPage),
      ),
    ),
  );
  await screen.findByRole("option", { name: "2026", selected: true });
  expect(await screen.findByRole("option", { name: "2024" })).toBeTruthy();
  await screen.findByRole("link", { name: "가상 투수 분석 보기" });
  version = 2;
  await client.invalidateQueries({ queryKey: ["analysis-seasons"] });
  await screen.findByRole("option", { name: "2027" });
  await waitFor(() => expect(calls.some((call) => call.includes("season=2027"))).toBe(true));
  fireEvent.change(screen.getByRole("combobox", { name: "선수 분석 시즌" }), {
    target: { value: "2026" },
  });
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: "가상 투수 분석 보기" }).getAttribute("href"),
    ).toContain("season=2026"),
  );
  const prior = calls.length;
  version = 3;
  await client.invalidateQueries({ queryKey: ["analysis-seasons"] });
  await waitFor(() => expect(calls.length).toBeGreaterThan(prior));
  expect(screen.getByRole("link", { name: "가상 투수 분석 보기" }).getAttribute("href")).toContain(
    "season=2026",
  );
});
