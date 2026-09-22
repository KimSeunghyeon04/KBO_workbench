// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { summarizeMatchupModel, analyzePitchAngles } from "@kbo/game-core";
import { MatchupModelPanel } from "../../apps/web/src/analysis/matchup-model-panel.js";
import { PitchAnglesPanel } from "../../apps/web/src/analysis/pitch-angles-panel.js";
import { getPitchAngles } from "../../apps/web/src/api/pitch-angles-client.js";
import { getMatchupModel } from "../../apps/web/src/api/matchup-model-client.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function wrap(child: ReturnType<typeof createElement>) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    createElement(MemoryRouter, null, child),
  );
}
it("loads the matchup extension only on demand and explains missing model without fabricating predictions", async () => {
  const query = { season: 2025, pitcherId: "p", batterId: "b" },
    scope = resolveAnalysisScope({ season: 2025 }, "regular"),
    data = summarizeMatchupModel(query, scope, "a".repeat(64), [], [], null, null),
    fetch = vi.fn(async () => Response.json(data));
  vi.stubGlobal("fetch", fetch);
  render(wrap(createElement(MatchupModelPanel, { query })));
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "구질 유사도·기대 반응 보기" }));
  expect(await screen.findByText(/현재 원천에 맞는 매치업 모델이 없습니다/)).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ...data, query: { ...query, batterId: "wrong" } })),
  );
  await expect(getMatchupModel(query, new AbortController().signal)).rejects.toThrow("범위");
});
it("labels raw angles and physical course, validates coverage and defers loading until opened", async () => {
  const query = { season: 2025 },
    scope = resolveAnalysisScope(query, "regular"),
    data = analyzePitchAngles([], scope, "p", "a".repeat(64)),
    fetch = vi.fn(async () => Response.json(data));
  vi.stubGlobal("fetch", fetch);
  render(wrap(createElement(PitchAnglesPanel, { query, pitcherId: "p" })));
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "진입각 VAA/HAA 보기" }));
  expect(await screen.findByRole("table", { name: "구종 진입각" })).toBeTruthy();
  expect(screen.getByText(/구장 보정과 초기 방향 정렬을 적용하지 않았습니다/)).toBeTruthy();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ...data, coverage: { ...data.coverage, actual: 1 } })),
  );
  await expect(getPitchAngles("p", query, new AbortController().signal)).rejects.toThrow(
    "표본 합계",
  );
});
