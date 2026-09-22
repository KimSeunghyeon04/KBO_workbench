import { expect, it } from "vitest";
import fc from "fast-check";
import { Value } from "@sinclair/typebox/value";
import { PitchAnglesResponseSchema, resolveAnalysisScope } from "@kbo/contracts";
import { pitchApproachAngles, analyzePitchAngles, type PitchAngleInput } from "@kbo/game-core";
const input: PitchAngleInput = {
  gameId: "g",
  revision: 1,
  pitchId: "p",
  gameDate: "2025-04-01",
  pitcherId: "p1",
  stadium: "park",
  pitchType: "fastball",
  trackingId: "t",
  supported: true,
  x0: 0,
  y0: 50,
  z0: 6,
  vx0: 5,
  vy0: -140,
  vz0: -4,
  ax: -8,
  ay: 20,
  az: -15,
  crossPlateY: 1.4167,
};
it("evaluates the raw velocity at one fixed plane regardless of the source crossing convention", () => {
  const middle = pitchApproachAngles(input, 17 / 24),
    mixed = pitchApproachAngles({ ...input, crossPlateY: 0.7083 }, 17 / 24);
  expect(middle).toEqual(mixed);
  expect(middle?.vaaDegrees).toBeLessThan(0);
  expect(middle?.haaDegrees).toBeGreaterThan(0);
  expect(pitchApproachAngles({ ...input, ay: 0, ax: 0, az: 0 }, 17 / 24)?.vaaDegrees).toBeCloseTo(
    (Math.atan2(-4, 140) * 180) / Math.PI,
    12,
  );
  expect(pitchApproachAngles({ ...input, vy0: 140 }, 17 / 24)).toBeNull();
  expect(pitchApproachAngles({ ...input, az: NaN }, 17 / 24)).toBeNull();
  expect(pitchApproachAngles({ ...input, z0: -1 }, 17 / 24)).toBeNull();
  expect(pitchApproachAngles(input, 50)).toBeNull();
  expect(pitchApproachAngles(input, 17 / 12)?.vaaDegrees).not.toBe(middle?.vaaDegrees);
});
it("preserves coordinate reflection and agrees with an independent finite difference of the trajectory", () => {
  fc.assert(
    fc.property(
      fc.double({ min: -12, max: 12, noNaN: true }),
      fc.double({ min: -15, max: 15, noNaN: true }),
      (vx0, ax) => {
        const point = { ...input, vx0, ax },
          angle = pitchApproachAngles(point, 17 / 24),
          mirror = pitchApproachAngles({ ...point, x0: -input.x0, vx0: -vx0, ax: -ax }, 17 / 24);
        if (angle === null || mirror === null) throw new Error("Valid trajectory expected");
        expect(angle.haaDegrees).toBeCloseTo(-mirror.haaDegrees, 10);
        expect(angle.vaaDegrees).toBe(mirror.vaaDegrees);
        const time = (140 - Math.sqrt(140 ** 2 - 40 * (50 - 17 / 24))) / 20,
          dt = 1e-6,
          x = (t: number) => vx0 * t + (ax * t * t) / 2,
          y = (t: number) => 50 - 140 * t + 10 * t * t,
          dx = x(time + dt) - x(time - dt),
          dy = y(time - dt) - y(time + dt);
        expect(angle.haaDegrees).toBeCloseTo((Math.atan2(dx, dy) * 180) / Math.PI, 7);
      },
    ),
  );
});
it("accounts for exclusions, identity and date boundaries without modifying source rows", () => {
  const rows = [
      input,
      { ...input, pitchId: "missing", trackingId: null },
      { ...input, pitchId: "unsupported", supported: false },
      { ...input, pitchId: "bad", vy0: 1 },
      { ...input, pitchId: "wrong", pitcherId: "other" },
      { ...input, pitchId: "future", gameDate: "2025-05-01" },
    ],
    before = structuredClone(rows),
    scope = resolveAnalysisScope({ season: 2025, dateTo: "2025-04-30" }, "regular"),
    response = analyzePitchAngles(rows, scope, "p1", "a".repeat(64));
  expect(Value.Check(PitchAnglesResponseSchema, response)).toBe(true);
  expect(response.coverage).toEqual({
    actual: 4,
    missingTracking: 1,
    unsupported: 1,
    invalid: 1,
    used: 1,
  });
  expect(rows).toEqual(before);
  expect(response.groups[0]?.sdVaaDegrees).toBeNull();
  expect(response.games[0]?.groups[0]?.pitches).toBe(1);
  expect(analyzePitchAngles([...rows].reverse(), scope, "p1", "a".repeat(64))).toEqual(response);
});
