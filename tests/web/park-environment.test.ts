// @vitest-environment jsdom
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
      { client: createAnalysisQueryClient() },
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/park-environment?season=2025"] },
        createElement(ParkEnvironmentPage),
      ),
    ),
  );
  expect(await screen.findByRole("region", { name: "구장별 관측 비율 비교" })).toBeTruthy();
  const chart = screen.getByRole("region", { name: "구장별 관측 비율 비교" });
  expect(within(chart).getAllByRole("listitem")).toHaveLength(data.parks.length);
  expect(within(chart).getAllByLabelText("득점 / 타석 0.075")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("비교 지표"), { target: { value: "homeRunRate" } });
  expect(within(chart).getAllByLabelText("홈런 / 타석 0.150")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("비교 지표"), { target: { value: "completeRunRate" } });
  expect(within(chart).getByText(/완결 반이닝은 정상 9이닝 경기의 1–8회/)).toBeTruthy();
  fireEvent.click(screen.getByText("구장별 상세 기록"));
  expect(screen.getByRole("status").textContent).toContain("조정 지수 미제공");
  const table = screen.getByRole("table", { name: "구장별 홈 원정 성적" });
  const totalRows = within(table).getAllByRole("row").length;
  fireEvent.click(screen.getByRole("button", { name: "홈·원정 세부 성적 보기" }));
  expect(within(table).getAllByRole("row").length).toBe((totalRows - 1) * 3 + 1);
  expect(
    screen.getAllByRole("link").every((link) => link.getAttribute("href")?.includes("revision=1")),
  ).toBe(true);
  expect(screen.queryByRole("table", { name: "home_runs 조정값" })).toBeNull();
});
