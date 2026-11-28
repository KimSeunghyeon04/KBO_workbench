// @vitest-environment jsdom
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement } from "react";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { AnalysisCoveragePage } from "../../apps/web/src/pages/analysis-coverage-page.js";
import { getAnalysisCoverage } from "../../apps/web/src/api/analysis-coverage-client.js";
import { coverageFixture } from "../helpers/analysis-coverage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows distinct denominators and restores the selected season", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(coverageFixture(2020))));
  vi.stubGlobal("fetch", fetcher);
  render(
    createElement(
      QueryClientProvider,
      { client: createAnalysisQueryClient() },
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/coverage?season=2020"] },
        createElement(AnalysisCoveragePage),
      ),
    ),
  );
  expect(await screen.findByText(/경기 종류 미분류 0경기/)).toBeTruthy();
  expect(screen.getByText("트래킹 누락")).toBeTruthy();
  expect(screen.getByText("궤적 부적합")).toBeTruthy();
  expect(screen.getByRole("link", { name: "투수별 구질 보기" }).getAttribute("href")).toContain(
    "season=2020",
  );
  fetcher.mockImplementation(async () => new Response(JSON.stringify(coverageFixture(2021))));
  fireEvent.change(screen.getByLabelText("시즌"), { target: { value: "2021" } });
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "투수별 구질 보기" }).getAttribute("href")).toContain(
      "season=2021",
    ),
  );
});
it("rejects a response with a mismatched season or inconsistent counts", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(coverageFixture(2020)))),
  );
  await expect(getAnalysisCoverage(2025, new AbortController().signal)).rejects.toThrow("일치하지");
  const broken = coverageFixture();
  broken.total.actualPitches++;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(broken))),
  );
  await expect(getAnalysisCoverage(2025, new AbortController().signal)).rejects.toThrow("일치하지");
});

it("polls preparation to completion and offers an explicit retry after failure", async () => {
  const fixture = coverageFixture(2020);
  const preparing = { state: "preparing", scope: fixture.scope, sourceKey: "a".repeat(64) };
  const paths: string[] = [];
  let state = "preparing";
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    paths.push(url.pathname.split("/").at(-1) ?? "");
    if (url.pathname.endsWith("/status")) {
      expect(url.searchParams.get("sourceKey")).toBe(preparing.sourceKey);
      return Response.json({ state });
    }
    expect(url.searchParams.get("season")).toBe("2020");
    if (url.pathname.endsWith("/prepare")) {
      state = "preparing";
      return Response.json(preparing, { status: 202 });
    }
    return Response.json(state === "missing" ? fixture : { ...preparing, state });
  });
  vi.stubGlobal("fetch", fetcher);
  const client = createAnalysisQueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/coverage?season=2020"] },
        createElement(AnalysisCoveragePage),
      ),
    ),
  );
  expect(await screen.findByText(/품질 요약을 준비하고 있습니다/)).toBeTruthy();
  await waitFor(() => expect(paths).toEqual(["coverage", "status"]));
  state = "failed";
  expect(
    await screen.findByText(/품질 요약을 준비하지 못했습니다/, {}, { timeout: 2500 }),
  ).toBeTruthy();
  expect(paths).toEqual(["coverage", "status", "status", "coverage"]);
  fireEvent.click(screen.getByRole("button", { name: "다시 준비" }));
  await waitFor(() => expect(paths.slice(-2)).toEqual(["prepare", "status"]));
  expect(await screen.findByText(/품질 요약을 준비하고 있습니다/)).toBeTruthy();
  state = "missing";
  expect(await screen.findByText(/경기 종류 미분류 0경기/, {}, { timeout: 2500 })).toBeTruthy();
  expect(paths).toEqual([
    "coverage",
    "status",
    "status",
    "coverage",
    "prepare",
    "status",
    "status",
    "coverage",
  ]);
  client.clear();
}, 7500);

it("rejects a preparation response for a different scope", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            state: "preparing",
            scope: coverageFixture(2020).scope,
            sourceKey: "a".repeat(64),
          }),
        ),
    ),
  );
  await expect(getAnalysisCoverage(2025, new AbortController().signal)).rejects.toThrow("일치하지");
});

it("keeps competition and dates in related analysis links, resetting dates only when season changes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const { season, ...options } = Object.fromEntries(url.searchParams);
      const fixture = coverageFixture(Number(season));
      return Response.json({
        ...fixture,
        scope: resolveAnalysisScope({ season: Number(season), ...options }),
      });
    }),
  );
  const client = createAnalysisQueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            "/analysis/coverage?season=2020&competition=unknown&dateFrom=2020-06-01&dateTo=2020-06-30",
          ],
        },
        createElement(AnalysisCoveragePage),
      ),
    ),
  );
  const link = await screen.findByRole("link", { name: "투수별 구질 보기" });
  const query = new URL(link.getAttribute("href") ?? "", "http://localhost").searchParams;
  expect(Object.fromEntries(query)).toEqual({
    season: "2020",
    competition: "unknown",
    dateFrom: "2020-06-01",
    dateTo: "2020-06-30",
  });
  fireEvent.change(screen.getByLabelText("시즌"), { target: { value: "2021" } });
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "투수별 구질 보기" }).getAttribute("href")).toBe(
      "/analysis/pitch-shape?season=2021&competition=unknown",
    ),
  );
  client.clear();
});
