import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  ParkEnvironmentModelSchema,
  ParkEnvironmentResponseSchema,
  resolveAnalysisScope,
} from "@kbo/contracts";
import { analyzeParkEnvironment, trainParkEnvironment } from "@kbo/game-core";
import {
  fitCountRegression,
  invertCountInformation,
  countMean,
} from "../../packages/game-core/src/count-regression.js";
import { parkEnvironmentRows } from "../helpers/park-environment.js";
it("keeps home/away games and PA denominators separate and unsupported facility names visible", () => {
  const rows = parkEnvironmentRows(2025, 4).map((r, i) => (i < 2 ? { ...r, parkId: null } : r));
  const result = analyzeParkEnvironment(
    resolveAnalysisScope({ season: 2025, competition: "regular" }),
    "a".repeat(64),
    rows,
    null,
    null,
  );
  expect(Value.Check(ParkEnvironmentResponseSchema, result)).toBe(true);
  expect(result.games).toBe(4);
  expect(result.rows).toBe(8);
  expect(result.parks.reduce((s, p) => s + p.total.pa, 0)).toBe(320);
  expect(result.modelStatus).toBe("model_unavailable");
  expect(result.weather).toBe("excluded_no_confirmed_start_time");
});
it("compares time splits and reports identifiable supported factors without future leakage", () => {
  const rows = [2020, 2021, 2022, 2023, 2024].flatMap((y) => parkEnvironmentRows(y)),
    hash = "a".repeat(64),
    model = trainParkEnvironment(rows, hash),
    future = parkEnvironmentRows(2025).map((r) => ({
      ...r,
      homeRuns: 200,
      completeRuns: 900,
      parkId: "new",
    }));
  expect(Value.Check(ParkEnvironmentModelSchema, model)).toBe(true);
  const changed = trainParkEnvironment([...rows, ...future], hash);
  expect(changed.metrics.map((m) => m.fitted)).toEqual(model.metrics.map((m) => m.fitted));
  const hr = model.metrics[0];
  expect(hr?.adopted).toBe(true);
  expect(hr?.fitted.factors.find((f) => f.parkId === "park0")?.index).toBeGreaterThan(100);
  expect(changed.metrics[0]?.evaluation?.excluded).toBe(future.length);
  expect(
    model.metrics.every((m) =>
      m.validation.every((v) => v.evaluations.every((e) => e.rows === 480)),
    ),
  ).toBe(true);
});
it("uses explicit exposure, converges on count data and leaves singular/empty fits unsupported", () => {
  const rows = [
      { game: "a", indices: [0], exposure: 10, y: 2 },
      { game: "b", indices: [0], exposure: 20, y: 4 },
    ],
    fit = fitCountRegression(rows, 1, 1, 0);
  expect(fit.converged).toBe(true);
  expect(
    countMean(rows[0] ?? { game: "a", indices: [0], exposure: 10, y: 2 }, fit.coefficients),
  ).toBeCloseTo(2);
  expect(
    invertCountInformation([
      [1, 1],
      [1, 1],
    ]),
  ).toBeNull();
  expect(fitCountRegression([], 1, 1, 0).converged).toBe(false);
  const empty = trainParkEnvironment([], "a".repeat(64));
  expect(empty.metrics.every((m) => !m.adopted)).toBe(true);
});
