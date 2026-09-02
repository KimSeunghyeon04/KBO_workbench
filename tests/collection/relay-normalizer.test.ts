import { describe, expect, it } from "vitest";

import { normalizeNaverRelay, type RelayBlockInput, type RelayRosterPlayer } from "@kbo/collection";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

const players: readonly RelayRosterPlayer[] = [
  player("a1", "원정1", "away", 1),
  player("a2", "원정2", "away", 2),
  player("a3", "원정3", "away", 3),
  player("hp1", "홈투수", "home", undefined, ["투수"]),
  player("h1", "홈1", "home", 1),
  player("h2", "홈2", "home", 2),
  player("ap1", "원정투수", "away", undefined, ["투수"]),
];

describe("Naver 평면 relay 원장 정규화", () => {
  it("볼넷 결과 앞의 정상적인 4구 볼은 사구로 바꾸지 않는다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      row(2, "pitch", "4구 볼", {
        call: "ball",
        batterId: "a1",
        pitcherId: "hp1",
      }),
      row(3, "plate_result", "원정1 : 볼넷", {
        result: "walk",
        batterId: "a1",
        pitcherId: "hp1",
      }),
    ]);

    expect(normalized.events[2]).toMatchObject({
      kind: "pitch",
      payload: { call: "ball" },
    });
  });

  it.each([
    ["원정1 : 3루수 내야플라이 아웃", "popup", false],
    ["원정1 : 유격수 라인드라이브 아웃", "line_drive", false],
    ["원정1 : 유격수 땅볼 아웃", "ground_ball", false],
    ["원정1 : 중견수 뜬공 아웃", "fly_ball", false],
    ["원정1 : 3루수 번트 땅볼 아웃", "ground_ball", true],
  ] as const)("원문 타구 유형을 분류하고 원문을 그대로 보존한다: %s", (text, type, isBunt) => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      row(2, "plate_result", text, { result: "field_out", batterId: "a1", pitcherId: "hp1" }),
    ]);
    const result = normalized.events.find((event) => event.kind === "plate_result");
    expect(result?.kind).toBe("plate_result");
    if (result?.kind !== "plate_result") return;
    expect(result.relayText).toBe(text);
    expect(result.payload).toMatchObject({ battedBallType: type, isBunt });
    expect(result.payload).not.toHaveProperty("movements");
  });

  it("희생번트 야수선택 출루는 희생번트와 타자 생존을 함께 보존한다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      row(2, "plate_result", "원정1 : 투수 희생번트 야수선택으로 출루", {
        result: "fielder_choice",
        batterId: "a1",
        pitcherId: "hp1",
      }),
    ]);

    const result = normalized.events[2];
    expect(result?.kind === "plate_result" ? result.payload : null).toMatchObject({
      result: "sacrifice_bunt",
      batterDestination: 1,
      isBunt: true,
    });
  });

  it("모든 원천 행을 같은 위치와 원문을 가진 원장 행 하나로 보존한다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "administrative", "마운드 방문", { code: "mound_visit" }),
      row(2, "review", "비디오 판독 요청", { decision: "requested" }),
      { seqno: 3, type: 77, text: "알 수 없는 형식" },
    ]);
    expect(normalized.events.map((event) => event.kind)).toEqual([
      "half_inning_start",
      "administrative",
      "review",
      "unresolved",
    ]);
    expect(normalized.events.map((event) => event.identity)).toEqual(
      normalized.events.map((_, index) =>
        expect.objectContaining({ endpoint: "relay_001", blockIndex: 0, eventIndex: index }),
      ),
    );
    expect(normalized.events.at(-1)?.relayText).toBe("알 수 없는 형식");
    expect(normalized.findings).toEqual([
      expect.objectContaining({
        code: "source.relay.classification.kind.unclassified",
        severity: "blocking",
        eventId: normalized.events.at(-1)?.identity.eventId,
        endpoint: "relay_001",
        blockIndex: 0,
        rowIndex: 3,
        sourceEventId: "3",
        sourceText: "알 수 없는 형식",
      }),
    ]);
    expect(compileStagingGameDocumentV2(documentFor(normalized.events)).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unresolved_relay_row" })]),
    );
  });

  it("한 행 실패 뒤의 후속 타석과 다음 반이닝을 버리지 않는다", () => {
    const normalized = normalize(
      [
        row(0, "half_inning_start", "1회초 시작"),
        row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
        { seqno: 2, type: 1, text: "알 수 없는 투구 판정" },
        row(3, "batter_start", "원정2 타석", { batterId: "a2", pitcherId: "hp1" }),
      ],
      [block(1, "bottom", [row(4, "half_inning_start", "1회말 시작")])],
    );
    expect(normalized.events.map((event) => event.kind)).toEqual([
      "half_inning_start",
      "batter_start",
      "unresolved",
      "batter_start",
      "half_inning_start",
    ]);
  });

  it("같은 팀의 동명이인을 문구만으로 임의 선택하지 않는다", () => {
    const ambiguousPlayers = [
      ...players,
      player("dup1", "김태훈", "away", 7),
      player("dup2", "김태훈", "away", 8),
    ];
    const normalized = normalizeNaverRelay({
      gameId: "20260820TEST0",
      blocks: [block(1, "top", [row(0, "batter_start", "김태훈 타석", { pitcherId: "hp1" })])],
      players: ambiguousPlayers,
      startingPitchers: { away: "ap1", home: "hp1" },
      closeTrailingHalf: false,
    });

    expect(normalized.events[0]).toMatchObject({
      kind: "unresolved",
      payload: { suspectedKind: "batter_start" },
    });
    expect(normalized.findings[0]?.code).toContain("source.relay.entity.batter.unresolved");
  });

  it("명시적 선수 ID가 예상 팀 roster와 충돌하면 문맥 선수로 대체하지 않는다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "h1", pitcherId: "hp1" }),
      row(2, "batter_start", "원정2 타석", { batterId: "a2", pitcherId: "hp1" }),
    ]);

    expect(normalized.events.map((event) => event.kind)).toEqual([
      "half_inning_start",
      "unresolved",
      "batter_start",
    ]);
    expect(normalized.events[2]).toMatchObject({
      kind: "batter_start",
      payload: { batterId: "a2", pitcherId: "hp1" },
    });
  });

  it("ID 없는 같은 투구는 중복 제거하지 않고 인공 ID도 만들지 않는다", () => {
    const duplicate = row(2, "pitch", "1구 볼", { call: "ball", batterId: "a1", pitcherId: "hp1" });
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      duplicate,
      { ...duplicate, seqno: 3 },
    ]);
    const pitches = normalized.events.filter((event) => event.kind === "pitch");
    expect(pitches).toHaveLength(2);
    for (const pitch of pitches) expect(pitch.payload).not.toHaveProperty("sourcePitchId");
  });

  it("의미 필드가 같은 인접 행과 반복 묶음도 원천 행별로 보존한다", () => {
    const start = row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" });
    const pitch = row(2, "pitch", "1구 볼", {
      call: "ball",
      source_pitch_id: "p1",
      batterId: "a1",
      pitcherId: "hp1",
    });
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      start,
      { ...start, seqno: 2 },
      pitch,
      row(4, "administrative", "공지", { code: "announcement" }),
      { ...pitch, seqno: 5 },
      row(6, "administrative", "공지", { code: "announcement" }),
    ]);
    expect(normalized.events.map((event) => event.kind)).toEqual([
      "half_inning_start",
      "batter_start",
      "batter_start",
      "pitch",
      "administrative",
      "pitch",
      "administrative",
    ]);
  });

  it("연결 주자 행은 결과 뒤 독립 행으로 남고 compiler에서 한 play가 된다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      row(2, "plate_result", "원정1 : 고의4구", {
        result: "intentional_walk",
        batterId: "a1",
        pitcherId: "hp1",
      }),
      row(3, "batter_start", "원정2 타석", { batterId: "a2", pitcherId: "hp1" }),
      row(4, "plate_result", "원정2 : 안타", {
        result: "single",
        batterId: "a2",
        pitcherId: "hp1",
      }),
      row(5, "administrative", "판정 확인 중", { code: "announcement" }),
      row(6, "runner_advance", "1루주자 원정1 : 2루 진루", {
        runnerId: "a1",
        fromBase: 1,
        toBase: 2,
        outcome: "safe",
      }),
    ]);
    const document = documentFor(normalized.events);
    const compiled = compileStagingGameDocumentV2(document);
    const play = compiled.plays.find(
      (item) =>
        item.kind === "plate_result" &&
        item.relayEventIds.includes(normalized.events[4]?.identity.eventId ?? ""),
    );
    expect(normalized.events.filter((event) => event.kind === "runner_advance")).toHaveLength(1);
    expect(play?.relayEventIds).toHaveLength(3);
    expect(play?.movements.map((movement) => movement.runnerId).sort()).toEqual(["a1", "a2"]);
    expect(play?.applied).toBe(true);
  });

  it("독립 사유가 있는 주자 행을 앞 타석 결과에 잘못 연결하지 않는다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "runner_advance", "1루주자 원정1 : 2루 도루 성공", {
        runnerId: "a1",
        fromBase: 1,
        toBase: 2,
        outcome: "safe",
      }),
    ]);
    const runner = normalized.events[1];
    expect(runner?.kind === "runner_advance" ? runner.payload.context : null).toEqual({
      kind: "independent",
      reason: "stolen_base",
    });
  });

  it("원천 result가 field_out이어도 땅볼로 출루한 행은 야수선택으로 보존한다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      row(2, "plate_result", "원정1 : 3루수 앞 땅볼로 출루", {
        result: "field_out",
        batterId: "a1",
        pitcherId: "hp1",
      }),
    ]);

    const result = normalized.events[2];
    expect(result?.kind === "plate_result" ? result.payload.result : null).toBe("fielder_choice");
  });

  it.each([
    ["원정1 : 투수 희생번트 실책으로 출루", "sacrifice_bunt"],
    ["원정1 : 우익수 희생플라이 (우익수 실책)", "sacrifice_fly"],
    ["원정1 : 유격수 병살타로 출루", "double_play"],
  ] as const)("복합 결과가 타자 생존을 명시하면 도착 베이스를 보존한다: %s", (text, result) => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      row(2, "plate_result", text, { result, batterId: "a1", pitcherId: "hp1" }),
    ]);

    const plateResult = normalized.events[2];
    expect(
      plateResult?.kind === "plate_result" ? plateResult.payload.batterDestination : null,
    ).toBe(1);
  });

  it("원천 result보다 쓰리번트 아웃 문구를 우선해 삼진으로 분류한다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      row(2, "plate_result", "원정1 : 포수 쓰리번트 아웃", {
        result: "field_out",
        batterId: "a1",
        pitcherId: "hp1",
      }),
    ]);

    const result = normalized.events[2];
    expect(result?.kind === "plate_result" ? result.payload.result : null).toBe("strikeout");
    expect(result?.kind === "plate_result" ? result.payload : null).not.toHaveProperty(
      "battedBallType",
    );
    expect(result?.kind === "plate_result" ? result.payload : null).not.toHaveProperty("isBunt");
    expect(() => compileStagingGameDocumentV2(documentFor(normalized.events))).not.toThrow();
  });

  it.each([
    ["원정1 : 포수 스트라이크 낫 아웃 (포수 태그아웃)", undefined],
    ["원정1 : 포수 스트라이크 낫 아웃 (포수->1루수 1루 터치아웃)", undefined],
    ["원정1 : 스트라이크 낫아웃 폭투", 1],
    ["원정1 : 스트라이크 낫아웃 포일", 1],
    ["원정1 : 포수 스트라이크 낫아웃 실책으로 출루", 1],
  ] as const)("낫아웃 문구의 실제 타자 생존 여부만 보존한다: %s", (text, destination) => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      row(2, "plate_result", text, {
        result: "strikeout",
        batterId: "a1",
        pitcherId: "hp1",
      }),
    ]);

    const result = normalized.events[2];
    expect(result?.kind === "plate_result" ? result.payload.batterDestination : undefined).toBe(
      destination,
    );
  });

  it("이중도루 실패 상황에서 진루한 주자를 도루 실패 아웃으로 오인하지 않는다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "runner_advance", "1루주자 원정1 : 이중도루 실패시 2루까지 진루", {
        runnerId: "a1",
        fromBase: 1,
        toBase: 2,
      }),
      row(2, "runner_advance", "2루주자 원정2 : 이중도루 실패 아웃", {
        runnerId: "a2",
        fromBase: 2,
        toBase: 3,
      }),
    ]);

    const [safeRunner, outRunner] = normalized.events.slice(1);
    expect(safeRunner?.kind === "runner_advance" ? safeRunner.payload : null).toMatchObject({
      outcome: "safe",
      context: { kind: "independent", reason: "stolen_base" },
    });
    expect(outRunner?.kind === "runner_advance" ? outRunner.payload : null).toMatchObject({
      outcome: "out",
      context: { kind: "independent", reason: "caught_stealing" },
    });
  });

  it("pitch clock award와 no-pitch에는 인공 source ID를 넣지 않는다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      { seqno: 2, type: 7, text: "피치클락 투수 위반 볼" },
      { seqno: 3, type: 7, text: "투수판 이탈 no-pitch" },
    ]);
    const pitches = normalized.events.filter((event) => event.kind === "pitch");
    expect(pitches.map((event) => event.payload.call)).toEqual(["automatic_ball", "no_pitch"]);
    for (const pitch of pitches) expect(pitch.payload).not.toHaveProperty("sourcePitchId");
  });

  it("투수 피치클락 경고 직후 ID 없는 볼을 automatic ball로 보존한다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      { seqno: 2, type: 7, text: "피치클락 위반 투수 경고 : 홈투수" },
      {
        seqno: 3,
        type: 1,
        text: "2구 볼",
        pitchResult: "B",
        batterId: "a1",
        pitcherId: "hp1",
      },
    ]);

    const pitch = normalized.events[3];
    expect(pitch?.kind === "pitch" ? pitch.payload.call : null).toBe("automatic_ball");
    expect(pitch?.kind === "pitch" ? pitch.payload.sourcePitchId : undefined).toBeUndefined();
  });

  it.each([
    ["1회초 5번타순 4구 후 피치클락 위반 투수 경고 : 홈투수", "5구 볼", "B", "ball"],
    [
      "8회말 7번타순 초구 전 피치클락 위반 타자 경고 : 원정1",
      "1구 스트라이크",
      "S",
      "called_strike",
    ],
    [
      "2회초 4번타순 초구 전 피치클락 위반 타자 경고 : 원정1",
      "1구 번트헛스윙",
      "W",
      "swinging_strike",
    ],
  ] as const)(
    "투구 위치를 명시한 피치클락 경고 뒤 실제 투구는 자동 판정으로 바꾸지 않는다: %s",
    (warning, pitchText, pitchResult, expected) => {
      const normalized = normalize([
        row(0, "half_inning_start", "1회초 시작"),
        row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
        { seqno: 2, type: 7, text: warning },
        {
          seqno: 3,
          type: 1,
          text: pitchText,
          pitchResult,
          batterId: "a1",
          pitcherId: "hp1",
        },
      ]);

      const pitch = normalized.events[3];
      expect(pitch?.kind === "pitch" ? pitch.payload.call : null).toBe(expected);
    },
  );

  it("provider block 번호로 역순 endpoint 배열을 시간순으로 복원한다", () => {
    const blocks = [
      numberedBlock(1, "top", 3, [
        row(3, "plate_result", "원정1 : 안타", {
          result: "single",
          batterId: "a1",
          pitcherId: "hp1",
        }),
      ]),
      numberedBlock(1, "top", 2, [
        row(2, "pitch", "1구 타격", {
          call: "in_play",
          sourcePitchId: "p1",
          batterId: "a1",
          pitcherId: "hp1",
        }),
      ]),
      numberedBlock(1, "top", 1, [
        row(1, "batter_start", "1번타자 원정1", { batterId: "a1", pitcherId: "hp1" }),
      ]),
      numberedBlock(1, "top", 0, [row(0, "half_inning_start", "1회초 원정 공격")]),
    ];
    const normalized = normalizeNaverRelay({
      gameId: "20260820TEST0",
      blocks,
      players,
      startingPitchers: { away: "ap1", home: "hp1" },
      closeTrailingHalf: false,
    });

    expect(normalized.events.map((event) => event.kind)).toEqual([
      "half_inning_start",
      "batter_start",
      "pitch",
      "plate_result",
    ]);
    expect(
      compileStagingGameDocumentV2(documentFor(normalized.events)).findings.map(
        (finding) => finding.code,
      ),
    ).not.toEqual(expect.arrayContaining(["event_without_half", "event_half_mismatch"]));
  });

  it("seqno가 재시작된 corrected suffix도 이전 text와 함께 원천 행별로 보존한다", () => {
    const normalized = normalizeNaverRelay({
      gameId: "20260820TEST0",
      blocks: [
        numberedBlock(1, "top", 0, [row(0, "half_inning_start", "1회초 시작")], "시작"),
        {
          ...numberedBlock(
            1,
            "top",
            1,
            [
              row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
              row(2, "pitch", "잘못 전송된 1구 볼", {
                call: "ball",
                sourcePitchId: "old-pitch",
              }),
            ],
            "원정1 타석",
          ),
          block: {
            ...numberedBlock(1, "top", 1, [], "원정1 타석").block,
            textOptions: [
              row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
              row(2, "pitch", "잘못 전송된 1구 볼", {
                call: "ball",
                sourcePitchId: "old-pitch",
              }),
            ],
            ptsOptions: [{ pitchId: "old-pitch" }],
          },
        },
        numberedBlock(
          1,
          "top",
          2,
          [
            row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
            row(2, "pitch", "정정된 1구 스트라이크", {
              call: "called_strike",
              sourcePitchId: "new-pitch",
            }),
          ],
          "원정1 타석",
        ),
      ],
      players,
      startingPitchers: { away: "ap1", home: "hp1" },
      closeTrailingHalf: false,
    });

    expect(normalized.events.map((event) => event.relayText)).toEqual([
      "1회초 시작",
      "원정1 타석",
      "잘못 전송된 1구 볼",
      "원정1 타석",
      "정정된 1구 스트라이크",
    ]);
    expect(normalized.blocks.some((item) => Array.isArray(item.block.ptsOptions))).toBe(true);
  });

  it("구조화 playerChange와 대타 확인 머리글을 같은 열린 타석 문맥으로 처리한다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "3번타자 원정3", { batterId: "a3", pitcherId: "hp1" }),
      {
        seqno: 2,
        type: 2,
        text: "3번타자 원정3 : 대타 원정2 (으)로 교체",
        playerChange: {
          type: "change",
          outPlayer: { playerId: "a3", playerName: "원정3", playerPos: "3번타자" },
          inPlayer: { playerId: "a2", playerName: "원정2", playerPos: "대타" },
        },
      },
      row(3, "batter_start", "대타 원정2", { batterId: "a2", pitcherId: "hp1" }),
      row(4, "pitch", "1구 볼", {
        call: "ball",
        batterId: "a2",
        pitcherId: "hp1",
      }),
    ]);
    const substitution = normalized.events.find((event) => event.kind === "substitution");
    expect(substitution?.kind === "substitution" ? substitution.payload : null).toMatchObject({
      side: "away",
      role: "batter",
      incomingPlayerId: "a2",
      outgoingPlayerId: "a3",
      battingOrder: 3,
    });
    expect(
      compileStagingGameDocumentV2(documentFor(normalized.events)).findings.map(
        (finding) => finding.code,
      ),
    ).not.toContain("plate_appearance_overlap");
  });

  it("교체 문구 양쪽에 대주자와 대타가 함께 있으면 들어오는 대타 역할을 사용한다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      {
        seqno: 1,
        type: 2,
        text: "대주자 원정1 : 대타 원정2 (으)로 교체",
        playerChange: { type: "change" },
      },
    ]);

    const substitution = normalized.events[1];
    expect(substitution?.kind === "substitution" ? substitution.payload : null).toMatchObject({
      role: "batter",
      incomingPlayerId: "a2",
      outgoingPlayerId: "a1",
    });
  });

  it("동명이인 주자는 직전 관측 베이스의 선수 ID로 한정해 해석한다", () => {
    const duplicatePlayers = [
      ...players,
      player("dup1", "김태훈", "away"),
      player("dup2", "김태훈", "away"),
    ];
    const normalized = normalizeNaverRelay({
      gameId: "20260820TEST0",
      blocks: [
        block(1, "top", [
          row(0, "half_inning_start", "1회초 시작"),
          {
            seqno: 1,
            type: 7,
            text: "주자 확인",
            currentGameState: { base1: "dup2" },
          },
          {
            seqno: 2,
            type: 14,
            text: "1루주자 김태훈 : 주자의 재치로 2루까지 진루",
            outcome: "safe",
          },
        ]),
      ],
      players: duplicatePlayers,
      startingPitchers: { away: "ap1", home: "hp1" },
      closeTrailingHalf: false,
    });

    const runner = normalized.events[2];
    expect(runner?.kind === "runner_advance" ? runner.payload.runnerId : null).toBe("dup2");
  });

  it("플레이 종료 snapshot의 출발 베이스에 들어온 후행 주자를 이동 주자로 오인하지 않는다", () => {
    const finalPlayState = {
      base1: "a3",
      base2: "a1",
      base3: "a2",
      batter: "a3",
      pitcher: "hp1",
    };
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      row(2, "plate_result", "원정1 : 1루타", {
        result: "single",
        batterId: "a1",
        pitcherId: "hp1",
      }),
      row(3, "batter_start", "원정2 타석", { batterId: "a2", pitcherId: "hp1" }),
      row(4, "plate_result", "원정2 : 2루타", {
        result: "double",
        batterId: "a2",
        pitcherId: "hp1",
      }),
      row(5, "batter_start", "원정3 타석", { batterId: "a3", pitcherId: "hp1" }),
      row(6, "plate_result", "원정3 : 볼넷", {
        result: "walk",
        batterId: "a3",
        pitcherId: "hp1",
        currentGameState: finalPlayState,
      }),
      row(7, "runner_advance", "1루주자 원정1 : 2루까지 진루", {
        outcome: "safe",
        currentGameState: finalPlayState,
      }),
      row(8, "runner_advance", "2루주자 원정2 : 3루까지 진루", {
        outcome: "safe",
        currentGameState: finalPlayState,
      }),
    ]);

    const movements = normalized.events.filter((event) => event.kind === "runner_advance");
    expect(movements.map((event) => event.payload.runnerId)).toEqual(["a1", "a2"]);
  });

  it("동명이인 주자는 앞선 typed 결과로 확인한 출발 베이스 ID로 해석한다", () => {
    const duplicatePlayers = [
      ...players,
      player("dup1", "김태훈", "away"),
      player("dup2", "김태훈", "away"),
    ];
    const normalized = normalizeNaverRelay({
      gameId: "20260820TEST0",
      blocks: [
        block(1, "top", [
          row(0, "half_inning_start", "1회초 시작"),
          row(1, "batter_start", "김태훈 타석", { batterId: "dup2", pitcherId: "hp1" }),
          row(2, "plate_result", "김태훈 : 중견수 앞 1루타", {
            result: "single",
            batterId: "dup2",
            pitcherId: "hp1",
          }),
          row(3, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
          row(4, "plate_result", "원정1 : 우익수 앞 1루타", {
            result: "single",
            batterId: "a1",
            pitcherId: "hp1",
          }),
          { seqno: 5, type: 14, text: "1루주자 김태훈 : 2루까지 진루", outcome: "safe" },
        ]),
      ],
      players: duplicatePlayers,
      startingPitchers: { away: "ap1", home: "hp1" },
      closeTrailingHalf: false,
    });

    const runner = normalized.events[5];
    expect(runner?.kind === "runner_advance" ? runner.payload.runnerId : null).toBe("dup2");
  });

  it("raw 표시 필드만 다른 의미상 같은 투구 재전송도 각각 보존한다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      row(1, "batter_start", "원정1 타석", { batterId: "a1", pitcherId: "hp1" }),
      row(2, "pitch", "1구 볼", {
        call: "ball",
        source_pitch_id: "p1",
        batterId: "a1",
        pitcherId: "hp1",
        displayIndex: 1,
      }),
      row(3, "pitch", "1구 볼", {
        call: "ball",
        source_pitch_id: "p1",
        batterId: "a1",
        pitcherId: "hp1",
        displayIndex: 2,
      }),
    ]);

    expect(normalized.events.filter((event) => event.kind === "pitch")).toHaveLength(2);
  });

  it("ID 없는 playerChange text도 양쪽 선수명을 roster에서 안전하게 해석한다", () => {
    const normalized = normalize([
      row(0, "half_inning_start", "1회초 시작"),
      {
        seqno: 1,
        type: 2,
        text: "2루수 홈1 : 2루수 홈2 (으)로 교체",
        playerChange: { type: "text" },
      },
    ]);
    const substitution = normalized.events[1];
    expect(substitution?.kind).toBe("substitution");
    expect(substitution?.kind === "substitution" ? substitution.payload : null).toMatchObject({
      side: "home",
      role: "fielder",
      incomingPlayerId: "h2",
      outgoingPlayerId: "h1",
    });
  });
});

function normalize(
  rows: readonly Readonly<Record<string, unknown>>[],
  extras: readonly RelayBlockInput[] = [],
) {
  return normalizeNaverRelay({
    gameId: "20260820TEST0",
    blocks: [block(1, "top", rows), ...extras],
    players,
    startingPitchers: { away: "ap1", home: "hp1" },
    closeTrailingHalf: false,
  });
}
function block(
  inning: number,
  half: "top" | "bottom",
  textOptions: readonly Readonly<Record<string, unknown>>[],
): RelayBlockInput {
  return {
    endpoint: `relay_${String(inning).padStart(3, "0")}`,
    endpointBlockIndex: half === "top" ? 0 : 1,
    block: { inn: inning, homeOrAway: half === "top" ? "0" : "1", textOptions },
  };
}
function numberedBlock(
  inning: number,
  half: "top" | "bottom",
  no: number,
  textOptions: readonly Readonly<Record<string, unknown>>[],
  title?: string,
): RelayBlockInput {
  return {
    endpoint: `relay_${String(inning).padStart(3, "0")}`,
    endpointBlockIndex: 99 - no,
    block: {
      inn: inning,
      homeOrAway: half === "top" ? "0" : "1",
      no,
      ...(title === undefined ? {} : { title }),
      textOptions,
    },
  };
}
function row(
  seqno: number,
  kind: string,
  text: string,
  payload: Readonly<Record<string, unknown>> = {},
) {
  return { seqno, kind, text, ...payload };
}
function player(
  playerId: string,
  name: string,
  side: "away" | "home",
  battingOrder?: number,
  positions: readonly string[] = ["야수"],
): RelayRosterPlayer {
  return {
    playerId,
    name,
    side,
    ...(battingOrder === undefined ? {} : { battingOrder }),
    starter: true,
    positions,
  };
}
function documentFor(events: ReturnType<typeof normalizeNaverRelay>["events"]) {
  return {
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: "20260820TEST0",
      collectedAt: "2026-08-20T12:00:00+09:00",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: "20260820TEST0",
      season: 2026,
      gameDate: "2026-08-20",
      status: "suspended",
      scheduledInnings: 9,
    },
    teams: { away: { teamId: "AWAY", name: "원정" }, home: { teamId: "HOME", name: "홈" } },
    rosters: {
      away: {
        teamId: "AWAY",
        players: players.filter((item) => item.side === "away").map(contractPlayer),
      },
      home: {
        teamId: "HOME",
        players: players.filter((item) => item.side === "home").map(contractPlayer),
      },
    },
    events,
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  };
}
function contractPlayer(item: RelayRosterPlayer) {
  return {
    playerId: item.playerId,
    name: item.name,
    ...(item.battingOrder === undefined ? {} : { battingOrder: item.battingOrder }),
    starter: item.starter,
    positions: item.positions,
  };
}
