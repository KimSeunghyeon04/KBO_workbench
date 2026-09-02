import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ContractValidationError, parseStagingGameDocumentV2 } from "@kbo/contracts";

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.resolve("tests/fixtures/game-document-v2.golden.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("StagingGameDocumentV2 strict 원장 계약", () => {
  it("평면 원장 golden 문서를 decode한다", async () => {
    const parsed = parseStagingGameDocumentV2(await fixture());
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.events).toHaveLength(21);
    expect(parsed.source.collectedAt).toBe("2026-08-20T03:00:00.000Z");
    expect(parsed.events.filter((event) => event.kind === "runner_advance")).toHaveLength(3);
    expect(
      parsed.events.find((event) => event.kind === "plate_result")?.payload,
    ).not.toHaveProperty("movements");
  });

  it("unknown field와 다른 schemaVersion을 거부한다", async () => {
    const document = await fixture();
    expect(() => parseStagingGameDocumentV2({ ...document, advertisement: "no" })).toThrow(
      ContractValidationError,
    );
    expect(() => parseStagingGameDocumentV2({ ...document, schemaVersion: 1 })).toThrow(
      ContractValidationError,
    );
  });

  it("tracking ID는 고유하지만 같은 sourcePitchId 관측은 보존한다", async () => {
    const valid = parseStagingGameDocumentV2(await fixture());
    expect(valid.trackingCandidates.map((item) => item.sourcePitchId)).toEqual([
      "p-duplicate",
      "p-duplicate",
    ]);
    const invalid = await fixture();
    const observations = invalid.trackingCandidates as Array<Record<string, unknown>>;
    observations[1] = { ...observations[1], trackingId: "t1" };
    expect(() => parseStagingGameDocumentV2(invalid)).toThrowError(/tracking ID/);
  });

  it("투구 sourcePitchId는 선택값이고 빈 문자열은 거부한다", async () => {
    const document = await fixture();
    const pitch = (document.events as Array<Record<string, unknown>>).find(
      (event) => event.kind === "pitch",
    );
    if (pitch === undefined) throw new Error("pitch fixture가 없습니다.");
    const payload = pitch.payload as Record<string, unknown>;
    delete payload.sourcePitchId;
    expect(
      parseStagingGameDocumentV2(document).events.find((event) => event.kind === "pitch")?.payload,
    ).not.toHaveProperty("sourcePitchId");
    payload.sourcePitchId = "";
    expect(() => parseStagingGameDocumentV2(document)).toThrow(ContractValidationError);
  });

  it("원문을 trim하고 공백 및 1,000자 초과를 거부한다", async () => {
    const document = await fixture();
    const first = (document.events as Array<Record<string, unknown>>)[0];
    if (first === undefined) throw new Error("event fixture가 없습니다.");
    first.relayText = "  1회초 시작  ";
    expect(parseStagingGameDocumentV2(document).events[0]?.relayText).toBe("1회초 시작");
    first.relayText = "   ";
    expect(() => parseStagingGameDocumentV2(document)).toThrow(ContractValidationError);
    first.relayText = "가".repeat(1_001);
    expect(() => parseStagingGameDocumentV2(document)).toThrow(ContractValidationError);
  });

  it("주자 이동은 기존 베이스와 정확히 하나의 context만 가진다", async () => {
    const document = await fixture();
    const runner = (document.events as Array<Record<string, unknown>>).find(
      (event) => event.kind === "runner_advance",
    );
    if (runner === undefined) throw new Error("runner fixture가 없습니다.");
    const payload = runner.payload as Record<string, unknown>;
    payload.fromBase = 0;
    expect(() => parseStagingGameDocumentV2(document)).toThrow(ContractValidationError);
    payload.fromBase = 1;
    payload.context = { kind: "independent", reason: "wild_pitch", plateResultEventId: "e10" };
    expect(() => parseStagingGameDocumentV2(document)).toThrow(ContractValidationError);
  });

  it.each(["ground_ball", "fly_ball", "line_drive", "popup"] as const)(
    "타석 결과의 %s 타구 유형을 보존한다",
    async (battedBallType) => {
      const document = await fixture();
      const result = (document.events as Array<Record<string, unknown>>).find(
        (event) =>
          event.kind === "plate_result" &&
          (event.payload as Record<string, unknown>).result === "single",
      );
      if (result === undefined) throw new Error("plate result fixture가 없습니다.");
      (result.payload as Record<string, unknown>).battedBallType = battedBallType;
      expect(
        parseStagingGameDocumentV2(document).events.find(
          (event) => event.kind === "plate_result" && event.payload.result === "single",
        )?.payload,
      ).toEqual(expect.objectContaining({ battedBallType }));
    },
  );
});
