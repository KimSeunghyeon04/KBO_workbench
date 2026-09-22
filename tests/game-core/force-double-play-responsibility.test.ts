import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

const document = parseStagingGameDocumentV2(
  JSON.parse(
    await readFile(
      "tests/fixtures/correction/force-double-play-responsibility.anonymized.json",
      "utf8",
    ),
  ) as unknown,
);
const result = document.events.find(
  (event) => event.kind === "plate_result" && event.payload.result === "double_play",
);
if (result === undefined) throw new Error("missing anonymous double play");
const retired = document.events.find(
  (event) => event.kind === "runner_advance" && event.payload.outcome === "out",
);
if (retired?.kind !== "runner_advance") throw new Error("missing anonymous force out");

describe("포스 병살의 실점 책임 승계", () => {
  it("홈 포스아웃 뒤 후속 주자의 책임을 승계하고 다음 홈런 득점까지 유지한다", () => {
    const replay = compileStagingGameDocumentV2(document);
    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    const play = replay.plays.find((play) => play.relayEventIds.includes(result.identity.eventId));
    expect(play?.before.bases[0]).toEqual({ runnerId: "h3", responsiblePitcherId: "a51" });
    expect(play?.after.bases[1]).toEqual({ runnerId: "h3", responsiblePitcherId: "a1" });
    expect(
      play?.movements.find((movement) => movement.runnerId === "h3")?.responsiblePitcherId,
    ).toBe("a1");
    expect(replay.pitcherLines.find((line) => line.playerId === "a1")?.runs).toBe(3);
    expect(replay.pitcherLines.find((line) => line.playerId === "a51")?.runs).toBe(1);
    expect(replay.finalState.awayScore).toBe(4);
    expect(compileStagingGameDocumentV2(document)).toEqual(replay);
  });

  it("비포스 병살의 아웃을 책임 승계로 확대하지 않는다", () => {
    const altered = parseStagingGameDocumentV2({
      ...document,
      events: document.events.map((event) =>
        event === retired ? { ...retired, payload: { ...retired.payload, outKind: "tag" } } : event,
      ),
    });
    const replay = compileStagingGameDocumentV2(altered);
    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(replay.pitcherLines.find((line) => line.playerId === "a1")?.runs).toBe(2);
    expect(replay.pitcherLines.find((line) => line.playerId === "a51")?.runs).toBe(2);
  });

  it("이동 검증이 실패하면 책임 변경도 일부 반영하지 않는다", () => {
    const altered = parseStagingGameDocumentV2({
      ...document,
      events: document.events.map((event) =>
        event === retired ? { ...retired, payload: { ...retired.payload, fromBase: 2 } } : event,
      ),
    });
    const replay = compileStagingGameDocumentV2(altered);
    const play = replay.plays.find((play) => play.relayEventIds.includes(result.identity.eventId));
    expect(play?.after).toEqual(play?.before);
    expect(play?.movements).toEqual([]);
    expect(replay.findings.some((finding) => finding.code === "runner_not_at_origin")).toBe(true);
  });
});
