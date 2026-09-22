import { expect, it } from "vitest";
import fc from "fast-check";
import { Value } from "@sinclair/typebox/value";
import { WorkloadComparisonResponseSchema, resolveAnalysisScope } from "@kbo/contracts";
import { comparePitcherWorkload } from "@kbo/game-core";
import {
  workloadAppearance,
  workloadCell,
  workloadComparisonFixture,
} from "../helpers/workload-comparison.js";
const query = { season: 2024, competition: "all" as const },
  scope = resolveAnalysisScope(query),
  hash = "a".repeat(64);
const run = (input = workloadComparisonFixture()) =>
  comparePitcherWorkload(query, scope, "p", hash, input.history, input.cells);
it("removes composition differences on common support and preserves metric-specific denominators", () => {
  const result = run();
  expect(Value.Check(WorkloadComparisonResponseSchema, result)).toBe(true);
  const pitch = result.dimensions.find((d) => d.dimension === "pitchNumber");
  const speed = pitch?.comparisons.find((r) => r.comparison === "26–50" && r.metric === "speed");
  expect(speed).toMatchObject({
    status: "ready",
    commonStrata: 2,
    overlapWeight: 60,
    difference: 0,
    interval: { low: 0, high: 0 },
    validReplicates: 600,
  });
  expect(speed?.baseline).toMatchObject({
    rawMean: 136,
    adjustedMean: 130,
    samples: 150,
    matchedGames: 6,
  });
  expect(speed?.target).toMatchObject({ rawMean: 124, adjustedMean: 130, samples: 150 });
  const whiff = pitch?.comparisons.find((r) => r.comparison === "26–50" && r.metric === "whiff");
  expect(whiff?.baseline.samples).toBe(90);
  expect(whiff?.baseline.rawMean).toBeCloseTo(0.2);
  expect(whiff?.difference).toBeCloseTo(0);
  expect(
    result.dimensions.every(
      (d) =>
        d.groupedPitches + d.excludedWorkloadPitches + result.excludedConditionPitches ===
        result.actualPitches,
    ),
  ).toBe(true);
});
it("resamples games jointly so shared game shocks do not create a fictitious contrast interval", () => {
  const history = Array.from({ length: 8 }, (_, i) =>
    workloadAppearance(`g${i}`, `2024-06-${String(i + 1).padStart(2, "0")}`),
  );
  const cells = history.flatMap((a, i) => [
    workloadCell(a.gameId, { speedSum: (130 + i * 2) * 20 }),
    workloadCell(a.gameId, { pitchBucket: 1, speedSum: (132 + i * 2) * 20 }),
  ]);
  const row = run({ history, cells }).dimensions.find((d) => d.dimension === "pitchNumber")
    ?.comparisons[0];
  expect(row?.difference).toBeCloseTo(2);
  expect(row?.interval?.low).toBeCloseTo(2);
  expect(row?.interval?.high).toBeCloseTo(2);
});
it("keeps unsupported strata out, and never substitutes zero for missing metadata or ambiguous same-day workload", () => {
  const fixture = workloadComparisonFixture();
  fixture.cells = fixture.cells.map((c) => (c.pitchBucket === 1 ? { ...c, stance: "L" } : c));
  const result = run(fixture),
    row = result.dimensions.find((d) => d.dimension === "pitchNumber")?.comparisons[0];
  expect(row).toMatchObject({
    status: "insufficient_support",
    difference: null,
    interval: null,
    commonStrata: 0,
  });
  expect(row?.baseline.samples).toBe(150);
  const first = workloadAppearance("first", "2024-06-01"),
    second = workloadAppearance("same", "2024-06-01"),
    unknown = workloadAppearance("unknown", "2024-06-02", "unknown");
  const missing = run({
    history: [first, second, unknown],
    cells: [
      workloadCell("first"),
      workloadCell("same", { stance: null }),
      workloadCell("unknown", { observedRole: "unknown" }),
    ],
  });
  expect(missing.actualPitches).toBe(60);
  expect(missing.excludedConditionPitches).toBe(40);
  expect(missing.dimensions.find((d) => d.dimension === "rest")).toMatchObject({
    groupedPitches: 0,
    excludedWorkloadPitches: 20,
  });
  expect(missing.dimensions.find((d) => d.dimension === "pitchNumber")).toMatchObject({
    groupedPitches: 20,
    excludedWorkloadPitches: 0,
  });
});
it("does not use future rows and produces identical results for reordered input", () => {
  const fixture = workloadComparisonFixture(),
    before = run(fixture);
  expect(
    run({ history: [...fixture.history].reverse(), cells: [...fixture.cells].reverse() }),
  ).toEqual(before);
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 200 }), (speed) => {
      expect(
        run({
          history: [...fixture.history, workloadAppearance("future", "2025-01-01")],
          cells: [...fixture.cells, workloadCell("future", { speedSum: 20 * speed })],
        }),
      ).toEqual(before);
    }),
    { numRuns: 8 },
  );
});
it("uses separately labelled observed entry roles without filling the official roster role", () => {
  const fixture = workloadComparisonFixture();
  const history = fixture.history.map((a) => ({ ...a, role: "unknown" as const }));
  const result = run({ history, cells: fixture.cells });
  expect(result.roleEvidence).toEqual({
    registeredPitches: 0,
    observedPitches: 300,
    unknownPitches: 0,
  });
  expect(result.dimensions.find((d) => d.dimension === "pitchNumber")?.comparisons[0]?.status).toBe(
    "ready",
  );
  expect(history.every((a) => a.role === "unknown")).toBe(true);
  const separated = run({
    history,
    cells: fixture.cells.map((c) =>
      c.pitchBucket === 1 ? { ...c, observedRole: "later_pitcher" as const } : c,
    ),
  });
  expect(
    separated.dimensions.find((d) => d.dimension === "pitchNumber")?.comparisons[0]?.commonStrata,
  ).toBe(0);
});
it("withholds the contrast when rare conditions disappear in too many game resamples", () => {
  const fixture = workloadComparisonFixture();
  fixture.cells.push(
    workloadCell("g0", { pitchType: "rare" }),
    workloadCell("g0", { pitchType: "rare", pitchBucket: 1 }),
  );
  const row = run(fixture).dimensions.find((d) => d.dimension === "pitchNumber")?.comparisons[0];
  expect(row?.status).toBe("unstable_interval");
  expect(row?.validReplicates).toBeLessThan(480);
  expect(row?.difference).toBeNull();
  expect(row?.interval).toBeNull();
});
it("uses prior calendar days across scope/team boundaries and excludes unknown same-day ordering only from date loads", () => {
  const history = [
    workloadAppearance("prior", "2024-05-31"),
    workloadAppearance("one", "2024-06-01"),
    workloadAppearance("two", "2024-06-01"),
  ];
  const result = run({ history, cells: [workloadCell("one"), workloadCell("two")] });
  expect(
    result.dimensions
      .filter((d) => ["rest", "previous3Days", "previous7Days"].includes(d.dimension))
      .every((d) => d.groupedPitches === 0),
  ).toBe(true);
  const single = run({ history: history.slice(0, 2), cells: [workloadCell("one")] });
  expect(
    single.dimensions.find((d) => d.dimension === "rest")?.comparisons[0]?.target.samples,
  ).toBe(20);
  expect(
    single.dimensions.find((d) => d.dimension === "previous3Days")?.comparisons[0]?.target.samples,
  ).toBe(20);
});
