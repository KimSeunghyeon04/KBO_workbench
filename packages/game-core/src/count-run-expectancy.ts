import { modelValidationSeasons } from "./model-training-period.js";
import type {
  AnalysisPlay,
  CountRunModel,
  CountRunObservation,
  RunObservation,
  RunTrainingGame,
} from "@kbo/contracts";
import {
  baseMask,
  completeAnalysisHalf,
  groupAnalysisHalves,
  trainRunExpectancy,
} from "./run-expectancy.js";
import { attackScore, countValueTransitions, validCountState } from "./count-run-value.js";
import { gameLossInterval } from "./game-bootstrap.js";
export function collectCountRunObservations(
  game: RunTrainingGame,
  plays: readonly AnalysisPlay[],
): CountRunObservation[] {
  if (!game.normalEnd || game.scheduledInnings !== 9 || game.status !== "final") return [];
  const rows: CountRunObservation[] = [];
  for (const half of groupAnalysisHalves(plays)) {
    const first = half[0],
      last = half.filter((p) => p.applied).at(-1);
    if (
      first === undefined ||
      last === undefined ||
      first.inning > 8 ||
      !completeAnalysisHalf(half)
    )
      continue;
    for (const t of countValueTransitions(half)) {
      const play = t.plays[0];
      if (
        play === undefined ||
        !play.applied ||
        t.unsupportedLink ||
        !validCountState(t.before) ||
        !["pitch", "runner_advance", "plate_result"].includes(play.kind) ||
        play.pitch?.call === "no_pitch"
      )
        continue;
      const remainingRuns = attackScore(last.after, first.half) - attackScore(t.before, first.half);
      if (remainingRuns < 0) throw new Error("Negative remaining runs");
      rows.push({
        gameId: game.gameId,
        revision: game.revision,
        gameDate: game.gameDate,
        season: game.season,
        inning: first.inning,
        half: first.half,
        outs: t.before.outs,
        bases: baseMask(t.before),
        balls: t.before.balls,
        strikes: t.before.strikes,
        remainingRuns,
      });
    }
  }
  return rows;
}
const index = (r: CountRunObservation) => (r.outs * 8 + r.bases) * 12 + r.balls * 3 + r.strikes;
function fit(
  rows: readonly CountRunObservation[],
  prior: ReturnType<typeof trainRunExpectancy>["cells"],
  through: number,
  weight: 20 | 100,
): CountRunModel["cells"] {
  const groups = Array.from({ length: 288 }, () => ({ samples: 0, sum: 0 }));
  for (const r of rows) {
    if (r.season > through || r.season < 2020) continue;
    const group = groups[index(r)];
    if (group === undefined) throw new Error("Invalid count state");
    group.samples++;
    group.sum += r.remainingRuns;
  }
  return groups.map((g, i) => {
    const re = prior[Math.floor(i / 12)]?.mean;
    return {
      outs: Math.floor(i / 96),
      bases: Math.floor(i / 12) % 8,
      balls: Math.floor((i % 12) / 3),
      strikes: i % 3,
      samples: g.samples,
      mean:
        re == null
          ? g.samples === 0
            ? null
            : g.sum / g.samples
          : (g.sum + weight * re) / (g.samples + weight),
    };
  });
}
function evaluate(
  cells: CountRunModel["cells"],
  rows: readonly CountRunObservation[],
  season: number,
) {
  let samples = 0,
    unsupported = 0,
    abs = 0,
    square = 0,
    error = 0;
  for (const r of rows) {
    if (r.season !== season) continue;
    const estimate = cells[index(r)]?.mean;
    if (estimate == null) {
      unsupported++;
      continue;
    }
    const delta = estimate - r.remainingRuns;
    samples++;
    abs += Math.abs(delta);
    square += delta ** 2;
    error += delta;
  }
  return {
    season,
    samples,
    unsupported,
    mae: samples === 0 ? null : abs / samples,
    rmse: samples === 0 ? null : Math.sqrt(square / samples),
    bias: samples === 0 ? null : error / samples,
  };
}
export function trainCountRunExpectancy(
  input: readonly CountRunObservation[],
  paRows: readonly RunObservation[],
  hash: string,
  through = 2024,
): CountRunModel {
  const rows = [...input]
      .filter((r) => r.season >= 2020 && r.season <= through + 1)
      .sort((a, b) =>
        a.gameId < b.gameId
          ? -1
          : a.gameId > b.gameId
            ? 1
            : a.revision - b.revision ||
              a.inning - b.inning ||
              index(a) - index(b) ||
              a.remainingRuns - b.remainingRuns,
      ),
    years = modelValidationSeasons(through);
  // Both shrinkage candidates share the same 24-state prior in each temporal fold.
  const priors = new Map(
    [...new Set([...years.map((year) => year - 1), through])].map((end) => [
      end,
      trainRunExpectancy(
        paRows.filter((r) => r.season <= end),
        hash,
        end,
      ).cells,
    ]),
  );
  const fitAt = (end: number, weight: 20 | 100) => {
    const prior = priors.get(end);
    if (prior === undefined) throw new Error("Missing count reference period");
    return fit(rows, prior, end, weight);
  };
  const validation = ([20, 100] as const).map((shrinkage) => {
    const games = new Map<string, { sum: number; samples: number }>();
    const evaluations = years.map((season) => {
      const candidate = fitAt(season - 1, shrinkage),
        base = shrinkage === 100 ? candidate : fitAt(season - 1, 100);
      for (const r of rows) {
        if (r.season !== season) continue;
        const a = candidate[index(r)]?.mean,
          b = base[index(r)]?.mean;
        if (a == null || b == null) continue;
        const key = JSON.stringify([r.gameId, r.revision]),
          game = games.get(key) ?? { sum: 0, samples: 0 };
        game.sum += (a - r.remainingRuns) ** 2 - (b - r.remainingRuns) ** 2;
        game.samples++;
        games.set(key, game);
      }
      return evaluate(candidate, rows, season);
    });
    return {
      shrinkage,
      evaluations,
      mseDifference95: shrinkage === 100 ? null : gameLossInterval([...games.values()]),
    };
  });
  const candidate = validation[0],
    baseline = validation[1];
  const shrinkage =
    candidate?.mseDifference95 !== null &&
    candidate?.mseDifference95 !== undefined &&
    candidate.mseDifference95.high < 0 &&
    candidate.evaluations.length === 2 &&
    candidate.evaluations.every(
      (e, i) => e.rmse !== null && e.rmse < (baseline?.evaluations[i]?.rmse ?? -Infinity),
    )
      ? 20
      : 100;
  const training = rows.filter((r) => r.season <= through),
    cells = fitAt(through, shrinkage),
    evaluation = evaluate(cells, rows, through + 1);
  return {
    version: 1,
    kind: "decision-count-re",
    sourceHash: hash,
    trainedThrough: through,
    status: training.length === 0 ? "insufficient_data" : "ready",
    trainingSamples: training.length,
    trainingGames: new Set(training.map((r) => JSON.stringify([r.gameId, r.revision]))).size,
    shrinkage,
    cells,
    validation,
    evaluation: evaluation.samples + evaluation.unsupported === 0 ? null : evaluation,
  };
}
