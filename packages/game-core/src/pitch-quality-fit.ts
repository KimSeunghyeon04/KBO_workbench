import type { PitchQualityFit } from "@kbo/contracts";
import { fitBinaryLogit, type BinaryDesign } from "./binary-logit.js";
import type { QualitySample } from "./pitch-quality-features.js";
import { qualityOutcome } from "./pitch-quality-target.js";
export type QualityCandidate = Pick<PitchQualityFit, "kind" | "lambda">;

function labelRows(samples: readonly QualitySample[], target: PitchQualityFit["target"]) {
  const labels = new Uint8Array(samples.length),
    indices: number[] = [];
  let positives = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s === undefined) continue;
    const y = qualityOutcome(s, target);
    if (y !== null) {
      labels[i] = y;
      indices.push(i);
      positives += y;
    }
  }
  return { labels, indices: Uint32Array.from(indices), positives };
}
export function fitQualityTarget(
  samples: readonly QualitySample[],
  target: PitchQualityFit["target"],
  candidate: QualityCandidate,
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
