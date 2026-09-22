// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { PitchOutcomeQuerySchema, resolveAnalysisScope } from "@kbo/contracts";
import { analyzeBatterProfile } from "@kbo/game-core";
import { PitchOutcomesPage } from "../../apps/web/src/pages/pitch-outcomes-page.js";
import { outcomeRow, terminalPa } from "../helpers/pitch-outcomes.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("restores scope and exposes separate pitch and PA denominators with revision-bound replay links", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), "http://localhost");
    const raw = Object.fromEntries(u.searchParams);
    const scope = resolveAnalysisScope({ season: 2024, competition: "all" });
    if (u.pathname.endsWith("batter-discipline"))
      return new Response(
        JSON.stringify({
          season: 2024,
          scope,
          batters: [{ batterId: "b1", name: "타자", pitches: 1 }],
        }),
      );
    const q = Value.Decode(PitchOutcomeQuerySchema, { ...raw, season: Number(raw.season) });
    return new Response(
      JSON.stringify(
        analyzeBatterProfile(q, "b1", scope, "a".repeat(64), [outcomeRow()], [terminalPa()]),
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/batter-profile?season=2024&competition=all&batter=b1"] },
        createElement(PitchOutcomesPage, { role: "batter" }),
      ),
    ),
  );
  const table = await screen.findByRole("table", { name: "전체 반응" });
  expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
  expect(await screen.findByRole("table", { name: "종결 구종 성적" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "경기 재생 r1" }).getAttribute("href")).toContain(
    "revision=1",
  );
  const buttons = within(screen.getByLabelText("실제 코스 지도")).getAllByRole("button");
  expect(buttons).toHaveLength(25);
  fireEvent.click(buttons[0] as HTMLElement);
  expect(screen.getByText(/선택 근거 0구/u)).toBeTruthy();
});
