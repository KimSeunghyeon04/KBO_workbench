// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PitchArsenalGroup } from "@kbo/contracts";
import { PitchArsenalPanel } from "../../apps/web/src/analysis/pitch-arsenal-panel.js";

afterEach(cleanup);
function group(
  stance: string | null,
  balls = 0,
  strikes = 0,
  types: [string | null, number][] = [
    ["직구", 6],
    ["슬라이더", 4],
  ],
): PitchArsenalGroup {
  const pitches = types.reduce((sum, [, count]) => sum + count, 0);
  return {
    stance,
    balls,
    strikes,
    pitches,
    types: types.map(([pitchType, count]) => ({
      pitchType,
      pitches: count,
      usageRate: count / pitches,
    })),
  };
}
function show(groups: PitchArsenalGroup[], onSelect = vi.fn()) {
  const view = render(createElement(PitchArsenalPanel, { groups, onSelect }));
  return { ...view, onSelect };
}
it("selects a count state and shows both sides using server rates, then drills into the original group", () => {
  const selected = group("R", 2, 1, [
    ["체인지업", 3],
    ["직구", 1],
  ]);
  const { onSelect } = show([group("L"), group("R"), selected]);
  const board = screen.getByRole("group", { name: "볼카운트 상태 선택" });
  expect(within(board).getAllByRole("button")).toHaveLength(12);
  expect(
    within(board)
      .getByRole("button", { name: /^0볼 0스트라이크/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(within(board).getByRole("button", { name: /^2볼 1스트라이크/ }));
  expect(screen.getByRole("heading", { name: "2–1 카운트의 구종 선택" })).toBeTruthy();
  const right = screen.getByRole("region", { name: "우타자 선택 카운트 구종 배합" });
  expect(within(right).getByText("3/4구")).toBeTruthy();
  expect(within(right).getByText("75.0%")).toBeTruthy();
  expect(screen.getByText("이 방향·카운트에서 관측된 투구가 없습니다.")).toBeTruthy();
  fireEvent.click(
    within(right).getByRole("button", { name: "우타자 2볼 1스트라이크 체인지업 코스 보기" }),
  );
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(selected, "체인지업");
});
it("keeps missing direction and S records separate without assigning them to L/R", () => {
  const { onSelect } = show([
    group("L"),
    group(null, 1, 0, [["직구", 1]]),
    group("S", 0, 2, [["슬라이더", 2]]),
  ]);
  const disclosure = screen.getByText("좌·우로 분류하지 않은 기록").closest("details");
  if (!(disclosure instanceof HTMLDetailsElement))
    throw new Error("Missing unclassified disclosure");
  expect(disclosure.open).toBe(false);
  fireEvent.click(screen.getByText("좌·우로 분류하지 않은 기록"));
  const table = screen.getByRole("table", { name: "좌우 미분류 구종 배합" });
  expect(within(table).getByText("타석 방향 미확인")).toBeTruthy();
  expect(within(table).getByText("양타석 표기")).toBeTruthy();
  expect(within(table).getByText("1/1구")).toBeTruthy();
  expect(screen.getByText(/같은 경기의 선수 프로필에 명시된 좌타·우타로 보완/)).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "좌타자 선택 카운트 구종 배합" }).textContent,
  ).toContain("10구");
  expect(
    screen.getByRole("region", { name: "우타자 선택 카운트 구종 배합" }).textContent,
  ).toContain("투구 없음");
  fireEvent.click(within(table).getByRole("button", { name: "슬라이더 코스 보기" }));
  expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ stance: "S", strikes: 2 });
});
it("does not invent a known-side state or action for unknown-only data", () => {
  show([group(null, 0, 0, [[null, 1]])]);
  expect(screen.queryByRole("group", { name: "볼카운트 상태 선택" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain(
    "좌·우타석 방향이 확인된 투구가 없습니다",
  );
  fireEvent.click(screen.getByText("좌·우로 분류하지 않은 기록"));
  expect(screen.getByRole("table", { name: "좌우 미분류 구종 배합" }).textContent).toContain(
    "구종 미상",
  );
  expect(screen.queryByRole("button")).toBeNull();
});
it("distinguishes the six provider pitch colors and shows ties truthfully", () => {
  const types: [string, number][] = ["직구", "슬라이더", "체인지업", "커브", "커터", "투심"].map(
    (type) => [type, 1],
  );
  show([group("L", 0, 0, types)]);
  const legend = screen.getByRole("list", { name: "구종 색상" });
  const colors = within(legend)
    .getAllByRole("listitem")
    .map((item) => item.querySelector("i")?.style.background);
  expect(new Set(colors).size).toBe(6);
  expect(screen.getAllByText(/공동 최다/).length).toBeGreaterThan(0);
});
it("falls back to an available state after filters change without mutating the cached groups", () => {
  const a = group("L"),
    b = group("R", 3, 2);
  Object.freeze(a.types);
  Object.freeze(a);
  const view = show([a, b]);
  fireEvent.click(screen.getByRole("button", { name: /^3볼 2스트라이크/ }));
  const c = group("R", 1, 1);
  view.rerender(createElement(PitchArsenalPanel, { groups: [c], onSelect: view.onSelect }));
  expect(
    screen.getByRole("button", { name: /^1볼 1스트라이크/ }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByRole("heading", { name: "1–1 카운트의 구종 선택" })).toBeTruthy();
});
