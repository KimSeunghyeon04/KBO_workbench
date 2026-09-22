export interface WorkloadContrastGame {
  cells: { index: number; samples: number; sum: number }[];
}

/** Resample whole games jointly across both arms, keeping the original common strata and weights. */
export function workloadContrastInterval(
  games: readonly WorkloadContrastGame[],
  weights: readonly number[],
  repetitions: number,
) {
  const samples = new Float64Array(weights.length * 2),
    sums = new Float64Array(samples.length),
    multiplicity = new Uint32Array(games.length),
    estimates: number[] = [],
    totalWeight = weights.reduce((a, b) => a + b, 0);
  let state = 73129;
  for (let b = 0; b < repetitions; b++) {
    multiplicity.fill(0);
    samples.fill(0);
    sums.fill(0);
    for (let i = 0; i < games.length; i++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const index = Math.floor((state / 4294967296) * games.length);
      multiplicity[index] = (multiplicity[index] ?? 0) + 1;
    }
    for (let i = 0; i < games.length; i++) {
      const count = multiplicity[i] ?? 0;
      if (count === 0) continue;
      for (const cell of games[i]?.cells ?? []) {
        samples[cell.index] = (samples[cell.index] ?? 0) + count * cell.samples;
        sums[cell.index] = (sums[cell.index] ?? 0) + count * cell.sum;
      }
    }
    let estimate = 0,
      valid = true;
    for (let s = 0; s < weights.length; s++) {
      const baseline = samples[s * 2] ?? 0,
        target = samples[s * 2 + 1] ?? 0;
      if (baseline === 0 || target === 0) {
        valid = false;
        break;
      }
      estimate +=
        (weights[s] ?? 0) * ((sums[s * 2 + 1] ?? 0) / target - (sums[s * 2] ?? 0) / baseline);
    }
    if (valid) estimates.push(estimate / totalWeight);
  }
  estimates.sort((a, b) => a - b);
  const low = estimates[Math.floor(estimates.length * 0.025)],
    high = estimates[Math.min(estimates.length - 1, Math.floor(estimates.length * 0.975))];
  return {
    validReplicates: estimates.length,
    interval: low === undefined || high === undefined ? null : { low, high },
  };
}
