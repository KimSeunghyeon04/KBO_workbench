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

  it("비정규 원문 공백과 1,000자 초과를 엄격 거부한다", async () => {
    const document = await fixture();
    const first = (document.events as Array<Record<string, unknown>>)[0];
    if (first === undefined) throw new Error("event fixture가 없습니다.");
    first.relayText = "  1회초 시작  ";
    expect(() => parseStagingGameDocumentV2(document)).toThrow(/앞뒤 공백/);
    first.relayText = "   ";
    expect(() => parseStagingGameDocumentV2(document)).toThrow(ContractValidationError);
    first.relayText = "가".repeat(1_001);
    expect(() => parseStagingGameDocumentV2(document)).toThrow(ContractValidationError);
  });

  it("양 팀 roster와 같은 유형의 공식 기록에서 선수 ID 중복을 거부한다", async () => {
    const rosterDuplicate = await fixture();
    const rosters = rosterDuplicate.rosters as Record<
      string,
      { players: Array<{ playerId: string }> }
    >;
    rosters.home.players[0] = {
      ...rosters.home.players[0],
      playerId: rosters.away.players[0]?.playerId ?? "missing",
    };
    expect(() => parseStagingGameDocumentV2(rosterDuplicate)).toThrow(/roster 선수 ID/);

    const recordDuplicate = await fixture();
    const official = recordDuplicate.officialRecords as Record<
      string,
      Array<Record<string, unknown>>
    >;
    const duplicateRecord = {
      playerId: "a1",
      side: "away",
      atBats: 0,
      runs: 0,
      hits: 0,
      homeRuns: 0,
      runsBattedIn: 0,
      walks: 0,
      strikeouts: 0,
    };
    official.batters.push(duplicateRecord, { ...duplicateRecord });
    expect(() => parseStagingGameDocumentV2(recordDuplicate)).toThrow(/공식 기록/);
  });

  it("manual 행에는 제공자 observedStateAfter를 저장하지 않는다", async () => {
    const document = await fixture();
    const first = (document.events as Array<Record<string, unknown>>)[0];
    if (first === undefined) throw new Error("event fixture가 없습니다.");
    first.identity = {
      kind: "manual",
      eventId: "0198f1e2-7d2a-7000-8000-000000000080",
    };
    first.observedStateAfter = { balls: 0, strikes: 0, outs: 0 };
    expect(() => parseStagingGameDocumentV2(document)).toThrow(/source 원장 행/);
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
