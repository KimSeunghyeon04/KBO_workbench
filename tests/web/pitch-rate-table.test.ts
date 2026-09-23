// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope, type PitchRateGroup } from "@kbo/contracts";
import { analyzeBatterProfile, analyzePitchLocation } from "@kbo/game-core";
import {
  PitchOutcomeBreakdown,
  PitchRateTable,
} from "../../apps/web/src/analysis/pitch-rate-table.js";
import { outcomeRow } from "../helpers/pitch-outcomes.js";

const query = { season: 2024, competition: "all" as const };
const scope = resolveAnalysisScope(query);
const sourceHash = "a".repeat(64);
const baseGroup = analyzePitchLocation(query, "hp1", scope, sourceHash, [], []).total;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function group(key: string, overrides: Partial<PitchRateGroup> = {}): PitchRateGroup {
  return { ...baseGroup, key, ...overrides };
}

function rowLabels(table: HTMLElement) {
  return within(table)
    .getAllByRole("rowheader")
    .map((header) => header.textContent);
}

it("sorts unrounded rates in both directions, keeps nulls last and preserves source order for ties without mutation", async () => {
  const rows = Object.freeze([
    Object.freeze(
      group("lower", { pitches: 100000, swings: 100000, whiffs: 20001, whiffRate: 0.20001 }),
    ),
    Object.freeze(group("missing-first")),
    Object.freeze(
      group("higher-first", { pitches: 100000, swings: 100000, whiffs: 20004, whiffRate: 0.20004 }),
    ),
    Object.freeze(
      group("higher-second", {
        pitches: 100000,
        swings: 100000,
        whiffs: 20004,
        whiffRate: 0.20004,
      }),
    ),
    Object.freeze(group("missing-second")),
    Object.freeze(group("zero", { pitches: 1, swings: 1, whiffRate: 0 })),
  ]);
  const before = structuredClone(rows);
  const user = userEvent.setup();
  render(createElement(PitchRateTable, { title: "반응 비교", rows }));
  const table = screen.getByRole("table", { name: "반응 비교" });
  expect(within(table).getAllByText("20.0%")).toHaveLength(3);
  expect(rowLabels(table)).toEqual(rows.map((row) => row.key));
  await user.click(within(table).getByRole("button", { name: "Whiff% 내림차순 정렬" }));
  expect(rowLabels(table)).toEqual([
    "higher-first",
    "higher-second",
    "lower",
    "zero",
    "missing-first",
    "missing-second",
  ]);
  expect(
    within(table)
      .getByRole("columnheader", { name: /Whiff%/ })
      .getAttribute("aria-sort"),
  ).toBe("descending");
  await user.click(within(table).getByRole("button", { name: "Whiff% 오름차순 정렬" }));
  expect(rowLabels(table)).toEqual([
    "zero",
    "lower",
    "higher-first",
    "higher-second",
    "missing-first",
    "missing-second",
  ]);
  expect(
    within(table)
      .getByRole("columnheader", { name: /Whiff%/ })
      .getAttribute("aria-sort"),
  ).toBe("ascending");
  expect(rows).toEqual(before);
});

it("sorts formatted counts numerically and starts a newly selected column in descending order", async () => {
  const user = userEvent.setup();
  render(
    createElement(PitchRateTable, {
      title: "투구 비교",
      rows: [
        group("two", { pitches: 2, swingRate: 0.8 }),
        group("thousand", { pitches: 1200, swingRate: 0.2 }),
        group("twelve", { pitches: 12, swingRate: 0.5 }),
      ],
    }),
  );
  const table = screen.getByRole("table", { name: "투구 비교" });
  expect(within(table).getByText("1,200")).toBeTruthy();
  await user.click(within(table).getByRole("button", { name: "투구 내림차순 정렬" }));
  expect(rowLabels(table)).toEqual(["thousand", "twelve", "two"]);
  await user.click(within(table).getByRole("button", { name: "투구 오름차순 정렬" }));
  expect(rowLabels(table)).toEqual(["two", "twelve", "thousand"]);
  await user.click(within(table).getByRole("button", { name: "Swing% 내림차순 정렬" }));
  expect(rowLabels(table)).toEqual(["two", "twelve", "thousand"]);
  expect(
    within(table)
      .getByRole("columnheader", { name: /Swing%/ })
      .getAttribute("aria-sort"),
  ).toBe("descending");
  expect(within(table).getByRole("columnheader", { name: /투구/ }).getAttribute("aria-sort")).toBe(
    "none",
  );
});

it("supports keyboard sorting and a native metric guide containing the currently visible denominators", async () => {
  const user = userEvent.setup();
  render(
    createElement(PitchRateTable, {
      title: "키보드 비교",
      rows: [group("smaller", { pitches: 1 }), group("larger", { pitches: 2 })],
    }),
  );
  const table = screen.getByRole("table", { name: "키보드 비교" });
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "상세 지표" }));
  await user.tab();
  expect(document.activeElement).toBe(table.parentElement);
  await user.tab();
  expect(document.activeElement).toBe(
    within(table).getByRole("button", { name: "투구 내림차순 정렬" }),
  );
  await user.keyboard("{Enter}");
  expect(rowLabels(table)).toEqual(["larger", "smaller"]);
  await user.keyboard(" ");
  expect(rowLabels(table)).toEqual(["smaller", "larger"]);

  const guide = screen.getByText("지표 안내");
  const details = guide.closest("details");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("Missing metric disclosure");
  expect(details.open).toBe(false);
  guide.focus();
  expect(document.activeElement).toBe(guide);
  expect(guide.tagName).toBe("SUMMARY");
  // JSDOM does not emulate the native summary keyboard action.
  await user.click(guide);
  expect(details.open).toBe(true);
  expect(within(details).getByText("헛스윙 수 / 스윙 수.")).toBeTruthy();
  expect(within(details).queryByText("Contact%")).toBeNull();
  expect(within(details).getAllByRole("term")).toHaveLength(6);
  await user.click(screen.getByRole("button", { name: "상세 지표" }));
  expect(within(table).getAllByRole("columnheader")).toHaveLength(18);
  expect(within(details).getAllByRole("term")).toHaveLength(17);
  expect(within(details).getByText(/공식 타율과 분모가 다릅니다/)).toBeTruthy();
});

it("clears sorting by a detailed-only metric when its column is hidden", async () => {
  const user = userEvent.setup();
  render(
    createElement(PitchRateTable, {
      title: "상세 정렬",
      rows: [
        group("more-whiffs", { whiffRate: 0.8 }),
        group("less-whiffs", { whiffRate: 0.2 }),
        group("no-swings"),
      ],
    }),
  );
  const table = screen.getByRole("table", { name: "상세 정렬" });
  const detail = screen.getByRole("button", { name: "상세 지표" });
  await user.click(detail);
  await user.click(within(table).getByRole("button", { name: "Contact% 내림차순 정렬" }));
  expect(rowLabels(table)).toEqual(["less-whiffs", "more-whiffs", "no-swings"]);
  await user.click(detail);
  expect(within(table).getAllByRole("columnheader")).toHaveLength(7);
  expect(rowLabels(table)).toEqual(["more-whiffs", "less-whiffs", "no-swings"]);
  expect(table.querySelectorAll('[aria-sort="ascending"], [aria-sort="descending"]')).toHaveLength(
    0,
  );
});

it("retains the local sort across comparison groups and uses each group's rows without a request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const data = analyzeBatterProfile(query, "b1", scope, sourceHash, [outcomeRow()], []);
  data.byType = [group("직구", { pitches: 10 }), group("슬라이더", { pitches: 20 })];
  data.byCount = [group("0-0", { pitches: 15 }), group("1-0", { pitches: 5 })];
  data.bySpeed = [group("below-140", { pitches: 7 }), group("above-140", { pitches: 23 })];
  const before = structuredClone(data);
  const user = userEvent.setup();
  render(createElement(PitchOutcomeBreakdown, { data }));
  await user.click(screen.getByRole("button", { name: "투구 내림차순 정렬" }));
  expect(rowLabels(screen.getByRole("table", { name: "구종별 반응" }))).toEqual([
    "슬라이더",
    "직구",
  ]);
  const choices = screen.getByRole("group", { name: "비교 기준" });
  await user.click(within(choices).getByRole("button", { name: "카운트별" }));
  const count = screen.getByRole("table", { name: "카운트별 반응" });
  expect(screen.queryByRole("table", { name: "구종별 반응" })).toBeNull();
  expect(rowLabels(count)).toEqual(["0-0", "1-0"]);
  await user.click(within(count).getByRole("button", { name: "투구 오름차순 정렬" }));
  expect(rowLabels(count)).toEqual(["1-0", "0-0"]);
  await user.click(within(choices).getByRole("button", { name: "구속대별" }));
  const speed = screen.getByRole("table", { name: "구속대별 반응" });
  expect(rowLabels(speed)).toEqual(["below-140", "above-140"]);
  expect(within(speed).getByRole("columnheader", { name: /투구/ }).getAttribute("aria-sort")).toBe(
    "ascending",
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(data).toEqual(before);
});
