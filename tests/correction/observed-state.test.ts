import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseCorrectionCommand, parseStagingGameDocumentV2 } from "@kbo/contracts";
import { applyCorrectionCommand } from "@kbo/correction";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";

const source = parseStagingGameDocumentV2(
  JSON.parse(
    await readFile("tests/fixtures/correction/in-play-observation.anonymized.json", "utf8"),
  ) as unknown,
);
const pitch = source.events[3];
if (pitch?.kind !== "pitch") throw new Error("missing anonymous in-play pitch");
const command = parseCorrectionCommand({
  commandId: "correct-observation",
  kind: "update_observed_state",
  eventId: pitch.identity.eventId,
  observedStateAfter: { ...pitch.observedStateAfter, balls: 0 },
});

describe("명시적 관측값 보정", () => {
  it("잘못된 볼 관측만 고치고 투구·원문·소스 위치·다른 관측·계산 통계를 보존한다", () => {
    const beforeHash = stagingDocumentHash(source);
    const before = compileStagingGameDocumentV2(source);
    expect(before.findings).toContainEqual(
      expect.objectContaining({
        code: "source_observation_mismatch",
        eventId: "e3",
        details: [{ field: "balls", expected: 1, actual: 0 }],
      }),
    );
    const corrected = applyCorrectionCommand(source, command);
    expect(corrected.document.events[3]).toEqual({
      ...pitch,
      observedStateAfter: { ...pitch.observedStateAfter, balls: 0 },
    });
    expect(corrected.document.source).toEqual(source.source);
    expect(corrected.document.events.filter((event) => event.kind === "pitch")).toHaveLength(2);
    expect(corrected.replay.findings.filter((finding) => finding.severity === "blocking")).toEqual(
      [],
    );
    expect(corrected.replay.finalState).toEqual(before.finalState);
    expect(corrected.replay.pitcherLines).toEqual(before.pitcherLines);
    expect(corrected.replay.batterLines).toEqual(before.batterLines);
    expect(corrected.replay.pitchFacts).toEqual(before.pitchFacts);
    expect(stagingDocumentHash(source)).toBe(beforeHash);
    expect(stagingDocumentHash(corrected.document)).not.toBe(beforeHash);
    expect(applyCorrectionCommand(source, command)).toEqual(corrected);
  });

  it("여전히 잘못된 관측은 전체 검증에서 차단하며 상태에 주입하지 않는다", () => {
    const corrected = applyCorrectionCommand(source, {
      commandId: "wrong-observation",
      kind: "update_observed_state",
      eventId: "e3",
      observedStateAfter: { balls: 3, strikes: 2 },
    });
    expect(corrected.replay.findings.filter((finding) => finding.eventId === "e3")).toEqual([
      expect.objectContaining({
        code: "source_observation_mismatch",
        details: [
          { field: "balls", expected: 3, actual: 0 },
          { field: "strikes", expected: 2, actual: 1 },
        ],
      }),
    ]);
    expect(corrected.replay.finalState).toEqual(compileStagingGameDocumentV2(source).finalState);
  });

  it("전체 미관측은 빈 객체를 남기지 않고 관측 속성을 제거한다", () => {
    const corrected = applyCorrectionCommand(source, {
      commandId: "clear-observation",
      kind: "update_observed_state",
      eventId: "e3",
      observedStateAfter: {},
    });
    expect(corrected.document.events[3]).not.toHaveProperty("observedStateAfter");
    expect(source.events[3]?.observedStateAfter?.balls).toBe(1);
  });

  it("일반 행 수정은 관측값을 우회해서 변경할 수 없다", () => {
    const corrected = applyCorrectionCommand(source, {
      commandId: "replace",
      kind: "replace_event",
      eventId: "e3",
      event: { ...pitch, observedStateAfter: { balls: 0 } },
    });
    expect(corrected.document.events[3]?.observedStateAfter).toEqual(pitch.observedStateAfter);
    const unobserved = source.events[1];
    if (unobserved === undefined) throw new Error("missing anonymous batter start");
    const injected = applyCorrectionCommand(source, {
      commandId: "inject-observation",
      kind: "replace_event",
      eventId: unobserved.identity.eventId,
      event: { ...unobserved, observedStateAfter: { balls: 0 } },
    });
    expect(injected.document.events[1]).not.toHaveProperty("observedStateAfter");
  });

  it("수동 행·누락 행 및 잘못된 구조는 거부하고 실패 batch는 원본을 보존한다", () => {
    const manualId = "0198f1e2-7d2a-7000-8000-000000000011";
    const invalidBatch = parseCorrectionCommand({
      commandId: "invalid-batch",
      kind: "correction_batch",
      commands: [
        command,
        {
          commandId: "add",
          kind: "add_event",
          beforeEventId: null,
          event: {
            identity: { kind: "manual", eventId: manualId },
            sequence: 5,
            inning: 1,
            half: "top",
            relayText: "비식별 안내",
            kind: "administrative",
            payload: { code: "announcement" },
          },
        },
        {
          commandId: "manual",
          kind: "update_observed_state",
          eventId: manualId,
          observedStateAfter: { balls: 0 },
        },
      ],
    });
    const hash = stagingDocumentHash(source);
    expect(() => applyCorrectionCommand(source, invalidBatch)).toThrow("원문에서 수집한 행");
    expect(stagingDocumentHash(source)).toBe(hash);
    expect(() =>
      applyCorrectionCommand(source, {
        commandId: "missing",
        kind: "update_observed_state",
        eventId: "missing",
        observedStateAfter: {},
      }),
    ).toThrow();
    for (const observedStateAfter of [
      { balls: -1 },
      { strikes: 1.5 },
      { extra: 0 },
      { bases: [null] },
    ]) {
      expect(() =>
        parseCorrectionCommand({
          commandId: "invalid",
          kind: "update_observed_state",
          eventId: "e3",
          observedStateAfter,
        }),
      ).toThrow();
    }
  });
});
