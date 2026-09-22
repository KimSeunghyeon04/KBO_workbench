import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  WinModelSchema,
  WinProbabilityResponseSchema,
  type WinObservation,
  type RunTrainingGame,
} from "@kbo/contracts";
import {
  collectWinObservations,
  trainWinProbability,
  winPredictor,
  evaluateWinValues,
  winInningLimit,
} from "@kbo/game-core";
import {
  fitMultinomial,
  multinomialPredict,
} from "../../packages/game-core/src/multinomial-logit.js";
import { analysisPlay as play, analysisState as state } from "../helpers/analysis-play.js";
const hash = "a".repeat(64);
function observations(season: number): WinObservation[] {
  return Array.from({ length: 45 }, (_, i) => ({
    gameId: `${season}-${i}`,
    revision: 1,
    season,
    inning: 1,
    half: "top",
    outs: 0,
    bases: 0,
    lead: 0,
    limit: 12,
    outcome: i % 3,
    weight: 1,
  }));
}
const game: RunTrainingGame = {
  gameId: "g",
  revision: 1,
  season: 2024,
  gameDate: "2024-06-01",
  scheduledInnings: 9,
  status: "final",
  normalEnd: true,
  documentHash: hash,
};
function finish(homeScore: number) {
  const inning = homeScore === 0 ? 12 : 9;
  return [
    play({
      kind: "half_inning_start",
      playId: "start",
      sequence: 0,
      before: state({ inning: 0 }),
      after: state(),
    }),
    play({
      kind: "half_inning_start",
      playId: "ninth",
      sequence: 1,
      inning,
      half: "bottom",
      before: state(),
      after: state({ inning, half: "bottom", outs: 2 }),
    }),
    play({
      playId: "end",
      sequence: 2,
      inning,
      half: "bottom",
      before: state({ inning, half: "bottom", outs: 2 }),
      after: state({ inning, half: "bottom", homeScore, outs: homeScore > 0 ? 2 : 3 }),
    }),
  ];
}
it("weights each game's distinct preterminal states once and handles verified rule changes", () => {
  const rows = collectWinObservations(game, finish(1));
  expect(rows.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1);
  expect(rows.every((r) => r.outcome === 0)).toBe(true);
  expect(collectWinObservations({ ...game, normalEnd: false }, finish(1))).toEqual([]);
  expect(winInningLimit(2020)).toBeNull();
  expect(winInningLimit(2021)).toBeNull();
  expect(winInningLimit(2024)).toBe(12);
  expect(winInningLimit(2025)).toBe(11);
});
it("keeps preprocessing and selection independent of future outcomes and refuses unseen rules", () => {
  const rows = observations(2022),
    model = trainWinProbability(rows, hash, 2023),
    future = observations(2024).map((r) => ({ ...r, lead: 200, outcome: 0 }));
  expect(Value.Check(WinModelSchema, model)).toBe(true);
  expect(model.status).toBe("ready");
  const changed = trainWinProbability([...rows, ...future], hash, 2023);
  expect(changed.means).toEqual(model.means);
  expect(changed.scales).toEqual(model.scales);
  expect(changed.table).toEqual(model.table);
  expect(changed.method).toBe(model.method);
  const row = rows[0];
  if (row === undefined) throw new Error("Missing fixture");
  const predict = winPredictor(model);
  expect(predict(row)?.value).toBeCloseTo(0.5);
  expect(predict({ ...row, limit: 11 })).toBeNull();
  expect(trainWinProbability([], hash).status).toBe("insufficient_data");
});
it("ends at win 1 / draw 0.5 / loss 0 and conserves opposite home/away WPA", () => {
  const model = trainWinProbability(observations(2022), hash, 2023);
  for (const score of [0, 1]) {
    const result = evaluateWinValues(game, finish(score), model, hash);
    expect(Value.Check(WinProbabilityResponseSchema, result)).toBe(true);
    expect(result.terminalValue).toBe(score === 0 ? 0.5 : 1);
    expect(result.conserved).toBe(true);
    expect(result.plays.every((p) => p.homeWpa === null || p.homeWpa === -(p.awayWpa ?? 0))).toBe(
      true,
    );
  }
  const away = finish(0).map((p) => ({
    ...p,
    before: { ...p.before, awayScore: 1 },
    after: { ...p.after, awayScore: 1 },
  }));
  expect(evaluateWinValues(game, away, model, hash).terminalValue).toBe(0);
  expect(evaluateWinValues({ ...game, season: 2025 }, finish(1), model, hash).status).toBe(
    "unsupported_rules",
  );
  expect(
    evaluateWinValues({ ...game, normalEnd: false }, finish(1), model, hash).terminalValue,
  ).toBeNull();
});
it("fits finite probabilities with separation and makes nonconvergence explicit", () => {
  const rows = [
      { x: [1, -1], counts: [10, 0, 0] },
      { x: [1, 0], counts: [0, 10, 0] },
      { x: [1, 1], counts: [0, 0, 10] },
    ],
    fit = fitMultinomial(rows, 3, 0.1);
  expect(fit.converged).toBe(true);
  const p = multinomialPredict([1, 1], fit.coefficients, 3);
  expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  expect(p[2]).toBeGreaterThan(p[0] ?? 1);
  expect(fitMultinomial(rows, 3, 0.1, 0).converged).toBe(false);
  expect(fitMultinomial([], 3, 1).converged).toBe(false);
});

function twelveInnings(homeScore: number, awayScore: number) {
  return [
    ...finish(1).slice(0, 1),
    play({
      playId: "eleventh-out",
      sequence: 1,
      inning: 11,
      half: "bottom",
      before: state({ inning: 11, half: "bottom", outs: 2 }),
      after: state({ inning: 11, half: "bottom", outs: 3 }),
    }),
    play({
      playId: "twelfth",
      sequence: 2,
      kind: "half_inning_start",
      inning: 12,
      before: state({ inning: 11, half: "bottom", outs: 3 }),
      after: state({ inning: 12 }),
    }),
    play({
      playId: "end",
      sequence: 3,
      inning: 12,
      half: "bottom",
      before: state({ inning: 12, half: "bottom", outs: 2, awayScore }),
      after: state({ inning: 12, half: "bottom", outs: 3, homeScore, awayScore }),
    }),
  ];
}
it("censors at the observed eleventh third out without changing source facts or using the twelfth", () => {
  const source = twelveInnings(1, 0),
    original = structuredClone(source),
    shortened = collectWinObservations(game, source, 11);
  expect(shortened).toHaveLength(2);
  expect(shortened.every((r) => r.limit === 11 && r.inning <= 11 && r.outcome === 1)).toBe(true);
  expect(shortened.reduce((sum, r) => sum + r.weight, 0)).toBeCloseTo(1);
  expect(shortened.some((r) => r.inning === 11 && r.half === "bottom" && r.outs === 3)).toBe(false);
  for (const [home, away] of [
    [0, 0],
    [0, 5],
    [6, 0],
  ] as const) {
    expect(collectWinObservations(game, twelveInnings(home, away), 11)).toEqual(shortened);
  }
  expect(collectWinObservations(game, [...source].reverse(), 11)).toEqual(shortened);
  expect(source).toEqual(original);
  expect(collectWinObservations(game, source).every((r) => r.outcome === 0)).toBe(true);
});
it("preserves earlier wins and losses and refuses missing boundaries, incomplete games and extension", () => {
  const source = twelveInnings(1, 0);
  expect(
    collectWinObservations(
      game,
      source.filter((p) => p.inning !== 11),
      11,
    ),
  ).toEqual([]);
  expect(
    collectWinObservations(
      game,
      source.map((p) => ({ ...p, applied: p.inning !== 11 })),
      11,
    ),
  ).toEqual([]);
  expect(collectWinObservations({ ...game, normalEnd: false }, source, 11)).toEqual([]);
  expect(collectWinObservations({ ...game, season: 2025 }, finish(1), 12)).toEqual([]);
  expect(collectWinObservations({ ...game, season: 2021 }, finish(1), 11)).toEqual([]);
  for (const inning of [9, 10, 11]) {
    for (const outcome of [0, 2]) {
      const plays = finish(1).map((p) =>
        p.sequence === 0
          ? p
          : {
              ...p,
              inning,
              before: { ...p.before, inning },
              after: {
                ...p.after,
                inning,
                homeScore: outcome === 0 && p.playId === "end" ? 1 : 0,
                awayScore: outcome === 2 && p.playId === "end" ? 1 : 0,
                outs: p.playId === "end" ? 3 : 2,
              },
            },
      );
      const rows = collectWinObservations(game, plays, 11);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.outcome === outcome && r.limit === 11)).toBe(true);
    }
  }
});
it("supports 2025 with prior games reconstructed under the same limit and keeps evaluation held out", () => {
  const rows = [2022, 2023, 2024, 2025].flatMap((season) =>
    observations(season).map((r) => ({ ...r, limit: 11 as const })),
  );
  const model = trainWinProbability(rows, hash);
  expect(Value.Check(WinModelSchema, model)).toBe(true);
  expect(model.limits).toEqual([11]);
  expect(model.trainingGames).toBe(135);
  expect(model.evaluation).toMatchObject({ games: 45, unsupported: 0 });
  const changed = trainWinProbability(
    rows.map((r) => (r.season === 2025 ? { ...r, outcome: 0, lead: 20 } : r)),
    hash,
  );
  expect({ ...changed, evaluation: null }).toEqual({ ...model, evaluation: null });
  for (const source of [finish(1), twelveInnings(0, 0).filter((p) => p.sequence <= 1)]) {
    const result = evaluateWinValues({ ...game, season: 2025 }, source, model, hash);
    expect(result.status).toBe("ready");
    expect(result.conserved).toBe(true);
    expect(result.plays.every((p) => p.homeWpa === null || p.homeWpa === -(p.awayWpa ?? 0))).toBe(
      true,
    );
  }
  expect(trainWinProbability(observations(2024), hash).status).toBe("insufficient_data");
});
