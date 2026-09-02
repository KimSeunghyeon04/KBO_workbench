import type { StagingRelayEvent } from "@kbo/contracts";
import { describe, expect, it } from "vitest";

import {
  effectiveRelayText,
  pitchOrdinalAt,
  suggestedRelayText,
  type RelayTextOptions,
} from "../../apps/web/src/events/relay-text.js";

const names = new Map([
  ["away-batter", "선수A"],
  ["away-runner", "선수B"],
  ["home-pitcher", "선수C"],
  ["home-reliever", "선수D"],
]);
const battingOrders = new Map([["away-batter", 1]]);
const options: RelayTextOptions = {
  playerName: (playerId) => names.get(playerId),
  battingOrder: (playerId) => battingOrders.get(playerId),
};

describe("Naver형 중계 문구 제안", () => {
  it("이닝·타자·투구 문구를 구조화 정보와 표시 순번으로 만든다", () => {
    const half: StagingRelayEvent = {
      ...base("half", 0),
      kind: "half_inning_start",
      payload: {},
    };
    const batter: StagingRelayEvent = {
      ...base("batter", 1),
      kind: "batter_start",
      payload: { batterId: "away-batter", pitcherId: "home-pitcher" },
    };
    const pitch: StagingRelayEvent = {
      ...base("pitch", 2),
      kind: "pitch",
      payload: { call: "called_strike" },
    };

    expect(suggestedRelayText(half, options)).toBe("1회초 시작");
    expect(suggestedRelayText(batter, options)).toBe("1번타자 선수A");
    expect(suggestedRelayText(pitch, { ...options, pitchOrdinal: 3 })).toBe("3구 스트라이크");
  });

  it("결과에는 확인된 타구 유형만 사용하고 안타 방향이나 선수 ID를 만들지 않는다", () => {
    const hit: StagingRelayEvent = {
      ...base("hit", 3),
      kind: "plate_result",
      payload: {
        result: "single",
        batterId: "away-batter",
        pitcherId: "home-pitcher",
        battedBallType: "ground_ball",
      },
    };
    const flyOut: StagingRelayEvent = {
      ...base("fly-out", 4),
      kind: "plate_result",
      payload: {
        result: "field_out",
        batterId: "away-batter",
        pitcherId: "home-pitcher",
        battedBallType: "fly_ball",
      },
    };

    expect(suggestedRelayText(hit, options)).toBe("선수A : 안타");
    expect(suggestedRelayText(flyOut, options)).toBe("선수A : 플라이 아웃");
    expect(suggestedRelayText(hit, options)).not.toMatch(/away-batter|좌전|우전|중전/);
  });

  it("주자 사유를 중계 어순에 배치하고 근거 없는 other는 생략한다", () => {
    const wildPitch: StagingRelayEvent = {
      ...base("runner-wild-pitch", 5),
      kind: "runner_advance",
      payload: {
        runnerId: "away-batter",
        fromBase: 1,
        toBase: 2,
        outcome: "safe",
        context: { kind: "independent", reason: "wild_pitch" },
      },
    };
    const other: StagingRelayEvent = {
      ...base("runner-other", 6),
      kind: "runner_advance",
      payload: {
        runnerId: "away-runner",
        fromBase: 3,
        toBase: 4,
        outcome: "scored",
        context: { kind: "independent", reason: "other" },
      },
    };
    const unknownReason: StagingRelayEvent = {
      ...base("runner-unknown-reason", 7),
      kind: "runner_advance",
      payload: {
        runnerId: "away-runner",
        fromBase: 1,
        toBase: 2,
        outcome: "safe",
        context: { kind: "independent", reason: "other" },
      },
    };

    expect(suggestedRelayText(wildPitch, options)).toBe("1루주자 선수A : 폭투로 2루까지 진루");
    expect(suggestedRelayText(other, options)).toBe("3루주자 선수B : 홈인");
    expect(suggestedRelayText(unknownReason, options)).toBe("1루주자 선수B : 2루까지 진루");
  });

  it("교체 역할과 확인된 타순·수비 위치만 문구에 사용한다", () => {
    const pitcher: StagingRelayEvent = {
      ...base("pitcher-change", 7),
      kind: "substitution",
      payload: {
        side: "home",
        role: "pitcher",
        incomingPlayerId: "home-reliever",
        outgoingPlayerId: "home-pitcher",
      },
    };
    const batter: StagingRelayEvent = {
      ...base("batter-change", 8),
      kind: "substitution",
      payload: {
        side: "away",
        role: "batter",
        incomingPlayerId: "away-runner",
        outgoingPlayerId: "away-batter",
        battingOrder: 1,
      },
    };
    const runner: StagingRelayEvent = {
      ...base("runner-change", 9),
      kind: "substitution",
      payload: {
        side: "away",
        role: "runner",
        incomingPlayerId: "away-runner",
        outgoingPlayerId: "away-batter",
      },
    };

    expect(suggestedRelayText(pitcher, options)).toBe("투수 선수C : 투수 선수D (으)로 교체");
    expect(suggestedRelayText(batter, options)).toBe("1번타자 선수A : 대타 선수B (으)로 교체");
    expect(suggestedRelayText(runner, options)).toBe("대주자 선수A : 대주자 선수B (으)로 교체");
  });

  it.each([
    [undefined, "비디오 판독"],
    ["requested", "비디오 판독 요청"],
    ["upheld", "비디오 판독 결과 : 원심 유지"],
    ["overturned", "비디오 판독 결과 : 판정 번복"],
    ["inconclusive", "비디오 판독 결과 : 판정 불가"],
  ] as const)("판독 결과 %s를 구분한다", (decision, expected) => {
    const review: StagingRelayEvent = {
      ...base(`review-${decision ?? "none"}`, 9),
      kind: "review",
      payload: decision === undefined ? {} : { decision },
    };
    expect(suggestedRelayText(review, options)).toBe(expected);
  });

  it("공지와 미해석 행을 보존하고 기존 relayText를 항상 우선한다", () => {
    const administrative: StagingRelayEvent = {
      ...base("break", 10),
      kind: "administrative",
      payload: { code: "break" },
    };
    const unresolved: StagingRelayEvent = {
      ...base("unresolved", 11),
      relayText: "확인되지 않은 원문",
      kind: "unresolved",
      payload: { sourceType: "unknown" },
    };
    const pitch: StagingRelayEvent = {
      ...base("original-pitch", 12),
      relayText: "수집된 1구 스트라이크",
      kind: "pitch",
      payload: { call: "called_strike" },
    };

    expect(suggestedRelayText(administrative, options)).toBe("경기 중단");
    expect(suggestedRelayText(unresolved, options)).toBe("확인되지 않은 원문");
    expect(effectiveRelayText(pitch, { ...options, pitchOrdinal: 1 })).toBe(
      "수집된 1구 스트라이크",
    );
  });
});

describe("표시용 투구 순번", () => {
  const events: readonly StagingRelayEvent[] = [
    { ...base("half", 0), kind: "half_inning_start", payload: {} },
    {
      ...base("batter-one", 1),
      kind: "batter_start",
      payload: { batterId: "away-batter", pitcherId: "home-pitcher" },
    },
    { ...base("pitch-one", 2), kind: "pitch", payload: { call: "ball" } },
    { ...base("pitch-two", 3), kind: "pitch", payload: { call: "automatic_ball" } },
    { ...base("pitch-three", 4), kind: "pitch", payload: { call: "no_pitch" } },
    { ...base("pitch-four", 5), kind: "pitch", payload: { call: "called_strike" } },
    {
      ...base("result", 6),
      kind: "plate_result",
      payload: {
        result: "walk",
        batterId: "away-batter",
        pitcherId: "home-pitcher",
      },
    },
    {
      ...base("batter-two", 7),
      kind: "batter_start",
      payload: { batterId: "away-runner", pitcherId: "home-pitcher" },
    },
    { ...base("next-pitch", 8), kind: "pitch", payload: { call: "ball" } },
  ];

  it("추가·교체 위치 앞의 모든 pitch 행을 세고 현재 행은 제외한다", () => {
    expect(pitchOrdinalAt(events, 3, { inning: 1, half: "top" })).toBe(2);
    expect(pitchOrdinalAt(events, 5, { inning: 1, half: "top" })).toBe(4);
  });

  it("타석 결과 뒤에는 순번을 내지 않고 다음 타석에서 1구로 초기화한다", () => {
    expect(pitchOrdinalAt(events, 7, { inning: 1, half: "top" })).toBeUndefined();
    expect(pitchOrdinalAt(events, 8, { inning: 1, half: "top" })).toBe(1);
    expect(pitchOrdinalAt(events, 8, { inning: 1, half: "bottom" })).toBeUndefined();
  });
});

function base(eventId: string, sequence: number) {
  return {
    identity: { kind: "manual" as const, eventId },
    sequence,
    inning: 1,
    half: "top" as const,
    relayText: "기존 중계 문구",
  };
}
