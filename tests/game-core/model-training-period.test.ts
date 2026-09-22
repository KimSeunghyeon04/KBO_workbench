import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisModelPeriodSchema,
  type AnalysisModelKind,
  type RunObservation,
} from "@kbo/contracts";
import {
  modelTrainingPeriod,
  trainRunExpectancy,
  trainCountRunExpectancy,
  trainPitchQuality,
  trainMatchupModel,
  trainParkEnvironment,
} from "@kbo/game-core";
import { qualityRows, qualityProfiles } from "../helpers/pitch-quality.js";
import { parkEnvironmentRows } from "../helpers/park-environment.js";
const withoutEvaluation = (model: object) =>
  Object.fromEntries(Object.entries(model).filter(([key]) => key !== "evaluation"));

it("requires two prior validation years and keeps unsupported win rules distinct", () => {
  for (let season = 2020; season <= 2025; season++) {
    for (const kind of [
      "re24",
      "count",
      "quality",
      "matchup",
      "park",
      "win",
    ] satisfies AnalysisModelKind[]) {
      const period = modelTrainingPeriod(kind, season);
      expect(Value.Check(AnalysisModelPeriodSchema, period)).toBe(true);
      expect(
        period.validationSeasons.every(
          (year) => year < season && year > period.trainingStartSeason,
        ),
      ).toBe(true);
      expect(period.support === "eligible").toBe(season >= (kind === "win" ? 2025 : 2023));
    }
  }
  expect(modelTrainingPeriod("win", 2021).support).toBe("unsupported_rules");
  expect(modelTrainingPeriod("win", 2024).support).toBe("insufficient_history");
  expect(() => modelTrainingPeriod("quality", 2026)).toThrow();
});

it.each([2023, 2024, 2025])(
  "fits and validates RE/count for %i without target or later labels",
  (season) => {
    const rows: RunObservation[] = Array.from({ length: 6 }, (_, i) => 2020 + i).flatMap((year) =>
      Array.from({ length: 30 }, (_, game) => ({
        gameId: `${year}-${game}`,
        revision: 1,
        season: year,
        gameDate: `${year}-06-01`,
        inning: 1,
        half: "top" as const,
        outs: 0,
        bases: 0,
        remainingRuns: game % 4,
      })),
    );
    const through = season - 1;
    const train = (input: RunObservation[]) => [
      trainRunExpectancy(input, "a".repeat(64), through),
      trainCountRunExpectancy(
        input.map((r) => ({ ...r, balls: 0, strikes: 0 })),
        input,
        "a".repeat(64),
        through,
      ),
    ];
    const original = train(rows),
      changed = train(
        rows.map((r) => (r.season >= season ? { ...r, remainingRuns: 999, bases: 7 } : r)),
      );
    original.forEach((model, index) => {
      expect(model.validation[0]?.evaluations.map((e) => e.season)).toEqual([
        season - 2,
        season - 1,
      ]);
      expect(model.evaluation?.season).toBe(season);
      expect(withoutEvaluation(changed[index] ?? {})).toEqual(withoutEvaluation(model));
    });
  },
);

it.each([2023, 2024])(
  "keeps quality and matchup preprocessing and selection before %i",
  (season) => {
    const rows = qualityRows(),
      profiles = qualityProfiles(),
      hash = "a".repeat(64),
      through = season - 1;
    const fit = (input: typeof rows) => {
      const base = trainPitchQuality(input, profiles, hash, through);
      return { base, matchup: trainMatchupModel(input, base, hash, hash) };
    };
    const original = fit(rows),
      changed = fit(
        rows.map((r) =>
          r.season >= season
            ? { ...r, swing: !r.swing, whiff: false, speedKph: 400, crossPlateX: 20 }
            : r,
        ),
      );
    expect(original.base.targets.some((t) => t.adopted)).toBe(true);
    for (const key of ["base", "matchup"] as const) {
      const model = original[key];
      expect(model.validationPreprocessing.map((p) => p.season)).toEqual([season - 2, season - 1]);
      expect(changed[key].validationPreprocessing).toEqual(model.validationPreprocessing);
      expect(model.targets.map((t) => t.evaluation?.season)).toEqual([season, season, season]);
      expect(changed[key].targets.map(withoutEvaluation)).toEqual(
        model.targets.map(withoutEvaluation),
      );
    }
    expect(changed.base.preprocessing).toEqual(original.base.preprocessing);
    expect(changed.matchup.similarity).toEqual(original.matchup.similarity);
  },
  60_000,
);

it("validates park effects on the two seasons preceding historical application", () => {
  const rows = [2020, 2021, 2022, 2023, 2024].flatMap((season) => parkEnvironmentRows(season, 120));
  const model = trainParkEnvironment(rows, "a".repeat(64), 2022);
  const changed = trainParkEnvironment(
    rows.map((r) => (r.season >= 2023 ? { ...r, homeRuns: 99, completeRuns: 999 } : r)),
    "a".repeat(64),
    2022,
  );
  expect(model.metrics[0]?.validation[0]?.evaluations.map((e) => e.season)).toEqual([2021, 2022]);
  expect(changed.metrics.map(withoutEvaluation)).toEqual(model.metrics.map(withoutEvaluation));
}, 30_000);
