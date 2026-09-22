import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PitchSequenceResponseSchema,
  resolveAnalysisScope,
  type PitchSequenceRow,
} from "@kbo/contracts";
import { analyzePitchSequences, pitchPositionAtPlane } from "@kbo/game-core";
function row(pitchSequence: number, overrides: Partial<PitchSequenceRow> = {}): PitchSequenceRow {
  return {
    gameId: "g",
    revision: 1,
    gameDate: "2024-06-01",
    stadium: "잠실",
    pitchId: `e${pitchSequence}`,
    pitchSequence,
    paId: "pa",
    pitcherId: "p",
    batterId: "b",
    pitchType: "직구",
    stance: "R",
    speedKph: 140,
    balls: 0,
    strikes: 0,
    actual: true,
    pitchCall: "ball",
    swing: false,
    whiff: false,
    calledStrike: false,
    eligible: true,
    interveningChange: false,
    supported: true,
    trackingId: `t${pitchSequence}`,
    x0: 0,
    y0: 50,
    z0: 6,
    vx0: 1,
    vy0: -140,
    vz0: -4,
    ax: 0,
    ay: 20,
    az: -15,
    crossPlateX: 0,
    crossPlateY: 1.4167,
    ...overrides,
  };
}
const query = { season: 2024 },
  scope = resolveAnalysisScope(query, "regular");
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
  const p = analyzePitchSequences(query, "p", scope, "hash", [a, b]).pairs[0];
  const reversed = analyzePitchSequences(query, "p", scope, "hash", [
    { ...b, pitchSequence: 0 },
    { ...a, pitchSequence: 1 },
  ]).pairs[0];
  expect(p?.planeDistanceCm).toBe(reversed?.planeDistanceCm);
  expect(p?.speedDifferenceKph).toBe(-10);
  expect(reversed?.speedDifferenceKph).toBe(10);
  expect(p?.planeTimeDifferenceMs).toBe(-(reversed?.planeTimeDifferenceMs ?? 0));
  expect(
    analyzePitchSequences(query, "p", scope, "hash", [a, row(1)]).pairs[0]?.planeDistanceCm,
  ).toBe(0);
  expect(pitchPositionAtPlane({ ...a, vy0: 20, ay: 0 }, 23.8)).toBeNull();
});
