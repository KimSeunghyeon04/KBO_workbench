import type { MatchupEffect, PitchQualityFit } from "@kbo/contracts";
import type { QualitySample } from "./pitch-quality-features.js";
import { qualityOutcome } from "./pitch-quality.js";
export const MATCHUP_PENALTIES = [20, 100, 500] as const;
export function offsetProbability(p: number, offset: number): number {
  const bounded = Math.max(1e-12, Math.min(1 - 1e-12, p));
  const logit = Math.log(bounded) - Math.log1p(-bounded) + offset;
  return logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
}
export function fitBatterEffects(
  samples: readonly QualitySample[],
  target: PitchQualityFit["target"],
  probabilities: Float64Array,
  penalty: number,
): MatchupEffect[] {
  const groups = new Map<string, number[]>();
  samples.forEach((s, i) => {
    if (qualityOutcome(s, target) === null) return;
    const indices = groups.get(s.row.batterId) ?? [];
    indices.push(i);
    groups.set(s.row.batterId, indices);
  });
  return [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([batterId, indices]) => {
      let offset = 0,
        converged = false;
      for (let iteration = 0; iteration < 50; iteration++) {
        let gradient = penalty * offset,
          curvature = penalty;
        for (const i of indices) {
          const sample = samples[i];
          if (sample === undefined) continue;
          const p = offsetProbability(probabilities[i] ?? 0.5, offset);
          gradient += p - (qualityOutcome(sample, target) ?? 0);
          curvature += p * (1 - p);
        }
        const step = Math.max(-1, Math.min(1, gradient / curvature));
        offset -= step;
        if (Math.abs(step) < 1e-8) {
          converged = true;
          break;
        }
      }
      return {
        batterId,
        samples: indices.length,
        games: new Set(indices.map((i) => samples[i]?.row.gameId)).size,
        offset,
        converged,
      };
    });
}
export function usableBatterEffect(effect: MatchupEffect | undefined): effect is MatchupEffect {
  return effect !== undefined && effect.converged && effect.samples >= 20 && effect.games >= 5;
}
