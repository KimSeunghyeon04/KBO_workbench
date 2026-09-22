import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { makeDocument } from "../helpers/game-document.js";

const terminalFixture = parseStagingGameDocumentV2(
  JSON.parse(
    await readFile("tests/fixtures/correction/extra-inning-called-game.anonymized.json", "utf8"),
  ) as unknown,
);
const buntFixture = parseStagingGameDocumentV2(
  JSON.parse(
    await readFile("tests/fixtures/correction/terminal-bunt-count.anonymized.json", "utf8"),
  ) as unknown,
);

describe("시즌 보정에서 발견한 계산 회귀", () => {
  it("반이닝 없이 종료 선언만 있는 문서는 유효한 종료 근거가 아니다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([{ kind: "administrative", payload: { code: "called_game" } }], "final"),
    );
    expect(replay.findings.map((finding) => finding.code)).toContain(
      "invalid_called_game_declaration",
    );
  });
  it("명시적 종료 선언은 연장 반이닝과 미완료 타석을 닫으며 원문을 유지한다", () => {
    const document = terminalFixture;
    const replay = compileStagingGameDocumentV2(document);
    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(replay.plateAppearances.at(-1)).toMatchObject({
      terminationReason: "called_game",
      endEventId: document.events.at(-1)?.identity.eventId,
    });
    expect(replay.pitchFacts).toHaveLength(1);
  });
  it("종료 선언 뒤 투구 또는 다른 반이닝이 있으면 선언으로 불완전 경기를 통과시키지 않는다", () => {
    const document = terminalFixture;
    const pitch = document.events.at(-2);
    if (pitch === undefined) throw new Error("missing pitch");
    const replay = compileStagingGameDocumentV2({
      ...document,
      events: [
        ...document.events,
        {
          ...pitch,
          sequence: document.events.length,
          identity: { ...pitch.identity, eventId: "later" },
        },
      ],
    });
    expect(replay.findings.map((finding) => finding.code)).toContain(
      "invalid_called_game_declaration",
    );
    expect(replay.findings.map((finding) => finding.code)).toContain(
      "final_game_has_incomplete_half",
    );
  });
  it("쓰리번트 삼진이 확인된 투구의 2스트라이크 표기는 보존하되 다른 불일치는 차단한다", () => {
    const document = buntFixture;
    const replay = compileStagingGameDocumentV2(document);
    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(replay.findings).toContainEqual(
      expect.objectContaining({
        code: "source_terminal_bunt_count_display",
        severity: "warning",
        eventSequence: 4,
        details: [{ field: "strikes", expected: 2, actual: 3 }],
      }),
    );
    expect(document.events[4]?.observedStateAfter?.strikes).toBe(2);
    const withoutResult = compileStagingGameDocumentV2({
      ...document,
      events: document.events.slice(0, -1),
    });
    expect(withoutResult.findings.map((finding) => finding.code)).toContain(
      "source_observation_mismatch",
    );
    const wrong = compileStagingGameDocumentV2({
      ...document,
      events: document.events.map((event, index) =>
        index === 4 ? { ...event, observedStateAfter: { strikes: 1 } } : event,
      ),
    });
    expect(wrong.findings.map((finding) => finding.code)).toContain("source_observation_mismatch");
  });
  it("야수선택의 연속 진루를 최종 주자 순서로 계산하여 승계 책임을 보존한다", async () => {
    const document = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile(
          "tests/fixtures/correction/fielder-choice-multistep.anonymized.json",
          "utf8",
        ),
      ) as unknown,
    );
    const replay = compileStagingGameDocumentV2(document);
    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    const play = replay.plays.find((item) =>
      item.movements.some((move) => move.runnerId === "a1" && move.outcome === "out"),
    );
    expect(play?.after.bases).toEqual([
      null,
      { runnerId: "a4", responsiblePitcherId: "hp2" },
      { runnerId: "a2", responsiblePitcherId: "hp1" },
    ]);
    expect(replay.pitcherLines.find((line) => line.playerId === "hp1")?.runs).toBe(1);
    expect(replay.pitcherLines.find((line) => line.playerId === "hp2")?.runs).toBe(2);
  });
});
