import { describe, expect, it } from "vitest";

import {
  applyPitchCall,
  compileStagingGameDocumentV2,
  isWalkTransferredToPreviousPitcher,
} from "@kbo/game-core";
import { mixedPitchDocument } from "../helpers/mixed-pitch-document.js";

describe("투구와 count 규칙", () => {
  it("2스트라이크 뒤 일반 파울은 count를 유지하고 번트 파울은 삼진이 된다", () => {
    expect(applyPitchCall(1, 2, "foul")).toMatchObject({ strikes: 2, isPitchingStrike: true });
    expect(applyPitchCall(1, 2, "foul_bunt")).toMatchObject({ strikes: 3, isPitchingStrike: true });
  });

  it("자동 볼·스트라이크는 count만 바꾸고 실제 투구로 세지 않는다", () => {
    expect(applyPitchCall(2, 1, "automatic_ball")).toEqual({
      balls: 3,
      strikes: 1,
      isActualPitch: false,
      isPitchingStrike: false,
    });
    expect(applyPitchCall(2, 1, "automatic_strike")).toEqual({
      balls: 2,
      strikes: 2,
      isActualPitch: false,
      isPitchingStrike: false,
    });
  });

  it("자동 판정과 무효 투구가 섞여도 count와 투수·타석 투구 수를 각각 계산한다", () => {
    const result = compileStagingGameDocumentV2(mixedPitchDocument());

    expect(
      result.frames
        .filter((frame) => frame.kind === "pitch")
        .map((frame) => [frame.eventId, frame.applied, frame.after.balls, frame.after.strikes]),
    ).toEqual([
      ["e2", true, 1, 0],
      ["e3", true, 2, 0],
      ["e4", true, 2, 1],
      ["e5", true, 2, 1],
      ["e6", true, 2, 2],
      ["e7", true, 2, 2],
      ["e10", true, 0, 0],
    ]);
    expect(result.pitcherLines).toMatchObject([
      { playerId: "hp1", pitches: 4, strikes: 3, battersFaced: 2 },
    ]);
    expect(result.plateAppearances.map((pa) => [pa.startEventId, pa.actualPitchCount])).toEqual([
      ["e1", 3],
      ["e9", 1],
    ]);
  });

  it("투구 fact는 모든 판정을 보존하고 실제 투구에만 타석 내 순번을 부여한다", () => {
    const { pitchFacts } = compileStagingGameDocumentV2(mixedPitchDocument());

    expect(
      pitchFacts.map((pitch) => [
        pitch.pitchId,
        pitch.actual,
        pitch.pitchEventNumber,
        pitch.actualPitchNumber,
      ]),
    ).toEqual([
      ["e2", false, 1, null],
      ["e3", true, 2, 1],
      ["e4", false, 3, null],
      ["e5", false, 4, null],
      ["e6", true, 5, 2],
      ["e7", true, 6, 3],
      ["e10", true, 1, 1],
    ]);
  });

  it("중간 투수 교체 때 볼넷 책임 count를 구분한다", () => {
    expect(isWalkTransferredToPreviousPitcher(2, 0)).toBe(true);
    expect(isWalkTransferredToPreviousPitcher(3, 2)).toBe(true);
    expect(isWalkTransferredToPreviousPitcher(1, 2)).toBe(false);
  });
});
