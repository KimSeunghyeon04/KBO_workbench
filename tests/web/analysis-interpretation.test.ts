// @vitest-environment jsdom
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope, type PitchProfileGroup } from "@kbo/contracts";
import { analyzeMatchup, resolveBatterStrikeZone } from "@kbo/game-core";
import { PitchLocationMap } from "../../apps/web/src/analysis/pitch-location-panel.js";
import { PitchProfilePanel } from "../../apps/web/src/analysis/pitch-profile-panel.js";
import { MatchupPage } from "../../apps/web/src/pages/matchup-page.js";
import { outcomeRow } from "../helpers/pitch-outcomes.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([2020, 2021, 2022, 2023, 2024, 2025])(
  "labels the %i analysis zone with the same rule year as the core policy",
  (season) => {
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(PitchLocationMap, { season, cells: [], points: [] }),
      ),
    );
    const expectedRule = resolveBatterStrikeZone(season, 180)?.ruleYear;
    expect(expectedRule).toBeDefined();
    expect(
      screen.getByText(new RegExp(`분석용 신장 기준 존 · ${expectedRule} 규칙 적용`)),
    ).toBeTruthy();
    expect(
      screen.getByText(/당시 심판 판정이나 ABS 장비의 판정 존을 재현한 값이 아닙니다/),
    ).toBeTruthy();
  },
);

it("keeps the selected-period profile separate from expandable monthly detail", async () => {
  const group: PitchProfileGroup = {
    pitchType: "직구",
    actualPitches: 10,
    usageRate: 1,
    speedCount: 10,
    meanSpeedKph: 145,
    shapeCount: 8,
    calibratedCount: 5,
    meanXCm: 1,
    meanZCm: 2,
    sdXCm: 1,
    sdZCm: 2,
    meanArrivalMs: 400,
    calibratedXCm: 1,
    calibratedZCm: 2,
    calibratedArrivalMs: 400,
    swings: 4,
    whiffs: 1,
    whiffRate: 0.25,
  };
  render(
    createElement(PitchProfilePanel, {
      profile: {
        groups: [group],
        months: [{ month: "2024-04", actualPitches: 10, groups: [group] }],
      },
    }),
  );
  const summary = screen.getByRole("table", { name: "구종 프로필" });
  expect(within(summary).getByText("선택 기간")).toBeTruthy();
  expect(within(summary).queryByText("2024-04")).toBeNull();
  const toggle = screen.getByText("월별 구종 변화 보기 · 1개월");
  expect(toggle.closest("details")).toHaveProperty("open", false);
  await userEvent.setup().click(toggle);
  expect(toggle.closest("details")).toHaveProperty("open", true);
  expect(
    within(screen.getByRole("table", { name: "월별 구종 프로필" })).getByText("2024-04"),
  ).toBeTruthy();
  expect(within(summary).getAllByRole("row")).toHaveLength(2);
});

it("distinguishes matchup called strikes per pitch from model called strikes per take", async () => {
  const query = { season: 2024, competition: "regular" as const, pitcherId: "hp1", batterId: "b1" };
  const scope = resolveAnalysisScope({ season: query.season, competition: query.competition });
  const rows = [
    outcomeRow({ pitchId: "swing", swing: true, whiff: true, calledStrike: false }),
    outcomeRow({ pitchId: "take", swing: false, whiff: false, calledStrike: true }),
  ];
  const data = analyzeMatchup(query, scope, "a".repeat(64), rows, [], [], []);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path.endsWith("matchups")) return Response.json(data);
      return Response.json({
        season: 2024,
        scope,
        ...(path.endsWith("batter-discipline")
          ? { batters: [{ batterId: "b1", name: "타자", pitches: 2 }] }
          : { pitchers: [{ pitcherId: "hp1", name: "투수", pitches: 2 }] }),
      });
    }),
  );
  const client = createAnalysisQueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            "/analysis/matchups?season=2024&competition=regular&pitcher=hp1&batter=b1",
          ],
        },
        createElement(MatchupPage),
      ),
    ),
  );
  const comparison = await screen.findByRole("region", { name: "매치업 반응 비교" });
  const observedWhiff = within(comparison).getByRole("region", { name: "헛스윙 / 스윙" });
  expect(within(observedWhiff).getByText("1/1 스윙")).toBeTruthy();
  expect(within(observedWhiff).getByText("—")).toBeTruthy();
  await userEvent.setup().click(screen.getByText("관측 반응 상세 기록"));
  const direct = screen.getByRole("table", { name: "매치업 관측 반응" });
  expect(within(direct).getByRole("columnheader", { name: "루킹/투구" })).toBeTruthy();
  expect(within(direct).queryByRole("columnheader", { name: "루킹%" })).toBeNull();
  const first = within(direct).getAllByRole("row")[1];
  expect(first).toBeDefined();
  if (!first) throw new Error("Expected direct cohort row");
  expect(within(first).getAllByText("50.0%")).toHaveLength(2);
  expect(within(first).getByText("100.0%")).toBeTruthy();
  expect(within(first).getByText("1/1 스윙")).toBeTruthy();
  expect(within(first).getAllByText("소표본 · 분모 20 미만")).toHaveLength(3);
  await userEvent.setup().click(screen.getByText("표본 기준과 분모"));
  expect(screen.getByText(/모델 패널의 루킹\/비스윙과는 분모가 다릅니다/)).toBeTruthy();
  expect(
    within(screen.getByRole("table", { name: "매치업 조건 일치 비교" })).getByText("루킹/투구"),
  ).toBeTruthy();
  client.clear();
});
