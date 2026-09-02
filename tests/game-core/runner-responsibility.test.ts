import { describe, expect, it } from "vitest";

import { compileStagingGameDocumentV2 } from "@kbo/game-core";

import { makeDocument, out, safe, scored } from "../helpers/game-document.js";

describe("주자와 투수 책임", () => {
  it("구원 등판 전 3볼 count의 볼넷은 앞 투수에게 PA·볼넷·주자 책임을 기록한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "ball", pitcherId: "hp1", batterId: "a1" } },
        { kind: "pitch", payload: { call: "ball", pitcherId: "hp1", batterId: "a1" } },
        { kind: "pitch", payload: { call: "ball", pitcherId: "hp1", batterId: "a1" } },
        {
          kind: "substitution",
          payload: {
            side: "home",
            role: "pitcher",
            incomingPlayerId: "hp2",
            outgoingPlayerId: "hp1",
          },
        },
        { kind: "pitch", payload: { call: "ball", pitcherId: "hp2", batterId: "a1" } },
        { kind: "plate_result", payload: { result: "walk", batterId: "a1", pitcherId: "hp2" } },
      ]),
    );

    expect(replay.plateAppearances[0]).toMatchObject({ batterId: "a1", pitcherId: "hp1" });
    expect(replay.pitcherLines.find((line) => line.playerId === "hp1")).toMatchObject({
      battersFaced: 1,
      walks: 1,
      pitches: 3,
    });
    expect(replay.pitcherLines.find((line) => line.playerId === "hp2")).toMatchObject({
      battersFaced: 0,
      walks: 0,
      pitches: 1,
    });
    expect(replay.finalState.bases[0]).toMatchObject({
      runnerId: "a1",
      responsiblePitcherId: "hp1",
    });
  });

  it("2스트라이크 뒤 대타가 삼진을 완성하면 원래 타자에게 기록한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "called_strike", batterId: "a1", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "foul", batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "substitution",
          payload: {
            side: "away",
            role: "batter",
            incomingPlayerId: "a2",
            outgoingPlayerId: "a1",
          },
        },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "swinging_strike", batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "strikeout", batterId: "a2", pitcherId: "hp1" },
        },
      ]),
    );

    expect(replay.findings.map((finding) => finding.code)).not.toContain(
      "plate_appearance_overlap",
    );
    expect(replay.plateAppearances[0]?.batterId).toBe("a1");
    expect(replay.batterLines.find((line) => line.playerId === "a1")).toMatchObject({
      plateAppearances: 1,
      atBats: 1,
      strikeouts: 1,
    });
    expect(replay.batterLines.find((line) => line.playerId === "a2")?.plateAppearances ?? 0).toBe(
      0,
    );
  });

  it("고의4구를 전체 볼넷과 고의4구 양쪽에 집계한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "intentional_walk", batterId: "a1", pitcherId: "hp1" },
        },
      ]),
    );

    expect(replay.batterLines.find((line) => line.playerId === "a1")).toMatchObject({
      walks: 1,
      intentionalWalks: 1,
    });
    expect(replay.pitcherLines.find((line) => line.playerId === "hp1")).toMatchObject({
      walks: 1,
      intentionalWalks: 1,
    });
  });

  it("같은 타격 play의 실책·폭투 득점은 RBI로 추정하지 않는다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "plate_result", payload: { result: "triple", batterId: "a1", pitcherId: "hp1" } },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "single",
            batterId: "a2",
            pitcherId: "hp1",
            movements: [
              safe("a2", 0, 1, 0),
              { ...scored("a1", 3, 1), relayText: "3루주자 a1 : 폭투로 홈인" },
            ],
          },
        },
      ]),
    );

    expect(replay.finalState.awayScore).toBe(1);
    expect(replay.batterLines.find((line) => line.playerId === "a2")?.runsBattedIn).toBe(0);
  });

  it("fielder's choice로 대체된 주자와 대주자에게 원래 책임 투수를 승계한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        {
          kind: "plate_appearance_start",
          payload: { batterId: "a1", pitcherId: "hp1" },
        },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "intentional_walk",
            batterId: "a1",
            pitcherId: "hp1",
            creditedRbi: 0,
            movements: [safe("a1", 0, 1, 0)],
          },
        },
        {
          kind: "substitution",
          payload: {
            side: "home",
            role: "pitcher",
            incomingPlayerId: "hp2",
            outgoingPlayerId: "hp1",
          },
        },
        {
          kind: "plate_appearance_start",
          payload: { batterId: "a2", pitcherId: "hp2" },
        },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "fielder_choice",
            batterId: "a2",
            pitcherId: "hp2",
            creditedRbi: 0,
            movements: [out("a1", 1, 2, 0, "force"), safe("a2", 0, 1, 1)],
          },
        },
        {
          kind: "substitution",
          payload: {
            side: "away",
            role: "runner",
            incomingPlayerId: "ar1",
            outgoingPlayerId: "a2",
          },
        },
        {
          kind: "plate_appearance_start",
          payload: { batterId: "a3", pitcherId: "hp2" },
        },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "home_run",
            batterId: "a3",
            pitcherId: "hp2",
            creditedRbi: 2,
            movements: [scored("ar1", 1, 0), scored("a3", 0, 1)],
          },
        },
      ]),
    );
    expect(replay.findings).toEqual([]);
    expect(replay.pitcherLines.find((line) => line.playerId === "hp1")?.runs).toBe(1);
    expect(replay.pitcherLines.find((line) => line.playerId === "hp2")?.runs).toBe(1);
  });

  it("야수선택으로 선행 책임 주자가 아웃되면 책임 슬롯을 후속 주자까지 연쇄 승계한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        {
          kind: "plate_appearance_start",
          payload: { batterId: "a1", pitcherId: "hp1" },
        },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "intentional_walk",
            batterId: "a1",
            pitcherId: "hp1",
            creditedRbi: 0,
            movements: [safe("a1", 0, 1, 0)],
          },
        },
        {
          kind: "plate_appearance_start",
          payload: { batterId: "a2", pitcherId: "hp1" },
        },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "intentional_walk",
            batterId: "a2",
            pitcherId: "hp1",
            creditedRbi: 0,
            movements: [safe("a1", 1, 2, 0), safe("a2", 0, 1, 1)],
          },
        },
        {
          kind: "substitution",
          payload: {
            side: "home",
            role: "pitcher",
            incomingPlayerId: "hp2",
            outgoingPlayerId: "hp1",
          },
        },
        {
          kind: "plate_appearance_start",
          payload: { batterId: "a3", pitcherId: "hp2" },
        },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "intentional_walk",
            batterId: "a3",
            pitcherId: "hp2",
            creditedRbi: 0,
            movements: [safe("a1", 2, 3, 0), safe("a2", 1, 2, 1), safe("a3", 0, 1, 2)],
          },
        },
        {
          kind: "plate_appearance_start",
          payload: { batterId: "a4", pitcherId: "hp2" },
        },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "fielder_choice",
            batterId: "a4",
            pitcherId: "hp2",
            creditedRbi: 0,
            movements: [
              out("a1", 3, 3, 0, "force"),
              safe("a2", 2, 3, 1),
              safe("a3", 1, 2, 2),
              safe("a4", 0, 1, 3),
            ],
          },
        },
        {
          kind: "runner_play",
          payload: {
            reason: "other",
            movements: [scored("a2", 3, 0), scored("a3", 2, 1), scored("a4", 1, 2)],
          },
        },
      ]),
    );

    expect(replay.findings).toEqual([]);
    expect(replay.pitcherLines.find((line) => line.playerId === "hp1")?.runs).toBe(2);
    expect(replay.pitcherLines.find((line) => line.playerId === "hp2")?.runs).toBe(1);
  });

  it("야수선택 뒤 같은 주자가 추가 진루해 득점해도 승계한 책임 투수를 유지한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "plate_result", payload: { result: "single", batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "substitution",
          payload: {
            side: "home",
            role: "pitcher",
            incomingPlayerId: "hp2",
            outgoingPlayerId: "hp1",
          },
        },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp2" } },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "single",
            batterId: "a2",
            pitcherId: "hp2",
            movements: [safe("a2", 0, 1, 0), safe("a1", 1, 2, 1)],
          },
        },
        { kind: "batter_start", payload: { batterId: "a3", pitcherId: "hp2" } },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "fielder_choice",
            batterId: "a3",
            pitcherId: "hp2",
            movements: [
              safe("a3", 0, 1, 0),
              safe("a3", 1, 2, 1),
              safe("a2", 1, 2, 2),
              safe("a2", 2, 3, 3),
              scored("a2", 3, 4),
              out("a1", 2, 3, 5, "force"),
            ],
          },
        },
      ]),
    );

    expect(replay.findings).toEqual([]);
    expect(replay.pitcherLines.find((line) => line.playerId === "hp1")?.runs).toBe(1);
    expect(replay.pitcherLines.find((line) => line.playerId === "hp2")?.runs).toBe(0);
  });

  it("명시적 타점이 없는 실책 출루 득점은 공식 타점 차이를 차단 오류로 단정하지 않는다", () => {
    const raw = makeDocument([
      { kind: "half_inning_start", payload: {} },
      { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
      { kind: "plate_result", payload: { result: "single", batterId: "a1", pitcherId: "hp1" } },
      { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
      {
        kind: "plate_appearance_result",
        payload: {
          result: "single",
          batterId: "a2",
          pitcherId: "hp1",
          movements: [safe("a2", 0, 1, 0), safe("a1", 1, 3, 1)],
        },
      },
      { kind: "batter_start", payload: { batterId: "a3", pitcherId: "hp1" } },
      {
        kind: "plate_appearance_result",
        payload: {
          result: "reached_on_error",
          batterId: "a3",
          pitcherId: "hp1",
          movements: [safe("a3", 0, 1, 0), safe("a2", 1, 2, 1), scored("a1", 3, 2)],
        },
      },
    ]) as Record<string, unknown>;
    const replay = compileStagingGameDocumentV2({
      ...raw,
      officialRecords: {
        batters: [
          {
            playerId: "a3",
            side: "away",
            atBats: 1,
            runs: 0,
            hits: 0,
            homeRuns: 0,
            runsBattedIn: 1,
            walks: 0,
            strikeouts: 0,
          },
        ],
        pitchers: [],
      },
    });

    expect(replay.batterLines.find((line) => line.playerId === "a3")?.runsBattedIn).toBe(0);
    expect(replay.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "official_rbi_not_verifiable", severity: "warning" }),
      ]),
    );
    expect(replay.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "official_batter_record_mismatch",
          details: expect.arrayContaining([expect.objectContaining({ field: "runsBattedIn" })]),
        }),
      ]),
    );
  });
});
