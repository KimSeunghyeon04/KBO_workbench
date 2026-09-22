import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { applyCorrectionCommand } from "@kbo/correction";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";

// 같은 검토 경기의 비식별 원장으로 문구 보정과 경기 내용의 경계를 고정한다.
const document = parseStagingGameDocumentV2(
  JSON.parse(
    await readFile("tests/fixtures/correction/runner-autofill-multistep.anonymized.json", "utf8"),
  ) as unknown,
);
const target = document.events.find((event) => event.identity.eventId === "wrong-runner");
if (target === undefined) throw new Error("missing anonymous source runner");

describe("수집 행 중계문구 보정", () => {
  it("명시한 문구를 반영하되 선수·이동·관측·추적·원본과 계산 결과를 보존한다", () => {
    const before = compileStagingGameDocumentV2(document);
    const hash = stagingDocumentHash(document);
    const command = {
      kind: "replace_event" as const,
      commandId: "edit-text",
      eventId: target.identity.eventId,
      event: { ...target, relayText: "3루주자 a2 : 홈인 확인" },
    };
    const corrected = applyCorrectionCommand(document, command);
    expect(corrected.document.events[target.sequence]).toEqual({
      ...target,
      relayText: command.event.relayText,
    });
    expect(corrected.document.source).toEqual(document.source);
    expect(corrected.document.trackingCandidates).toEqual(document.trackingCandidates);
    expect(corrected.replay).toEqual({
      ...before,
      plays: before.plays.map((play) => ({
        ...play,
        relayTexts: play.relayTexts.map((text) =>
          text === target.relayText ? command.event.relayText : text,
        ),
      })),
    });
    expect(stagingDocumentHash(document)).toBe(hash);
    expect(stagingDocumentHash(corrected.document)).not.toBe(hash);
    expect(applyCorrectionCommand(document, command)).toEqual(corrected);
  });

  it("문구를 생략한 programmatic 교체는 현재 문구를 유지한다", () => {
    const replacement = structuredClone(target);
    delete replacement.relayText;
    const corrected = applyCorrectionCommand(document, {
      kind: "replace_event",
      commandId: "preserve-text",
      eventId: target.identity.eventId,
      event: replacement,
    });
    expect(corrected.document.events[target.sequence]?.relayText).toBe(target.relayText);
  });

  it.each(["", "x".repeat(1001)])(
    "유효하지 않은 문구는 원본을 바꾸지 않고 거부한다",
    (relayText) => {
      const hash = stagingDocumentHash(document);
      expect(() =>
        applyCorrectionCommand(document, {
          kind: "replace_event",
          commandId: "invalid-text",
          eventId: target.identity.eventId,
          event: { ...target, relayText },
        }),
      ).toThrow();
      expect(stagingDocumentHash(document)).toBe(hash);
    },
  );
});
