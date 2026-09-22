import { modelValidationSeasons } from "./model-training-period.js";
import type {
  AnalysisPlay,
  AnalysisState,
  RunTrainingGame,
  RunObservation,
  RunExpectancyModel,
  RunValueResponse,
} from "@kbo/contracts";
import { gameLossInterval } from "./game-bootstrap.js";
export function baseMask(state: Pick<AnalysisState, "bases">) {
  return state.bases.reduce((n, r, i) => n + (r === null ? 0 : 2 ** i), 0);
}
const score = (state: AnalysisState, half: AnalysisPlay["half"]) =>
  half === "top" ? state.awayScore : state.homeScore;
export function groupAnalysisHalves(plays: readonly AnalysisPlay[]) {
  const map = new Map<string, AnalysisPlay[]>();
  for (const p of plays) {
    const key = JSON.stringify([p.gameId, p.revision, p.inning, p.half]),
      group = map.get(key) ?? [];
    group.push(p);
    map.set(key, group);
  }
  return [...map.values()]
    .map((rows) => rows.sort((a, b) => a.sequence - b.sequence))
    .sort((a, b) => {
      const left = a[0],
        right = b[0];
      if (left === undefined || right === undefined) return 0;
      return left.gameId < right.gameId
        ? -1
        : left.gameId > right.gameId
          ? 1
          : left.revision - right.revision || left.sequence - right.sequence;
    });
}
export function completeAnalysisHalf(plays: readonly AnalysisPlay[]) {
  const first = plays[0],
    applied = plays.filter((p) => p.applied),
    last = applied.at(-1);
  return (
    first !== undefined &&
    first.kind === "half_inning_start" &&
    first.applied &&
    first.after.outs === 0 &&
    first.after.bases.every((b) => b === null) &&
    last !== undefined &&
    last.after.inning === first.inning &&
    last.after.half === first.half &&
    last.after.outs === 3
  );
}
/** A batter-start supplies one label; pitch rows never multiply the RE24 training weight. */
export function collectRunObservations(
  game: RunTrainingGame,
  plays: readonly AnalysisPlay[],
): RunObservation[] {
  if (game.status !== "final" || game.scheduledInnings !== 9 || !game.normalEnd) return [];
  const result: RunObservation[] = [];
  for (const half of groupAnalysisHalves(plays)) {
    if (!completeAnalysisHalf(half)) continue;
    const first = half[0],
      last = half.filter((p) => p.applied).at(-1);
    if (first === undefined || last === undefined || first.inning > 8) continue;
    const finalScore = score(last.after, first.half);
    for (const p of half) {
      if (!p.applied || p.kind !== "batter_start" || p.after.outs > 2) continue;
      const remainingRuns = finalScore - score(p.after, first.half);
      if (remainingRuns < 0) throw new Error("Negative remaining runs in a sealed half");
      result.push({
        gameId: game.gameId,
        revision: game.revision,
        season: game.season,
        gameDate: game.gameDate,
        inning: first.inning,
        half: first.half,
        outs: p.after.outs,
        bases: baseMask(p.after),
        remainingRuns,
      });
    }
  }
  return result;
}
function cells(
  rows: readonly RunObservation[],
  method: RunExpectancyModel["method"],
  through: number,
): RunExpectancyModel["cells"] {
  const sums = Array.from({ length: 24 }, () => ({ n: 0, sum: 0, recentN: 0, recentSum: 0 }));
  for (const r of rows) {
    if (r.season > through) continue;
    const g = sums[r.outs * 8 + r.bases];
    if (g === undefined) throw new Error("Invalid RE state");
    g.n++;
    g.sum += r.remainingRuns;
    if (r.season === through) {
      g.recentN++;
      g.recentSum += r.remainingRuns;
    }
  }
  return sums.map((g, index) => {
    const pooled = g.n === 0 ? null : g.sum / g.n,
      weight = method === "recent-shrink-20" ? 20 : 100;
    return {
      outs: Math.floor(index / 8),
      bases: index % 8,
      samples: g.n,
      mean:
        pooled === null
          ? null
          : method === "pooled"
            ? pooled
            : (g.recentSum + weight * pooled) / (g.recentN + weight),
    };
  });
}
function evaluate(
  table: RunExpectancyModel["cells"],
  rows: readonly RunObservation[],
  season: number,
) {
  const states = Array.from({ length: 24 }, (_, i) => ({
    outs: Math.floor(i / 8),
    bases: i % 8,
    samples: 0,
    sum: 0,
  }));
  let samples = 0,
    unsupported = 0,
    abs = 0,
    square = 0,
    error = 0;
  for (const r of rows) {
    if (r.season !== season) continue;
    const mean = table[r.outs * 8 + r.bases]?.mean;
    if (mean === null || mean === undefined) {
      unsupported++;
      continue;
    }
    const delta = mean - r.remainingRuns;
    samples++;
    abs += Math.abs(delta);
    square += delta * delta;
    error += delta;
    const state = states[r.outs * 8 + r.bases];
    if (state !== undefined) {
      state.samples++;
      state.sum += delta;
    }
  }
  return {
    season,
    samples,
    unsupported,
    mae: samples === 0 ? null : abs / samples,
    rmse: samples === 0 ? null : Math.sqrt(square / samples),
    bias: samples === 0 ? null : error / samples,
    states: states.map(({ sum, ...state }) => ({
      ...state,
      bias: state.samples === 0 ? null : sum / state.samples,
    })),
  };
}
export function trainRunExpectancy(
  input: readonly RunObservation[],
  sourceHash: string,
  through = 2024,
): RunExpectancyModel {
  const rows = [...input]
    .filter((r) => r.season >= 2020 && r.season <= through + 1)
    .sort((a, b) =>
      a.season === b.season
        ? a.gameId === b.gameId
          ? a.inning - b.inning
          : a.gameId < b.gameId
            ? -1
            : 1
        : a.season - b.season,
    );
  const methods = ["pooled", "recent-shrink-20", "recent-shrink-100"] as const;
  const validation = methods.map((method) => ({
    method,
    evaluations: modelValidationSeasons(through).map((season) =>
      evaluate(cells(rows, method, season - 1), rows, season),
    ),
    mseDifference95: method === "pooled" ? null : regressionDifference(rows, method, through),
  }));
  const baseline = validation[0];
  let method: RunExpectancyModel["method"] = "pooled",
    best = Infinity;
  for (const candidate of validation) {
    if (
      candidate.method === "pooled" ||
      candidate.evaluations.length < 2 ||
      candidate.mseDifference95 === null ||
      candidate.mseDifference95.high >= 0 ||
      !candidate.evaluations.every(
        (e, i) =>
          e.samples > 0 &&
          e.rmse !== null &&
          baseline?.evaluations[i]?.rmse !== null &&
          e.rmse < (baseline?.evaluations[i]?.rmse ?? -Infinity),
      )
    )
      continue;
    const loss = candidate.evaluations.reduce((n, e) => n + (e.rmse ?? Infinity), 0);
    if (loss < best) {
      best = loss;
      method = candidate.method === "recent-shrink-20" ? "recent-shrink-20" : "recent-shrink-100";
    }
  }
  const training = rows.filter((r) => r.season <= through),
    table = cells(training, method, through),
    evaluation = evaluate(table, rows, through + 1);
  return {
    version: 1,
    kind: "pa-start-re24",
    sourceHash,
    trainedThrough: through,
    status: training.length === 0 ? "insufficient_data" : "ready",
    trainingSamples: training.length,
    trainingGames: new Set(training.map((r) => JSON.stringify([r.gameId, r.revision]))).size,
    policy: "regular-nine-innings-complete-halves-1-to-8",
    method,
    cells: table,
    validation,
    evaluation: evaluation.samples + evaluation.unsupported === 0 ? null : evaluation,
  };
}
export function evaluateRunValues(
  game: RunTrainingGame,
  plays: readonly AnalysisPlay[],
  model: RunExpectancyModel | null,
  modelHash: string | null,
): RunValueResponse {
  const available = model?.status === "ready" && game.season === model.trainedThrough + 1;
  const value = (state: AnalysisState) =>
    state.outs === 3
      ? 0
      : available
        ? (model.cells[state.outs * 8 + baseMask(state)]?.mean ?? null)
        : null;
  const details: RunValueResponse["plays"] = [],
    halves: RunValueResponse["halves"] = [];
  for (const half of groupAnalysisHalves(plays)) {
    const first = half[0],
      last = half.filter((p) => p.applied).at(-1);
    if (first === undefined || last === undefined) continue;
    const complete = completeAnalysisHalf(half),
      runs = score(last.after, first.half) - score(first.after, first.half),
      startRE = value(first.after);
    const rows = half.map((p): RunValueResponse["plays"][number] => {
      const boundary = p.kind === "half_inning_start",
        beforeRE = boundary ? null : value(p.before),
        afterRE = boundary ? null : value(p.after),
        delta = boundary ? 0 : score(p.after, p.half) - score(p.before, p.half);
      const status = !p.applied
        ? "not_applied"
        : boundary
          ? "boundary"
          : !complete
            ? "incomplete_half"
            : beforeRE === null || afterRE === null
              ? "unsupported_state"
              : "supported";
      return {
        playId: p.playId,
        sequence: p.sequence,
        inning: p.inning,
        half: p.half,
        kind: p.kind,
        action: classifyRunAction(p),
        runs: delta,
        beforeRE,
        afterRE,
        value:
          status === "supported" && beforeRE !== null && afterRE !== null
            ? delta + afterRE - beforeRE
            : null,
        status,
      };
    });
    const supported =
        complete &&
        startRE !== null &&
        rows.every(
          (r) => r.status === "supported" || r.status === "boundary" || r.status === "not_applied",
        ),
      valueSum = supported ? rows.reduce((sum, p) => sum + (p.value ?? 0), 0) : null;
    details.push(...rows);
    halves.push({
      inning: first.inning,
      half: first.half,
      complete,
      referenceOnly: first.inning > 8 || game.scheduledInnings !== 9,
      runs,
      startRE,
      valueSum,
      conserved:
        valueSum === null || startRE === null ? null : Math.abs(valueSum - (runs - startRE)) < 1e-8,
    });
  }
  return {
    gameId: game.gameId,
    revision: game.revision,
    documentHash: game.documentHash,
    modelHash,
    modelTrainedThrough: model?.trainedThrough ?? null,
    model,
    status:
      model?.status !== "ready"
        ? "model_unavailable"
        : game.season !== model.trainedThrough + 1
          ? "outside_training_period"
          : "ready",
    halves,
    plays: details,
  };
}

function regressionDifference(
  rows: readonly RunObservation[],
  method: RunExpectancyModel["method"],
  through: number,
) {
  const games = new Map<string, { sum: number; samples: number }>();
  for (const season of modelValidationSeasons(through)) {
    const base = cells(rows, "pooled", season - 1),
      candidate = cells(rows, method, season - 1);
    for (const r of rows) {
      if (r.season !== season) continue;
      const a = base[r.outs * 8 + r.bases]?.mean,
        b = candidate[r.outs * 8 + r.bases]?.mean;
      if (a == null || b == null) continue;
      const key = JSON.stringify([r.gameId, r.revision]),
        game = games.get(key) ?? { sum: 0, samples: 0 };
      game.sum += (b - r.remainingRuns) ** 2 - (a - r.remainingRuns) ** 2;
      game.samples++;
      games.set(key, game);
    }
  }
  return gameLossInterval([...games.values()]);
}

/** An annotation of observed actions, never an allocation of personal credit. */
function classifyRunAction(play: AnalysisPlay): RunValueResponse["plays"][number]["action"] {
  if (play.isBunt === true) return "bunt";
  const explicit = play.movements.filter((m) => !m.derived);
  if (explicit.length === 0) return "other";
  if (
    play.kind !== "plate_result" &&
    new Set(explicit.map((m) => m.runnerId)).size === 1 &&
    explicit.every((m) => m.reason === "stolen_base" || m.reason === "caught_stealing")
  )
    return "steal_only";
  return "compound";
}
