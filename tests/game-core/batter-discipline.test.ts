import { describe, expect, it } from "vitest";
import { analyzeBatterDiscipline, disciplinePoint, prepareDisciplineSeason } from "@kbo/game-core";
import { DisciplineResponseSchema } from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { disciplineRow, disciplineSnapshot } from "../helpers/batter-discipline.js";

describe("batter swing decisions and fastball counterfactual", () => {
  it("filters the target period while retaining an explicit season or matching-period league cohort", () => {
    const rows = [
      disciplineRow({ pitchId: "target-june" }),
      disciplineRow({ pitchId: "target-july", gameDate: "2024-07-01" }),
      ...Array.from({ length: 20 }, (_, i) =>
        disciplineRow({ pitchId: `control-${i}`, batterId: "other", gameDate: "2024-07-01" }),
      ),
    ];
    const prepared = prepareDisciplineSeason(disciplineSnapshot(rows));
    const query = { season: 2024, dateFrom: "2024-06-01", dateTo: "2024-06-01" };
    const season = analyzeBatterDiscipline(prepared, "b1", query);
    const period = analyzeBatterDiscipline(prepared, "b1", { ...query, leaguePeriod: "target" });
    expect(season.coverage).toMatchObject({
      actualPitches: 1,
      locationPitches: 1,
      leagueLocationPitches: 20,
    });
    expect(period.coverage.leagueLocationPitches).toBe(0);
    expect(period.baseline).toEqual(season.baseline);
    expect(period.summary.every((g) => g.leagueSwingRate === null)).toBe(true);
  });
  it("never reads provider bounds, even when height is unavailable", () => {
    const row = disciplineRow();
    const legacy = { ...row, topSz: 0.375, bottomSz: 1.5 };
    expect(disciplinePoint(legacy, null)).toEqual(disciplinePoint(row, null));
    expect(disciplinePoint({ ...legacy, batterHeightCm: null }, null)).toBeNull();
    expect(disciplinePoint({ ...legacy, season: 2025 }, null)?.normalizedZ).toBe(
      disciplinePoint({ ...legacy, season: 2026 }, null)?.normalizedZ,
    );
    expect(disciplinePoint({ ...legacy, season: 2023 }, null)?.normalizedZ).toBe(
      disciplinePoint({ ...legacy, season: 2024 }, null)?.normalizedZ,
    );
  });
  it("compares course and added expectation on identical matched pitches and league eligibility", () => {
    const outside = { crossPlateX: 1.2, inZone: false };
    const rows = [
      disciplineRow({ ...outside, pitchId: "in", swing: true }),
      disciplineRow({ ...outside, pitchId: "out", x0: 1.2 }),
      disciplineRow({ ...outside, pitchId: "sparse", balls: 1 }),
      disciplineRow({ ...outside, pitchId: "no-curve", vx0: null, swing: true }),
      disciplineRow({ ...outside, pitchId: "sql-only", y0: 40 }),
      disciplineRow({ pitchId: "unknown-zone", inZone: null }),
      disciplineRow({ ...outside, pitchId: "excluded", eligible: false, swing: true }),
    ];
    for (let i = 0; i < 20; i++) {
      rows.push(disciplineRow({ ...outside, batterId: "other", pitchId: `ci${i}`, swing: i < 16 }));
      rows.push(
        disciplineRow({ ...outside, batterId: "other", pitchId: `co${i}`, x0: 1.2, swing: i < 4 }),
      );
      rows.push(
        disciplineRow({ ...outside, batterId: "other", pitchId: `cm${i}`, vx0: null, swing: true }),
      );
    }
    for (let i = 0; i < 19; i++)
      rows.push(disciplineRow({ ...outside, batterId: "other", pitchId: `cs${i}`, balls: 1 }));
    const prepared = prepareDisciplineSeason(disciplineSnapshot(rows));
    const r = analyzeBatterDiscipline(prepared, "b1", { season: 2024 });
    expect(Value.Check(DisciplineResponseSchema, r)).toBe(true);
    expect(r.courseComparison.conventional.batter).toMatchObject({
      pitches: 5,
      outsideSwings: 2,
      chaseRate: 0.4,
    });
    expect(r.courseComparison.conventional.league).toMatchObject({
      pitches: 79,
      outsideSwings: 40,
    });
    expect(r.courseComparison.common.batter).toMatchObject({
      pitches: 3,
      outsideSwings: 1,
      chaseRate: 1 / 3,
    });
    expect(r.courseComparison.common.league).toMatchObject({ pitches: 59, outsideSwings: 20 });
    const [all, inside, outsideGroup] = r.courseComparison.paired;
    expect(all).toMatchObject({
      pitches: 3,
      swings: 1,
      matchedPitches: 2,
      matchedSwings: 1,
      matchedSwingRate: 0.5,
      courseLeagueSwingRate: 0.5,
      expectationLeagueSwingRate: 0.5,
    });
    expect(inside).toMatchObject({
      pitches: 2,
      matchedPitches: 1,
      matchedSwingRate: 1,
      courseLeagueSwingRate: 0.5,
      expectationLeagueSwingRate: 0.8,
    });
    expect(inside?.expectationDifference).toBeCloseTo(0.2);
    expect(outsideGroup).toMatchObject({
      matchedPitches: 1,
      matchedSwingRate: 0,
      courseLeagueSwingRate: 0.5,
      expectationLeagueSwingRate: 0.2,
    });
    const sparse = analyzeBatterDiscipline(prepared, "b1", { season: 2024, balls: 1 });
    expect(sparse.courseComparison.conventional.batter.pitches).toBe(1);
    expect(sparse.courseComparison.paired[0]).toMatchObject({
      pitches: 1,
      matchedPitches: 0,
      courseLeagueSwingRate: null,
      expectationLeagueSwingRate: null,
    });
    const noBaseline = analyzeBatterDiscipline(
      prepareDisciplineSeason({ ...disciplineSnapshot(rows), reference: null }),
      "b1",
      { season: 2024 },
    );
    expect(noBaseline.courseComparison.conventional.batter.chaseRate).toBe(0.4);
    expect(noBaseline.courseComparison.common.batter.chaseRate).toBeNull();
    expect(
      noBaseline.courseComparison.paired.every(
        (g) => g.pitches === 0 && g.matchedSwingRate === null,
      ),
    ).toBe(true);
    const reversed = analyzeBatterDiscipline(
      prepareDisciplineSeason(disciplineSnapshot([...rows].reverse())),
      "b1",
      { season: 2024 },
    );
    expect(reversed.courseComparison).toEqual(r.courseComparison);
  });
  it("restores initial location/direction and compares each trajectory at its own plate arrival", () => {
    const baseline = disciplineSnapshot().reference;
    const point = disciplinePoint(
      disciplineRow({ vy0: -100, vz0: -1, az: -10, inZone: false, crossPlateX: 0.3 }),
      baseline,
    );
    const time = (50 - 1.4167) / 100;
    expect(point?.expectedZCm).toBeCloseTo((2.5 - 0.01 * (50 - 1.4167)) * 30.48);
    expect(point?.zCm).toBeCloseTo((2.5 - time - 5 * time * time) * 30.48);
    expect(point?.deltaMs).toBeCloseTo(((50 - 1.4167) / 100 - (50 - 1.4167) / 140) * 1000);
    expect(point?.expectedInZone).toBe(true);
    expect(point?.inZone).toBe(false);
    expect(point?.xCm).toBeCloseTo(0.3 * 30.48);
  });
  it("uses the target plate plane, not the league average distance", () => {
    const point = disciplinePoint(
      disciplineRow({ crossPlateY: 2 }),
      disciplineSnapshot().reference,
    );
    expect(point?.deltaMs).toBeCloseTo(0, 10);
  });
  it("preserves zone-only points with missing lateral trajectory and absent baseline", () => {
    const point = disciplinePoint(disciplineRow({ vx0: null }), disciplineSnapshot().reference);
    expect(point?.inZone).toBe(true);
    expect(point?.expectedInZone).toBeNull();
    expect(disciplinePoint(disciplineRow(), null)?.xCm).toBe(0);
    expect(disciplinePoint(disciplineRow({ inZone: null }), null)).toBeNull();
    expect(disciplinePoint(disciplineRow({ batterHeightCm: null }), null)).toBeNull();
    expect(disciplinePoint(disciplineRow({ eligible: false }), null)).toBeNull();
    expect(disciplinePoint(disciplineRow({ supported: false }), null)).toBeNull();
  });
  it("excludes the selected batter from controls and reports only matched denominators", () => {
    const rows = [disciplineRow({ swing: true }), disciplineRow({ pitchId: "p2", balls: 1 })];
    for (let i = 0; i < 20; i++)
      rows.push(disciplineRow({ batterId: "other", pitchId: `c${i}`, swing: i < 5 }));
    for (let i = 0; i < 19; i++)
      rows.push(disciplineRow({ batterId: "other", pitchId: `u${i}`, balls: 1, swing: true }));
    const response = analyzeBatterDiscipline(
      prepareDisciplineSeason(disciplineSnapshot(rows)),
      "b1",
      { season: 2024 },
    );
    expect(Value.Check(DisciplineResponseSchema, response)).toBe(true);
    expect(response.summary[0]).toMatchObject({
      pitches: 2,
      swings: 1,
      swingRate: 0.5,
      matchedPitches: 1,
      matchedSwings: 1,
      matchedSwingRate: 1,
      leagueSwingRate: 0.25,
      difference: 0.75,
    });
    const onlyTarget = analyzeBatterDiscipline(
      prepareDisciplineSeason(disciplineSnapshot(rows.slice(0, 2))),
      "b1",
      { season: 2024 },
    );
    expect(onlyTarget.summary[0]?.leagueSwingRate).toBeNull();
    expect(onlyTarget.summary[1]?.swingRate).toBeNull();
    const filtered = analyzeBatterDiscipline(
      prepareDisciplineSeason(disciplineSnapshot(rows)),
      "b1",
      { season: 2024, balls: 1 },
    );
    expect(filtered.points).toHaveLength(1);
    expect(filtered.summary[0]?.matchedPitches).toBe(0);
  });
  it("keeps unknown type/stance strata distinct, does not borrow unmatched context, and conserves counts", () => {
    const rows = [
      disciplineRow({ pitchType: null, stance: null }),
      disciplineRow({ pitchId: "p2", trackingId: null }),
      disciplineRow({ pitchId: "p3", eligible: false }),
      disciplineRow({ pitchId: "p4", vx0: null }),
    ];
    for (let i = 0; i < 20; i++) rows.push(disciplineRow({ batterId: "other", pitchId: `c${i}` }));
    const response = analyzeBatterDiscipline(
      prepareDisciplineSeason(disciplineSnapshot(rows)),
      "b1",
      { season: 2024 },
    );
    expect(response.coverage).toMatchObject({
      actualPitches: 4,
      excludedSituations: 1,
      missingLocation: 1,
      locationPitches: 2,
      comparisonPitches: 1,
    });
    expect(response.summary[0]?.matchedPitches).toBe(1);
    expect(response.transitions.reduce((n, g) => n + g.pitches, 0)).toBe(1);
    expect(response.cells.reduce((n, g) => n + g.pitches, 0)).toBe(2);
    expect(response.points.every((p) => !("batterId" in p))).toBe(true);
  });
});
