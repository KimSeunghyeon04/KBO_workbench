import { expect, it } from "vitest";
import fc from "fast-check";
import { Value } from "@sinclair/typebox/value";
import {
  PitchLocationResponseSchema,
  PitchLocationComparisonResponseSchema,
  pitchLocationComparisonQueries,
  resolveAnalysisScope,
  type PitchOutcomeQuery,
} from "@kbo/contracts";
import { analyzePitchLocation, comparePitchLocations } from "@kbo/game-core";
import { outcomeRow, terminalPa } from "../helpers/pitch-outcomes.js";

const hash = "a".repeat(64);
const query: PitchOutcomeQuery = { season: 2024, competition: "all" };
const scope = resolveAnalysisScope(query);
it("preserves every actual pitch in count/stance/type composition, including unknown and unlocated pitches", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          balls: fc.integer({ min: 0, max: 3 }),
          strikes: fc.integer({ min: 0, max: 2 }),
          stance: fc.constantFrom("L", "R", "S", null),
          pitchType: fc.constantFrom("직구", "슬라이더", null),
        }),
        { maxLength: 80 },
      ),
      (values) => {
        const rows = values.map((row, index) =>
          outcomeRow({ ...row, pitchId: `pitch-${index}`, trackingId: null, inZone: null }),
        );
        const a = analyzePitchLocation(query, "hp1", scope, hash, rows, []);
        const b = analyzePitchLocation(query, "hp1", scope, hash, [...rows].reverse(), []);
        expect(Value.Check(PitchLocationResponseSchema, a)).toBe(true);
        expect(a.arsenal).toEqual(b.arsenal);
        expect(a.arsenal.reduce((total, group) => total + group.pitches, 0)).toBe(rows.length);
        for (const group of a.arsenal) {
          expect(group.types.reduce((total, type) => total + type.pitches, 0)).toBe(group.pitches);
          expect(group.types.reduce((total, type) => total + type.usageRate, 0)).toBeCloseTo(1);
        }
        expect(a.coverage.locationPitches).toBe(0);
      },
    ),
  );
});

it("applies the selected cohort and exact situation to composition without requiring a location", () => {
  const rows = [
    outcomeRow({ stance: "L", strikes: 2, pitchType: "직구", trackingId: null }),
    outcomeRow({ stance: "L", strikes: 2, pitchType: "직구", eligible: false }),
    outcomeRow({ stance: "R", strikes: 2, pitchType: "직구" }),
    outcomeRow({ stance: "L", strikes: 1, pitchType: "직구" }),
    outcomeRow({ stance: "L", strikes: 2, pitchType: "슬라이더" }),
  ];
  const result = analyzePitchLocation(
    { ...query, stance: "L", strikes: 2, pitchType: "직구", cohort: "discipline" },
    "hp1",
    scope,
    hash,
    rows,
    [],
  );
  expect(result.total.pitches).toBe(1);
  expect(result.arsenal).toEqual([
    {
      stance: "L",
      balls: 0,
      strikes: 2,
      pitches: 1,
      types: [{ pitchType: "직구", pitches: 1, usageRate: 1 }],
    },
  ]);
});

it("keeps both period boundaries and all situation filters explicit", () => {
  const request = {
    ...query,
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
    compareSeason: 2025,
    compareDateFrom: "2025-06-01",
    compareDateTo: "2025-06-30",
    stance: "L" as const,
    balls: 1,
    strikes: 2,
    pitchType: "체인지업",
    cohort: "discipline" as const,
  };
  const { first, second } = pitchLocationComparisonQueries(request);
  expect(first).toEqual({
    ...query,
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
    stance: "L",
    balls: 1,
    strikes: 2,
    pitchType: "체인지업",
    cohort: "discipline",
  });
  expect(second).toEqual({ ...first, season: 2025, dateFrom: "2025-06-01", dateTo: "2025-06-30" });
  const { compareDateFrom, compareDateTo, ...wholeSeason } = request;
  void compareDateFrom;
  void compareDateTo;
  expect(pitchLocationComparisonQueries(wholeSeason).second.dateFrom).toBeUndefined();
});

it("compares location shares and response rates with their own denominators; reversing periods reverses differences", () => {
  const rows = [
    outcomeRow({ pitchId: "p1", swing: true, whiff: true, strikes: 2 }),
    outcomeRow({ pitchId: "p2", swing: true, whiff: false, inPlay: true, pitchCall: "in_play" }),
    outcomeRow({ pitchId: "p3", trackingId: null }),
  ];
  const a = analyzePitchLocation(query, "hp1", scope, hash, rows, [
    terminalPa({ pitchId: "p2", result: "single", pitchCall: "in_play", inPlay: true }),
  ]);
  const b = analyzePitchLocation(
    query,
    "hp1",
    scope,
    hash,
    [outcomeRow({ pitchId: "b1", swing: false })],
    [],
  );
  const q = { ...query, compareSeason: 2024 };
  const result = comparePitchLocations(q, "hp1", a, b);
  expect(Value.Check(PitchLocationComparisonResponseSchema, result)).toBe(true);
  const index = a.points[0]?.cell;
  if (index === undefined) throw new Error("Missing fixture location");
  expect(result.first.cells[index]).toMatchObject({
    usageRate: 1,
    whiffRate: 0.5,
    inPlayHitRate: 1,
  });
  expect(result.first.coverage).toMatchObject({ locationPitches: 2, missingLocation: 1 });
  expect(result.second.cells[index]).toMatchObject({
    usageRate: 1,
    whiffRate: null,
    inPlayHitRate: null,
  });
  expect(result.differences[index]).toMatchObject({
    usageRate: 0,
    whiffRate: null,
    inPlayHitRate: null,
  });
  const reverse = comparePitchLocations(q, "hp1", b, a);
  for (const row of result.differences) {
    const reversed = reverse.differences[row.cell];
    if (reversed === undefined) throw new Error("Missing reversed cell");
    if (row.usageRate === null) expect(reversed.usageRate).toBeNull();
    else expect(reversed.usageRate).toBeCloseTo(-row.usageRate);
  }
  const empty = comparePitchLocations(
    q,
    "hp1",
    a,
    analyzePitchLocation(query, "hp1", scope, hash, [], []),
  );
  expect(empty.second.cells.every((cell) => cell.usageRate === null)).toBe(true);
  expect(empty.differences.every((cell) => cell.usageRate === null)).toBe(true);
  expect("points" in result.first).toBe(false);
});
