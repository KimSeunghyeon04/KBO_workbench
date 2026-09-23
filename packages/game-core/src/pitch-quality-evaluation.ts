import type { PitchQualityFit, PitchQualityEvaluation } from "@kbo/contracts";
import type { BinaryDesign } from "./binary-logit.js";
import type { qualityCohort, QualitySample } from "./pitch-quality-features.js";
import { qualityOutcome, qualityPredictor } from "./pitch-quality-target.js";

type Score = { samples: number; positives: number; loss: number; squared: number };
const score = (): Score => ({ samples: 0, positives: 0, loss: 0, squared: 0 });
function add(value: Score, y: number, p: number) {
  const bounded = Math.min(1 - 1e-12, Math.max(1e-12, p));
  value.samples++;
  value.positives += y;
  value.loss += -(y * Math.log(bounded) + (1 - y) * Math.log1p(-bounded));
  value.squared += (p - y) ** 2;
}
function result(s: Score) {
  return {
    samples: s.samples,
    positives: s.positives,
    logLoss: s.samples === 0 ? null : s.loss / s.samples,
    brier: s.samples === 0 ? null : s.squared / s.samples,
  };
}
export function evaluateQualityTarget(
  cohort: ReturnType<typeof qualityCohort>,
  season: number,
  model: PitchQualityFit,
  design: BinaryDesign | null,
  trainingPitchers: Set<string>,
  baselineLoss?: Float64Array,
  customPredict?: (sample: QualitySample, index: number) => number,
) {
  const predict = customPredict ?? qualityPredictor(model, design),
    total = score(),
    fresh = score(),
    groups = new Map<string, Score>(),
    games = new Map<string, { sum: number; samples: number }>(),
    bins = Array.from({ length: 10 }, (_, bin) => ({ bin, samples: 0, observed: 0, expected: 0 })),
    losses = new Float64Array(cohort.samples.length);
  for (let i = 0; i < cohort.samples.length; i++) {
    const s = cohort.samples[i];
    if (s === undefined) continue;
    const y = qualityOutcome(s, model.target);
    if (y === null) continue;
    const p = predict(s, i),
      before = total.loss;
    add(total, y, p);
    const loss = total.loss - before;
    losses[i] = loss;
    if (!trainingPitchers.has(s.row.pitcherId)) add(fresh, y, p);
    for (const key of [
      `park:${s.row.parkId}`,
      `type:${s.row.pitchType}`,
      `stance:${s.row.stance}`,
    ]) {
      const g = groups.get(key) ?? score();
      add(g, y, p);
      groups.set(key, g);
    }
    const game = games.get(s.row.gameId) ?? { sum: 0, samples: 0 };
    game.samples++;
    game.sum += loss - (baselineLoss?.[i] ?? loss);
    games.set(s.row.gameId, game);
    const bin = bins[Math.min(9, Math.floor(p * 10))];
    if (bin !== undefined) {
      bin.samples++;
      bin.observed += y;
      bin.expected += p;
    }
  }
  const metrics: PitchQualityEvaluation = {
    season,
    coverage: cohort.coverage,
    samples: total.samples,
    games: games.size,
    logLoss: result(total).logLoss,
    brier: result(total).brier,
    calibration: bins.map((b) => ({
      ...b,
      observed: b.samples === 0 ? null : b.observed / b.samples,
      expected: b.samples === 0 ? null : b.expected / b.samples,
    })),
    groups: [...groups]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, s]) => ({ key, ...result(s) })),
    newPitchers: result(fresh),
  };
  return {
    metrics,
    losses,
    gameDifferences: [...games].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g),
  };
}
export function qualitySubgroupGate(
  current: PitchQualityEvaluation,
  baseline: PitchQualityEvaluation,
) {
  const groups = new Map(baseline.groups.map((g) => [g.key, g]));
  return current.groups.every(
    (g) =>
      g.samples < 1000 ||
      (g.logLoss !== null && g.logLoss <= (groups.get(g.key)?.logLoss ?? -Infinity) * 1.02),
  );
}
