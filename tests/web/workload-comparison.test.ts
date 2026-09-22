// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { comparePitcherWorkload } from "@kbo/game-core";
import { WorkloadComparisonPanel } from "../../apps/web/src/analysis/workload-comparison-panel.js";
import { getWorkloadComparison } from "../../apps/web/src/api/workload-comparison-client.js";
import { workloadComparisonFixture } from "../helpers/workload-comparison.js";
const query = { season: 2024 },
  fixture = workloadComparisonFixture();
const data = comparePitcherWorkload(
  query,
  resolveAnalysisScope(query, "regular"),
  "p",
  "a".repeat(64),
  fixture.history,
  fixture.cells,
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("defers work until opened, switches metrics locally and shows denominators and unsupported results", async () => {
  const fetch = vi.fn(async () => Response.json(data));
  vi.stubGlobal("fetch", fetch);
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(WorkloadComparisonPanel, { query, pitcherId: "p" }),
    ),
  );
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "조건을 맞춘 운용 비교 보기" }));
  expect(await screen.findByRole("table", { name: "조건을 맞춘 운용 성과" })).toBeTruthy();
  expect(screen.getByText("136.00 → 124.00")).toBeTruthy();
  expect(screen.getByText("130.00 → 130.00")).toBeTruthy();
  expect(screen.getAllByText("공통 표본 부족")).toHaveLength(2);
  fireEvent.change(screen.getByRole("combobox", { name: "운용 비교 성과" }), {
    target: { value: "whiff" },
  });
  expect(screen.getByText("90 / 90 · 90 / 90")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "운용 비교 항목" }), {
    target: { value: "rest" },
  });
  expect(screen.getByText("2일 이상 휴식 → 0일 휴식")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects mismatched query, coverage totals and ready states with missing estimates", async () => {
  for (const invalid of [
    { ...data, pitcherId: "wrong" },
    { ...data, actualPitches: data.actualPitches + 1 },
    {
      ...data,
      dimensions: data.dimensions.map((d) => ({
        ...d,
        comparisons: d.comparisons.map((r) => ({ ...r, status: "ready", difference: null })),
      })),
    },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(invalid)),
    );
    await expect(getWorkloadComparison(query, "p", new AbortController().signal)).rejects.toThrow(
      /범위|표본|상태/,
    );
  }
});
