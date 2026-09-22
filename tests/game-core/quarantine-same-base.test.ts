import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { parseStagingRelayEvent } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { makeDocument } from "../helpers/game-document.js";

const rows = Value.Decode(
  Type.Array(Type.Record(Type.String(), Type.Unknown())),
  JSON.parse(
    await readFile("tests/fixtures/correction/same-base-then-score.anonymized.json", "utf8"),
  ) as unknown,
);
const prefix = makeDocument([
  { kind: "half_inning_start", payload: {} },
  { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
  { kind: "plate_result", payload: { result: "triple", batterId: "a1", pitcherId: "hp1" } },
  { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
]);
const document = {
  ...prefix,
  events: [
    ...prefix.events,
    ...rows.map((row, offset) =>
      parseStagingRelayEvent({
        ...row,
        sequence: offset + 4,
        inning: 1,
        half: "top",
        identity: {
          kind: "source",
          eventId: `e${String(offset + 4)}`,
          endpoint: "relay_001",
          blockIndex: 0,
          eventIndex: offset,
        },
      }),
    ),
  ],
};

describe("검토 경기의 같은 베이스 생존 뒤 득점", () => {
  it("3루 생존 행 다음 3루 득점을 연속 이동으로 적용하고 원문 세 행을 유지한다", () => {
    const replay = compileStagingGameDocumentV2(document);
    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(replay.plays.at(-1)?.after).toMatchObject({
      awayScore: 1,
      outs: 1,
      bases: [null, null, null],
    });
    expect(replay.plays.at(-1)?.relayEventIds).toEqual(["e4", "e5", "e6"]);
  });
  it("실제 출발지를 두 번 떠나는 중복 이동은 계속 차단한다", () => {
    const altered = {
      ...document,
      events: document.events.map((event) =>
        event.identity.eventId === "e5" && event.kind === "runner_advance"
          ? { ...event, payload: { ...event.payload, toBase: 2 as const } }
          : event,
      ),
    };
    const replay = compileStagingGameDocumentV2(altered);
    expect(replay.findings.map((finding) => finding.code)).toContain("movement_origin_duplicated");
    expect(replay.plays.at(-1)?.after.awayScore).toBe(0);
  });
});
