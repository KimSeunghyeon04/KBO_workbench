// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { analyzeParkEnvironment } from "@kbo/game-core";
import { ParkEnvironmentPage } from "../../apps/web/src/pages/park-environment-page.js";
import { parkEnvironmentRows } from "../helpers/park-environment.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows descriptive denominators with exact revision links without requiring a model", async () => {
  const data = analyzeParkEnvironment(
      resolveAnalysisScope({ season: 2025, competition: "regular" }),
      "a".repeat(64),
      parkEnvironmentRows(2025, 4),
      null,
      null,
    ),
    fetch = vi.fn(async () => Response.json(data));
  vi.stubGlobal("fetch", fetch);
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/park-environment?season=2025"] },
        createElement(ParkEnvironmentPage),
      ),
    ),
  );
  expect(await screen.findByRole("table", { name: "구장별 홈 원정 성적" })).toBeTruthy();
  expect(screen.getByText(/현재 원천에 맞는 학습 모델이 없습니다/)).toBeTruthy();
  expect(
    screen.getAllByRole("link").every((link) => link.getAttribute("href")?.includes("revision=1")),
  ).toBe(true);
  expect(screen.queryByRole("table", { name: "home_runs 조정값" })).toBeNull();
});
