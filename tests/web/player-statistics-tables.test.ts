// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { battingStatistics, pitchingStatistics } from "@kbo/game-core";
import {
  BattingTable,
  PitchingTable,
} from "../../apps/web/src/analysis/player-statistics-tables.js";
import { battingTotals, pitchingTotals } from "../helpers/player-statistics.js";

afterEach(cleanup);

it("explains computed G and unrounded OPS in the full league batting table", () => {
  const row = battingStatistics({
    ...battingTotals,
    games: 1,
    plateAppearances: 3,
    atBats: 3,
    hits: 1,
    doubles: 0,
    homeRuns: 0,
    walks: 0,
    intentionalWalks: 0,
    hitByPitch: 0,
    sacrificeFlies: 0,
  });
  render(createElement(BattingTable, { rows: [row], view: "full" }));
  const table = within(screen.getByRole("table", { name: "타격 성적" }));
  expect(table.getByRole("columnheader", { name: "경기", exact: true })).toBeTruthy();
  expect(table.getAllByRole("cell", { name: "0.333", exact: true })).toHaveLength(3);
  expect(table.getByRole("cell", { name: "0.667", exact: true })).toBeTruthy();
  expect(screen.getByText(/무타석·무득점 출전은 빠질 수 있어/)).toBeTruthy();
  expect(screen.getByText(/OPS는 반올림 전 OBP와 SLG를 더한 뒤/)).toBeTruthy();
});

it("keeps incomplete ERA separate from G's participation limit", () => {
  render(
    createElement(PitchingTable, { rows: [pitchingStatistics(pitchingTotals)], view: "full" }),
  );
  const table = within(screen.getByRole("table", { name: "투구 성적" }));
  expect(table.getByRole("cell", { name: "—", exact: true })).toBeTruthy();
  expect(table.getByRole("cell", { name: "1/2", exact: true })).toBeTruthy();
  expect(table.getByRole("cell", { name: "3.00", exact: true })).toBeTruthy();
  expect(screen.getByText(/투구 등 실적이 없는 등판은 빠질 수/)).toBeTruthy();
  expect(screen.getByText(/자책점 미확인 경기가 있으면 전체 ERA는 —/)).toBeTruthy();
});
