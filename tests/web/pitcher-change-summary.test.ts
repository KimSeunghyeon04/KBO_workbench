// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { resolveAnalysisScope, type PitchChangeObservation } from "@kbo/contracts";
import { analyzePitcherChanges } from "@kbo/game-core";
import { PitcherChangeSummary } from "../../apps/web/src/analysis/pitcher-change-summary.js";
import { formatPitchChange } from "../../apps/web/src/analysis/pitch-change-metrics.js";

afterEach(cleanup);

function report() {
  const query = { season: 2025, dateTo: "2025-06-08" };
  const rows: PitchChangeObservation[] = Array.from({ length: 8 }, (_, day) =>
    Array.from({ length: 100 }, (_, pitch) => ({
      gameId: `g${day}`,
      revision: 1,
      gameDate: `2025-06-0${day + 1}`,
      pitchId: `p${pitch}`,
      stadium: "검증 구장",
      pitchType: pitch < (day < 5 ? 20 : 30) ? "슬라이더" : "직구",
      speedKph: day < 5 ? 140 : 141,
      stance: "R",
      balls: 0,
      strikes: 0,
      swing: false,
      whiff: false,
      xCm: 3,
      zCm: 4,
      arrivalMs: 400,
      calibrated: true,
    })),
  ).flat();
  return analyzePitcherChanges(
    query,
    "test-pitcher",
    resolveAnalysisScope(query),
    "hash",
    rows,
    "2025-06-08",
  );
}

it("presents usage changes in percentage points with their actual window denominators", () => {
  render(createElement(PitcherChangeSummary, { data: report() }));
  fireEvent.change(screen.getByLabelText("비교 지표"), { target: { value: "usage" } });
  const slider = within(screen.getByRole("article", { name: "슬라이더 사용률 변화" }));
  expect(slider.getByText("+10.0%p")).toBeTruthy();
  expect(slider.getByText("이전 20.0% → 최근 30.0%")).toBeTruthy();
  expect(slider.getByText(/95% 구간: \+10.0%p ~ \+10.0%p/)).toBeTruthy();
  expect(screen.getByText(/사용률 분모: 최근 전체 300구 · 이전 전체 500구/)).toBeTruthy();
  expect(screen.getByText("2025-06-06 ~ 2025-06-08")).toBeTruthy();
  expect(screen.getByText("2025-06-01 ~ 2025-06-05")).toBeTruthy();
});

it("distinguishes an interval containing zero from small samples and missing comparisons", () => {
  const data = report();
  data.changes = data.changes.map((group) => ({
    ...group,
    metrics: group.metrics.map((metric) =>
      metric.metric !== "speedKph"
        ? metric
        : {
            ...metric,
            lower: -0.2,
            upper: 2.1,
            status: "sufficient",
          },
    ),
  }));
  const view = render(createElement(PitcherChangeSummary, { data }));
  expect(screen.getAllByText("변화 방향 불확실")).toHaveLength(2);
  expect(screen.queryByText("차이 없음")).toBeNull();
  const sparse = {
    ...data,
    changes: data.changes.map((group) => ({
      ...group,
      metrics: group.metrics.map((metric) => ({
        ...metric,
        status: "small_sample" as const,
        lower: null,
        upper: null,
      })),
    })),
  };
  view.rerender(createElement(PitcherChangeSummary, { data: sparse }));
  expect(screen.getAllByText("소표본 · 판단 보류")).toHaveLength(2);
  const missing = { ...data, status: "ambiguous_same_day" as const, changes: [] };
  view.rerender(createElement(PitcherChangeSummary, { data: missing }));
  expect(screen.getByText("비교할 구종 자료가 없습니다.")).toBeTruthy();
  expect(screen.queryByText("+0.00km/h")).toBeNull();
});

it("retains unrounded differences and never formats missing values as zero", () => {
  expect(formatPitchChange("usage", 0.03494, true)).toBe("+3.5%p");
  expect(formatPitchChange("usage", null)).toBe("—");
  expect(formatPitchChange("speedKph", -0.001, true)).toBe("0.00km/h");
  expect(formatPitchChange("zCm", -2.34, true)).toBe("-2.34cm");
});
