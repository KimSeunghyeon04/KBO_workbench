import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { normalizeNaverRelay, type RelayRosterPlayer } from "@kbo/collection";
import { mapNaverTrackingCandidates } from "../../packages/collection/src/naver/tracking-mapper.js";

const players: readonly RelayRosterPlayer[] = [
  {
    playerId: "a1",
    name: "원정선수",
    side: "away",
    battingOrder: 1,
    starter: true,
    positions: ["외야수"],
  },
  {
    playerId: "a2",
    name: "원정대타",
    side: "away",
    battingOrder: 2,
    starter: true,
    positions: ["내야수"],
  },
  { playerId: "ap1", name: "원정대타", side: "away", starter: true, positions: ["투수"] },
  {
    playerId: "a3",
    name: "원정후속",
    side: "away",
    battingOrder: 3,
    starter: true,
    positions: ["내야수"],
  },
  { playerId: "a3-bench", name: "원정후속", side: "away", starter: false, positions: ["내야수"] },
  {
    playerId: "h1",
    name: "홈야수",
    side: "home",
    battingOrder: 1,
    starter: true,
    positions: ["1루수"],
  },
  { playerId: "hp1", name: "홈투수", side: "home", starter: true, positions: ["투수"] },
];
const fixture = Value.Decode(
  Type.Record(Type.String(), Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  JSON.parse(
    await readFile("tests/fixtures/naver/season-review-relay.anonymized.json", "utf8"),
  ) as unknown,
);
function normalize(key: string) {
  const rows = fixture[key];
  if (rows === undefined) throw new Error(`fixture missing: ${key}`);
  return normalizeNaverRelay({
    gameId: "anonymous-season-review",
    blocks: [
      {
        endpoint: "relay_001",
        endpointBlockIndex: 0,
        block: {
          inn: 1,
          homeOrAway: "0",
          textOptions: rows.map((row, seqno) => ({ ...row, seqno })),
        },
      },
    ],
    players,
    startingPitchers: { home: "hp1", away: "ap1" },
    closeTrailingHalf: false,
  });
}

describe("보유 시즌 원문 유형 회귀", () => {
  it("명시적 종료 뒤 타자 표시를 원문과 위치를 가진 안내 행으로 보존한다", () => {
    const result = terminalRelay([
      { type: 7, text: "강우콜드 선언" },
      { kind: "batter_start", batterId: "a1", pitcherId: "hp1", text: "1번타자 원정선수" },
    ]);
    expect(result.events.map((event) => event.kind)).toEqual(["administrative", "administrative"]);
    expect(result.events[0]).toMatchObject({ payload: { code: "called_game" } });
    expect(result.events[1]).toMatchObject({
      identity: { eventIndex: 1 },
      relayText: "1번타자 원정선수",
    });
  });
  it("완전히 같은 종료 뒤 재전송만 분류하고 tracking 원문은 제외 근거와 함께 남긴다", () => {
    const result = terminalRelay([...lastPlay, { type: 7, text: "경기 종료" }, ...lastPlay], true);
    expect(result.events).toHaveLength(7);
    expect(result.events.slice(4).every((event) => event.kind === "administrative")).toBe(true);
    expect(result.events[5]?.identity).toMatchObject({ blockIndex: 1, eventIndex: 1 });
    const tracking = mapNaverTrackingCandidates("anonymous-season-review", result);
    expect(tracking.candidates).toHaveLength(1);
    expect(tracking.candidates[0]?.resolution).toMatchObject({
      kind: "excluded",
      reason: "not_a_pitch",
    });
    expect(tracking.findings).toEqual([]);
  });
  it("투구 ID 누락·변경된 내용·종료 근거 없는 반복은 자동 분류하지 않는다", () => {
    const withNoPitch = [
      lastPlay[0] ?? {},
      { type: 7, text: "투수 투수판 이탈" },
      ...lastPlay.slice(1),
    ];
    expect(
      terminalRelay([...withNoPitch, { type: 7, text: "경기 종료" }, ...withNoPitch])
        .events.slice(5)
        .every((event) => event.kind === "administrative"),
    ).toBe(true);
    for (const rows of [
      [...lastPlay, ...lastPlay],
      [
        ...lastPlay,
        { type: 7, text: "경기 종료" },
        ...lastPlay.map((row, index) => (index === 1 ? { ...row, speed: 145 } : row)),
      ],
      [...lastPlay, { type: 7, text: "경기 종료" }, ...lastPlay].map((row) => ({
        ...row,
        sourcePitchId: null,
      })),
    ]) {
      expect(terminalRelay(rows).events.at(-1)?.kind).toBe("plate_result");
    }
  });
  it("수비위치 변경의 동일 선수와 새 투수 역할을 보존한다", () => {
    expect(normalize("shift").events[0]).toMatchObject({
      kind: "substitution",
      payload: { role: "pitcher", incomingPlayerId: "h1", fieldPosition: "투수", side: "home" },
    });
  });
  it("나가는 투수의 역할을 들어오는 야수에게 적용하지 않는다", () => {
    expect(normalize("pitcherToFielder").events[0]).toMatchObject({
      kind: "substitution",
      payload: {
        role: "fielder",
        incomingPlayerId: "h1",
        outgoingPlayerId: "hp1",
        fieldPosition: "3루수",
      },
    });
  });
  it("동명이인 대타 재교체의 나가는 선수를 현재 타석으로 한정한다", () => {
    const result = normalize("repeatedPinchHitter");
    expect(result.findings).toEqual([]);
    expect(result.events[1]).toMatchObject({
      kind: "substitution",
      payload: { role: "batter", incomingPlayerId: "a3", outgoingPlayerId: "a2" },
    });
  });
  it("최종 베이스 관찰이 다른 주자여도 행의 유일한 타자 주자 이름을 보존한다", () => {
    const result = normalize("batterRunner");
    expect(result.findings).toEqual([]);
    expect(result.events[5]).toMatchObject({
      kind: "runner_advance",
      payload: { runnerId: "a3", fromBase: 1, toBase: 2 },
    });
    expect(result.events[6]).toMatchObject({
      kind: "runner_advance",
      payload: { runnerId: "a1", fromBase: 1, toBase: 3 },
    });
  });
  it("포수 피치클락 위반 볼은 투구 ID 없는 자동 볼이다", () => {
    expect(normalize("catcherClock").events[1]).toMatchObject({
      kind: "pitch",
      payload: { call: "automatic_ball" },
      relayText: "2구 피치클락 포수위반 볼",
    });
  });
});

const lastPlay = [
  { kind: "batter_start", batterId: "a1", pitcherId: "hp1", text: "1번타자 원정선수" },
  {
    kind: "pitch",
    call: "in_play",
    batterId: "a1",
    pitcherId: "hp1",
    sourcePitchId: "pitch-final",
    text: "1구 타격",
  },
  {
    kind: "plate_result",
    result: "field_out",
    batterId: "a1",
    pitcherId: "hp1",
    text: "원정선수 : 땅볼 아웃",
  },
];
function terminalRelay(rows: readonly Record<string, unknown>[], split = false) {
  const groups = split ? [rows.slice(0, 4), rows.slice(4)] : [rows];
  return normalizeNaverRelay({
    gameId: "anonymous-season-review",
    players,
    startingPitchers: { home: "hp1", away: "ap1" },
    closeTrailingHalf: true,
    blocks: groups.map((group, blockIndex) => ({
      endpoint: "relay_010",
      endpointBlockIndex: blockIndex,
      block: {
        no: blockIndex,
        inn: 10,
        homeOrAway: "0",
        textOptions: group.map((row, seqno) => ({ ...row, seqno })),
        ...(split && blockIndex === 1 ? { ptsOptions: [{ pitchId: "pitch-final", x0: 1 }] } : {}),
      },
    })),
  });
}
