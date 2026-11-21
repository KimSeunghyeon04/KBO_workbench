import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { normalizeNaverRelay } from "@kbo/collection";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { makeDocument } from "../helpers/game-document.js";

const rows = Value.Decode(
  Type.Array(Type.Record(Type.String(), Type.Unknown())),
  JSON.parse(
    await readFile("tests/fixtures/naver/same-play-runner-continuation.anonymized.json", "utf8"),
  ) as unknown,
);
const base = parseStagingGameDocumentV2(makeDocument([]));
const names: Readonly<Record<string, string>> = {
  a1: "동명주자",
  ar1: "동명주자",
  a2: "선행주자",
  a3: "앞선주자",
  a4: "타자",
};
const players = [
  ...base.rosters.away.players.map((player) => ({
    ...player,
    name: names[player.playerId] ?? player.name,
    side: "away" as const,
  })),
  ...base.rosters.home.players.map((player) => ({ ...player, side: "home" as const })),
];
function normalize(input: readonly Record<string, unknown>[]) {
  return normalizeNaverRelay({
    gameId: "anonymous-runner-continuation",
    players,
    startingPitchers: { home: "hp1", away: null },
    closeTrailingHalf: true,
    blocks: [
      {
        endpoint: "relay_001",
        endpointBlockIndex: 0,
        block: {
          inn: 1,
          homeOrAway: "0",
          textOptions: input.map((row, seqno) => ({ ...row, seqno })),
        },
      },
    ],
  });
}

describe("시즌 중계의 주자 연결과 중복 종료 선언", () => {
  it("점유가 잠시 겹쳐도 같은 플레이의 명시적 진루로 동명이인 주자를 연결한다", () => {
    const result = normalize(rows);
    expect(result.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(result.events).toHaveLength(rows.length);
    expect(result.events[17]).toMatchObject({
      kind: "runner_advance",
      identity: { eventIndex: 17 },
      relayText: rows[17]?.["text"],
      payload: { runnerId: "a1", fromBase: 2, outcome: "out", outKind: "tag" },
    });
    const replay = compileStagingGameDocumentV2({ ...base, events: result.events });
    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(replay.plays.at(-1)?.after.outs).toBe(3);
    expect(result.events.slice(18).map((event) => event.kind)).toEqual([
      "runner_advance",
      "runner_advance",
    ]);
    expect(result).toEqual(normalize(rows));
  });

  it("명시적 앞선 진루가 없으면 동명이인 주자의 출발 베이스를 추측하지 않는다", () => {
    const result = normalize(rows.filter((_, index) => index !== 16));
    expect(result.events[16]?.kind).toBe("unresolved");
  });

  it("같은 플레이에서 이미 아웃된 주자의 이전 안전 도착을 재사용하지 않는다", () => {
    const result = normalize([
      ...rows.slice(0, 18),
      { type: 24, text: "2루주자 동명주자 : 3루까지 진루" },
      ...rows.slice(18),
    ]);
    expect(result.events[18]?.kind).toBe("unresolved");
  });

  it("주자 ID가 명시되면 앞선 진루에서 얻은 후보로 덮어쓰지 않는다", () => {
    const result = normalize(
      rows.map((row, index) => (index === 17 ? { ...row, runnerId: "ar1" } : row)),
    );
    expect(result.events[17]).toMatchObject({
      kind: "runner_advance",
      payload: { runnerId: "ar1" },
    });
    expect(
      compileStagingGameDocumentV2({ ...base, events: result.events }).findings,
    ).toContainEqual(expect.objectContaining({ severity: "blocking" }));
  });

  it.each([false, true])(
    "첫 콜드게임 종료 뒤 안내 구간의 재선언을 보존한다 (타자 표시: %s)",
    (header) => {
      const input = [
        { type: 7, text: "강우콜드 선언" },
        ...(header
          ? [{ kind: "batter_start", batterId: "a1", pitcherId: "hp1", text: "1번타자 동명주자" }]
          : []),
        { type: 7, text: "경기 종료" },
        { type: 7, text: "강우콜드 선언" },
      ];
      const result = normalize(input);
      expect(result.events).toHaveLength(input.length);
      expect(result.events[0]).toMatchObject({
        kind: "administrative",
        payload: { code: "called_game" },
      });
      expect(result.events.at(-1)).toMatchObject({
        kind: "administrative",
        payload: { code: "announcement" },
        identity: { eventIndex: input.length - 1 },
        relayText: "강우콜드 선언",
      });
    },
  );

  it("종료 선언 뒤 실제 투구가 있으면 재선언을 안내로 숨기지 않는다", () => {
    const result = normalize([
      { type: 7, text: "강우콜드 선언" },
      { kind: "batter_start", batterId: "a1", pitcherId: "hp1" },
      { kind: "pitch", batterId: "a1", pitcherId: "hp1", call: "ball", text: "1구 볼" },
      { type: 7, text: "강우콜드 선언" },
    ]);
    expect(result.events[2]?.kind).toBe("pitch");
    expect(result.events.at(-1)).toMatchObject({ payload: { code: "called_game" } });
  });
});
