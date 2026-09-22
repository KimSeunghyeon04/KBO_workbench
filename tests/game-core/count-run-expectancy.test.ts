import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  CountRunValueResponseSchema,
  CountRunModelSchema,
  type RunTrainingGame,
  type RunObservation,
  type CountRunObservation,
} from "@kbo/contracts";
import {
  collectCountRunObservations,
  countValueTransitions,
  evaluateCountRunValues,
  trainCountRunExpectancy,
} from "@kbo/game-core";
import {
  analysisPlay as play,
  analysisState as state,
  analysisMovement as movement,
} from "../helpers/analysis-play.js";
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
function model() {
  const pas: RunObservation[] = Array.from({ length: 24 }, (_, i) => ({
    gameId: "old",
    revision: 1,
    season: 2022,
    gameDate: "2022-06-01",
    inning: 1,
    half: "top",
    outs: Math.floor(i / 8),
    bases: i % 8,
    remainingRuns: 1,
  }));
  return trainCountRunExpectancy(
    pas.map((r) => ({ ...r, balls: 0, strikes: 0 })),
    pas,
    "a".repeat(64),
  );
}
function sample() {
  const s0 = state(),
    s1 = state({ balls: 1 }),
    s2 = state({ balls: 2 }),
    s3 = state({ balls: 3 }),
    s4 = state({ balls: 4 }),
    on = state({ bases: [{ runnerId: "b", pitcherId: "p" }, null, null] }),
    stolen = state({ bases: [null, { runnerId: "b", pitcherId: "p" }, null] }),
    end = state({ outs: 3, bases: [null, null, null] });
  return [
    play({ playId: "start", kind: "half_inning_start", before: s0, after: s0 }),
    ...[
      [s0, s1],
      [s1, s2],
      [s2, s3],
      [s3, s4],
    ].map(([before, after], i) =>
      play({
        playId: `p${i}`,
        kind: "pitch",
        before: before ?? s0,
        after: after ?? s0,
        pitch: { id: `p${i}`, call: "ball", actual: true, inPlay: false },
      }),
    ),
    play({ playId: "review", kind: "review", before: s4, after: s4 }),
    play({ playId: "walk", result: "walk", before: s4, after: on }),
    play({
      playId: "steal",
      kind: "runner_advance",
      before: on,
      after: stolen,
      movements: [movement({ runnerId: "b", reason: "stolen_base" })],
    }),
    play({ playId: "end", kind: "runner_advance", before: stolen, after: end }),
  ].map((p, sequence) => ({ ...p, sequence }));
}
it("covers every play once and keeps steals separate from terminal pitch plus result", () => {
  const plays = sample(),
    fitted = model(),
    result = evaluateCountRunValues(game, plays, fitted, "a".repeat(64));
  expect(Value.Check(CountRunModelSchema, fitted)).toBe(true);
  expect(Value.Check(CountRunValueResponseSchema, result)).toBe(true);
  expect(result.transitions.flatMap((t) => t.playIds)).toEqual(plays.map((p) => p.playId));
  expect(result.transitions.find((t) => t.terminalLinked)).toMatchObject({
    playIds: ["p3", "review", "walk"],
    kind: "pitch",
  });
  expect(result.transitions.find((t) => t.playIds.includes("steal"))?.kind).toBe("non_pitch");
  expect(result.halves[0]).toMatchObject({
    startRE: 1,
    runs: 0,
    pitchValue: 0,
    nonPitchValue: -1,
    valueSum: -1,
    conserved: true,
  });
  expect(collectCountRunObservations(game, plays)).toHaveLength(6);
  expect(
    collectCountRunObservations(game, plays).every((r) => r.balls <= 3 && r.strikes <= 2),
  ).toBe(true);
});
it("automatic terminal calls remain non-pitches and substitution or independent movement breaks linkage", () => {
  const rows = sample().map((p) =>
    p.playId === "p3"
      ? { ...p, pitch: { id: "p3", call: "automatic_ball" as const, actual: false, inPlay: false } }
      : p,
  );
  expect(
    evaluateCountRunValues(game, rows, model(), null).transitions.find((t) => t.terminalLinked)
      ?.kind,
  ).toBe("non_pitch");
  for (const kind of ["substitution", "runner_advance"]) {
    const broken = sample().map((p) => (p.playId === "review" ? { ...p, kind } : p)),
      transitions = countValueTransitions(broken);
    expect(transitions.some((t) => t.terminalLinked)).toBe(false);
    expect(evaluateCountRunValues(game, broken, model(), null).halves[0]?.valueSum).toBeNull();
    expect(transitions.flatMap((t) => t.plays.map((p) => p.playId))).toEqual(
      broken.map((p) => p.playId),
    );
  }
});
it("partial PA ending on bases is retained; future labels cannot alter fitted cells", () => {
  const fitted = model(),
    missing = sample().slice(0, -1);
  expect(evaluateCountRunValues(game, missing, fitted, null).halves[0]?.valueSum).toBeNull();
  expect(evaluateCountRunValues({ ...game, season: 2026 }, sample(), fitted, null).status).toBe(
    "outside_training_period",
  );
  const rows = collectCountRunObservations({ ...game, season: 2022 }, sample()),
    pas: RunObservation[] = rows;
  const first = rows[0];
  if (first === undefined) throw new Error("Expected training observations");
  const future: CountRunObservation = { ...first, season: 2025, remainingRuns: 500 };
  expect(trainCountRunExpectancy([...rows, future], pas, "a".repeat(64)).cells).toEqual(
    trainCountRunExpectancy(rows, pas, "a".repeat(64)).cells,
  );
});
