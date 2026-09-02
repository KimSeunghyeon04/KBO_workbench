import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { PitchCall } from "@kbo/contracts";
import { applyPitchCall } from "@kbo/game-core";

const calls: readonly PitchCall[] = [
  "ball",
  "called_strike",
  "swinging_strike",
  "foul",
  "foul_bunt",
  "foul_tip",
  "in_play",
  "hit_by_pitch",
  "automatic_ball",
  "automatic_strike",
  "no_pitch",
];

describe("game-core properties", () => {
  it("모든 합법적 pitch prefix에서 count와 실제 투구 수 불변식을 지킨다", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...calls), { maxLength: 60 }), (generated) => {
        let balls = 0;
        let strikes = 0;
        let pitches = 0;
        for (const call of generated) {
          if (balls >= 4 || strikes >= 3) break;
          const next = applyPitchCall(balls, strikes, call);
          balls = next.balls;
          strikes = next.strikes;
          if (next.isActualPitch) pitches += 1;
          expect(balls).toBeGreaterThanOrEqual(0);
          expect(balls).toBeLessThanOrEqual(4);
          expect(strikes).toBeGreaterThanOrEqual(0);
          expect(strikes).toBeLessThanOrEqual(3);
          expect(pitches).toBeLessThanOrEqual(generated.length);
        }
      }),
      { seed: 20260820, numRuns: 300 },
    );
  });
});
