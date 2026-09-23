import type {
  MatchupModel,
  MatchupModelResponse,
  MatchupQuery,
  AnalysisScope,
  PitchQualityRow,
  PitchQualityCoverage,
} from "@kbo/contracts";
import { prepareQualityRows, qualityCohort } from "./pitch-quality-features.js";
import { prepareQualityPredictors } from "./pitch-quality-target.js";
import { offsetProbability, usableBatterEffect } from "./matchup-effects.js";
import { shapeBuckets, shapeCondition, shapeDistance } from "./matchup-similarity.js";
function unavailable(rows: readonly PitchQualityRow[]): PitchQualityCoverage {
  const ineligible = rows.filter((r) => !r.eligible).length;
  return {
    actual: rows.length,
    ineligible,
    missing: 0,
    calibrationUnsupported: 0,
    outOfSupport: 0,
    modelUnavailable: rows.length - ineligible,
    used: 0,
  };
}
export function summarizeMatchupModel(
  query: MatchupQuery,
  scope: AnalysisScope,
  sourceHash: string,
  pitcherRows: readonly PitchQualityRow[],
  batterRows: readonly PitchQualityRow[],
  model: MatchupModel | null,
  modelHash: string | null,
): MatchupModelResponse {
  const ownPitcher = pitcherRows.filter((r) => r.pitcherId === query.pitcherId),
    ownBatter = batterRows.filter((r) => r.batterId === query.batterId);
  const response: MatchupModelResponse = {
    query,
    scope,
    sourceHash,
    modelHash: null,
    trainedThrough: null,
    status: scope.competition !== "regular" ? "scope_mismatch" : "model_unavailable",
    pitcherCoverage: unavailable(ownPitcher),
    batterCoverage: unavailable(ownBatter),
    similarity: null,
    effects: [],
    groups: [],
  };
  if (
    scope.competition !== "regular" ||
    model === null ||
    model.trainedThrough !== scope.season - 1
  )
    return response;
  const pre = model.base.preprocessing,
    pitcher = qualityCohort(prepareQualityRows(ownPitcher), pre),
    batter = qualityCohort(prepareQualityRows(ownBatter), pre),
    buckets = shapeBuckets(pitcher.samples);
  response.status = "ready";
  response.modelHash = modelHash;
  response.trainedThrough = model.trainedThrough;
  response.pitcherCoverage = pitcher.coverage;
  response.batterCoverage = batter.coverage;
  const similar: NonNullable<MatchupModelResponse["similarity"]>["rows"] = [];
  let conditionCandidates = 0;
  for (const s of batter.samples) {
    const candidates = buckets.get(shapeCondition(s));
    if (candidates === undefined) continue;
    conditionCandidates++;
    let distance = Infinity;
    for (const candidate of candidates)
      distance = Math.min(distance, shapeDistance(s, candidate, pre));
    if (distance > model.similarity.radius) continue;
    const r = s.row;
    similar.push({
      gameId: r.gameId,
      revision: r.revision,
      pitchId: r.pitchId,
      gameDate: r.gameDate,
      pitcherId: r.pitcherId,
      pitchType: r.pitchType,
      speedKph: r.speedKph,
      balls: r.balls,
      strikes: r.strikes,
      stance: r.stance,
      swing: r.swing,
      whiff: r.whiff,
      calledStrike: r.calledStrike,
      distance,
    });
  }
  const pitchers = new Map<string, number>();
  for (const s of similar)
    if (s.pitcherId !== null) pitchers.set(s.pitcherId, (pitchers.get(s.pitcherId) ?? 0) + 1);
  const swings = similar.filter((r) => r.swing).length,
    takes = similar.length - swings;
  const rate = (positive: number, samples: number) => ({
    samples,
    probability: samples < model.similarity.minSamples ? null : positive / samples,
  });
  response.similarity = {
    radius: model.similarity.radius,
    minSamples: 20,
    validatedImprovement: model.similarity.validatedImprovement,
    pitches: similar.length,
    games: new Set(similar.map((r) => JSON.stringify([r.gameId, r.revision]))).size,
    pitchers: pitchers.size,
    directOverlap: similar.filter((r) => r.pitcherId === query.pitcherId).length,
    largestPitcherShare:
      similar.length === 0 ? null : Math.max(...pitchers.values()) / similar.length,
    conditionCandidates,
    excludedByDistance: conditionCandidates - similar.length,
    swing: rate(swings, similar.length),
    whiff: rate(similar.filter((r) => r.whiff).length, swings),
    calledStrike: rate(similar.filter((r) => r.calledStrike).length, takes),
    rows: similar,
  };
  const effects = model.targets.map((m) => m.effects.find((e) => e.batterId === query.batterId));
  response.effects = model.targets.map((m, i) => ({
    target: m.target,
    status: !m.adopted
      ? "not_adopted"
      : usableBatterEffect(effects[i])
        ? "ready"
        : "insufficient_history",
    trainingSamples: effects[i]?.samples ?? 0,
    trainingGames: effects[i]?.games ?? 0,
    penalty: m.penalty,
  }));
  const predict = prepareQualityPredictors(
    pitcher.samples,
    pre,
    model.base.targets.map((target, i) =>
      response.effects[i]?.status === "ready" ? target.fitted : null,
    ),
  );
  const stances = new Set(
    ownBatter.filter((r) => r.eligible && r.stance !== null).map((r) => r.stance),
  );
  const groups = new Map<
    string,
    { pitchType: string; stance: string; location: string; pitches: number; sums: number[] }
  >();
  pitcher.samples.forEach((s, i) => {
    if (!stances.has(s.row.stance) || s.row.pitchType === null || s.row.stance === null) return;
    const x = s.features[4] ?? 0,
      z = s.features[5] ?? 0;
    const horizontal =
      x < -1
        ? "left-outside"
        : x > 1
          ? "right-outside"
          : x < -1 / 3
            ? "left"
            : x > 1 / 3
              ? "right"
              : "center";
    const vertical =
      z < -1 ? "below" : z > 1 ? "above" : z < -1 / 3 ? "low" : z > 1 / 3 ? "high" : "middle";
    const location = `${vertical}/${horizontal}`,
      key = JSON.stringify([s.row.pitchType, s.row.stance, location]);
    const g = groups.get(key) ?? {
      pitchType: s.row.pitchType,
      stance: s.row.stance,
      location,
      pitches: 0,
      sums: [0, 0, 0, 0],
    };
    g.pitches++;
    const probabilities = predict.map((p, t) =>
      p === null ? 0 : offsetProbability(p(s, i), effects[t]?.offset ?? 0),
    );
    for (let t = 0; t < 3; t++) g.sums[t] = (g.sums[t] ?? 0) + (probabilities[t] ?? 0);
    g.sums[3] = (g.sums[3] ?? 0) + (probabilities[0] ?? 0) * (probabilities[1] ?? 0);
    groups.set(key, g);
  });
  response.groups = [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, g]) => ({
      pitchType: g.pitchType,
      stance: g.stance,
      location: g.location,
      pitches: g.pitches,
      swing: predict[0] ? (g.sums[0] ?? 0) / g.pitches : null,
      whiff: predict[1] ? (g.sums[1] ?? 0) / g.pitches : null,
      calledStrike: predict[2] ? (g.sums[2] ?? 0) / g.pitches : null,
      whiffPerPitch: predict[0] && predict[1] ? (g.sums[3] ?? 0) / g.pitches : null,
    }));
  return response;
}
