// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { analyzePitchLocation } from "@kbo/game-core";
import {
  PitchOutcomeComparison,
  previousOutcomeQuery,
} from "../../apps/web/src/analysis/pitch-outcome-comparison.js";
import { SampleRate } from "../../apps/web/src/analysis/sample-rate.js";
import { outcomeRow } from "../helpers/pitch-outcomes.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("distinguishes sparse observed zero from supported zero and a missing denominator", () => {
  const view = render(
    createElement(SampleRate, { value: 0, numerator: 0, denominator: 5, unit: "스윙" }),
  );
  expect(screen.getByText("0.0%")).toBeTruthy();
  expect(screen.getByText("0/5 스윙")).toBeTruthy();
  expect(screen.getByText(/소표본/)).toBeTruthy();
  view.rerender(
    createElement(SampleRate, { value: 0, numerator: 0, denominator: 500, unit: "스윙" }),
  );
  expect(screen.queryByText(/소표본/)).toBeNull();
  view.rerender(
    createElement(SampleRate, { value: null, numerator: 0, denominator: 0, unit: "스윙" }),
  );
  expect(screen.getByText("—")).toBeTruthy();
  expect(screen.queryByText("0.0%")).toBeNull();
});

it("loads a prior full season only on demand, retaining every situation filter", async () => {
  const query = {
    season: 2025,
    competition: "postseason" as const,
    dateFrom: "2025-10-01",
    dateTo: "2025-10-31",
    pitchType: "직구",
    balls: 1,
    strikes: 2,
    stance: "L" as const,
    cohort: "discipline" as const,
  };
  const prior = previousOutcomeQuery(query);
  expect(prior).toEqual({
    season: 2024,
    competition: "postseason",
    pitchType: "직구",
    balls: 1,
    strikes: 2,
    stance: "L",
    cohort: "discipline",
  });
  expect(query.dateFrom).toBe("2025-10-01");
  const data = analyzePitchLocation(
    prior,
    "p",
    resolveAnalysisScope({ season: prior.season, competition: prior.competition }),
    "a".repeat(64),
    [outcomeRow({ pitcherId: "p", balls: 1, strikes: 2, stance: "L", swing: true, whiff: false })],
    [],
  );
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toContain("season=2024");
    return Response.json(data);
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(PitchOutcomeComparison, {
        query,
        id: "p",
        role: "pitcher",
        current: data.total,
      }),
    ),
  );
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "같은 선수의 이전 시즌과 비교 보기" }));
  const table = await screen.findByRole("table", { name: "이전 시즌 투구 반응 비교" });
  expect(within(table).getByText("2024시즌 전체")).toBeTruthy();
  expect(screen.getByText(/날짜 제한만 해제/)).toBeTruthy();
  const request = String(fetch.mock.calls[0]?.[0]);
  expect(request).toContain("season=2024");
  expect(request).not.toContain("dateFrom");
  client.clear();
});
