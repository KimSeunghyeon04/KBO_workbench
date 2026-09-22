import { modelValidationSeasons } from "./model-training-period.js";
import type {
  MatchupModel,
  PitchQualityModel,
  PitchQualityRow,
  PitchQualityEvaluation,
} from "@kbo/contracts";
import {
  fitQualityPreprocessing,
  prepareQualityRows,
  qualityCohort,
  qualityDesign,
  qualityHash,
} from "./pitch-quality-features.js";
import {
  fitQualityTarget,
  qualityPredictor,
  evaluateQualityTarget,
  qualitySubgroupGate,
} from "./pitch-quality.js";
import { gameLossInterval } from "./game-bootstrap.js";
import { MATCHUP_RADII, validateShapeProbabilities } from "./matchup-similarity.js";
import {
  MATCHUP_PENALTIES,
  fitBatterEffects,
  offsetProbability,
  usableBatterEffect,
} from "./matchup-effects.js";
type Validation = MatchupModel["similarity"]["validation"][number];
const createValidation = (parameter: number) => ({
  parameter,
  evaluations: [] as PitchQualityEvaluation[],
  lossDifference95: null as Validation["lossDifference95"],
  subgroupGate: true,
  games: [] as { sum: number; samples: number }[],
});
const finish = ({ games, ...v }: ReturnType<typeof createValidation>): Validation => ({
  ...v,
  lossDifference95: gameLossInterval(games),
});
const loss = (v: Validation) => v.evaluations.reduce((n, e) => n + (e.logLoss ?? Infinity), 0);
function accepted(v: Validation, baseline: PitchQualityEvaluation[]) {
  return (
    v.evaluations.length === 2 &&
    v.subgroupGate &&
    v.lossDifference95 !== null &&
    v.lossDifference95.high < 0 &&
    v.evaluations.every(
      (e, i) => e.logLoss !== null && e.logLoss < (baseline[i]?.logLoss ?? -Infinity),
    )
  );
}
export function trainMatchupModel(
  rows: readonly PitchQualityRow[],
  base: PitchQualityModel,
  baseModelHash: string,
  sourceHash: string,
): MatchupModel {
  if (base.sourceHash !== sourceHash)
    throw new Error("Matchup base source does not match training facts");
  const prepared = prepareQualityRows(
      rows
        .filter((r) => r.season >= 2020 && r.season <= base.trainedThrough + 1)
        .sort((a, b) =>
          a.gameId < b.gameId
            ? -1
            : a.gameId > b.gameId
              ? 1
              : a.pitchId < b.pitchId
                ? -1
                : a.pitchId > b.pitchId
                  ? 1
                  : 0,
        ),
    ),
    validations = base.targets.map(() => MATCHUP_PENALTIES.map(createValidation)),
    baselines = base.targets.map(() => [] as PitchQualityEvaluation[]),
    similarities = MATCHUP_RADII.map(createValidation),
    similarityBaseline: PitchQualityEvaluation[] = [],
    preprocessing: MatchupModel["validationPreprocessing"] = [];
  for (const through of modelValidationSeasons(base.trainedThrough).map((season) => season - 1)) {
    const training = prepared.filter((r) => r.season <= through),
      pre = fitQualityPreprocessing(training, base.preprocessing.profiles, through),
      train = qualityCohort(training, pre),
      test = qualityCohort(
        prepared.filter((r) => r.season === through + 1),
        pre,
      ),
      pitchers = new Set(training.map((r) => r.pitcherId));
    preprocessing.push({ season: through + 1, hash: qualityHash(pre) });
    // Only the selected A10 design is materialized, and each temporal fold is released before the next.
    for (let t = 0; t < base.targets.length; t++) {
      const parent = base.targets[t];
      if (parent === undefined) continue;
      const kind = parent.fitted.kind,
        design = kind === "baseline" ? null : qualityDesign(train.samples, pre, kind),
        testDesign = kind === "baseline" ? null : qualityDesign(test.samples, pre, kind),
        fitted = fitQualityTarget(
          train.samples,
          parent.target,
          { kind, lambda: parent.fitted.lambda },
          design,
        ),
        trainPredict = qualityPredictor(fitted, design),
        testPredict = qualityPredictor(fitted, testDesign),
        probabilities = Float64Array.from(train.samples, trainPredict),
        baseline = evaluateQualityTarget(test, through + 1, fitted, testDesign, pitchers);
      baselines[t]?.push(baseline.metrics);
      for (const validation of validations[t] ?? []) {
        const effects = new Map(
          fitBatterEffects(train.samples, parent.target, probabilities, validation.parameter).map(
            (e) => [e.batterId, e],
          ),
        );
        const evaluation = evaluateQualityTarget(
          test,
          through + 1,
          fitted,
          testDesign,
          pitchers,
          baseline.losses,
          (s, i) => {
            const effect = effects.get(s.row.batterId);
            return offsetProbability(
              testPredict(s, i),
              usableBatterEffect(effect) ? effect.offset : 0,
            );
          },
        );
        validation.evaluations.push(evaluation.metrics);
        validation.games.push(...evaluation.gameDifferences);
        validation.subgroupGate &&=
          fitted.converged && qualitySubgroupGate(evaluation.metrics, baseline.metrics);
      }
      if (parent.target === "swing") {
        const neighbour = validateShapeProbabilities(train.samples, test.samples, pre),
          coarse = evaluateQualityTarget(
            test,
            through + 1,
            fitted,
            testDesign,
            pitchers,
            undefined,
            (_s, i) => neighbour.baseline[i] ?? 0.5,
          );
        similarityBaseline.push(coarse.metrics);
        similarities.forEach((v, c) => {
          const evaluation = evaluateQualityTarget(
            test,
            through + 1,
            fitted,
            testDesign,
            pitchers,
            coarse.losses,
            (_s, i) => neighbour.candidates[c]?.[i] ?? 0.5,
          );
          v.evaluations.push(evaluation.metrics);
          v.games.push(...evaluation.gameDifferences);
          v.subgroupGate &&= qualitySubgroupGate(evaluation.metrics, coarse.metrics);
        });
      }
    }
  }
  const train = qualityCohort(
      prepared.filter((r) => r.season <= base.trainedThrough),
      base.preprocessing,
    ),
    test = qualityCohort(
      prepared.filter((r) => r.season === base.trainedThrough + 1),
      base.preprocessing,
    ),
    pitchers = new Set(train.samples.map((s) => s.row.pitcherId));
  const targets = base.targets.map((parent, t) => {
    const validation = (validations[t] ?? []).map(finish),
      candidates = validation
        .filter((v) => accepted(v, baselines[t] ?? []))
        .sort((a, b) => loss(a) - loss(b)),
      selected = candidates[0],
      penalty = selected?.parameter ?? 100,
      kind = parent.fitted.kind,
      design = kind === "baseline" ? null : qualityDesign(train.samples, base.preprocessing, kind),
      testDesign =
        kind === "baseline" ? null : qualityDesign(test.samples, base.preprocessing, kind),
      predict = qualityPredictor(parent.fitted, design),
      testPredict = qualityPredictor(parent.fitted, testDesign),
      effects = fitBatterEffects(
        train.samples,
        parent.target,
        Float64Array.from(train.samples, predict),
        penalty,
      ),
      lookup = new Map(effects.map((e) => [e.batterId, e])),
      adopted = parent.adopted && selected !== undefined;
    const evaluation = evaluateQualityTarget(
      test,
      base.trainedThrough + 1,
      parent.fitted,
      testDesign,
      pitchers,
      undefined,
      (s, i) => {
        const effect = lookup.get(s.row.batterId);
        return offsetProbability(
          testPredict(s, i),
          adopted && usableBatterEffect(effect) ? effect.offset : 0,
        );
      },
    ).metrics;
    return { target: parent.target, adopted, penalty, effects, validation, evaluation };
  });
  const validation = similarities.map(finish),
    eligible = validation
      .filter((v) => accepted(v, similarityBaseline))
      .sort((a, b) => loss(a) - loss(b));
  return {
    version: 1,
    kind: "matchup",
    policy: "frozen-shape-batter-offset-v1",
    sourceHash,
    trainedThrough: base.trainedThrough,
    baseModelHash,
    base,
    similarity: {
      radius: eligible[0]?.parameter ?? 1,
      minSamples: 20,
      validatedImprovement: eligible.length > 0,
      validation,
    },
    targets,
    validationPreprocessing: preprocessing,
  };
}
