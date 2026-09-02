import { describe, expect, it } from "vitest";

import { applyPitchCall, isWalkTransferredToPreviousPitcher } from "@kbo/game-core";

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

  it("중간 투수 교체 때 볼넷 책임 count를 구분한다", () => {
    expect(isWalkTransferredToPreviousPitcher(2, 0)).toBe(true);
    expect(isWalkTransferredToPreviousPitcher(3, 2)).toBe(true);
    expect(isWalkTransferredToPreviousPitcher(1, 2)).toBe(false);
  });
});
