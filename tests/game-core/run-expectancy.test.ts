import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  RunExpectancyModelSchema,
  RunValueResponseSchema,
  type RunTrainingGame,
  type RunObservation,
} from "@kbo/contracts";
import { collectRunObservations, trainRunExpectancy, evaluateRunValues } from "@kbo/game-core";
import { analysisPlay, analysisState, analysisMovement } from "../helpers/analysis-play.js";
const game: RunTrainingGame = {
  gameId: "g",
  revision: 1,
  season: 2025,
  gameDate: "2025-06-01",
  scheduledInnings: 9,
  status: "final",
  normalEnd: true,
  documentHash: "a".repeat(64),
};
const hash = "a".repeat(64);
function half() {
  return [
    analysisPlay({
      playId: "start",
      sequence: 0,
      kind: "half_inning_start",
      before: analysisState({ halfActive: false }),
      after: analysisState(),
    }),
    analysisPlay({ playId: "pa1", sequence: 1, kind: "batter_start" }),
    analysisPlay({ playId: "pitch1", sequence: 2, kind: "pitch" }),
    analysisPlay({ playId: "pitch2", sequence: 3, kind: "pitch" }),
    analysisPlay({
      playId: "hr",
      sequence: 4,
      before: analysisState(),
      after: analysisState({ awayScore: 1 }),
    }),
    analysisPlay({
      playId: "pa2",
      sequence: 5,
      kind: "batter_start",
      before: analysisState({ awayScore: 1 }),
      after: analysisState({ awayScore: 1 }),
    }),
    analysisPlay({
      playId: "end",
      sequence: 6,
      before: analysisState({ awayScore: 1 }),
      after: analysisState({ awayScore: 1, outs: 3 }),
    }),
  ];
}
it("uses one PA start observation and excludes incomplete, shortened and ninth-inning training halves", () => {
  const observations = collectRunObservations(game, half());
  expect(observations.map((r) => r.remainingRuns)).toEqual([1, 0]);
  expect(collectRunObservations({ ...game, normalEnd: false }, half())).toEqual([]);
  expect(collectRunObservations(game, half().slice(0, -1))).toEqual([]);
  expect(
    collectRunObservations(
      game,
      half().map((p) => ({
        ...p,
        inning: 9,
        before: { ...p.before, inning: 9 },
        after: { ...p.after, inning: 9 },
      })),
    ),
  ).toEqual([]);
});
it("never learns future states and preserves unsupported states as null", () => {
  const row: RunObservation = {
    gameId: "old",
    revision: 1,
    season: 2022,
    gameDate: "2022-06-01",
    inning: 1,
    half: "top",
    outs: 0,
    bases: 0,
    remainingRuns: 1,
  };
  const model = trainRunExpectancy(
    [row, { ...row, season: 2025, remainingRuns: 99, bases: 7 }],
    hash,
  );
  expect(Value.Check(RunExpectancyModelSchema, model)).toBe(true);
  expect(model.cells[0]?.mean).toBe(1);
  expect(model.cells[7]?.mean).toBeNull();
  expect(model.evaluation).toMatchObject({ samples: 0, unsupported: 1 });
  expect(
    trainRunExpectancy([row, { ...row, season: 2026, remainingRuns: 100 }], hash).cells,
  ).toEqual(model.cells);
});
it("conserves atomic play values and does not set walk-off remaining expectancy to zero", () => {
  const observations = collectRunObservations({ ...game, season: 2022 }, half()),
    model = trainRunExpectancy(observations, hash);
  const result = evaluateRunValues(game, half(), model, hash);
  expect(Value.Check(RunValueResponseSchema, result)).toBe(true);
  expect(result.halves[0]).toMatchObject({
    complete: true,
    runs: 1,
    startRE: 0.5,
    valueSum: 0.5,
    conserved: true,
  });
  expect(result.plays.find((p) => p.playId === "hr")?.value).toBe(1);
  const incomplete = evaluateRunValues(game, half().slice(0, -1), model, hash);
  expect(incomplete.halves[0]?.valueSum).toBeNull();
  expect(incomplete.plays.every((p) => p.value === null)).toBe(true);
  expect(evaluateRunValues({ ...game, season: 2024 }, half(), model, hash).status).toBe(
    "outside_training_period",
  );
});

it("annotates observed tactics without assigning compound value to an individual runner", () => {
  const plays = [
    analysisPlay({
      playId: "steal",
      kind: "runner_advance",
      movements: [analysisMovement({ reason: "stolen_base" })],
    }),
    analysisPlay({
      playId: "double-steal",
      sequence: 1,
      kind: "runner_advance",
      movements: [
        analysisMovement({ reason: "stolen_base" }),
        analysisMovement({ runnerId: "other", reason: "stolen_base" }),
      ],
    }),
    analysisPlay({ playId: "bunt", sequence: 2, isBunt: true }),
    analysisPlay({
      playId: "inferred",
      sequence: 3,
      movements: [analysisMovement({ derived: true })],
    }),
  ];
  expect(
    evaluateRunValues(game, plays, null, null).plays.map((p) => [p.playId, p.action, p.value]),
  ).toEqual([
    ["steal", "steal_only", null],
    ["double-steal", "compound", null],
    ["bunt", "bunt", null],
    ["inferred", "other", null],
  ]);
});
