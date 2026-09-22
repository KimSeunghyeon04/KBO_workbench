import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  alignPitchTrajectory,
  averagePitchTrajectory,
  comparePitchTrajectory,
  type PitchTrajectoryInput,
} from "@kbo/game-core";

const input: PitchTrajectoryInput = {
  x0: -1,
  y0: 50,
  z0: 6,
  vx0: 2,
  vy0: -140,
  vz0: -4,
  ax: -8,
  ay: 25,
  az: -15,
  crossPlateY: 1.4167,
};
function aligned(overrides: Partial<PitchTrajectoryInput> = {}) {
  const value = alignPitchTrajectory({ ...input, ...overrides });
  if (value === null) throw new Error("Invalid test trajectory");
  return value;
}

describe("pitch trajectory reference snapshot", () => {
  it("keeps equal curvature at the same position when only flight speed differs", () => {
    const reference = aligned({ ay: 0 });
    const slow = aligned({ ay: 0, vy0: -110 });
    const comparison = comparePitchTrajectory(slow, reference);
    expect(comparison).toMatchObject({ xCm: 0, zCm: 0, extrapolated: false });
    expect(comparison?.timingDifferenceMs).toBeGreaterThan(0);
  });
  it("defines the clock by the mean trajectory crossing, not the mean flight time", () => {
    const fast = aligned({ ay: 0, vy0: -150 });
    const slow = aligned({ ay: 0, vy0: -110 });
    const reference = averagePitchTrajectory([fast, slow]);
    expect(reference?.arrivalSeconds).toBeCloseTo((50 - 1.4167) / 130, 12);
    expect(reference?.arrivalSeconds).not.toBeCloseTo(
      (fast.arrivalSeconds + slow.arrivalSeconds) / 2,
      4,
    );
  });

  it("compares both pitches at one instant and keeps early arrival as extrapolation", () => {
    const reference = aligned();
    const fast = aligned({ vy0: -150, ax: 10 });
    const slow = aligned({ vy0: -115, az: -25 });
    const earlier = comparePitchTrajectory(fast, reference);
    const later = comparePitchTrajectory(slow, reference);
    expect(earlier?.timingDifferenceMs).toBeLessThan(0);
    expect(earlier?.distanceToPlateCm).toBeLessThan(0);
    expect(earlier?.extrapolated).toBe(true);
    expect(later?.timingDifferenceMs).toBeGreaterThan(0);
    expect(later?.distanceToPlateCm).toBeGreaterThan(0);
    expect(later?.extrapolated).toBe(false);
    expect(later?.zCm).toBeCloseTo(
      (((slow.verticalAcceleration - reference.verticalAcceleration) *
        reference.arrivalSeconds ** 2) /
        2) *
        30.48,
      12,
    );
    expect(comparePitchTrajectory(reference, reference)).toMatchObject({
      xCm: 0,
      zCm: 0,
      timingDifferenceMs: 0,
      extrapolated: false,
    });
  });

  it("removes initial position and direction without replacing the observed flight clock", () => {
    fc.assert(
      fc.property(fc.double({ min: -0.03, max: 0.03, noNaN: true }), (slope) => {
        const original = aligned();
        const shifted = aligned({
          x0: 20,
          z0: 30,
          vx0: 2 - 140 * slope,
          vz0: -4 - 140 * slope,
          ax: -8 + 25 * slope,
          az: -15 + 25 * slope,
        });
        expect(shifted.lateralAcceleration).toBeCloseTo(original.lateralAcceleration, 10);
        expect(shifted.verticalAcceleration).toBeCloseTo(original.verticalAcceleration, 10);
        expect(shifted.arrivalSeconds).toBe(original.arrivalSeconds);
      }),
    );
  });

  it("uses equal pitch weights and centers the reference population in the snapshot", () => {
    const samples = [aligned(), aligned({ ax: 3, vy0: -130 }), aligned({ ax: -5, vy0: -150 })];
    const reference = averagePitchTrajectory(samples);
    if (reference === null) throw new Error("Missing reference");
    const x = samples.map((sample) => comparePitchTrajectory(sample, reference)?.xCm ?? NaN);
    expect(x.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 10);
    expect(averagePitchTrajectory([])).toBeNull();
  });

  it.each([
    { x0: null },
    { az: Infinity },
    { vy0: NaN },
    { y0: 55 },
    { crossPlateY: -1 },
    { vy0: 0 },
    { vy0: 120 },
    { ay: 1000 },
    { az: -1000 },
  ])("rejects unavailable or nonphysical geometry: %j", (overrides) => {
    expect(alignPitchTrajectory({ ...input, ...overrides })).toBeNull();
  });
});
