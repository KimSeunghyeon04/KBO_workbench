import type { PitchQualityPreprocessing } from "@kbo/contracts";
import type { QualitySample } from "./pitch-quality-features.js";
export const MATCHUP_RADII = [0.5, 1, 1.5] as const;
export function shapeCondition(s: QualitySample): string {
  return JSON.stringify([
    s.row.pitchType,
    s.row.balls,
    s.row.strikes,
    s.row.stance,
    Math.floor((s.row.speedKph ?? 0) / 5),
  ]);
}
export function shapeDistance(
  a: QualitySample,
  b: QualitySample,
  pre: PitchQualityPreprocessing,
): number {
  let squared = 0;
  for (let i = 0; i < 4; i++)
    squared += (((a.features[i] ?? 0) - (b.features[i] ?? 0)) / (pre.scales[i] ?? 1)) ** 2;
  return Math.sqrt(squared / 4);
}
export function shapeBuckets(samples: readonly QualitySample[], perBatter = false) {
  const groups = new Map<string, QualitySample[]>();
  for (const s of samples) {
    const key = perBatter ? JSON.stringify([s.row.batterId, shapeCondition(s)]) : shapeCondition(s);
    const group = groups.get(key) ?? [];
    group.push(s);
    groups.set(key, group);
  }
  return groups;
}
/** Past-only neighbours, indexed by batter and exact coarse condition; no all-pairs league scan. */
export function validateShapeProbabilities(
  train: readonly QualitySample[],
  test: readonly QualitySample[],
  pre: PitchQualityPreprocessing,
) {
  const groups = shapeBuckets(train, true),
    prior = (train.reduce((n, s) => n + Number(s.row.swing), 0) + 1) / (train.length + 2),
    baseline = new Float64Array(test.length),
    candidates = MATCHUP_RADII.map(() => new Float64Array(test.length));
  for (let i = 0; i < test.length; i++) {
    const s = test[i];
    if (s === undefined) continue;
    const group = groups.get(JSON.stringify([s.row.batterId, shapeCondition(s)])) ?? [],
      counts = MATCHUP_RADII.map(() => ({ n: 0, y: 0 }));
    let positives = 0;
    for (const past of group) {
      positives += Number(past.row.swing);
      const distance = shapeDistance(s, past, pre);
      for (let c = 0; c < MATCHUP_RADII.length; c++) {
        const count = counts[c],
          radius = MATCHUP_RADII[c];
        if (count !== undefined && radius !== undefined && distance <= radius) {
          count.n++;
          count.y += Number(past.row.swing);
        }
      }
    }
    baseline[i] = (positives + 50 * prior) / (group.length + 50);
    for (let c = 0; c < candidates.length; c++) {
      const count = counts[c],
        candidate = candidates[c];
      if (count !== undefined && candidate !== undefined)
        candidate[i] = (count.y + 50 * prior) / (count.n + 50);
    }
  }
  return { baseline, candidates };
}
