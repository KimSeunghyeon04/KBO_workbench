import { modelValidationSeasons } from "./model-training-period.js";
import type {
  PitchQualityModel,
  PitchQualityFit,
  PitchQualityEvaluation,
  PitchQualityPreprocessing,
  PitchQualityRow,
  PitchQualityResponse,
  AnalysisScope,
} from "@kbo/contracts";
import { binaryPredict, fitBinaryLogit, type BinaryDesign } from "./binary-logit.js";
import { gameLossInterval } from "./game-bootstrap.js";
import {
  prepareQualityRows,
  fitQualityPreprocessing,
  qualityCohort,
  qualityDesign,
  qualityHash,
  type QualitySample,
} from "./pitch-quality-features.js";
const targets = ["swing", "whiff", "called_strike"] as const;
type Target = (typeof targets)[number];
type Candidate = { kind: PitchQualityFit["kind"]; lambda: number };
const candidates: Candidate[] = [
  { kind: "baseline", lambda: 0 },
  ...["shape", "location"].flatMap((kind) =>
    [0.1, 1, 10].map((lambda) => ({
      kind: kind === "shape" ? ("shape" as const) : ("location" as const),
      lambda,
    })),
  ),
];
function outcome(sample: QualitySample, target: Target): number | null {
  const r = sample.row;
  return target === "swing"
    ? Number(r.swing)
    : target === "whiff"
      ? r.swing
        ? Number(r.whiff)
        : null
      : r.swing
        ? null
        : Number(r.calledStrike);
}
function labelRows(samples: readonly QualitySample[], target: Target) {
  const labels = new Uint8Array(samples.length),
    indices: number[] = [];
  let positives = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s === undefined) continue;
    const y = outcome(s, target);
    if (y !== null) {
      labels[i] = y;
      indices.push(i);
      positives += y;
    }
  }
  return { labels, indices: Uint32Array.from(indices), positives };
}
function fit(
  samples: readonly QualitySample[],
  target: Target,
  candidate: Candidate,
  design: BinaryDesign | null,
): PitchQualityFit {
  const { labels, indices, positives } = labelRows(samples, target),
    prior = (positives + 1) / (indices.length + 2),
    base: PitchQualityFit = {
      target,
      kind: candidate.kind,
      lambda: candidate.lambda,
      converged: indices.length > 0,
      samples: indices.length,
      positives,
      prior,
      cells: [],
      coefficients: [],
    };
  if (candidate.kind === "baseline") {
    const cells = new Map<string, { samples: number; positives: number }>();
    for (const i of indices) {
      const s = samples[i];
      if (s === undefined) continue;
      const c = cells.get(s.key) ?? { samples: 0, positives: 0 };
      c.samples++;
      c.positives += labels[i] ?? 0;
      cells.set(s.key, c);
    }
    base.cells = [...cells]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, c]) => ({
        key,
        ...c,
        probability: (c.positives + 50 * prior) / (c.samples + 50),
      }));
    return base;
  }
  if (
    design === null ||
    indices.length < 200 ||
    new Set(samples.map((s) => s.row.gameId)).size < 20
  )
    return { ...base, converged: false };
  const fitted = fitBinaryLogit(design, labels, indices, candidate.lambda);
  return { ...base, coefficients: fitted.coefficients, converged: fitted.converged };
}
function predictor(model: PitchQualityFit, design: BinaryDesign | null) {
  const cells = new Map(model.cells.map((c) => [c.key, c.probability]));
  return (s: QualitySample, i: number) =>
    model.kind === "baseline"
      ? (cells.get(s.key) ?? model.prior)
      : design === null || !model.converged
        ? model.prior
        : binaryPredict(design, i, model.coefficients);
}
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
function evaluate(
  cohort: ReturnType<typeof qualityCohort>,
  season: number,
  model: PitchQualityFit,
  design: BinaryDesign | null,
  trainingPitchers: Set<string>,
  baselineLoss?: Float64Array,
  customPredict?: (sample: QualitySample, index: number) => number,
) {
  const predict = customPredict ?? predictor(model, design),
    total = score(),
    fresh = score(),
    groups = new Map<string, Score>(),
    games = new Map<string, { sum: number; samples: number }>(),
    bins = Array.from({ length: 10 }, (_, bin) => ({ bin, samples: 0, observed: 0, expected: 0 })),
    losses = new Float64Array(cohort.samples.length);
  for (let i = 0; i < cohort.samples.length; i++) {
    const s = cohort.samples[i];
    if (s === undefined) continue;
    const y = outcome(s, model.target);
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
function subgroupGate(current: PitchQualityEvaluation, baseline: PitchQualityEvaluation) {
  const groups = new Map(baseline.groups.map((g) => [g.key, g]));
  return current.groups.every(
    (g) =>
      g.samples < 1000 ||
      (g.logLoss !== null && g.logLoss <= (groups.get(g.key)?.logLoss ?? -Infinity) * 1.02),
  );
}
// Shared only by the pitch-response and batter-offset models; feature and denominator policies stay here.
export {
  fit as fitQualityTarget,
  predictor as qualityPredictor,
  outcome as qualityOutcome,
  evaluate as evaluateQualityTarget,
  subgroupGate as qualitySubgroupGate,
};
export function trainPitchQuality(
  rows: readonly PitchQualityRow[],
  profiles: PitchQualityPreprocessing["profiles"],
  sourceHash: string,
  through = 2024,
): PitchQualityModel {
  const ordered = rows
      .filter((r) => r.season >= 2020 && r.season <= through + 1)
      .sort((a, b) => {
        for (const key of ["gameId", "pitchId"] as const) {
          if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
        }
        return 0;
      }),
    prepared = prepareQualityRows(ordered);
  const validations = targets.map(() =>
      candidates.map((candidate) => ({
        ...candidate,
        converged: true,
        evaluations: [] as PitchQualityEvaluation[],
        lossDifference95: null as { low: number; high: number } | null,
        subgroupGate: true,
        gameDifferences: [] as { sum: number; samples: number }[],
      })),
    ),
    validationPreprocessing: PitchQualityModel["validationPreprocessing"] = [];
  for (const end of modelValidationSeasons(through).map((season) => season - 1)) {
    const training = prepared.filter((r) => r.season <= end),
      pre = fitQualityPreprocessing(training, profiles, end),
      train = qualityCohort(training, pre),
      test = qualityCohort(
        prepared.filter((r) => r.season === end + 1),
        pre,
      ),
      pitchers = new Set(training.map((r) => r.pitcherId));
    validationPreprocessing.push({ season: end + 1, hash: qualityHash(pre) });
    const trainDesign = {
        shape: qualityDesign(train.samples, pre, "shape"),
        location: qualityDesign(train.samples, pre, "location"),
      },
      testDesign = {
        shape: qualityDesign(test.samples, pre, "shape"),
        location: qualityDesign(test.samples, pre, "location"),
      };
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t];
      if (target === undefined) continue;
      let baseline: ReturnType<typeof evaluate> | undefined;
      for (let c = 0; c < candidates.length; c++) {
        const candidate = candidates[c],
          validation = validations[t]?.[c];
        if (candidate === undefined || validation === undefined) continue;
        const fitted = fit(
            train.samples,
            target,
            candidate,
            candidate.kind === "baseline" ? null : trainDesign[candidate.kind],
          ),
          ev = evaluate(
            test,
            end + 1,
            fitted,
            candidate.kind === "baseline" ? null : testDesign[candidate.kind],
            pitchers,
            baseline?.losses,
          );
        baseline ??= ev;
        validation.converged &&= fitted.converged;
        validation.evaluations.push(ev.metrics);
        validation.subgroupGate &&= subgroupGate(ev.metrics, baseline.metrics);
        validation.gameDifferences.push(...ev.gameDifferences);
      }
    }
  }
  const training = prepared.filter((r) => r.season <= through),
    pre = fitQualityPreprocessing(training, profiles, through),
    train = qualityCohort(training, pre),
    test = qualityCohort(
      prepared.filter((r) => r.season === through + 1),
      pre,
    ),
    pitchers = new Set(training.map((r) => r.pitcherId));
  const trainDesign = {
      shape: qualityDesign(train.samples, pre, "shape"),
      location: qualityDesign(train.samples, pre, "location"),
    },
    testDesign = {
      shape: qualityDesign(test.samples, pre, "shape"),
      location: qualityDesign(test.samples, pre, "location"),
    };
  const models = targets.map((target, t) => {
    const validation = (validations[t] ?? []).map(({ gameDifferences, ...v }) => ({
        ...v,
        lossDifference95: v.kind === "baseline" ? null : gameLossInterval(gameDifferences),
      })),
      baseline = validation[0];
    const eligible = validation.filter(
      (v) =>
        v.kind !== "baseline" &&
        v.converged &&
        v.subgroupGate &&
        v.evaluations.length === 2 &&
        v.lossDifference95 !== null &&
        v.lossDifference95.high < 0 &&
        v.evaluations.every(
          (e, i) =>
            e.logLoss !== null && e.logLoss < (baseline?.evaluations[i]?.logLoss ?? -Infinity),
        ),
    );
    eligible.sort(
      (a, b) =>
        a.evaluations.reduce((s, e) => s + (e.logLoss ?? Infinity), 0) -
        b.evaluations.reduce((s, e) => s + (e.logLoss ?? Infinity), 0),
    );
    const selected = eligible[0] ?? candidates[0];
    if (selected === undefined) throw new Error("Missing baseline");
    let fitted = fit(
      train.samples,
      target,
      selected,
      selected.kind === "baseline" ? null : trainDesign[selected.kind],
    );
    const adopted = selected.kind !== "baseline" && fitted.converged;
    if (!adopted) fitted = fit(train.samples, target, { kind: "baseline", lambda: 0 }, null);
    const evaluation = evaluate(
      test,
      through + 1,
      fitted,
      fitted.kind === "baseline" ? null : testDesign[fitted.kind],
      pitchers,
    ).metrics;
    return { target, adopted, fitted, validation, evaluation };
  });
  return {
    version: 1,
    kind: "pitch-quality",
    sourceHash,
    trainedThrough: through,
    preprocessing: pre,
    targets: models,
    validationPreprocessing,
  };
}
export function summarizePitchQuality(
  rows: readonly PitchQualityRow[],
  scope: AnalysisScope,
  pitcherId: string,
  sourceHash: string,
  model: PitchQualityModel | null,
  modelHash: string | null,
): PitchQualityResponse {
  const compatible = scope.competition === "regular" && model?.trainedThrough === scope.season - 1,
    usable = compatible ? model : null,
    prepared = prepareQualityRows(rows, usable !== null),
    cohort = usable === null ? null : qualityCohort(prepared, usable.preprocessing),
    samples = cohort?.samples ?? [];
  const designs =
    usable === null
      ? null
      : {
          shape: qualityDesign(samples, usable.preprocessing, "shape"),
          location: qualityDesign(samples, usable.preprocessing, "location"),
        };
  const predictors =
    usable?.targets.map((m) =>
      m.adopted
        ? predictor(
            m.fitted,
            m.fitted.kind === "baseline" ? null : (designs?.[m.fitted.kind] ?? null),
          )
        : null,
    ) ?? [];
  const groupMap = new Map<
    string | null,
    {
      pitches: number;
      swing: { n: number; y: number; p: number };
      whiff: { n: number; y: number; p: number };
      calledStrike: { n: number; y: number; p: number };
      whiffPerPitch: { n: number; y: number; p: number };
    }
  >();
  for (const row of rows) {
    const g = groupMap.get(row.pitchType) ?? {
      pitches: 0,
      swing: { n: 0, y: 0, p: 0 },
      whiff: { n: 0, y: 0, p: 0 },
      calledStrike: { n: 0, y: 0, p: 0 },
      whiffPerPitch: { n: 0, y: 0, p: 0 },
    };
    g.pitches++;
    groupMap.set(row.pitchType, g);
  }
  const evaluated =
    cohort === null
      ? prepared.filter((r) => r.eligible).map((row) => ({ row, key: "", features: [] }))
      : samples;
  for (let i = 0; i < evaluated.length; i++) {
    const s = evaluated[i];
    if (s === undefined) continue;
    const g = groupMap.get(s.row.pitchType);
    if (g === undefined) continue;
    const ps = predictors[0]?.(s, i) ?? 0,
      pw = predictors[1]?.(s, i) ?? 0,
      pc = predictors[2]?.(s, i) ?? 0;
    g.swing.n++;
    g.swing.y += Number(s.row.swing);
    g.swing.p += ps;
    g.whiffPerPitch.n++;
    g.whiffPerPitch.y += Number(s.row.whiff);
    g.whiffPerPitch.p += ps * pw;
    if (s.row.swing) {
      g.whiff.n++;
      g.whiff.y += Number(s.row.whiff);
      g.whiff.p += pw;
    } else {
      g.calledStrike.n++;
      g.calledStrike.y += Number(s.row.calledStrike);
      g.calledStrike.p += pc;
    }
  }
  const rate = (s: { n: number; y: number; p: number }, adopted: boolean) => ({
    samples: s.n,
    observed: s.n === 0 ? null : s.y / s.n,
    expected: s.n === 0 || !adopted ? null : s.p / s.n,
    difference: s.n === 0 || !adopted ? null : (s.y - s.p) / s.n,
  });
  return {
    version: 1,
    scope,
    pitcherId,
    sourceHash,
    modelHash: usable === null ? null : modelHash,
    trainedThrough: usable?.trainedThrough ?? null,
    status:
      scope.competition !== "regular"
        ? "scope_mismatch"
        : usable === null
          ? "model_unavailable"
          : usable.targets.some((m) => m.adopted)
            ? "ready"
            : "not_adopted",
    coverage: cohort?.coverage ?? {
      actual: rows.length,
      ineligible: rows.filter((r) => !r.eligible).length,
      missing: 0,
      calibrationUnsupported: 0,
      outOfSupport: 0,
      modelUnavailable: rows.filter((r) => r.eligible).length,
      used: 0,
    },
    models:
      usable?.targets.map((m) => ({
        target: m.target,
        adopted: m.adopted,
        kind: m.fitted.kind,
        evaluation: m.evaluation,
      })) ?? [],
    groups: [...groupMap]
      .sort(([a], [b]) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0))
      .map(([pitchType, g]) => ({
        pitchType,
        pitches: g.pitches,
        swing: rate(g.swing, Boolean(predictors[0])),
        whiff: rate(g.whiff, Boolean(predictors[1])),
        calledStrike: rate(g.calledStrike, Boolean(predictors[2])),
        whiffPerPitch: rate(g.whiffPerPitch, Boolean(predictors[0] && predictors[1])),
      })),
  };
}
