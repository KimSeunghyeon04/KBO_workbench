import { describe, expect, it } from "vitest";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import {
  reconcileEventSelection,
  selectEventRows,
  singleEventSelection,
} from "../../apps/web/src/correction/event-selection.js";
import { makeDocument } from "../helpers/game-document.js";

const events = parseStagingGameDocumentV2(
  makeDocument(
    Array.from({ length: 80 }, () => ({
      kind: "administrative",
      payload: { code: "announcement" },
    })),
  ),
).events;
const selected = (state: ReturnType<typeof singleEventSelection>) =>
  [...state.eventIds].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

describe("원장 ID 기반 다중 선택", () => {
  it("Ctrl로 개별 토글하고 일반 클릭은 단일 선택으로 전환한다", () => {
    let state = singleEventSelection("e2");
    state = selectEventRows(events, state, "e5", { toggle: true });
    expect(selected(state)).toEqual(["e2", "e5"]);
    state = selectEventRows(events, state, "e5", { toggle: true });
    expect(state.activeId).toBe("e2");
    expect(selected(state)).toEqual(["e2"]);
    state = selectEventRows(events, state, "e2", { toggle: true });
    expect(state.activeId).toBeNull();
    expect(state.eventIds.size).toBe(0);
    expect(selected(selectEventRows(events, state, "e7"))).toEqual(["e7"]);
  });
  it("Shift는 고정 anchor부터 양방향으로 선택하며 Ctrl+Shift는 기존 범위와 합친다", () => {
    let state = singleEventSelection("e4");
    state = selectEventRows(events, state, "e8", { range: true });
    expect(selected(state)).toEqual(["e4", "e5", "e6", "e7", "e8"]);
    state = selectEventRows(events, state, "e2", { range: true });
    expect(selected(state)).toEqual(["e2", "e3", "e4"]);
    state = selectEventRows(events, state, "e7", { range: true, toggle: true });
    expect(selected(state)).toEqual(["e2", "e3", "e4", "e5", "e6", "e7"]);
    expect(state.anchorId).toBe("e4");
  });
  it("필터·접기·가상 스크롤에 없는 행도 canonical 범위에서 빠지지 않는다", () => {
    const state = selectEventRows(events, singleEventSelection("e2"), "e70", { range: true });
    expect(state.eventIds.size).toBe(69);
    expect(state.eventIds.has("e35")).toBe(true);
    expect(selectEventRows(events, state, "missing")).toBe(state);
  });
  it("삭제 성공 뒤 인접 생존 행으로 이동하고 이동·undo 후에는 살아 있는 선택을 유지한다", () => {
    const state = selectEventRows(events, singleEventSelection("e2"), "e5", { range: true });
    const remaining = events.filter((event) => !state.eventIds.has(event.identity.eventId));
    expect(reconcileEventSelection(state, events, remaining)).toEqual(singleEventSelection("e6"));
    const moved = [...events.slice(6), ...events.slice(0, 6)];
    expect(selected(reconcileEventSelection(state, events, moved))).toEqual(selected(state));
    expect(reconcileEventSelection(state, events, [])).toEqual(singleEventSelection(null));
    expect(reconcileEventSelection(singleEventSelection(null), events, events)).toEqual(
      singleEventSelection(null),
    );
  });
});
