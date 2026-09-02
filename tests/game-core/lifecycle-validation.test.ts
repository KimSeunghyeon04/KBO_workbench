import { describe, expect, it } from "vitest";

import { compileStagingGameDocumentV2 } from "@kbo/game-core";

import { loadedBasesWithTwoOuts, makeDocument } from "../helpers/game-document.js";

describe("원장 compiler의 PA lifecycle과 불연속", () => {
  it("주루사로 3아웃이면 열린 타석을 third_out partial로 닫고 다음 반이닝을 독립 replay한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...loadedBasesWithTwoOuts(),
        { kind: "pitch", payload: { call: "called_strike" } },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a3",
            fromBase: 1,
            toBase: 2,
            outcome: "out",
            outKind: "tag",
            context: { kind: "independent", reason: "caught_stealing" },
          },
        },
        { kind: "half_inning_start", inning: 1, half: "bottom", payload: {} },
      ]),
    );

    const partial = replay.plateAppearances.find((pa) => !pa.completed);
    expect(partial).toMatchObject({
      batterId: "a6",
      completed: false,
      terminationReason: "third_out",
      endEventId: "e17",
      actualPitchCount: 1,
    });
    expect(replay.findings.map((finding) => finding.code)).not.toContain("source_half_incomplete");
    expect(replay.frames.at(-1)).toMatchObject({
      applied: true,
      after: { inning: 1, half: "bottom", outs: 0 },
    });
  });

  it("3아웃 전 다음 반이닝은 source_half_incomplete로 차단하되 경계부터 재개한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "ball" } },
        { kind: "half_inning_start", inning: 1, half: "bottom", payload: {} },
      ]),
    );
    expect(replay.findings.map((finding) => finding.code)).toContain("source_half_incomplete");
    expect(replay.plateAppearances[0]).toMatchObject({
      terminationReason: "source_boundary",
      endEventId: "e3",
    });
    expect(replay.frames[3]).toMatchObject({ applied: true, after: { half: "bottom", outs: 0 } });
  });

  it("대타 교체보다 먼저 온 새 타자 머리글은 교체 확인 행으로 처리한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "ball", batterId: "a1", pitcherId: "hp1" } },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "substitution",
          payload: {
            side: "home",
            role: "fielder",
            incomingPlayerId: "h2",
            outgoingPlayerId: "h1",
          },
        },
        {
          kind: "substitution",
          payload: {
            side: "away",
            role: "batter",
            incomingPlayerId: "a2",
            outgoingPlayerId: "a1",
          },
        },
        { kind: "pitch", payload: { call: "in_play", batterId: "a2", pitcherId: "hp1" } },
        { kind: "plate_result", payload: { result: "single", batterId: "a2", pitcherId: "hp1" } },
      ]),
    );

    expect(replay.findings.map((finding) => finding.code)).not.toContain(
      "plate_appearance_overlap",
    );
    expect(replay.plateAppearances[0]).toMatchObject({ batterId: "a2", completed: true });
  });

  it("final 경기의 예정 이닝 전 종료는 called_game partial로 보존한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument(
        [
          { kind: "half_inning_start", payload: {} },
          { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
          { kind: "pitch", payload: { call: "ball" } },
          { kind: "administrative", payload: { code: "footer" }, relayText: "강우 콜드게임" },
        ],
        "final",
      ),
    );
    expect(replay.plateAppearances[0]).toMatchObject({
      terminationReason: "called_game",
      endEventId: "e3",
    });
    expect(replay.findings.map((finding) => finding.code)).not.toContain(
      "final_game_has_incomplete_half",
    );
  });

  it("승패가 확정된 final 경기 뒤 행도 compiler가 삼키지 않고 unresolved를 차단한다", () => {
    const raw = makeDocument(
      [
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "plate_result", payload: { result: "home_run", batterId: "a1", pitcherId: "hp1" } },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "field_out", batterId: "a2", pitcherId: "hp1" },
        },
        { kind: "batter_start", payload: { batterId: "a3", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "field_out", batterId: "a3", pitcherId: "hp1" },
        },
        { kind: "batter_start", payload: { batterId: "a4", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "field_out", batterId: "a4", pitcherId: "hp1" },
        },
        { kind: "half_inning_start", inning: 1, half: "bottom", payload: {} },
        { kind: "batter_start", half: "bottom", payload: { batterId: "h1", pitcherId: "a9" } },
        {
          kind: "plate_result",
          half: "bottom",
          payload: { result: "field_out", batterId: "h1", pitcherId: "a9" },
        },
        { kind: "batter_start", half: "bottom", payload: { batterId: "h2", pitcherId: "a9" } },
        {
          kind: "plate_result",
          half: "bottom",
          payload: { result: "field_out", batterId: "h2", pitcherId: "a9" },
        },
        { kind: "batter_start", half: "bottom", payload: { batterId: "h3", pitcherId: "a9" } },
        {
          kind: "plate_result",
          half: "bottom",
          payload: { result: "field_out", batterId: "h3", pitcherId: "a9" },
        },
        { kind: "half_inning_start", inning: 2, half: "top", payload: {} },
        {
          kind: "batter_start",
          inning: 2,
          half: "top",
          payload: { batterId: "a5", pitcherId: "hp1" },
        },
        {
          kind: "administrative",
          inning: 2,
          half: "top",
          payload: { code: "footer" },
          relayText: "승리투수: ap1",
        },
        {
          kind: "unresolved",
          inning: 2,
          half: "top",
          payload: { sourceType: "unknown-footer" },
          relayText: "해석 불가 종료 행",
        },
      ],
      "final",
    ) as Record<string, unknown>;
    const document = {
      ...raw,
      metadata: {
        ...(raw.metadata as Record<string, unknown>),
        scheduledInnings: 1,
      },
    };

    const replay = compileStagingGameDocumentV2(document);
    expect(replay.finalState).toMatchObject({
      inning: 2,
      half: "top",
      outs: 0,
      awayScore: 1,
      homeScore: 0,
    });
    expect(replay.frames).toHaveLength(20);
    expect(replay.plateAppearances.some((plate) => plate.batterId === "a5")).toBe(true);
    expect(replay.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["unresolved_relay_row", "final_game_has_incomplete_half"]),
    );
  });

  it("연결 play 사이 상태 변경 행과 unresolved·dangling 링크를 각각 차단한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "single", batterId: "a1", pitcherId: "hp1", creditedRbi: 0 },
        },
        {
          kind: "substitution",
          payload: { side: "home", role: "pitcher", incomingPlayerId: "hp2" },
        },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a1",
            fromBase: 1,
            toBase: 2,
            outcome: "safe",
            context: { kind: "plate_result", plateResultEventId: "e2" },
          },
        },
        { kind: "unresolved", payload: { sourceType: "unknown" }, relayText: "해석 불가 원문" },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a1",
            fromBase: 1,
            toBase: 2,
            outcome: "safe",
            context: { kind: "plate_result", plateResultEventId: "missing" },
          },
        },
      ]),
    );
    expect(replay.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "state_event_inside_linked_play",
        "invalid_plate_result_link",
        "unresolved_relay_row",
        "dangling_plate_result_link",
      ]),
    );
    expect(replay.plays.find((play) => play.relayEventIds.includes("e2"))?.applied).toBe(false);
  });

  it("dangling·self·future review 참조를 결정론적인 blocking finding으로 만든다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "review", payload: { reviewedEventId: "e1" }, relayText: "자기 참조" },
        { kind: "review", payload: { reviewedEventId: "missing" }, relayText: "대상 없음" },
        { kind: "review", payload: { reviewedEventId: "e4" }, relayText: "미래 참조" },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
      ]),
    );

    expect(replay.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "self_review_reference",
        "dangling_review_reference",
        "future_review_reference",
      ]),
    );
  });

  it("타석 결과 count와 연결 주자 전 단계 점수를 최종 play 상태에 잘못 비교하지 않는다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "single", batterId: "a1", pitcherId: "hp1" },
          observedStateAfter: {
            balls: 1,
            strikes: 2,
            outs: 0,
            bases: ["a1", null, null],
            awayScore: 0,
            homeScore: 0,
          },
        },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "ball", batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "home_run", batterId: "a2", pitcherId: "hp1" },
          observedStateAfter: {
            balls: 1,
            strikes: 0,
            outs: 0,
            bases: ["a1", null, null],
            awayScore: 1,
            homeScore: 0,
          },
        },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a1",
            fromBase: 1,
            toBase: 4,
            outcome: "scored",
            context: { kind: "plate_result", plateResultEventId: "e5" },
          },
          observedStateAfter: {
            balls: 1,
            strikes: 0,
            outs: 0,
            bases: [null, null, null],
            awayScore: 2,
            homeScore: 0,
          },
        },
      ]),
    );

    expect(replay.findings.map((finding) => finding.code)).not.toContain(
      "source_observation_mismatch",
    );
    expect(replay.finalState.awayScore).toBe(2);
  });

  it("3아웃 결과에 남아 있는 원천 잔루 snapshot을 종료 후 빈 베이스와 비교하지 않는다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...loadedBasesWithTwoOuts(),
        {
          kind: "plate_result",
          payload: { result: "field_out", batterId: "a6", pitcherId: "hp1" },
          observedStateAfter: {
            balls: 0,
            strikes: 0,
            outs: 3,
            bases: [true, true, true],
            awayScore: 0,
            homeScore: 0,
          },
        },
      ]),
    );

    expect(replay.finalState.outs).toBe(3);
    expect(replay.findings.map((finding) => finding.code)).not.toContain(
      "source_observation_mismatch",
    );
  });

  it("review와 administrative 행의 과거 count·주자 snapshot은 상태 관측으로 재검증하지 않는다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "ball" } },
        {
          kind: "review",
          payload: { decision: "requested" },
          observedStateAfter: {
            balls: 3,
            strikes: 2,
            outs: 2,
            bases: [true, false, false],
            awayScore: 7,
            homeScore: 5,
          },
        },
        {
          kind: "administrative",
          payload: { code: "footer" },
          observedStateAfter: {
            balls: 3,
            strikes: 2,
            outs: 2,
            bases: [true, false, false],
            awayScore: 7,
            homeScore: 5,
          },
        },
      ]),
    );

    expect(replay.findings.map((finding) => finding.code)).not.toContain(
      "source_observation_mismatch",
    );
  });

  it("in-play 투구 snapshot에 미리 반영된 결과 주자·점수는 투구 상태와 비교하지 않는다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "pitch",
          payload: { call: "in_play", batterId: "a1", pitcherId: "hp1" },
          observedStateAfter: {
            balls: 0,
            strikes: 0,
            outs: 0,
            bases: ["a1", null, null],
            awayScore: 1,
            homeScore: 0,
          },
        },
      ]),
    );

    expect(replay.findings.map((finding) => finding.code)).not.toContain(
      "source_observation_mismatch",
    );
  });

  it("신뢰 가능한 play 종료 행의 여러 관측 차이를 finding 하나의 detail로 합친다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "field_out", batterId: "a1", pitcherId: "hp1" },
          observedStateAfter: {
            balls: 0,
            strikes: 0,
            outs: 2,
            bases: [true, false, false],
            awayScore: 3,
            homeScore: 0,
          },
        },
      ]),
    );

    const mismatches = replay.findings.filter(
      (finding) => finding.code === "source_observation_mismatch",
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.details.map((detail) => detail.field)).toEqual([
      "outs",
      "awayScore",
      "bases.1",
    ]);
  });

  it("카운트만 맞는 투구가 앞선 점수 관측 불일치를 해소하지 않는다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "single", batterId: "a1", pitcherId: "hp1" },
          observedStateAfter: {
            outs: 0,
            bases: ["a1", null, null],
            awayScore: 1,
            homeScore: 0,
          },
        },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "pitch",
          payload: { call: "ball", batterId: "a2", pitcherId: "hp1" },
          observedStateAfter: {
            balls: 1,
            strikes: 0,
            outs: 0,
            bases: ["a1", null, null],
            awayScore: 1,
            homeScore: 0,
          },
        },
        {
          kind: "plate_result",
          payload: { result: "field_out", batterId: "a2", pitcherId: "hp1" },
          observedStateAfter: {
            outs: 1,
            bases: ["a1", null, null],
            awayScore: 1,
            homeScore: 0,
          },
        },
      ]),
    );

    expect(
      replay.findings.filter((finding) => finding.code === "source_observation_mismatch"),
    ).toHaveLength(1);
  });
});
