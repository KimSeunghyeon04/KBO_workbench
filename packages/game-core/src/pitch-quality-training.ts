import { modelValidationSeasons } from "./model-training-period.js";
import type {
  PitchQualityModel,
  PitchQualityEvaluation,
  PitchQualityPreprocessing,
  PitchQualityRow,
} from "@kbo/contracts";
import { gameLossInterval } from "./game-bootstrap.js";
import {
  prepareQualityRows,
  fitQualityPreprocessing,
  qualityCohort,
  qualityDesign,
  qualityHash,
} from "./pitch-quality-features.js";
import { fitQualityTarget, type QualityCandidate } from "./pitch-quality-fit.js";
import { evaluateQualityTarget, qualitySubgroupGate } from "./pitch-quality-evaluation.js";

const targets = ["swing", "whiff", "called_strike"] as const;
const candidates: QualityCandidate[] = [
  { kind: "baseline", lambda: 0 },
  ...["shape", "location"].flatMap((kind) =>
    [0.1, 1, 10].map((lambda) => ({
      kind: kind === "shape" ? ("shape" as const) : ("location" as const),
      lambda,
    })),
  ),
];
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
      let baseline: ReturnType<typeof evaluateQualityTarget> | undefined;
      for (let c = 0; c < candidates.length; c++) {
        const candidate = candidates[c],
          validation = validations[t]?.[c];
        if (candidate === undefined || validation === undefined) continue;
        const fitted = fitQualityTarget(
            train.samples,
            target,
            candidate,
            candidate.kind === "baseline" ? null : trainDesign[candidate.kind],
          ),
          ev = evaluateQualityTarget(
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
        validation.subgroupGate &&= qualitySubgroupGate(ev.metrics, baseline.metrics);
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
    let fitted = fitQualityTarget(
      train.samples,
      target,
      selected,
      selected.kind === "baseline" ? null : trainDesign[selected.kind],
    );
    const adopted = selected.kind !== "baseline" && fitted.converged;
    if (!adopted)
      fitted = fitQualityTarget(train.samples, target, { kind: "baseline", lambda: 0 }, null);
    const evaluation = evaluateQualityTarget(
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
