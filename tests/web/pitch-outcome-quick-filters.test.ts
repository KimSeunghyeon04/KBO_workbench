// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PitchOutcomeQuickFilters } from "../../apps/web/src/analysis/pitch-outcome-quick-filters.js";

afterEach(() => cleanup());

const base =
  "season=2024&competition=regular&dateFrom=2024-05-01&dateTo=2024-05-31&pitcher=p1&batter=b1&extra=first&extra=second";

function show(search = base) {
  const params = new URLSearchParams(search);
  const onChange = vi.fn<(next: URLSearchParams) => void>();
  const view = render(createElement(PitchOutcomeQuickFilters, { params, onChange }));
  return { params, onChange, view };
}

function changed(onChange: ReturnType<typeof show>["onChange"]) {
  expect(onChange).toHaveBeenCalledTimes(1);
  const next = onChange.mock.calls[0]?.[0];
  if (next === undefined) throw new Error("Missing changed URL parameters");
  return next;
}

it.each([
  ["전체 타석", "stance=R", []],
  ["좌타자", "stance=R", [["stance", "L"]]],
  ["우타자", "stance=L", [["stance", "R"]]],
] as const)(
  "changes %s without mutating the URL or other conditions",
  (label, initial, expected) => {
    const { params, onChange } = show(
      `${base}&${initial}&balls=0&pitchType=직구&cohort=discipline`,
    );
    const before = params.toString();
    fireEvent.click(
      within(screen.getByRole("group", { name: "타석 바로 선택" })).getByRole("button", {
        name: label,
      }),
    );
    const next = changed(onChange);
    const wanted = new URLSearchParams(params);
    if (expected.length === 0) wanted.delete("stance");
    for (const [key, value] of expected) wanted.set(key, value);
    expect([...next]).toEqual([...wanted]);
    expect(next).not.toBe(params);
    expect(params.toString()).toBe(before);
  },
);

it.each([
  ["전체 카운트", null, null],
  ["초구", "0", "0"],
  ["2스트라이크", null, "2"],
] as const)(
  "applies %s atomically while preserving scope and player identity",
  (label, balls, strikes) => {
    const { params, onChange } = show(
      `${base}&balls=3&strikes=1&stance=L&pitchType=슬라이더&cohort=discipline`,
    );
    const before = params.toString();
    fireEvent.click(
      within(screen.getByRole("group", { name: "카운트 바로 선택" })).getByRole("button", {
        name: label,
      }),
    );
    const next = changed(onChange);
    expect(next.get("balls")).toBe(balls);
    expect(next.get("strikes")).toBe(strikes);
    const retained = new URLSearchParams(next);
    retained.delete("balls");
    retained.delete("strikes");
    const original = new URLSearchParams(params);
    original.delete("balls");
    original.delete("strikes");
    expect([...retained]).toEqual([...original]);
    expect(params.toString()).toBe(before);
  },
);

it.each([
  ["", "전체 카운트"],
  ["balls=0&strikes=0", "초구"],
  ["strikes=2", "2스트라이크"],
  ["balls=0&strikes=2", null],
  ["balls=1&strikes=2", null],
  ["balls=3", null],
  ["strikes=0", null],
] as const)("accurately marks the preset for %s", (query, selected) => {
  show(`${base}&${query}`);
  const group = screen.getByRole("group", { name: "카운트 바로 선택" });
  for (const button of within(group).getAllByRole("button"))
    expect(button.getAttribute("aria-pressed")).toBe(String(button.textContent === selected));
});

it.each([
  ["pitchType", "구종: 슬라이더 조건 해제"],
  ["stance", "좌타자 조건 해제"],
  ["balls", "0볼 조건 해제"],
  ["strikes", "0스트라이크 조건 해제"],
  ["cohort", "선구안 표본 조건 해제"],
] as const)("removes only the %s chip, including zero-valued count conditions", (key, label) => {
  const { params, onChange } = show(
    `${base}&pitchType=슬라이더&stance=L&balls=0&strikes=0&cohort=discipline`,
  );
  const before = params.toString();
  fireEvent.click(screen.getByRole("button", { name: label }));
  const next = changed(onChange);
  const wanted = new URLSearchParams(params);
  wanted.delete(key);
  expect([...next]).toEqual([...wanted]);
  expect(params.toString()).toBe(before);
});

it("resets only feature conditions and preserves unrelated repeated URL parameters", () => {
  const { params, onChange } = show(
    `${base}&pitchType=슬라이더&stance=S&balls=0&strikes=2&cohort=discipline`,
  );
  const before = params.toString();
  expect(screen.getByRole("button", { name: "스위치 타석 조건 해제" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "상황 조건 초기화" }));
  expect([...changed(onChange)]).toEqual([...new URLSearchParams(base)]);
  expect(params.toString()).toBe(before);
});

it("reads pressed states from parent URL changes and supports native keyboard activation", async () => {
  const { params, onChange, view } = show();
  expect(screen.getByRole("button", { name: "상황 조건 초기화" })).toHaveProperty("disabled", true);
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "전체 타석" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "좌타자", exact: true }));
  await user.keyboard("{Enter}");
  const next = changed(onChange);
  expect(next.get("stance")).toBe("L");
  expect(params.has("stance")).toBe(false);
  expect(
    screen.getByRole("button", { name: "좌타자", exact: true }).getAttribute("aria-pressed"),
  ).toBe("false");
  view.rerender(createElement(PitchOutcomeQuickFilters, { params: next, onChange }));
  expect(
    screen.getByRole("button", { name: "좌타자", exact: true }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: "전체 타석" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
});
