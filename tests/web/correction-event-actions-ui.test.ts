// @vitest-environment jsdom

import { readFile } from "node:fs/promises";

import {
  parseStagingGameDocumentV2,
  type CorrectionCommand,
  type CorrectionEventContext,
  type CorrectionSession,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { applyCorrectionCommand } from "@kbo/correction";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EventPresentation } from "../../apps/web/src/correction/event-presentation.js";
import { prepareCorrectionSnapshot } from "../../apps/server/src/correction-snapshot.js";
import {
  decodeObservedStateForm,
  observedStateForm,
} from "../../apps/web/src/correction/observed-state-editor.js";
import type { EventCollapseGroup } from "../../apps/web/src/correction/event-collapse.js";
import {
  CorrectionDrawer,
  newCommandId,
  VirtualEventList,
} from "../../apps/web/src/pages/correct-page.js";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});

afterEach(() => cleanup());

describe("평면 원장 빠른 보정 UI", () => {
  it("책임 투수의 실제 이름을 표시하되 문구만 바꾸면 책임을 명시적으로 고정하지 않는다", async () => {
    const document = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile(
          "tests/fixtures/correction/force-double-play-responsibility.anonymized.json",
          "utf8",
        ),
      ) as unknown,
    );
    const target = document.events.find(
      (event) =>
        event.kind === "runner_advance" &&
        event.payload.runnerId === "h3" &&
        event.payload.toBase === 2,
    );
    if (target?.kind !== "runner_advance") throw new Error("missing anonymous runner");
    let submitted: CorrectionCommand | undefined;
    const props = {
      request: { mode: "replace_event" as const, eventId: target.identity.eventId },
      session: {
        ...session(document),
        ...prepareCorrectionSnapshot(document, compileStagingGameDocumentV2(document), []),
      },
      selectedEvent: target,
      pending: false,
      error: null,
      onClose: vi.fn(),
      onApply: (command: CorrectionCommand) => {
        submitted = command;
      },
    };
    render(createElement(CorrectionDrawer, props));
    const picker = screen.getByRole("combobox", { name: "책임 투수 (선택)" });
    expect(picker.textContent).toContain("선수a1 (a1)");
    expect(picker.textContent).not.toContain("자동");
    fireEvent.change(screen.getByRole("textbox", { name: "중계 문구" }), {
      target: { value: "확인한 주자 이동" },
    });
    expect(picker.textContent).toContain("선수a1 (a1)");
    await userEvent.setup().click(screen.getByRole("button", { name: "작업 사본에 즉시 반영" }));
    if (submitted?.kind !== "replace_event" || submitted.event.kind !== "runner_advance")
      throw new Error("missing runner command");
    expect(submitted.event.payload.responsiblePitcherId).toBeUndefined();
    expect(submitted.event.payload).toEqual(target.payload);
    fireEvent.change(screen.getByRole("combobox", { name: "도착" }), { target: { value: "3" } });
    expect(picker.textContent).toContain("반영 후 확인");
    await userEvent.setup().click(picker);
    await userEvent.setup().click(screen.getByRole("option", { name: /선수a51\(a51\)/ }));
    expect(picker.textContent).toContain("선수a51(a51)");
  });

  it("수집 행 문구를 수정해 적용·재열기해도 선수와 이동은 바뀌지 않는다", async () => {
    const document = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile(
          "tests/fixtures/correction/runner-autofill-multistep.anonymized.json",
          "utf8",
        ),
      ) as unknown,
    );
    const target = document.events.find((event) => event.identity.eventId === "wrong-runner");
    if (target === undefined) throw new Error("missing anonymous source runner");
    let submitted: CorrectionCommand | undefined;
    const props = {
      request: { mode: "replace_event" as const, eventId: target.identity.eventId },
      session: session(document),
      selectedEvent: target,
      pending: false,
      error: null,
      onClose: vi.fn(),
      onApply: (command: CorrectionCommand) => {
        submitted = command;
      },
    };
    const view = render(createElement(CorrectionDrawer, props));
    const relayText = "3루주자 a2 : 수동 확인한 홈인 문구";
    fireEvent.change(screen.getByRole("textbox", { name: "중계 문구" }), {
      target: { value: relayText },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "작업 사본에 즉시 반영" }));
    if (submitted === undefined) throw new Error("missing correction command");
    const corrected = applyCorrectionCommand(document, submitted);
    const edited = corrected.document.events.find(
      (event) => event.identity.eventId === target.identity.eventId,
    );
    expect(edited).toEqual({ ...target, relayText });
    const before = compileStagingGameDocumentV2(document);
    expect(corrected.replay.finalState).toEqual(before.finalState);
    expect(corrected.replay.findings).toEqual(before.findings);
    expect(corrected.replay.pitcherLines).toEqual(before.pitcherLines);
    expect(corrected.replay.batterLines).toEqual(before.batterLines);
    view.unmount();
    render(
      createElement(CorrectionDrawer, {
        ...props,
        session: session(corrected.document),
        selectedEvent: edited,
      }),
    );
    expect((screen.getByRole("textbox", { name: "중계 문구" }) as HTMLTextAreaElement).value).toBe(
      relayText,
    );
    expect(document.events[target.sequence]?.relayText).toBe(target.relayText);
  });
  it.each(["player-first", "base-first"])(
    "같은 플레이의 2루→3루→홈 교정은 선택 순서(%s)에 관계없이 선수·출발을 보존한다",
    async (order) => {
      // 검토 경기의 주자 이동 순서와 잘못 선택된 선수를 비식별 축약한 사본이다.
      const document = parseStagingGameDocumentV2(
        JSON.parse(
          await readFile(
            "tests/fixtures/correction/runner-autofill-multistep.anonymized.json",
            "utf8",
          ),
        ) as unknown,
      );
      const originalHash = stagingDocumentHash(document);
      const target = document.events.find((event) => event.identity.eventId === "wrong-runner");
      if (target?.kind !== "runner_advance") throw new Error("missing anonymous runner");
      const compiled = compileStagingGameDocumentV2(document);
      expect(
        compiled.findings.some((finding) => finding.code === "movement_origin_duplicated"),
      ).toBe(true);
      const before = correctionState({
        bases: ["a4", "a2", "a1"],
        batterId: "a5",
        pitcherId: "hp1",
        outs: 1,
      });
      let submitted: CorrectionCommand | undefined;
      const props = {
        request: { mode: "replace_event" as const, eventId: target.identity.eventId },
        session: session(document, [
          { eventId: "play-result", applied: false, before, after: before },
          { eventId: target.identity.eventId, applied: false, before, after: before },
        ]),
        selectedEvent: target,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply: (command: CorrectionCommand) => {
          submitted = command;
        },
      };
      const view = render(createElement(CorrectionDrawer, props));
      const user = userEvent.setup();
      const selectRunner = async () => {
        await user.click(screen.getByRole("combobox", { name: "주자" }));
        await user.click(screen.getByRole("option", { name: /a2\(a2\)/ }));
      };
      const selectBase = async () => {
        await user.selectOptions(screen.getByRole("combobox", { name: "출발" }), "2");
        await user.selectOptions(screen.getByRole("combobox", { name: "출발" }), "3");
      };
      if (order === "player-first") {
        await selectRunner();
        await selectBase();
      } else {
        await selectBase();
        await selectRunner();
      }
      view.rerender(createElement(CorrectionDrawer, props));
      expect(screen.getByRole("combobox", { name: "주자" }).textContent).toContain("a2(a2)");
      expect((screen.getByRole("combobox", { name: "출발" }) as HTMLSelectElement).value).toBe("3");
      await user.click(screen.getByRole("button", { name: "작업 사본에 즉시 반영" }));
      if (submitted === undefined) throw new Error("missing correction command");
      expect(submitted).toMatchObject({
        kind: "replace_event",
        event: {
          payload: {
            runnerId: "a2",
            fromBase: 3,
            toBase: 4,
            outcome: "scored",
            context: { kind: "plate_result", plateResultEventId: "play-result" },
          },
        },
      });
      const corrected = applyCorrectionCommand(document, submitted);
      expect(
        corrected.replay.findings.filter((finding) => finding.severity === "blocking"),
      ).toEqual([]);
      expect(corrected.replay.finalState).toMatchObject({
        awayScore: 2,
        homeScore: 0,
        bases: [null, { runnerId: "a5" }, { runnerId: "a4" }],
      });
      expect(stagingDocumentHash(document)).toBe(originalHash);
      expect(
        corrected.document.events.find(
          (event) => event.identity.eventId === target.identity.eventId,
        ),
      ).toMatchObject({
        identity: target.identity,
        relayText: target.relayText,
        observedStateAfter: target.observedStateAfter,
      });
    },
  );
  it("관측값만 변경하면 원장 내용을 교체하지 않고 다른 관측은 보존한다", async () => {
    const document = fixture();
    const pitch = {
      ...pitchEvent("e3", 3, "in_play", "2구 타격"),
      observedStateAfter: { balls: 1, strikes: 1, bases: [false, null, true] as const },
    };
    const onApply = vi.fn<(command: CorrectionCommand) => void>();
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: "e3" },
        session: session(document),
        selectedEvent: pitch,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply,
      }),
    );
    await userEvent.setup().click(screen.getByText("관측값 수정 (검증용)"));
    expect(screen.getByLabelText("관측 볼").getAttribute("value")).toBe("1");
    expect(screen.getByLabelText("관측 아웃").getAttribute("value")).toBe("");
    fireEvent.change(screen.getByLabelText("관측 볼"), { target: { value: "0" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "작업 사본에 즉시 반영" }));
    expect(onApply).toHaveBeenCalledWith({
      commandId: expect.any(String),
      kind: "update_observed_state",
      eventId: "e3",
      observedStateAfter: { balls: 0, strikes: 1, bases: [false, null, true] },
    });
    fireEvent.change(screen.getByLabelText("중계 문구"), { target: { value: "2구 타격 확인" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "작업 사본에 즉시 반영" }));
    expect(onApply).toHaveBeenLastCalledWith({
      commandId: expect.any(String),
      kind: "correction_batch",
      commands: [
        expect.objectContaining({ kind: "replace_event", eventId: "e3" }),
        expect.objectContaining({ kind: "update_observed_state", eventId: "e3" }),
      ],
    });
  });

  it("관측값 편집은 잘못된 입력·전송 중 편집을 막고 변경 폐기 확인을 제공한다", async () => {
    const document = fixture();
    const pitch = {
      ...pitchEvent("e3", 3, "in_play", "2구 타격"),
      observedStateAfter: { balls: 1 },
    };
    const props = {
      request: { mode: "replace_event" as const, eventId: "e3" },
      session: session(document),
      selectedEvent: pitch,
      pending: false,
      error: null,
      onClose: vi.fn(),
      onApply: vi.fn(),
    };
    const view = render(createElement(CorrectionDrawer, props));
    await userEvent.setup().click(screen.getByText("관측값 수정 (검증용)"));
    fireEvent.change(screen.getByLabelText("관측 볼"), { target: { value: "-1" } });
    expect(screen.getByText("관측 볼은 0 이상의 정수로 입력하세요.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "작업 사본에 즉시 반영" }).hasAttribute("disabled"),
    ).toBe(true);
    await userEvent.setup().click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByRole("alert").textContent).toContain("입력 중인 변경을 버릴까요?");
    expect(props.onClose).not.toHaveBeenCalled();
    view.rerender(createElement(CorrectionDrawer, { ...props, pending: true }));
    expect(screen.getByLabelText("관측 볼").matches(":disabled")).toBe(true);
  });

  it("관측 베이스는 선수·점유·없음·미관측을 구분하고 원문의 false/null을 유지한다", () => {
    const original = { balls: 0, bases: [false, null, "a1"] as const };
    const form = observedStateForm(original);
    expect(decodeObservedStateForm(form, original)).toEqual({ value: original, error: null });
    expect(
      decodeObservedStateForm({ ...form, bases: ["player:a2", "occupied", "empty"] }, original),
    ).toEqual({ value: { balls: 0, bases: ["a2", true, false] }, error: null });
    expect(
      decodeObservedStateForm(
        { ...form, numbers: { ...form.numbers, balls: "" }, bases: null },
        original,
      ),
    ).toEqual({ value: {}, error: null });
  });
  it("secure context가 아니어도 보정 명령 ID를 생성한다", () => {
    const source = {
      getRandomValues: <T extends ArrayBufferView>(array: T): T => {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xab);
        return array;
      },
    };
    expect(newCommandId(source)).toBe("cmd-abababab-abab-4bab-abab-abababababab");
  });

  it("원장 각 행에 수정·이동·삭제·더보기 작업을 제공한다", async () => {
    const canonicalEvents = [event("e1", 0), event("e2", 1), event("e3", 2)];
    const actions = vi.fn();
    const view = render(
      createElement(VirtualEventList, {
        rows: canonicalEvents.map((value) => ({
          kind: "event" as const,
          key: value.identity.eventId,
          presentation: presentation(value),
        })),
        canonicalEvents,
        selectedEventId: "e1",
        disabled: false,
        onSelect: vi.fn(),
        onAction: actions,
      }),
    );
    const rows = screen.getAllByRole("listitem");
    const firstButtons = within(rows[0] as HTMLElement).getAllByRole("button");
    const secondButtons = within(rows[1] as HTMLElement).getAllByRole("button");
    expect(firstButtons).toHaveLength(6);
    expect((firstButtons[2] as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(secondButtons[3] as HTMLElement);
    expect(actions).toHaveBeenCalledWith("e2", "move_down");
    const list = view.container.querySelector(".virtual-event-list");
    if (!(list instanceof HTMLElement)) throw new Error("virtual list missing");
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 500));
    vi.spyOn(secondButtons[5] as HTMLElement, "getBoundingClientRect").mockReturnValue(
      rect(424, 450),
    );
    await userEvent.setup().click(secondButtons[5] as HTMLElement);
    expect(view.container.querySelector('[role="menu"]')?.classList.contains("opens-upward")).toBe(
      true,
    );
    expect(screen.getByRole("menuitem", { name: "앞에 행 추가" })).toBe(document.activeElement);
    fireEvent.scroll(list, { target: { scrollTop: 1 } });
    expect(view.container.querySelector('[role="menu"]')).not.toBeNull();
    await userEvent.setup().keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "뒤에 행 추가" })).toBe(document.activeElement);
    await userEvent.setup().keyboard("{Escape}");
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    expect(secondButtons[5]).toBe(document.activeElement);
  });

  it("필터 결과가 비면 명시적인 빈 상태를 표시한다", () => {
    render(
      createElement(VirtualEventList, {
        rows: [],
        canonicalEvents: [event("e1", 0)],
        selectedEventId: null,
        disabled: false,
        onSelect: vi.fn(),
        onAction: vi.fn(),
      }),
    );
    expect(screen.getByText("조건에 맞는 원장 행이 없습니다.")).toBeTruthy();
  });

  it("이닝·타석 헤더에서 접기 상태와 숨긴 행 수를 키보드 버튼으로 전달한다", async () => {
    const canonicalEvents = [event("half-1", 0), pitchEvent("pitch-1", 1, "ball", "1구 볼")];
    const rows = canonicalEvents.map((value) => ({
      kind: "event" as const,
      key: value.identity.eventId,
      presentation: presentation(value),
    }));
    const group: EventCollapseGroup = {
      eventId: "half-1",
      kind: "inning",
      label: "1회초",
      childCount: 1,
    };
    const onToggleCollapse = vi.fn();
    const onSelect = vi.fn();
    const view = render(
      createElement(VirtualEventList, {
        rows,
        canonicalEvents,
        selectedEventId: "pitch-1",
        disabled: false,
        collapseGroups: new Map([["half-1", [group]]]),
        collapsedInningEventIds: new Set<string>(),
        onSelect,
        onAction: vi.fn(),
        onToggleCollapse,
      }),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "1회초 이닝 접기" }));
    expect(onSelect).toHaveBeenLastCalledWith("half-1");
    expect(onToggleCollapse).toHaveBeenCalledWith("inning", "half-1");

    view.rerender(
      createElement(VirtualEventList, {
        rows: rows.slice(0, 1),
        canonicalEvents,
        selectedEventId: null,
        disabled: false,
        collapseGroups: new Map([["half-1", [group]]]),
        collapsedInningEventIds: new Set(["half-1"]),
        onSelect,
        onAction: vi.fn(),
        onToggleCollapse,
      }),
    );
    const expand = screen.getByRole("button", { name: "1회초 이닝 펼치기" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText(/아래 1행 접힘/)).toBeTruthy();
    expand.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("half-1");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onToggleCollapse).toHaveBeenLastCalledWith("inning", "half-1");
  });

  it("큰 원장은 보이는 구간만 DOM에 렌더링한다", () => {
    const canonicalEvents = Array.from({ length: 1_000 }, (_, index) =>
      event(`e${String(index)}`, index),
    );
    const view = render(
      createElement(VirtualEventList, {
        rows: canonicalEvents.map((value) => ({
          kind: "event" as const,
          key: value.identity.eventId,
          presentation: presentation(value),
        })),
        canonicalEvents,
        selectedEventId: null,
        disabled: false,
        onSelect: vi.fn(),
        onAction: vi.fn(),
      }),
    );

    expect(view.container.querySelector(".virtual-event-list")).not.toBeNull();
    expect(screen.getAllByRole("listitem").length).toBeLessThan(30);
    expect((view.container.querySelector(".ledger-event-list") as HTMLElement).style.height).toBe(
      "72000px",
    );
  });

  it("연결 주자 이동도 별도 add_event 한 건으로 제출한다", async () => {
    const document = fixture();
    const result = document.events.find((item) => item.kind === "plate_result");
    const next = document.events.find((item) => item.kind === "unresolved");
    if (result?.kind !== "plate_result") throw new Error("plate result fixture missing");
    if (next === undefined) throw new Error("next event fixture missing");
    const onApply = vi.fn<(command: CorrectionCommand) => void>();
    render(
      createElement(CorrectionDrawer, {
        request: {
          mode: "add_event",
          beforeEventId: next.identity.eventId,
          seedEvent: result,
        },
        session: session(document),
        selectedEvent: result,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply,
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect((dialog.querySelector("select") as HTMLSelectElement).value).toBe("runner_advance");
    const runnerPicker = within(dialog).getByRole("combobox", { name: "주자" });
    if (!(runnerPicker instanceof HTMLElement)) throw new Error("runner picker missing");
    await userEvent.setup().click(runnerPicker);
    await userEvent.setup().type(screen.getByRole("searchbox"), "a1");
    await userEvent.setup().click(screen.getByRole("option", { name: /a1/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "중계 문구" }), {
      target: { value: "1루주자 Away Batter : 2루 진루" },
    });
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "작업 사본에 즉시 반영" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "add_event",
        event: expect.objectContaining({
          kind: "runner_advance",
          payload: expect.objectContaining({
            runnerId: "a1",
            context: { kind: "plate_result", plateResultEventId: result.identity.eventId },
          }),
        }),
      }),
    );
  });

  it("선수 ID가 없는 투구 편집기는 compiler 현재 타석의 타자와 투수를 표시한다", () => {
    const base = fixture();
    const pitch: StagingRelayEvent = {
      identity: {
        kind: "source",
        eventId: "pitch-with-inherited-pa",
        endpoint: "test-relay",
        blockIndex: 3,
        eventIndex: 0,
      },
      sequence: base.events.length,
      inning: 1,
      half: "top",
      relayText: "1구 스트라이크",
      kind: "pitch",
      payload: { call: "called_strike" },
    };
    const document = parseStagingGameDocumentV2({ ...base, events: [...base.events, pitch] });
    const before: CorrectionEventContext["before"] = {
      balls: 0,
      strikes: 0,
      outs: 0,
      bases: [null, null, null],
      awayScore: 0,
      homeScore: 0,
      batterId: "a1",
      pitcherId: "p1",
    };
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: pitch.identity.eventId },
        session: session(document, [
          {
            eventId: pitch.identity.eventId,
            applied: true,
            before,
            after: { ...before, strikes: 1 },
          },
        ]),
        selectedEvent: pitch,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply: vi.fn(),
      }),
    );
    expect(screen.getByRole("combobox", { name: "타자 (선택)" }).textContent).toContain(
      "현재 타석 상태 사용 · Away Away Batter (a1)",
    );
    expect(screen.getByRole("combobox", { name: "투수 (선택)" }).textContent).toContain(
      "현재 타석 상태 사용 · Home Home Pitcher (p1)",
    );
  });

  it("종류 변경 시 현재 타석 선수를 자동 지정하고 근거를 표시한다", async () => {
    const document = fixture();
    const unresolved = document.events.find((item) => item.kind === "unresolved");
    if (unresolved?.kind !== "unresolved") throw new Error("unresolved fixture missing");
    const before = correctionState({ batterId: "a1", pitcherId: "p1" });
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: unresolved.identity.eventId },
        session: session(document, [
          { eventId: unresolved.identity.eventId, applied: true, before, after: before },
        ]),
        selectedEvent: unresolved,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply: vi.fn(),
      }),
    );
    const dialog = screen.getByRole("dialog");
    await userEvent
      .setup()
      .selectOptions(within(dialog).getByRole("combobox", { name: "행 종류" }), "plate_result");

    expect(within(dialog).getByRole("combobox", { name: "타자" }).textContent).toContain(
      "Away Batter(a1)",
    );
    expect(within(dialog).getByRole("combobox", { name: "투수" }).textContent).toContain(
      "Home Pitcher(p1)",
    );
    expect(within(dialog).getByRole("status").textContent).toContain("타자(현재 타석)");
    expect(within(dialog).getAllByText("자동 지정 · 현재 타석")).toHaveLength(2);
  });

  it("타석 시작 변환은 활성 타석이 없어도 다음 명단 타자와 직전 투수를 지정한다", async () => {
    const document = fixture();
    const unresolved = document.events.find((item) => item.kind === "unresolved");
    if (unresolved?.kind !== "unresolved") throw new Error("unresolved fixture missing");
    const before = correctionState({ batterId: null, pitcherId: null });
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: unresolved.identity.eventId },
        session: session(document, [
          { eventId: unresolved.identity.eventId, applied: false, before, after: before },
        ]),
        selectedEvent: unresolved,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply: vi.fn(),
      }),
    );

    const dialog = screen.getByRole("dialog");
    await userEvent
      .setup()
      .selectOptions(within(dialog).getByRole("combobox", { name: "행 종류" }), "batter_start");

    expect(within(dialog).getByRole("combobox", { name: "타자" }).textContent).toContain(
      "First Runner(a2)",
    );
    expect(within(dialog).getByRole("combobox", { name: "투수" }).textContent).toContain(
      "Home Pitcher(p1)",
    );
    expect(within(dialog).getByRole("status").textContent).toContain("타자(명단 다음 타순)");
    expect(within(dialog).getByRole("status").textContent).toContain("투수(직전 행)");
    expect(within(dialog).getByText("자동 지정 · 명단 다음 타순")).toBeTruthy();
    expect(within(dialog).getByText("자동 지정 · 직전 행")).toBeTruthy();
  });

  it("타석 결과 뒤 추가는 현재 베이스의 첫 주자를 채우고 초기 자동값은 폐기 확인을 만들지 않는다", async () => {
    const document = fixture();
    const result = document.events.find((item) => item.kind === "plate_result");
    const next = document.events.find((item) => item.kind === "unresolved");
    if (result?.kind !== "plate_result" || next === undefined)
      throw new Error("linked runner fixture missing");
    const before = correctionState({ bases: ["a2", "a3", null] });
    const onClose = vi.fn();
    render(
      createElement(CorrectionDrawer, {
        request: {
          mode: "add_event",
          beforeEventId: next.identity.eventId,
          seedEvent: result,
        },
        session: session(document, [
          { eventId: result.identity.eventId, applied: true, before, after: before },
        ]),
        selectedEvent: result,
        pending: false,
        error: null,
        onClose,
        onApply: vi.fn(),
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "주자" }).textContent).toContain(
      "First Runner(a2)",
    );
    expect(within(dialog).getByRole("status").textContent).toContain("현재 1루");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByText("입력 중인 변경을 버릴까요?")).toBeNull();
  });

  it("교체 역할과 판독 대상은 canonical 상태와 직전 행으로 자동 지정한다", async () => {
    const document = fixture();
    const unresolved = document.events.find((item) => item.kind === "unresolved");
    if (unresolved?.kind !== "unresolved") throw new Error("unresolved fixture missing");
    const before = correctionState({
      batterId: "a1",
      pitcherId: "p1",
      bases: ["a2", null, null],
    });
    const view = render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: unresolved.identity.eventId },
        session: session(document, [
          { eventId: unresolved.identity.eventId, applied: true, before, after: before },
        ]),
        selectedEvent: unresolved,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply: vi.fn(),
      }),
    );
    let dialog = screen.getByRole("dialog");
    await userEvent
      .setup()
      .selectOptions(within(dialog).getByRole("combobox", { name: "행 종류" }), "substitution");
    expect((within(dialog).getByRole("combobox", { name: "팀" }) as HTMLSelectElement).value).toBe(
      "away",
    );
    expect(
      within(dialog).getByRole("combobox", { name: "나가는 선수 (선택)" }).textContent,
    ).toContain("Away Batter(a1)");
    expect(
      (within(dialog).getByRole("spinbutton", { name: "타순 (선택)" }) as HTMLInputElement).value,
    ).toBe("1");
    await userEvent
      .setup()
      .selectOptions(within(dialog).getByRole("combobox", { name: "역할" }), "pitcher");
    expect((within(dialog).getByRole("combobox", { name: "팀" }) as HTMLSelectElement).value).toBe(
      "home",
    );
    expect(
      within(dialog).getByRole("combobox", { name: "나가는 선수 (선택)" }).textContent,
    ).toContain("Home Pitcher(p1)");

    view.unmount();
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: unresolved.identity.eventId },
        session: session(document, [
          { eventId: unresolved.identity.eventId, applied: true, before, after: before },
        ]),
        selectedEvent: unresolved,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply: vi.fn(),
      }),
    );
    dialog = screen.getByRole("dialog");
    await userEvent
      .setup()
      .selectOptions(within(dialog).getByRole("combobox", { name: "행 종류" }), "review");
    expect(
      (within(dialog).getByRole("combobox", { name: "판독 대상 행 (선택)" }) as HTMLSelectElement)
        .value,
    ).toBe("e1");
    expect(within(dialog).getByText("자동 지정 · 직전 행")).toBeTruthy();
  });

  it("문구 제안은 canonical 타석 위치의 투구 순번을 사용하고 수동 문구를 누르기 전까지 보존한다", async () => {
    const baseDocument = fixture();
    const batterStart: StagingRelayEvent = {
      identity: {
        kind: "source",
        eventId: "batter-for-relay-suggestion",
        endpoint: "test-relay",
        blockIndex: 1,
        eventIndex: 0,
      },
      sequence: 1,
      inning: 1,
      half: "top",
      relayText: "1번타자 Away Batter",
      kind: "batter_start",
      payload: { batterId: "a1", pitcherId: "p1" },
    };
    const pitches = [
      pitchEvent("suggestion-pitch-one", 2, "ball", "1구 볼"),
      pitchEvent("suggestion-pitch-two", 3, "automatic_ball", "2구 자동 볼"),
      pitchEvent("suggestion-pitch-three", 4, "no_pitch", "3구 투구 무효"),
      pitchEvent("suggestion-target", 5, "called_strike", "수동 확인 문구"),
    ];
    const target = pitches.at(-1);
    if (target === undefined) throw new Error("pitch suggestion target missing");
    const document = parseStagingGameDocumentV2({
      ...baseDocument,
      events: [event("suggestion-half", 0), batterStart, ...pitches],
    });
    const onApply = vi.fn<(command: CorrectionCommand) => void>();
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: target.identity.eventId },
        session: session(document),
        selectedEvent: target,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply,
      }),
    );

    const dialog = screen.getByRole("dialog");
    const relayText = within(dialog).getByRole("textbox", { name: "중계 문구" });
    expect((relayText as HTMLTextAreaElement).value).toBe("수동 확인 문구");
    expect(onApply).not.toHaveBeenCalled();

    await userEvent.setup().click(within(dialog).getByRole("button", { name: "문구 제안" }));

    expect((relayText as HTMLTextAreaElement).value).toBe("4구 스트라이크");
    expect(onApply).not.toHaveBeenCalled();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(screen.getByRole("alert").textContent).toContain("입력 중인 변경을 버릴까요?");
  });

  it("타석 결과 편집기는 movement를 만들지 않고 신규 기본 번트 값을 false로 둔다", async () => {
    const document = fixture();
    const result = document.events.find((item) => item.kind === "plate_result");
    if (result?.kind !== "plate_result") throw new Error("plate result fixture missing");
    const onApply = vi.fn<(command: CorrectionCommand) => void>();
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: result.identity.eventId },
        session: session(document),
        selectedEvent: result,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply,
      }),
    );
    const dialog = screen.getByRole("dialog");
    const buntSelect = [...dialog.querySelectorAll("select")].find(
      (select) =>
        [...select.options].some((option) => option.value === "true") && select.value === "false",
    );
    expect(buntSelect?.value).toBe("false");
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "작업 사본에 즉시 반영" }));
    const command = onApply.mock.calls[0]?.[0];
    expect(command?.kind).toBe("replace_event");
    if (command?.kind !== "replace_event" || command.event.kind !== "plate_result") return;
    expect(command.event.payload).not.toHaveProperty("movements");
    expect(command.event.payload.isBunt).toBe(false);
  });

  it("삼진을 선택하면 타구 입력을 숨기고 오래된 타구 정보를 command에서 제거한다", async () => {
    const document = fixture();
    const result = document.events.find((item) => item.kind === "plate_result");
    if (result?.kind !== "plate_result") throw new Error("plate result fixture missing");
    const onApply = vi.fn<(command: CorrectionCommand) => void>();
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: result.identity.eventId },
        session: session(document),
        selectedEvent: result,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply,
      }),
    );
    const dialog = screen.getByRole("dialog");
    const resultSelect = within(dialog).getByRole("combobox", { name: "타석 결과" });
    expect(within(dialog).getByText("타구 유형")).toBeTruthy();
    expect(within(dialog).getByText("번트 여부")).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "타점 (선택)" }), {
      target: { value: "2" },
    });
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "직접 기록 아웃 (선택)" }), {
      target: { value: "2" },
    });
    await userEvent
      .setup()
      .selectOptions(within(dialog).getByRole("combobox", { name: "타자 생존 도착 베이스" }), "3");

    await userEvent.setup().selectOptions(resultSelect, "strikeout");

    expect(within(dialog).queryByText("타구 유형")).toBeNull();
    expect(within(dialog).queryByText("번트 여부")).toBeNull();
    expect(
      (within(dialog).getByRole("spinbutton", { name: "타점 (선택)" }) as HTMLInputElement).value,
    ).toBe("");
    expect(
      (
        within(dialog).getByRole("spinbutton", {
          name: "직접 기록 아웃 (선택)",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(
      (
        within(dialog).getByRole("combobox", {
          name: "타자 생존 도착 베이스",
        }) as HTMLSelectElement
      ).value,
    ).toBe("");
    expect(within(dialog).getByRole("option", { name: "기본 결과 사용 · 아웃" })).toBeTruthy();

    await userEvent.setup().selectOptions(resultSelect, "field_out");
    expect(
      (within(dialog).getByRole("combobox", { name: "번트 여부" }) as HTMLSelectElement).value,
    ).toBe("false");
    await userEvent.setup().selectOptions(resultSelect, "strikeout");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "중계 문구" }), {
      target: { value: "비식별 타자 : 삼진" },
    });
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "작업 사본에 즉시 반영" }));

    const command = onApply.mock.calls[0]?.[0];
    expect(command?.kind).toBe("replace_event");
    if (command?.kind !== "replace_event" || command.event.kind !== "plate_result") return;
    expect(command.event.payload.result).toBe("strikeout");
    expect(command.event.payload).not.toHaveProperty("battedBallType");
    expect(command.event.payload).not.toHaveProperty("isBunt");
  });

  it("서로 다른 추가 draft를 재정렬해 동일 anchor의 atomic batch로 제출한다", async () => {
    const document = fixture();
    const onApply = vi.fn<(command: CorrectionCommand) => void>();
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "add_event", beforeEventId: "e1" },
        session: session(document),
        selectedEvent: undefined,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply,
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("1 / 100")).toBeTruthy();
    expect(within(dialog).queryByText("추가할 행을 찾을 수 없습니다.")).toBeNull();
    await userEvent.setup().clear(within(dialog).getByRole("spinbutton", { name: "회" }));
    await userEvent.setup().type(within(dialog).getByRole("spinbutton", { name: "회" }), "3");
    await userEvent
      .setup()
      .selectOptions(within(dialog).getByRole("combobox", { name: "초/말" }), "bottom");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "다음 행 추가" }));
    expect(within(dialog).getByText("2 / 100")).toBeTruthy();
    expect((within(dialog).getByRole("spinbutton", { name: "회" }) as HTMLInputElement).value).toBe(
      "3",
    );
    expect(
      (within(dialog).getByRole("combobox", { name: "초/말" }) as HTMLSelectElement).value,
    ).toBe("bottom");
    await userEvent
      .setup()
      .selectOptions(within(dialog).getByRole("combobox", { name: "행 종류" }), "administrative");
    await userEvent.setup().clear(within(dialog).getByRole("textbox", { name: "중계 문구" }));
    await userEvent
      .setup()
      .type(within(dialog).getByRole("textbox", { name: "중계 문구" }), "둘째 비식별 행");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "2번 행 위로 이동" }));

    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "2개 행 한 번에 반영" }));

    const command = onApply.mock.calls[0]?.[0];
    expect(command?.kind).toBe("correction_batch");
    if (command?.kind !== "correction_batch") return;
    expect(command.commands).toHaveLength(2);
    expect(
      command.commands.map((item) => (item.kind === "add_event" ? item.beforeEventId : undefined)),
    ).toEqual(["e1", "e1"]);
    expect(
      command.commands.map((item) =>
        item.kind === "add_event" ? item.event.relayText : undefined,
      ),
    ).toEqual(["둘째 비식별 행", "볼"]);
    expect(
      new Set(
        command.commands.map((item) =>
          item.kind === "add_event" ? item.event.identity.eventId : "",
        ),
      ).size,
    ).toBe(2);
  });

  it("queued 타석 결과 다음 draft를 주자 이동으로 만들고 안정적인 결과 ID를 연결한다", async () => {
    const document = fixture();
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "add_event", beforeEventId: null },
        session: session(document),
        selectedEvent: undefined,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply: vi.fn(),
      }),
    );
    const dialog = screen.getByRole("dialog");
    const user = userEvent.setup();
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "행 종류" }),
      "plate_result",
    );
    await user.click(within(dialog).getByRole("combobox", { name: "타자" }));
    await user.click(within(dialog).getByRole("option", { name: /Away Batter\(a1\)/ }));
    await user.click(within(dialog).getByRole("combobox", { name: "투수" }));
    await user.click(within(dialog).getByRole("option", { name: /Home Pitcher\(p1\)/ }));
    await user.click(within(dialog).getByRole("button", { name: "다음 행 추가" }));

    expect(
      (within(dialog).getByRole("combobox", { name: "행 종류" }) as HTMLSelectElement).value,
    ).toBe("runner_advance");
    const link = within(dialog).getByRole("combobox", { name: "연결할 타석 결과" });
    expect((link as HTMLSelectElement).selectedOptions[0]?.textContent).toContain("추가 1");
    expect(within(dialog).getByText("자동 지정 · 앞선 추가 행")).toBeTruthy();
  });

  it("queued 판독 참조가 재정렬로 후행이 되면 전체 제출을 막고 오류 draft를 선택한다", async () => {
    const document = fixture();
    const onApply = vi.fn<(command: CorrectionCommand) => void>();
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "add_event", beforeEventId: null },
        session: session(document),
        selectedEvent: undefined,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply,
      }),
    );
    const dialog = screen.getByRole("dialog");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "다음 행 추가" }));
    await userEvent
      .setup()
      .selectOptions(within(dialog).getByRole("combobox", { name: "행 종류" }), "review");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "문구 제안" }));
    const target = within(dialog).getByRole("combobox", { name: "판독 대상 행 (선택)" });
    expect((target as HTMLSelectElement).selectedOptions[0]?.textContent).toContain("추가 1");

    await userEvent.setup().click(within(dialog).getByRole("button", { name: "2번 행 위로 이동" }));
    expect(
      within(dialog).getByText("판독 대상은 현재 행보다 앞선 원장 행이어야 합니다."),
    ).toBeTruthy();
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "2개 행 한 번에 반영" }));

    expect(onApply).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/1번 행: 판독 대상은/)).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "판독 대상 행 (선택)" })).toBe(
      globalThis.document.activeElement,
    );
  });

  it("draft 추가도 폐기 확인에 포함하고 pending 중 queue 편집을 잠근다", async () => {
    const document = fixture();
    const onClose = vi.fn();
    const props = {
      request: { mode: "add_event" as const, beforeEventId: null },
      session: session(document),
      selectedEvent: undefined,
      error: null,
      onClose,
      onApply: vi.fn(),
    };
    const view = render(createElement(CorrectionDrawer, { ...props, pending: false }));
    let dialog = screen.getByRole("dialog");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "다음 행 추가" }));
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(screen.getByRole("alert").textContent).toContain("입력 중인 변경을 버릴까요?");
    await userEvent.setup().click(screen.getByRole("button", { name: "편집 계속" }));

    view.rerender(
      createElement(CorrectionDrawer, {
        ...props,
        pending: false,
        error: new Error("서버 batch 검증 실패"),
      }),
    );
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("2 / 100")).toBeTruthy();
    expect(within(dialog).getByText("서버 batch 검증 실패")).toBeTruthy();

    view.rerender(createElement(CorrectionDrawer, { ...props, pending: true }));
    dialog = screen.getByRole("dialog");
    expect(
      (within(dialog).getByRole("button", { name: "2번 행 삭제" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "다음 행 추가" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "닫기" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("unresolved 원문 행을 같은 identity의 typed 행으로 교체한다", async () => {
    const document = fixture();
    const unresolved = document.events.find((item) => item.kind === "unresolved");
    if (unresolved?.kind !== "unresolved") throw new Error("unresolved fixture missing");
    const onApply = vi.fn<(command: CorrectionCommand) => void>();
    render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: unresolved.identity.eventId },
        session: session(document),
        selectedEvent: unresolved,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onApply,
      }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.change(dialog.querySelector("select") as HTMLSelectElement, {
      target: { value: "administrative" },
    });
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "작업 사본에 즉시 반영" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "replace_event",
        eventId: unresolved.identity.eventId,
        event: expect.objectContaining({
          identity: unresolved.identity,
          kind: "administrative",
          relayText: unresolved.relayText,
        }),
      }),
    );
  });

  it("수정한 드로어를 닫을 때 폐기를 확인하고 요청 중에는 닫기를 잠근다", async () => {
    const document = fixture();
    const selected = document.events[0];
    if (selected === undefined) throw new Error("event fixture missing");
    const onClose = vi.fn();
    const view = render(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: selected.identity.eventId },
        session: session(document),
        selectedEvent: selected,
        pending: false,
        error: null,
        onClose,
        onApply: vi.fn(),
      }),
    );
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    await userEvent.setup().clear(within(dialog).getByRole("textbox", { name: "중계 문구" }));
    await userEvent
      .setup()
      .type(within(dialog).getByRole("textbox", { name: "중계 문구" }), "비식별 중계 문구");
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.getByRole("alert").textContent).toContain("입력 중인 변경을 버릴까요?");
    await userEvent.setup().click(screen.getByRole("button", { name: "변경 버리기" }));
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(
      createElement(CorrectionDrawer, {
        request: { mode: "replace_event", eventId: selected.identity.eventId },
        session: session(document),
        selectedEvent: selected,
        pending: true,
        error: null,
        onClose,
        onApply: vi.fn(),
      }),
    );
    expect((screen.getByRole("button", { name: "닫기" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function fixture(): StagingGameDocumentV2 {
  return parseStagingGameDocumentV2({
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: "ui-game",
      collectedAt: "2026-08-20T03:00:00.000Z",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: "ui-game",
      season: 2026,
      gameDate: "2026-08-20",
      status: "suspended",
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: "AWAY", name: "Away" },
      home: { teamId: "HOME", name: "Home" },
    },
    rosters: {
      away: {
        teamId: "AWAY",
        players: [
          {
            playerId: "a1",
            name: "Away Batter",
            battingOrder: 1,
            starter: true,
            positions: ["1B"],
          },
          {
            playerId: "a2",
            name: "First Runner",
            battingOrder: 2,
            starter: true,
            positions: ["2B"],
          },
          {
            playerId: "a3",
            name: "Second Runner",
            battingOrder: 3,
            starter: true,
            positions: ["3B"],
          },
        ],
      },
      home: {
        teamId: "HOME",
        players: [{ playerId: "p1", name: "Home Pitcher", starter: true, positions: ["P"] }],
      },
    },
    events: [
      event("e0", 0),
      {
        identity: {
          kind: "source",
          eventId: "e1",
          endpoint: "test-relay",
          blockIndex: 0,
          eventIndex: 1,
        },
        sequence: 1,
        inning: 1,
        half: "top",
        relayText: "Away Batter : 땅볼 아웃",
        kind: "plate_result",
        payload: {
          result: "field_out",
          batterId: "a1",
          pitcherId: "p1",
          battedBallType: "ground_ball",
          isBunt: false,
        },
      },
      {
        identity: {
          kind: "source",
          eventId: "e2",
          endpoint: "relay",
          blockIndex: 2,
          eventIndex: 7,
        },
        sequence: 2,
        inning: 1,
        half: "top",
        relayText: "해석되지 않은 원문",
        kind: "unresolved",
        payload: { sourceType: "unknown", suspectedKind: "administrative" },
      },
    ],
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  });
}

function event(eventId: string, sequence: number): StagingRelayEvent {
  return {
    identity: {
      kind: "source",
      eventId,
      endpoint: "test-relay",
      blockIndex: 0,
      eventIndex: sequence,
    },
    kind: "half_inning_start",
    sequence,
    inning: 1,
    half: "top",
    relayText: "1회초 시작",
    payload: {},
  };
}

function pitchEvent(
  eventId: string,
  sequence: number,
  call: Extract<StagingRelayEvent, { kind: "pitch" }>["payload"]["call"],
  relayText: string,
): StagingRelayEvent {
  return {
    identity: {
      kind: "source",
      eventId,
      endpoint: "test-relay",
      blockIndex: 1,
      eventIndex: sequence,
    },
    kind: "pitch",
    sequence,
    inning: 1,
    half: "top",
    relayText,
    payload: { call },
  };
}

function presentation(value: StagingRelayEvent): EventPresentation {
  return {
    event: value,
    location: "1회초",
    startsHalf: value.sequence === 0,
    kindLabel: "이닝 시작",
    title: `이벤트 ${String(value.sequence + 1)}`,
    summary: "테스트 이벤트",
    stateText: "B0 S0 O0",
    searchText: "테스트",
  };
}

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function session(
  document: StagingGameDocumentV2,
  eventContexts: readonly CorrectionEventContext[] = [],
): CorrectionSession {
  return {
    sessionId: "session-1",
    authority: "staging",
    gameId: document.metadata.gameId,
    baseDocumentHash: "0".repeat(64),
    sessionVersion: 0,
    draftDocumentHash: "1".repeat(64),
    draftDocument: document,
    storedFindings: [],
    findings: [],
    eventContexts: [...eventContexts],
    calculatedRecords: { batters: [], pitchers: [] },
    blockingCount: 0,
    warningCount: 0,
    canUndo: false,
    canRedo: false,
    dirty: false,
  };
}

function correctionState(
  patch: Partial<CorrectionEventContext["before"]> = {},
): CorrectionEventContext["before"] {
  return {
    balls: 0,
    strikes: 0,
    outs: 0,
    bases: [null, null, null],
    awayScore: 0,
    homeScore: 0,
    batterId: null,
    pitcherId: null,
    ...patch,
  };
}
