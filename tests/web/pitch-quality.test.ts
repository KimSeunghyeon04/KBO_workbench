// @vitest-environment jsdom
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope, type PitchQualityResponse } from "@kbo/contracts";
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
      { client: createAnalysisQueryClient() },
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
  expect(screen.getByText("관측 비율 표본 30구 · 모델 비교 미제공")).toBeTruthy();
  expect(screen.getByText(/좌표\/조건 누락·보정 지원·학습 범위 판정은 미확인/)).toBeTruthy();
  expect(screen.queryByText(/좌표\/조건 누락 0/)).toBeNull();
  expect(screen.queryByText(/모델 적용 표본 0/)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  [2023, "2021·2022"],
  [2024, "2022·2023"],
  [2025, "2023·2024"],
])(
  "uses the %i model's validation years and distinguishes assessed zero from absent evaluation",
  async (season, years) => {
    const query = { season, competition: "regular" as const };
    const base = summarizePitchQuality(
      [],
      resolveAnalysisScope(query),
      "p",
      "a".repeat(64),
      null,
      null,
    );
    const data: PitchQualityResponse = {
      ...base,
      status: "not_adopted",
      trainedThrough: season - 1,
      modelHash: "b".repeat(64),
      models: (["swing", "whiff", "called_strike"] as const).map((target) => ({
        target,
        adopted: false,
        kind: "baseline",
        evaluation: null,
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(data)),
    );
    const client = createAnalysisQueryClient();
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PitchQualityPanel, { pitcherId: "p", query }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "구종 기대 효과 보기" }));
    expect(await screen.findByText(/좌표\/조건 누락 0구/)).toBeTruthy();
    expect(screen.queryByText(/판정은 미확인/)).toBeNull();
    expect(screen.getByText(new RegExp(`${years} 시간 검증`))).toBeTruthy();
    expect(screen.getAllByText(/다음 시즌 평가 미제공/)).toHaveLength(3);
    expect(screen.queryByText(/n=0/)).toBeNull();
    client.clear();
  },
);
