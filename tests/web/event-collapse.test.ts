import type { StagingRelayEvent } from "@kbo/contracts";
import { describe, expect, it } from "vitest";

import {
  applyEventCollapse,
  buildEventCollapseModel,
  collapseOwnersForEvent,
} from "../../apps/web/src/correction/event-collapse.js";
import type {
  CorrectionTimelinePresentation,
  EventPresentation,
} from "../../apps/web/src/correction/event-presentation.js";

describe("보정 원장 이닝·타석 접기", () => {
  const rows = timeline([
    half("half-top-1", 0, 1, "top"),
    batter("pa-anon-1", 1, 1, "top", "익명 타자 1"),
    pitch("pitch-anon-1", 2, 1, "top"),
    pitch("pitch-anon-2", 3, 1, "top"),
    batter("pa-anon-2", 4, 1, "top", "익명 타자 2"),
    pitch("pitch-anon-3", 5, 1, "top"),
    half("half-bottom-1", 6, 1, "bottom"),
    batter("pa-anon-3", 7, 1, "bottom", "익명 타자 3"),
    pitch("pitch-anon-4", 8, 1, "bottom"),
  ]);
  const model = buildEventCollapseModel(rows);

  it("반이닝 시작 행만 남기고 다음 반이닝 경계 전 행을 숨긴다", () => {
    expect(group(model, "half-top-1", "inning")?.childCount).toBe(5);
    expect(ids(applyEventCollapse(rows, model, new Set(["half-top-1"]), new Set(), false))).toEqual(
      ["half-top-1", "half-bottom-1", "pa-anon-3", "pitch-anon-4"],
    );
  });

  it("타석 시작 행만 남기고 다음 타석 또는 반이닝 경계 전 행을 숨긴다", () => {
    expect(group(model, "pa-anon-1", "plate")?.childCount).toBe(2);
    expect(ids(applyEventCollapse(rows, model, new Set(), new Set(["pa-anon-1"]), false))).toEqual([
      "half-top-1",
      "pa-anon-1",
      "pa-anon-2",
      "pitch-anon-3",
      "half-bottom-1",
      "pa-anon-3",
      "pitch-anon-4",
    ]);
  });

  it("검색·종류·문제 필터 중에는 접힘 상태와 무관하게 필터 결과를 모두 표시한다", () => {
    const filtered = rows.filter((row) => row.presentation.event.kind === "pitch");
    expect(
      ids(
        applyEventCollapse(filtered, model, new Set(["half-top-1"]), new Set(["pa-anon-3"]), true),
      ),
    ).toEqual(["pitch-anon-1", "pitch-anon-2", "pitch-anon-3", "pitch-anon-4"]);
  });

  it("finding 대상 행을 드러낼 이닝과 타석 소유자를 결정론적으로 찾는다", () => {
    expect(collapseOwnersForEvent(model, "pitch-anon-2")).toEqual({
      inningEventId: "half-top-1",
      plateEventId: "pa-anon-1",
    });
    expect(collapseOwnersForEvent(model, "half-bottom-1")).toEqual({
      inningEventId: "half-bottom-1",
    });
  });
});

function group(
  model: ReturnType<typeof buildEventCollapseModel>,
  eventId: string,
  kind: "inning" | "plate",
) {
  return (model.groupsByEventId.get(eventId) ?? []).find((candidate) => candidate.kind === kind);
}

function ids(rows: readonly CorrectionTimelinePresentation[]): string[] {
  return rows.map((row) => row.presentation.event.identity.eventId);
}

function timeline(events: readonly StagingRelayEvent[]): CorrectionTimelinePresentation[] {
  return events.map((event, index) => {
    const location = `${String(event.inning)}회${event.half === "top" ? "초" : "말"}`;
    const presentation: EventPresentation = {
      event,
      kindLabel:
        event.kind === "batter_start" ? "타석 시작" : event.kind === "pitch" ? "투구" : "이닝 시작",
      location,
      title: event.relayText ?? event.identity.eventId,
      summary: "비식별 테스트 행",
      stateText: "B0 S0 O0 · 주자 없음 · 0:0",
      searchText: "비식별",
      startsHalf:
        index === 0 ||
        events[index - 1]?.inning !== event.inning ||
        events[index - 1]?.half !== event.half,
    };
    return { kind: "event", key: event.identity.eventId, presentation };
  });
}

function identity(eventId: string, eventIndex: number) {
  return {
    kind: "source" as const,
    eventId,
    endpoint: "sanitized-relay",
    blockIndex: 0,
    eventIndex,
  };
}

function half(
  eventId: string,
  sequence: number,
  inning: number,
  halfValue: "top" | "bottom",
): StagingRelayEvent {
  return {
    identity: identity(eventId, sequence),
    kind: "half_inning_start",
    sequence,
    inning,
    half: halfValue,
    relayText: `${String(inning)}회${halfValue === "top" ? "초" : "말"} 시작`,
    payload: {},
  };
}

function batter(
  eventId: string,
  sequence: number,
  inning: number,
  halfValue: "top" | "bottom",
  name: string,
): StagingRelayEvent {
  return {
    identity: identity(eventId, sequence),
    kind: "batter_start",
    sequence,
    inning,
    half: halfValue,
    relayText: `${name} 타석`,
    payload: { batterId: `batter-${String(sequence)}`, pitcherId: "pitcher-anon" },
  };
}

function pitch(
  eventId: string,
  sequence: number,
  inning: number,
  halfValue: "top" | "bottom",
): StagingRelayEvent {
  return {
    identity: identity(eventId, sequence),
    kind: "pitch",
    sequence,
    inning,
    half: halfValue,
    relayText: "스트라이크",
    payload: { call: "called_strike" },
  };
}
