import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  parseCorrectionCommand,
  parseStagingGameDocumentV2,
} from "@kbo/contracts";
import { applyCorrectionCommand, CorrectionCommandError } from "@kbo/correction";
import { makeDocument } from "../helpers/game-document.js";

const document = parseStagingGameDocumentV2(
  makeDocument(
    Array.from({ length: 180 }, (_, index) => ({
      kind: "administrative",
      payload: { code: "announcement" },
      relayText: `비식별 원문 ${index}`,
    })),
  ),
);
const ids = (value: typeof document) => value.events.map((event) => event.identity.eventId);

describe("선택한 원장 행의 원자적 삭제·이동", () => {
  it("100행을 넘어도 하나의 명령으로 삭제하며 원본과 선택 밖 행을 보존한다", () => {
    const original = canonicalStringify(document);
    const selected = ids(document).slice(10, 170).reverse();
    const result = applyCorrectionCommand(document, {
      commandId: "bulk-delete",
      kind: "delete_events",
      eventIds: selected,
    });
    expect(ids(result.document)).toEqual([
      ...ids(document).slice(0, 10),
      ...ids(document).slice(170),
    ]);
    expect(result.document.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );
    expect(result.preview.eventCountDelta).toBe(-160);
    expect(canonicalStringify(document)).toBe(original);
    expect(result.document.events[0]).toEqual(document.events[0]);
  });

  it("불연속 선택과 역순 요청도 원장 순서대로 묶어 이동한다", () => {
    const result = applyCorrectionCommand(document, {
      commandId: "bulk-move",
      kind: "move_events",
      eventIds: ["e8", "e2", "e5"],
      beforeEventId: "e1",
    });
    expect(ids(result.document).slice(0, 7)).toEqual(["e0", "e2", "e5", "e8", "e1", "e3", "e4"]);
    expect(result.document.events.find((event) => event.identity.eventId === "e5")).toEqual({
      ...document.events[5],
      sequence: 2,
    });
    const otherOrder = applyCorrectionCommand(document, {
      commandId: "other-order",
      kind: "move_events",
      eventIds: ["e5", "e8", "e2"],
      beforeEventId: "e1",
    });
    expect(otherOrder.document).toEqual(result.document);
    const end = applyCorrectionCommand(document, {
      commandId: "end",
      kind: "move_events",
      eventIds: ["e3", "e1"],
      beforeEventId: null,
    });
    expect(ids(end.document).slice(-2)).toEqual(["e1", "e3"]);
  });

  it("없는 ID·선택 안의 목적지·중복 ID는 전체를 거부한다", () => {
    const before = canonicalStringify(document);
    for (const command of [
      { kind: "delete_events", eventIds: ["e2", "missing"] },
      { kind: "move_events", eventIds: ["e2", "missing"], beforeEventId: null },
      { kind: "move_events", eventIds: ["e2", "e3"], beforeEventId: "e3" },
      { kind: "move_events", eventIds: ["e2"], beforeEventId: "missing" },
      { kind: "delete_events", eventIds: ["e2", "e2"] },
      { kind: "delete_events", eventIds: [] },
    ]) {
      expect(() =>
        applyCorrectionCommand(
          document,
          parseCorrectionCommand({ commandId: "invalid", ...command }),
        ),
      ).toThrow();
      expect(canonicalStringify(document)).toBe(before);
    }
    expect(() =>
      applyCorrectionCommand(document, {
        commandId: "missing",
        kind: "delete_events",
        eventIds: ["e1", "missing"],
      }),
    ).toThrow(CorrectionCommandError);
  });

  it("투구를 여러 개 삭제해도 직접 tracking과 duplicate 관찰은 제외 상태로 보존한다", async () => {
    const golden = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    const first = golden.trackingCandidates[0];
    if (first === undefined) throw new Error("missing anonymous tracking");
    const input = parseStagingGameDocumentV2({
      ...golden,
      trackingCandidates: [
        ...golden.trackingCandidates,
        {
          ...first,
          sequence: golden.trackingCandidates.length,
          trackingId: "duplicate-observation",
          resolution: { kind: "duplicate", canonicalTrackingId: first.trackingId },
        },
      ],
    });
    const result = applyCorrectionCommand(input, {
      commandId: "pitches",
      kind: "delete_events",
      eventIds: ["e3", "e2"],
    });
    expect(result.document.trackingCandidates).toHaveLength(3);
    for (const candidate of result.document.trackingCandidates)
      expect(candidate.resolution).toMatchObject({ kind: "excluded", reason: "manual_other" });
    expect(
      result.document.trackingCandidates.map((candidate) => ({ ...candidate, resolution: null })),
    ).toEqual(input.trackingCandidates.map((candidate) => ({ ...candidate, resolution: null })));
  });
});
