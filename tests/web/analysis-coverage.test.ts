// @vitest-environment jsdom
import { createElement } from "react";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
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
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/coverage?season=2020"] },
        createElement(AnalysisCoveragePage),
      ),
    ),
  );
  expect(await screen.findByText(/경기 종류 미분류 1경기/)).toBeTruthy();
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
  const fetcher = vi.fn(async () => new Response(JSON.stringify(preparing), { status: 202 }));
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  fetcher.mockImplementation(
    async () => new Response(JSON.stringify({ ...preparing, state: "failed" })),
  );
  expect(
    await screen.findByText(/품질 요약을 준비하지 못했습니다/, {}, { timeout: 2500 }),
  ).toBeTruthy();
  fetcher.mockImplementation(async () => new Response(JSON.stringify(fixture)));
  fireEvent.click(screen.getByRole("button", { name: "다시 준비" }));
  expect(await screen.findByText(/경기 종류 미분류 1경기/)).toBeTruthy();
  expect(fetcher).toHaveBeenLastCalledWith(
    expect.stringContaining("/coverage/prepare?"),
    expect.objectContaining({ method: "POST" }),
  );
});

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
