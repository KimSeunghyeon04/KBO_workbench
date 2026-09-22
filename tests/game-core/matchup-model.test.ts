import { beforeAll, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  MatchupModelSchema,
  MatchupModelResponseSchema,
  resolveAnalysisScope,
  type MatchupModel,
  type PitchQualityModel,
} from "@kbo/contracts";
import { trainPitchQuality, trainMatchupModel, summarizeMatchupModel } from "@kbo/game-core";
import { qualityRows, qualityProfiles } from "../helpers/pitch-quality.js";
import {
  offsetProbability,
  fitBatterEffects,
} from "../../packages/game-core/src/matchup-effects.js";
import {
  prepareQualityRows,
  qualityCohort,
} from "../../packages/game-core/src/pitch-quality-features.js";
let randomState = 1907;
const random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 4294967296;
};
const rows = qualityRows().map((r, i) => {
  const batter = (Math.floor(i / 30) + (i % 30)) % 4,
    offset = batter < 2 ? -1.5 : 1.5,
    swing = random() < offsetProbability(Math.abs(r.crossPlateX ?? 0) < 0.85 ? 0.8 : 0.2, offset),
    whiff = swing && random() < offsetProbability((r.speedKph ?? 0) > 140 ? 0.65 : 0.15, offset);
  return {
    ...r,
    batterId: `b-${batter}`,
    swing,
    whiff,
    calledStrike:
      !swing &&
      random() < offsetProbability(Math.abs(r.crossPlateX ?? 0) < 0.85 ? 0.85 : 0.15, offset),
  };
});
let base: PitchQualityModel, model: MatchupModel;
beforeAll(() => {
  base = trainPitchQuality(rows, qualityProfiles(), "a".repeat(64));
  model = trainMatchupModel(rows, base, "b".repeat(64), base.sourceHash);
}, 30000);
it("validates batter effects out of time and fits shrinkage without using future labels", () => {
  expect(Value.Check(MatchupModelSchema, model)).toBe(true);
  expect(model.targets.some((m) => m.adopted)).toBe(true);
  const changed = trainMatchupModel(
    rows.map((r) =>
      r.season === 2025
        ? { ...r, swing: !r.swing, whiff: false, calledStrike: false, speedKph: 250 }
        : r,
    ),
    base,
    "b".repeat(64),
    base.sourceHash,
  );
  expect(changed.similarity).toEqual(model.similarity);
  expect(changed.validationPreprocessing).toEqual(model.validationPreprocessing);
  expect(
    changed.targets.map(({ evaluation, ...m }) => {
      void evaluation;
      return m;
    }),
  ).toEqual(
    model.targets.map(({ evaluation, ...m }) => {
      void evaluation;
      return m;
    }),
  );
  expect(trainMatchupModel([...rows].reverse(), base, "b".repeat(64), base.sourceHash)).toEqual(
    model,
  );
}, 30000);
it("keeps raw facts unchanged, conserves coverage and declines sparse/unvalidated batter predictions", () => {
  const query = { season: 2025, pitcherId: "pitcher-0", batterId: "b-0" },
    scope = resolveAnalysisScope({ season: 2025 }, "regular"),
    pitches = rows.filter((r) => r.season === 2025 && r.pitcherId === query.pitcherId),
    batter = rows.filter((r) => r.season === 2025 && r.batterId === query.batterId),
    before = structuredClone([pitches, batter]),
    response = summarizeMatchupModel(
      query,
      scope,
      "a".repeat(64),
      pitches,
      batter,
      model,
      "b".repeat(64),
    );
  expect(Value.Check(MatchupModelResponseSchema, response)).toBe(true);
  expect([pitches, batter]).toEqual(before);
  expect(response.similarity?.rows.length).toBe(response.similarity?.pitches);
  expect(response.similarity?.rows.every((r) => r.distance <= model.similarity.radius)).toBe(true);
  expect(response.similarity?.conditionCandidates).toBe(
    (response.similarity?.pitches ?? 0) + (response.similarity?.excludedByDistance ?? 0),
  );
  const unavailable = summarizeMatchupModel(
    query,
    scope,
    "a".repeat(64),
    pitches,
    batter,
    null,
    null,
  );
  expect(unavailable.status).toBe("model_unavailable");
  expect(unavailable.groups).toEqual([]);
  const unknown = summarizeMatchupModel(
    { ...query, batterId: "new" },
    scope,
    "a".repeat(64),
    pitches,
    batter.map((r) => ({ ...r, batterId: "new" })),
    model,
    "b".repeat(64),
  );
  expect(unknown.effects.every((e) => e.status !== "ready")).toBe(true);
  expect(
    unknown.groups.every((g) => g.swing === null && g.whiff === null && g.calledStrike === null),
  ).toBe(true);
  const disabled = summarizeMatchupModel(
    query,
    scope,
    "a".repeat(64),
    pitches,
    batter,
    { ...model, targets: model.targets.map((t) => ({ ...t, adopted: false })) },
    "b".repeat(64),
  );
  expect(disabled.groups.every((g) => g.swing === null && g.whiffPerPitch === null)).toBe(true);
  expect(
    summarizeMatchupModel(
      query,
      { ...scope, competition: "all" },
      "a".repeat(64),
      pitches,
      batter,
      model,
      "b".repeat(64),
    ).status,
  ).toBe("scope_mismatch");
});
it("shrinks extreme player effects toward the fixed league probability", () => {
  const samples = qualityCohort(
      prepareQualityRows(rows.filter((r) => r.season < 2025)),
      base.preprocessing,
    ).samples.map((s) => ({ ...s, row: { ...s.row, swing: true } })),
    p = new Float64Array(samples.length).fill(0.5),
    weak = fitBatterEffects(samples, "swing", p, 20),
    strong = fitBatterEffects(samples, "swing", p, 500);
  expect(weak.every((e) => e.converged && Number.isFinite(e.offset))).toBe(true);
  weak.forEach((e, i) => expect(e.offset).toBeGreaterThan(strong[i]?.offset ?? Infinity));
  expect(offsetProbability(0.5, 0)).toBe(0.5);
});
