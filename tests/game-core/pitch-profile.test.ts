import { expect, it } from "vitest";
import { summarizePitchProfile } from "@kbo/game-core";
it("uses all actual pitches for usage, valid speeds for velocity and distinct calibrated shape samples", () => {
  const a = { gameDate: "2024-06-01", pitchType: "직구", speedKph: 140, swing: true, whiff: true };
  const rows = [
    a,
    { ...a, speedKph: null, swing: false, whiff: false },
    { ...a, pitchType: null, gameDate: "2024-07-01" },
  ];
  const result = summarizePitchProfile(rows, [
    { ...a, xCm: 2, zCm: 6, arrivalMs: 400, calibrationStatus: "applied" },
    { ...a, xCm: 4, zCm: 2, arrivalMs: 420, calibrationStatus: "insufficient_data" },
  ]);
  expect(result.groups[0]).toMatchObject({
    actualPitches: 2,
    usageRate: 2 / 3,
    speedCount: 1,
    meanSpeedKph: 140,
    shapeCount: 2,
    meanXCm: 3,
    meanZCm: 4,
    meanArrivalMs: 410,
    calibratedCount: 1,
    calibratedXCm: 2,
    whiffRate: 1,
  });
  expect(result.groups[0]?.sdXCm).toBeCloseTo(Math.sqrt(2));
  expect(result.groups[1]).toMatchObject({
    pitchType: null,
    actualPitches: 1,
    shapeCount: 0,
    meanXCm: null,
    sdXCm: null,
  });
  expect(result.months.map((m) => m.actualPitches)).toEqual([2, 1]);
  expect(summarizePitchProfile([], [])).toEqual({ groups: [], months: [] });
});
