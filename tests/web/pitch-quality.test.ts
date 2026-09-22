// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { summarizePitchQuality } from "@kbo/game-core";
import { PitchQualityPanel } from "../../apps/web/src/analysis/pitch-quality-panel.js";
import { qualityRows } from "../helpers/pitch-quality.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("loads on demand and preserves observed denominators when a model is unavailable", async () => {
  const data = summarizePitchQuality(
      qualityRows([2025]).slice(0, 30),
      resolveAnalysisScope({ season: 2025, competition: "regular" }),
      "p",
      "a".repeat(64),
      null,
      null,
    ),
    fetch = vi.fn(async () => Response.json(data));
  vi.stubGlobal("fetch", fetch);
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(PitchQualityPanel, {
        pitcherId: "p",
        query: { season: 2025, competition: "regular" },
      }),
    ),
  );
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "구종 기대 효과 보기" }));
  expect(await screen.findByText(/현재 원천에 맞는 학습 모델이 없습니다/)).toBeTruthy();
  expect(screen.getByRole("table", { name: "구종 관측 기대 비교" })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});
