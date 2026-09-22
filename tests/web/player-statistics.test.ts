// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  BattingStatisticsQuerySchema,
  PitchingStatisticsQuerySchema,
  resolveAnalysisScope,
} from "@kbo/contracts";
import { battingStatistics, pitchingStatistics } from "@kbo/game-core";
import { PlayerStatisticsPage } from "../../apps/web/src/pages/player-statistics-page.js";
import { battingTotals, pitchingTotals } from "../helpers/player-statistics.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("defaults new statistics to confirmed regular games and distinguishes incomplete ERA", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost"),
      pitch = url.pathname.endsWith("pitching");
    const raw = Object.fromEntries(url.searchParams);
    const candidate = {
      ...raw,
      season: Number(raw.season),
      page: Number(raw.page),
      limit: Number(raw.limit),
      ...(pitch ? { minBF: Number(raw.minBF) } : { minPA: Number(raw.minPA) }),
    };
    const query = pitch
      ? Value.Decode(PitchingStatisticsQuerySchema, candidate)
      : Value.Decode(BattingStatisticsQuerySchema, candidate);
    return new Response(
      JSON.stringify({
        kind: pitch ? "pitching" : "batting",
        query,
        scope: resolveAnalysisScope({
          season: query.season,
          competition: query.competition ?? "regular",
        }),
        sourceHash: "a".repeat(64),
        group: query.group ?? "player",
        total: 1,
        page: 1,
        limit: 50,
        rows: [pitch ? pitchingStatistics(pitchingTotals) : battingStatistics(battingTotals)],
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(MemoryRouter, null, createElement(PlayerStatisticsPage)),
    ),
  );
  const batting = await screen.findByRole("table", { name: "타격 성적" });
  expect(within(batting).getByText("1.700")).toBeTruthy();
  expect(fetch.mock.calls[0]?.[0]).toContain("competition=regular");
  fireEvent.change(screen.getByLabelText("성적 종류"), { target: { value: "pitching" } });
  const pitching = await screen.findByRole("table", { name: "투구 성적" });
  expect(within(pitching).getByText("—")).toBeTruthy();
  expect(within(pitching).getByText("3.00")).toBeTruthy();
  expect(within(pitching).getByText("1/2")).toBeTruthy();
});
