import type { StagingGameDocumentV2, StagingRelayEvent } from "@kbo/contracts";
import { describe, expect, it } from "vitest";

import {
  buildAdjacentMoveCommand,
  buildImmediateDeleteCommand,
  eventMoveCapabilities,
  insertionReferenceAfter,
  selectionAfterDelete,
} from "../../apps/web/src/correction/event-actions.js";

const events = ["e1", "e2", "e3", "e4"].map((eventId, sequence) => event(eventId, sequence));

describe("correction event row actions", () => {
  it("canonical 문서 순서로 한 칸 위·아래 이동 명령을 만든다", () => {
    expect(buildAdjacentMoveCommand(events, "e3", "up", "up")).toMatchObject({
      eventId: "e3",
      beforeEventId: "e2",
    });
    expect(buildAdjacentMoveCommand(events, "e2", "down", "down")).toMatchObject({
      eventId: "e2",
      beforeEventId: "e4",
    });
    expect(buildAdjacentMoveCommand(events, "e4", "down", "last")).toBeNull();
    expect(buildAdjacentMoveCommand(events, "e1", "up", "first")).toBeNull();
  });

  it("문서 경계 capability와 삭제 뒤 선택 대상을 계산한다", () => {
    expect(eventMoveCapabilities(events, "e1")).toEqual({
      canMoveUp: false,
      canMoveDown: true,
    });
    expect(eventMoveCapabilities(events, "e4")).toEqual({
      canMoveUp: true,
      canMoveDown: false,
    });
    expect(selectionAfterDelete(events, "e2")).toBe("e3");
    expect(selectionAfterDelete(events, "e4")).toBe("e3");
    expect(insertionReferenceAfter(events, "e2")).toBe("e3");
    expect(insertionReferenceAfter(events, "e4")).toBeNull();
  });

  it("투구 삭제 명령은 compiler가 tracking 연결을 원자적으로 해제하도록 이벤트만 지정한다", () => {
    const document = {
      events,
      trackingCandidates: [],
    } as unknown as StagingGameDocumentV2;
    expect(buildImmediateDeleteCommand(document, "e2", "delete-linked")).toEqual({
      commandId: "delete-linked",
      kind: "delete_event",
      eventId: "e2",
    });
    expect(buildImmediateDeleteCommand(document, "e3", "delete-unlinked")).toEqual({
      commandId: "delete-unlinked",
      kind: "delete_event",
      eventId: "e3",
    });
  });
});

function event(eventId: string, sequence: number): StagingRelayEvent {
  return {
    identity: { kind: "manual", eventId },
    kind: "half_inning_start",
    sequence,
    inning: 1,
    half: "top",
    payload: {},
  };
}
