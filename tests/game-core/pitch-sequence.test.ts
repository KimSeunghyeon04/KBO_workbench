import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PitchSequenceResponseSchema,
  resolveAnalysisScope,
  type PitchReleaseGroup,
} from "@kbo/contracts";
import { analyzePitchSequences, pitchPositionAtPlane } from "@kbo/game-core";
import { independentSequenceSamples, pitchSequenceRow as row } from "../helpers/pitch-sequence.js";
import { pitchFrom50Feet, pitchFrom55Feet } from "../helpers/pitch-trajectory.js";
const query = { season: 2024 },
  scope = resolveAnalysisScope(query, "regular");
const fastballRelease: PitchReleaseGroup = {
  pitchType: "직구",
  games: 3,
  pitches: 120,
  estimate: { xCm: 100, heightCm: 140, extensionCm: 5.5 * 30.48 },
};
const releases = [fastballRelease];

it("uses one clock for a pair with different original reference planes", () => {
  const previous = row(0, { ...pitchFrom50Feet, speedKph: 139 }),
    current = row(1, { ...pitchFrom55Feet, speedKph: 141 });
  const position = pitchPositionAtPlane(current, 1.76, 55);
  expect(position?.timeMs).toBeCloseTo(440, 9);
  expect(position?.xCm).toBeCloseTo(2.6544 * 30.48, 10);
  expect(position?.zCm).toBeCloseTo(2.216 * 30.48, 10);
  const { pairs, coverage } = analyzePitchSequences(
    query,
    "p",
    scope,
    "hash",
    [previous, current],
    releases,
  );
  expect(coverage.geometryPairs).toBe(1);
  expect(pairs[0]?.planeDistanceCm).toBeCloseTo(0, 9);
  expect(pairs[0]?.planeTimeDifferenceMs).toBeCloseTo(0, 9);
  expect(pairs[0]?.arrivalDistanceCm).toBeCloseTo(0, 9);
  expect(pairs[0]?.speedDifferenceKph).toBe(2);
  expect(pitchPositionAtPlane(previous, 55, 55)).toMatchObject({
    timeMs: 0,
    xCm: expect.closeTo(30.48),
  });
});

it("changes elapsed time by release depth and keeps measured geometry when an estimate is missing", () => {
  const previous = row(0, { y0: 50, vy0: -100, ay: 0 });
  const current = { ...previous, pitchSequence: 1, pitchId: "e1", pitchType: "슬라이더" };
  const slider = {
    ...fastballRelease,
    pitchType: "슬라이더",
    estimate: {
      xCm: -85,
      heightCm: 190,
      extensionCm: 6.5 * 30.48,
    },
  };
  const pair = analyzePitchSequences(
    query,
    "p",
    scope,
    "hash",
    [previous, current],
    [...releases, slider],
  ).pairs[0];
  expect(pair).toMatchObject({ planeDistanceCm: 0, arrivalDistanceCm: 0 });
  expect(pair?.planeTimeDifferenceMs).toBeCloseTo(-10, 9);
  const missing = analyzePitchSequences(query, "p", scope, "hash", [previous, current], releases);
  expect(missing.pairs[0]).toMatchObject({
    planeDistanceCm: 0,
    arrivalDistanceCm: 0,
    planeTimeDifferenceMs: null,
  });
  expect(missing.groups[0]).toMatchObject({ planeDistancePairs: 1, planeTimeDifferencePairs: 0 });
});

it("uses the original spatial interval if the estimated start is physically invalid for one pitch", () => {
  const pitch = row(0, { z0: 0.1, vz0: 10 });
  expect(pitchPositionAtPlane(pitch, 53, 55)).toBeNull();
  const point = pitchPositionAtPlane(pitch, 23.8, 55);
  expect(point).toEqual(pitchPositionAtPlane(pitch, 23.8));
  expect(point?.timeMs).toBeNull();
});
it("forms pairs before type filtering and preserves missing tracking as an intervening pitch", () => {
  const rows = [
    row(0),
    row(1, { pitchType: "슬라이더", trackingId: null }),
    row(2, { swing: true, whiff: true }),
  ];
  const r = analyzePitchSequences({ ...query, pitchType: "직구" }, "p", scope, "hash", rows);
  expect(Value.Check(PitchSequenceResponseSchema, r)).toBe(true);
  expect(r.coverage).toMatchObject({
    targetPitches: 3,
    eligiblePairs: 2,
    filteredPairs: 1,
    geometryPairs: 0,
  });
  expect(r.pairs[0]?.previous.pitchId).toBe("e1");
  expect(r.pairs[0]?.planeDistanceCm).toBeNull();
  expect(r.groups[0]?.whiffRate).toBe(1);
});
it("splits automatic/no-pitch boundaries, player changes and PA boundaries without bridging", () => {
  const rows = [
    row(0),
    row(1, { actual: false, pitchCall: "automatic_strike" }),
    row(2),
    row(3, { batterId: "sub" }),
    row(4, { batterId: "sub", interveningChange: true }),
    row(5, { paId: "next" }),
  ];
  const r = analyzePitchSequences(query, "p", scope, "hash", rows);
  expect(r.coverage).toMatchObject({
    targetPitches: 5,
    noPrevious: 2,
    nonActualBoundary: 1,
    playerChange: 2,
    eligiblePairs: 0,
  });
  expect(analyzePitchSequences(query, "p", scope, "hash", [...rows].reverse())).toEqual(r);
});
it("keeps geometric distance symmetric and differences signed, rejecting invalid forward crossings", () => {
  const a = row(0),
    b = row(1, { vy0: -120, speedKph: 130, x0: 1 });
  const p = analyzePitchSequences(query, "p", scope, "hash", [a, b], releases).pairs[0];
  const reversed = analyzePitchSequences(
    query,
    "p",
    scope,
    "hash",
    [
      { ...b, pitchSequence: 0 },
      { ...a, pitchSequence: 1 },
    ],
    releases,
  ).pairs[0];
  expect(p?.planeDistanceCm).toBe(reversed?.planeDistanceCm);
  expect(p?.speedDifferenceKph).toBe(-10);
  expect(reversed?.speedDifferenceKph).toBe(10);
  expect(p?.planeTimeDifferenceMs).toBe(-(reversed?.planeTimeDifferenceMs ?? 0));
  expect(
    analyzePitchSequences(query, "p", scope, "hash", [a, row(1)]).pairs[0]?.planeDistanceCm,
  ).toBe(0);
  expect(pitchPositionAtPlane({ ...a, vy0: 20, ay: 0 }, 23.8)).toBeNull();
});

it("reports independent mean denominators without dropping valid zeros or changing outcome denominators", () => {
  const response = analyzePitchSequences(
    query,
    "p",
    scope,
    "hash",
    independentSequenceSamples(),
    releases,
  );
  expect(Value.Check(PitchSequenceResponseSchema, response)).toBe(true);
  expect(response.groups).toEqual([
    {
      key: JSON.stringify(["직구", "직구"]),
      pairs: 3,
      swings: 2,
      whiffs: 1,
      calledStrikes: 1,
      swingRate: 2 / 3,
      whiffRate: 1 / 2,
      calledStrikeRate: 1 / 3,
      geometryPairs: 2,
      planeDistancePairs: 2,
      planeTimeDifferencePairs: 2,
      speedDifferencePairs: 2,
      arrivalDistancePairs: 1,
      meanPlaneDistanceCm: 0,
      meanPlaneTimeDifferenceMs: 0,
      meanSpeedDifferenceKph: 3,
      meanArrivalDistanceCm: 0,
    },
  ]);
});

it("preserves null means when no pair can supply that measurement", () => {
  const response = analyzePitchSequences(query, "p", scope, "hash", [
    row(0),
    row(1, { trackingId: null, speedKph: null }),
  ]);
  expect(response.groups[0]).toMatchObject({
    pairs: 1,
    geometryPairs: 0,
    planeDistancePairs: 0,
    planeTimeDifferencePairs: 0,
    speedDifferencePairs: 0,
    arrivalDistancePairs: 0,
    meanPlaneDistanceCm: null,
    meanPlaneTimeDifferenceMs: null,
    meanSpeedDifferenceKph: null,
    meanArrivalDistanceCm: null,
  });
  expect(Value.Check(PitchSequenceResponseSchema, response)).toBe(true);
});

it.each([
  "planeDistancePairs",
  "planeTimeDifferencePairs",
  "speedDifferencePairs",
  "arrivalDistancePairs",
])("requires a non-negative count for %s in the strict response", (field) => {
  const response = analyzePitchSequences(query, "p", scope, "hash", [row(0), row(1)]);
  const group = response.groups[0];
  if (group === undefined) throw new Error("Expected a sequence group");
  expect(
    Value.Check(PitchSequenceResponseSchema, {
      ...response,
      groups: [{ ...group, [field]: -1 }],
    }),
  ).toBe(false);
  expect(
    Value.Check(PitchSequenceResponseSchema, {
      ...response,
      groups: [Object.fromEntries(Object.entries(group).filter(([key]) => key !== field))],
    }),
  ).toBe(false);
});
