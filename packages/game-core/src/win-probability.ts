import { modelValidationSeasons } from "./model-training-period.js";
import type { WinModel, WinObservation, WinProbability, WinState } from "@kbo/contracts";
import { gameLossInterval } from "./game-bootstrap.js";
import { fitMultinomial, multinomialPredict, type MultinomialRow } from "./multinomial-logit.js";
import { winInningLimit } from "./win-probability-rules.js";
const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
function features(s: WinState) {
  const lead = clamp(s.lead, 20),
    remaining = Math.max(0, 9 - s.inning),
    home = s.half === "bottom" ? 1 : 0;
  return [
    s.inning,
    remaining,
    s.limit - s.inning,
    home,
    s.outs,
    s.bases & 1,
    (s.bases >> 1) & 1,
    (s.bases >> 2) & 1,
    lead,
    lead / (remaining + 1),
    lead * home,
    Math.abs(lead),
    s.outs * home,
  ];
}
const tableKey = (s: WinState) =>
  JSON.stringify([
    s.limit,
    Math.min(4, Math.floor((s.inning - 1) / 3)),
    s.half,
    s.outs,
    s.bases === 0 ? 0 : 1,
    clamp(s.lead, 4),
  ]);
const probability = (p: readonly number[]): WinProbability => ({
  homeWin: p[0] ?? 0,
  draw: p[1] ?? 0,
  homeLoss: p[2] ?? 0,
  value: (p[0] ?? 0) + 0.5 * (p[1] ?? 0),
});
const vector = (p: WinProbability) => [p.homeWin, p.draw, p.homeLoss];
function fit(
  rows: readonly WinObservation[],
  method: WinModel["method"],
  lambda: number,
  sourceHash: string,
  through: number,
): WinModel {
  const training = rows.filter((r) => r.season <= through),
    width = features(
      training[0] ?? { inning: 1, half: "top", outs: 0, bases: 0, lead: 0, limit: 12 },
    ).length,
    total = training.reduce((s, r) => s + r.weight, 0),
    means = Array.from({ length: width }, () => 0),
    variances = Array.from({ length: width }, () => 0),
    classCounts = [1, 1, 1];
  for (const r of training) {
    const x = features(r);
    for (let i = 0; i < width; i++)
      means[i] = (means[i] ?? 0) + (r.weight * (x[i] ?? 0)) / Math.max(total, 1);
    classCounts[r.outcome] = (classCounts[r.outcome] ?? 0) + r.weight;
  }
  for (const r of training) {
    const x = features(r);
    for (let i = 0; i < width; i++)
      variances[i] =
        (variances[i] ?? 0) +
        (r.weight * ((x[i] ?? 0) - (means[i] ?? 0)) ** 2) / Math.max(total, 1);
  }
  const scales = variances.map((v) => (Math.sqrt(v) > 1e-9 ? Math.sqrt(v) : 1)),
    prior = probability(classCounts.map((c) => c / (total + 3))),
    groups = new Map<string, { states: number; weight: number; counts: number[] }>(),
    numeric = new Map<string, MultinomialRow>();
  for (const r of training) {
    const key = tableKey(r),
      g = groups.get(key) ?? { states: 0, weight: 0, counts: [0, 0, 0] };
    g.states++;
    g.weight += r.weight;
    g.counts[r.outcome] = (g.counts[r.outcome] ?? 0) + r.weight;
    groups.set(key, g);
    if (method === "multinomial") {
      const x = [1, ...features(r).map((v, i) => (v - (means[i] ?? 0)) / (scales[i] ?? 1))],
        k = JSON.stringify(x),
        g = numeric.get(k) ?? { x, counts: [0, 0, 0] },
        counts = [...g.counts];
      counts[r.outcome] = (counts[r.outcome] ?? 0) + r.weight;
      numeric.set(k, { x, counts });
    }
  }
  const fitted =
    method === "multinomial"
      ? fitMultinomial([...numeric.values()], 3, lambda)
      : { coefficients: [], converged: true };
  return {
    version: 1,
    kind: "home-win-draw-loss",
    policy: "regular-2022-2025-shortened-limit-v1",
    sourceHash,
    trainedThrough: through,
    status:
      new Set(training.map((r) => r.gameId)).size < 30 || classCounts.some((n) => n <= 1)
        ? "insufficient_data"
        : "ready",
    trainingGames: new Set(training.map((r) => JSON.stringify([r.gameId, r.revision]))).size,
    trainingStates: training.length,
    limits: [...new Set(training.map((r) => r.limit))].sort((a, b) => a - b),
    method,
    lambda,
    prior,
    table: [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, g]) => ({
        key,
        states: g.states,
        weight: g.weight,
        probability: probability(
          g.counts.map((n, i) => (n + (vector(prior)[i] ?? 0) * 2) / (g.weight + 2)),
        ),
      })),
    means,
    scales,
    coefficients: fitted.coefficients,
    converged: fitted.converged,
    validation: [],
    evaluation: null,
  };
}
export function winPredictor(model: WinModel) {
  const table = new Map(model.table.map((r) => [r.key, r.probability]));
  return (state: WinState): WinProbability | null => {
    if (
      model.status !== "ready" ||
      !model.limits.includes(state.limit) ||
      state.inning > state.limit
    )
      return null;
    if (model.method === "state_table") return table.get(tableKey(state)) ?? model.prior;
    if (!model.converged) return null;
    const x = [
      1,
      ...features(state).map((v, i) => (v - (model.means[i] ?? 0)) / (model.scales[i] ?? 1)),
    ];
    return probability(multinomialPredict(x, model.coefficients, 3));
  };
}
export function evaluateWinModel(model: WinModel, rows: readonly WinObservation[], season: number) {
  const predict = winPredictor(model),
    games = new Set<string>(),
    calibration = Array.from({ length: 30 }, (_, i) => ({
      outcome: Math.floor(i / 10),
      bin: i % 10,
      weight: 0,
      predicted: 0,
      observed: 0,
    }));
  let states = 0,
    unsupported = 0,
    weight = 0,
    loss = 0,
    brier = 0;
  for (const r of rows) {
    if (r.season !== season) continue;
    const p = predict(r);
    if (p === null) {
      unsupported++;
      continue;
    }
    const v = vector(p);
    states++;
    weight += r.weight;
    games.add(JSON.stringify([r.gameId, r.revision]));
    loss -= r.weight * Math.log(Math.max(1e-15, v[r.outcome] ?? 0));
    for (let c = 0; c < 3; c++) {
      const predicted = v[c] ?? 0,
        y = r.outcome === c ? 1 : 0;
      brier += r.weight * (predicted - y) ** 2;
      const bin = calibration[c * 10 + Math.min(9, Math.floor(predicted * 10))];
      if (bin !== undefined) {
        bin.weight += r.weight;
        bin.predicted += r.weight * predicted;
        bin.observed += r.weight * y;
      }
    }
  }
  return {
    season,
    games: games.size,
    states,
    unsupported,
    logLoss: weight === 0 ? null : loss / weight,
    brier: weight === 0 ? null : brier / weight,
    calibration: calibration.map((b) => ({
      ...b,
      predicted: b.weight === 0 ? null : b.predicted / b.weight,
      observed: b.weight === 0 ? null : b.observed / b.weight,
    })),
  };
}
export function trainWinProbability(
  input: readonly WinObservation[],
  sourceHash: string,
  through = 2024,
): WinModel {
  const targetLimit = winInningLimit(through + 1),
    rows = [...input]
      .filter((r) => r.season >= 2022 && r.season <= through + 1 && r.limit === targetLimit)
      .sort((a, b) =>
        a.gameId < b.gameId
          ? -1
          : a.gameId > b.gameId
            ? 1
            : a.revision - b.revision ||
              (JSON.stringify(a) < JSON.stringify(b)
                ? -1
                : JSON.stringify(a) > JSON.stringify(b)
                  ? 1
                  : 0),
      ),
    years = modelValidationSeasons(through, 2022),
    methods = [
      { method: "state_table" as const, lambda: 0 },
      ...[0.1, 1, 10].map((lambda) => ({ method: "multinomial" as const, lambda })),
    ];
  const baseline = years.map((year) => fit(rows, "state_table", 0, sourceHash, year - 1));
  const validation = methods.map((option) => {
    const games = new Map<string, { sum: number; samples: number }>();
    let converged = true;
    const evaluations = years.map((season, i) => {
      const model = fit(rows, option.method, option.lambda, sourceHash, season - 1),
        base = baseline[i];
      converged = converged && model.converged;
      if (base !== undefined) {
        const a = winPredictor(model),
          b = winPredictor(base);
        for (const r of rows) {
          if (r.season !== season) continue;
          const pa = a(r),
            pb = b(r);
          if (pa === null || pb === null) continue;
          const key = JSON.stringify([r.gameId, r.revision]),
            g = games.get(key) ?? { sum: 0, samples: 1 };
          g.sum +=
            r.weight *
            (Math.log(Math.max(1e-15, vector(pb)[r.outcome] ?? 0)) -
              Math.log(Math.max(1e-15, vector(pa)[r.outcome] ?? 0)));
          games.set(key, g);
        }
      }
      return evaluateWinModel(model, rows, season);
    });
    return {
      ...option,
      converged,
      evaluations,
      logLossDifference95:
        option.method === "state_table" ? null : gameLossInterval([...games.values()]),
    };
  });
  const eligible = validation.filter(
    (v) =>
      v.method === "multinomial" &&
      v.converged &&
      v.evaluations.length === 2 &&
      v.logLossDifference95 !== null &&
      v.logLossDifference95.high < 0 &&
      v.evaluations.every(
        (e, i) =>
          e.logLoss !== null && e.logLoss < (validation[0]?.evaluations[i]?.logLoss ?? -Infinity),
      ),
  );
  eligible.sort(
    (a, b) =>
      a.evaluations.reduce((s, e) => s + (e.logLoss ?? Infinity), 0) -
        b.evaluations.reduce((s, e) => s + (e.logLoss ?? Infinity), 0) || a.lambda - b.lambda,
  );
  const selected = eligible[0],
    model = fit(
      rows,
      selected === undefined ? "state_table" : "multinomial",
      selected?.lambda ?? 0,
      sourceHash,
      through,
    );
  // A failed final fit never exposes unconverged coefficients.
  const final = model.converged ? model : fit(rows, "state_table", 0, sourceHash, through),
    evaluation = evaluateWinModel(final, rows, through + 1);
  return {
    ...final,
    validation,
    evaluation: evaluation.states + evaluation.unsupported === 0 ? null : evaluation,
  };
}
