import { describe, expect, it } from "vitest";

import { assertNoUnexpectedQuarantineIncrease } from "../../apps/server/src/maintenance/derived-rebuild-validation.js";

describe("derived workspace rebuild validation", () => {
  it("격리 경기 수가 같거나 줄어들면 허용한다", () => {
    expect(() =>
      assertNoUnexpectedQuarantineIncrease(2, [
        { gameId: "game-1", findings: [] },
        {
          gameId: "game-2",
          findings: [{ code: "source.actual_error", severity: "blocking" }],
        },
      ]),
    ).not.toThrow();
  });

  it("격리 경기 수가 늘면 교체 전에 주요 차단 코드와 함께 중단한다", () => {
    expect(() =>
      assertNoUnexpectedQuarantineIncrease(1, [
        {
          gameId: "game-1",
          findings: [
            {
              code: "domain.tracking.plate_appearance_mismatch",
              severity: "blocking",
            },
          ],
        },
        {
          gameId: "game-2",
          findings: [
            {
              code: "domain.tracking.plate_appearance_mismatch",
              severity: "blocking",
            },
          ],
        },
      ]),
    ).toThrow(
      /baseline=1, projected=2; blocking codes: domain\.tracking\.plate_appearance_mismatch=2/,
    );
  });
});
