import { expect, it } from "vitest";
import fc from "fast-check";
import { Value } from "@sinclair/typebox/value";
import { DisciplinePeriodQuerySchema, PitchProfilePeriodQuerySchema } from "@kbo/contracts";
import {
  resolveAnalysisScope,
  analysisPeriodQueries,
  pitchLocationComparisonQueries,
  pitchOutcomeScope,
  type PitchAnalysisSample,
} from "@kbo/contracts";
import {
  battingStatistics,
  pitchingStatistics,
  compareBattingPeriods,
  comparePitchingPeriods,
  summarizePitchProfile,
  comparePitchProfilePeriods,
  analyzeBatterProfile,
  compareBatterProfilePeriods,
} from "@kbo/game-core";
import { battingTotals, pitchingTotals } from "../helpers/player-statistics.js";
import { outcomeRow, terminalPa } from "../helpers/pitch-outcomes.js";
import { calibrationSummary } from "../helpers/pitch-calibration.js";

it("validates both scopes and never inherits A dates into a whole-season B", () => {
  expect(
    analysisPeriodQueries({
      season: 2024,
      dateFrom: "2024-04-01",
      dateTo: "2024-05-01",
      compareSeason: 2025,
      balls: 2,
    }).second,
  ).toEqual({ season: 2025, balls: 2 });
  for (const bad of [
    { compareDateFrom: "2025-05-01", compareDateTo: "2025-04-01" },
    { compareDateFrom: "2024-04-01" },
    { compareDateFrom: "2025-02-29" },
  ])
    expect(() => analysisPeriodQueries({ season: 2024, compareSeason: 2025, ...bad })).toThrow();
});
it("splits location comparison dates and preserves the shared filters and regular-season default", () => {
  const query = {
    season: 2024,
    dateFrom: "2024-02-29",
    dateTo: "2024-04-01",
    compareSeason: 2025,
    compareDateTo: "2025-05-02",
    strikes: 2,
    pitchType: "직구",
  };
  const periods = pitchLocationComparisonQueries(query);
  expect(periods).toEqual({
    first: {
      season: 2024,
      dateFrom: "2024-02-29",
      dateTo: "2024-04-01",
      strikes: 2,
      pitchType: "직구",
    },
    second: { season: 2025, dateTo: "2025-05-02", strikes: 2, pitchType: "직구" },
  });
  expect(analysisPeriodQueries(query)).toEqual(periods);
  expect(pitchOutcomeScope(periods.second)).toEqual({
    season: 2025,
    competition: "regular",
    dateFrom: null,
    dateTo: "2025-05-02",
  });
  expect(pitchOutcomeScope({ ...periods.first, competition: "postseason" }).competition).toBe(
    "postseason",
  );
});

it("aggregates team numerators and denominators before comparing batting rates", () => {
  const rows = [
    battingStatistics(battingTotals),
    battingStatistics({
      ...battingTotals,
      teamId: "OTHER",
      hits: 1,
      doubles: 0,
      homeRuns: 0,
      atBats: 15,
    }),
  ];
  const result = compareBattingPeriods(
    rows,
    [rows[0]].filter((r) => r !== undefined),
  );
  expect(result.find((r) => r.label === "AVG")).toMatchObject({
    first: { value: 3 / 20, numerator: 3, denominator: 20 },
    second: { value: 2 / 5 },
  });
  expect(result.find((r) => r.label === "AVG")?.difference).toBeCloseTo(0.25);
  expect(compareBattingPeriods([], []).find((r) => r.label === "OPS")?.difference).toBeNull();
});
it("keeps incomplete ERA unknown and compares only confirmed ER innings separately", () => {
  const result = comparePitchingPeriods(
    [pitchingStatistics(pitchingTotals)],
    [
      pitchingStatistics({
        ...pitchingTotals,
        knownErGames: 2,
        knownErOuts: 27,
        knownEarnedRuns: 2,
      }),
    ],
  );
  expect(result.find((r) => r.label === "ERA")).toMatchObject({
    first: { value: null },
    second: { value: 2 },
    difference: null,
  });
  expect(result.find((r) => r.label === "ER 확인 경기 ERA")).toMatchObject({
    first: { value: 3, numerator: 27, denominator: 9 },
    difference: -1,
  });
});
it("preserves statistics under equivalent team partitions and deterministic order", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      (count, hits) => {
        const row = battingStatistics({
          ...battingTotals,
          atBats: count + hits,
          hits,
          doubles: 0,
          homeRuns: 0,
        });
        const a = compareBattingPeriods([row, row], [row]);
        for (const m of a.filter((m) =>
          ["AVG", "OBP", "SLG", "OPS", "K%", "BB%"].includes(m.label),
        ))
          expect(m.difference).toBe(0);
        expect(compareBattingPeriods([row, row], [row])).toEqual(a);
      },
    ),
  );
});
function shape(season: number, pitchType: string | null = "직구"): PitchAnalysisSample {
  const r = { gameDate: `${season}-06-01`, pitchType, speedKph: 145, swing: true, whiff: false };
  return {
    modelVersion: 2,
    season,
    pitcherId: "hp1",
    sourceHash: "a".repeat(64),
    referenceSourceHash: "b".repeat(64),
    actualPitchCount: 1,
    missingTrackingCount: 0,
    invalidTrackingCount: 0,
    baseline: null,
    referenceDistribution: null,
    calibration: calibrationSummary(1),
    points: [],
    profile: summarizePitchProfile(
      [r],
      [{ ...r, xCm: 4, zCm: 8, arrivalMs: 400, calibrationStatus: "applied" }],
    ),
  };
}
it("aligns provider types, preserves observed zero usage and suppresses cross-season relative differences", () => {
  const a = shape(2024),
    b = shape(2025, "슬라이더");
  const result = comparePitchProfilePeriods(a, b);
  expect(result.find((r) => r.group === "구종 직구" && r.label === "사용률")).toMatchObject({
    second: { value: 0, numerator: 0, denominator: 1 },
    difference: -1,
  });
  expect(
    result.find((r) => r.group === "구종 슬라이더" && r.label === "평균 구속")?.first.value,
  ).toBeNull();
  const sameType = comparePitchProfilePeriods(a, shape(2025));
  expect(sameType.find((r) => r.label === "보정 가로")?.difference).toBeNull();
  expect(sameType.find((r) => r.label === "평균 구속")?.difference).toBe(0);
  expect(comparePitchProfilePeriods(a, a).find((r) => r.label === "보정 가로")?.difference).toBe(0);
});
it("keeps pitch reactions separate from terminal PA attribution across periods", () => {
  const q = { season: 2024 },
    scope = resolveAnalysisScope(q);
  const rows = Array.from({ length: 5 }, (_, i) =>
    outcomeRow({
      pitchId: `p${i}`,
      pitchType: i < 3 ? "직구" : "체인지업",
      swing: true,
      whiff: false,
    }),
  );
  const a = analyzeBatterProfile(q, "b1", scope, "a".repeat(64), rows, [
    terminalPa({
      pitchId: "p4",
      pitchType: "체인지업",
      result: "single",
      pitchCall: "in_play",
      inPlay: true,
    }),
  ]);
  const b = analyzeBatterProfile(q, "b1", scope, "b".repeat(64), [], []);
  const result = compareBatterProfilePeriods(a, b);
  const courses = [
    ...new Set(result.map((r) => r.group).filter((group) => group.startsWith("코스 "))),
  ];
  expect(courses[0]).toBe("코스 1행 1열");
  expect(courses[24]).toBe("코스 5행 5열");
  expect(result.find((r) => r.group === "전체" && r.label === "Swing%")?.first.denominator).toBe(5);
  expect(
    result.find((r) => r.group === "종결 투구 전체" && r.label === "완료 PA")?.first.value,
  ).toBe(1);
  expect(result.find((r) => r.group === "종결 투구 전체" && r.label === "AVG")?.first).toEqual({
    value: 1,
    numerator: 1,
    denominator: 1,
  });
  expect(result.find((r) => r.group === "전체" && r.label === "Whiff%")?.second.value).toBeNull();
});
it("uses the common analysis season range for both A and B", () => {
  expect(Value.Check(PitchProfilePeriodQuerySchema, { season: 2025, compareSeason: 2201 })).toBe(
    false,
  );
  expect(Value.Check(DisciplinePeriodQuerySchema, { season: 2024, compareSeason: 2027 })).toBe(
    true,
  );
  expect(Value.Check(DisciplinePeriodQuerySchema, { season: 2027, compareSeason: 2024 })).toBe(
    true,
  );
  expect(Value.Check(DisciplinePeriodQuerySchema, { season: 2027, compareSeason: 2201 })).toBe(
    false,
  );
  expect(Value.Check(DisciplinePeriodQuerySchema, { season: 1981, compareSeason: 2027 })).toBe(
    false,
  );
});
