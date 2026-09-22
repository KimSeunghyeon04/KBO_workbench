import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

const document = parseStagingGameDocumentV2(
  JSON.parse(
    await readFile("tests/fixtures/correction/stationary-inherited-runner.anonymized.json", "utf8"),
  ) as unknown,
);

describe("검토 경기의 움직이지 않은 승계주자", () => {
  it("야수선택 때 2루에 남은 주자도 이전 투수 책임을 이어받고 후속 득점에 반영한다", () => {
    const replay = compileStagingGameDocumentV2(document);
    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    const result = document.events.find(
      (event) => event.kind === "plate_result" && event.payload.result === "fielder_choice",
    );
    if (result === undefined) throw new Error("fixture의 야수선택 결과가 없습니다.");
    const play = replay.plays.find((item) => item.relayEventIds.includes(result.identity.eventId));
    if (play === undefined) throw new Error("야수선택 play가 없습니다.");
    const stationary = play.before.bases[1];
    const retired = play.before.bases[2];
    if (stationary === null || retired === null)
      throw new Error("승계주자 fixture가 잘못됐습니다.");
    expect(play.after.bases[1]).toEqual({
      runnerId: stationary.runnerId,
      responsiblePitcherId: retired.responsiblePitcherId,
    });
    expect(play.movements.some((movement) => movement.runnerId === stationary.runnerId)).toBe(
      false,
    );
    expect(
      replay.pitcherLines.find((line) => line.playerId === retired.responsiblePitcherId)?.runs,
    ).toBe(4);
    expect(
      replay.pitcherLines.find((line) => line.playerId === stationary.responsiblePitcherId)?.runs,
    ).toBe(0);
    expect(compileStagingGameDocumentV2(document)).toEqual(replay);
  });

  it("같은 play의 이동 검증이 실패하면 책임 변경과 득점도 함께 취소한다", () => {
    const result = document.events.find(
      (event) => event.kind === "plate_result" && event.payload.result === "fielder_choice",
    );
    if (result === undefined) throw new Error("fixture의 야수선택 결과가 없습니다.");
    const altered = {
      ...document,
      events: document.events.map((event) =>
        event.kind === "runner_advance" &&
        event.payload.context.kind === "plate_result" &&
        event.payload.context.plateResultEventId === result.identity.eventId
          ? { ...event, payload: { ...event.payload, fromBase: 1 as const } }
          : event,
      ),
    };
    const replay = compileStagingGameDocumentV2(altered);
    expect(replay.findings.map((finding) => finding.code)).toContain("runner_not_at_origin");
    const rejected = replay.plays.find((play) =>
      play.relayEventIds.includes(result.identity.eventId),
    );
    expect(rejected?.after).toEqual(rejected?.before);
    expect(rejected?.movements).toEqual([]);
  });
});
