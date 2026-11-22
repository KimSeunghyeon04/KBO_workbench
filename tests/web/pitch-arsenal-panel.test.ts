// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { analyzePitchCountFlow } from "@kbo/game-core";
import { pitchOutcomeScope } from "@kbo/contracts";
import { PitchArsenalPanel } from "../../apps/web/src/analysis/pitch-arsenal-panel.js";
import { countFlowRow } from "../helpers/pitch-outcomes.js";

afterEach(cleanup);
const query = { season: 2024 };
const scope = pitchOutcomeScope(query);
const slider = { pitchType: "슬라이더", stance: "L" };
function show() {
  const data = analyzePitchCountFlow(query, "hp1", scope, "a".repeat(64), [
    countFlowRow({
      ...slider,
      pitchId: "l0",
      balls: 0,
      strikes: 0,
      afterBalls: 1,
      afterStrikes: 0,
      pitchCall: "ball",
    }),
    countFlowRow({
      pitchType: "직구",
      stance: "L",
      pitchId: "l1",
      balls: 0,
      strikes: 0,
      afterBalls: 0,
      afterStrikes: 1,
    }),
    countFlowRow({
      ...slider,
      pitchId: "r0",
      stance: "R",
      balls: 0,
      strikes: 0,
      afterBalls: 0,
      afterStrikes: 1,
    }),
    countFlowRow({
      ...slider,
      pitchId: "lf",
      balls: 3,
      strikes: 2,
      afterBalls: 3,
      afterStrikes: 2,
      pitchCall: "foul",
    }),
    countFlowRow({
      ...slider,
      pitchId: "rf",
      terminalResult: "strikeout",
      stance: "R",
      balls: 3,
      strikes: 2,
      afterBalls: 3,
      afterStrikes: 3,
    }),
    countFlowRow({
      ...slider,
      pitchId: "uf",
      terminalResult: "walk",
      stance: null,
      balls: 3,
      strikes: 2,
      afterBalls: 4,
      afterStrikes: 2,
      pitchCall: "ball",
    }),
  ]);
  const onSelect = vi.fn();
  const view = render(createElement(PitchArsenalPanel, { groups: data.groups, onSelect }));
  const left = screen.getByRole("figure", { name: "좌타자 상대" });
  const right = screen.getByRole("figure", { name: "우타자 상대" });
  return { view, onSelect, left, right };
}
function rate(tree: HTMLElement, from: string, outcome: string) {
  return tree.querySelector(`[data-from="${from}"][data-outcome="${outcome}"] .pitch-flow-rate`)
    ?.textContent;
}

it("applies the chosen pitch at every count and pools the actual observations in the overall view", () => {
  const { left, right, onSelect } = show();
  expect(rate(left, "0–0", "ball")).toBe("50.0%");
  const full = within(left).getByRole("button", { name: "좌타자 상대 3볼 2스트라이크 구종 비중" });
  fireEvent.click(full);
  fireEvent.click(within(left).getByRole("button", { name: /슬라이더 100.0%/ }));
  expect(rate(left, "0–0", "ball")).toBe("100.0%");
  expect(rate(right, "0–0", "ball")).toBe("0.0%");
  expect(rate(left, "3–2", "foul")).toBe("100.0%");
  expect(rate(right, "3–2", "strikeout")).toBe("100.0%");
  expect(rate(right, "3–2", "walk")).toBe("0.0%");
  expect(rate(right, "2–2", "strikeout")).toBe("—");
  fireEvent.click(screen.getByRole("button", { name: "좌타자 상대 코스 보기" }));
  expect(onSelect).toHaveBeenCalledWith({ stance: "L", balls: 3, strikes: 2 }, "슬라이더");
  fireEvent.click(screen.getByRole("button", { name: "전체", exact: true }));
  const all = screen.getByRole("figure", { name: "전체 타자" });
  expect(screen.getAllByRole("figure")).toHaveLength(1);
  expect(rate(all, "3–2", "walk")).toBe("33.3%");
  expect(rate(all, "3–2", "strikeout")).toBe("33.3%");
  expect(rate(all, "3–2", "foul")).toBe("33.3%");
  expect(rate(all, "0–0", "ball")).toBe("50.0%");
});

it("opens every available pitch at the expanded node and keeps filtering until another pitch is chosen", () => {
  const { left } = show();
  const start = within(left).getByRole("button", { name: "좌타자 상대 0볼 0스트라이크 구종 비중" });
  fireEvent.click(start);
  fireEvent.click(within(left).getByRole("button", { name: /슬라이더 50.0%/ }));
  expect(start.querySelectorAll(".pitch-flow-dim")).toHaveLength(1);
  expect(start.getAttribute("aria-expanded")).toBe("false");
  fireEvent.pointerOver(start);
  expect(start.getAttribute("aria-expanded")).toBe("true");
  expect(rate(left, "0–0", "ball")).toBe("100.0%");
  const fastball = start.querySelector('[data-pitch-index="1"]');
  if (fastball === null) throw new Error("Missing fastball slice");
  fireEvent.click(fastball);
  expect(rate(left, "0–0", "ball")).toBe("0.0%");
  expect(rate(left, "3–2", "foul")).toBe("—");
  fireEvent.click(screen.getByRole("button", { name: "전체 구종으로" }));
  expect(start.querySelectorAll(".pitch-flow-dim")).toHaveLength(0);
  expect(rate(left, "0–0", "ball")).toBe("50.0%");
});

it("dismisses hover as soon as the pointer leaves the count and keeps activated pickers open", () => {
  const { left } = show();
  const start = within(left).getByRole("button", { name: "좌타자 상대 0볼 0스트라이크 구종 비중" });
  const center = within(left).getByRole("button", {
    name: "좌타자 상대 0볼 0스트라이크 전체 구종 상세",
  });
  const canvas = left.querySelector(".pitch-flow-canvas");
  fireEvent.pointerOver(start);
  expect(left.querySelector(".pitch-flow-picker")?.hasAttribute("inert")).toBe(true);
  fireEvent(start, new MouseEvent("pointerout", { relatedTarget: center, bubbles: true }));
  expect(start.getAttribute("aria-expanded")).toBe("true");
  fireEvent(center, new MouseEvent("pointerout", { relatedTarget: canvas, bubbles: true }));
  expect(start.getAttribute("aria-expanded")).toBe("false");
  expect(left.querySelector(".pitch-flow-picker")).toBeNull();

  fireEvent.click(start);
  fireEvent(start, new MouseEvent("pointerout", { relatedTarget: canvas, bubbles: true }));
  expect(start.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(within(left).getByRole("button", { name: /슬라이더 50.0%/ }));
});

it("selects another count across all pitches from its center with the pitch picker open", () => {
  const { left, right, onSelect } = show();
  const full = within(right).getByRole("button", { name: "우타자 상대 3볼 2스트라이크 구종 비중" });
  fireEvent.click(full);
  fireEvent.click(within(right).getByRole("button", { name: /슬라이더 100.0%/ }));
  const start = within(left).getByRole("button", { name: "좌타자 상대 0볼 0스트라이크 구종 비중" });
  fireEvent.pointerOver(start);
  expect(screen.getByRole("heading", { name: "3–2 · 슬라이더 한 공 뒤" })).toBeTruthy();
  const picks = left.querySelector(".pitch-flow-picker");
  expect(picks?.querySelectorAll("button")).toHaveLength(2);
  const center = within(left).getByRole("button", {
    name: "좌타자 상대 0볼 0스트라이크 전체 구종 상세",
  });
  fireEvent.click(center);

  expect(screen.getByRole("heading", { name: "0–0 · 전체 구종 한 공 뒤" })).toBeTruthy();
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "상세 카운트" }).value).toBe("0");
  const details = screen.getByRole("table", { name: "선택 카운트의 한 공 뒤 결과" });
  expect(within(details).getByRole("columnheader", { name: /좌타자 상대\s*2구/ })).toBeTruthy();
  const ball = within(details).getByRole("row", { name: /1–0 이동/ });
  expect(
    within(ball)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["50.0%", "0.0%"]);
  expect(rate(left, "0–0", "ball")).toBe("50.0%");
  expect(start.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(center);
  expect(onSelect).not.toHaveBeenCalled();
});
