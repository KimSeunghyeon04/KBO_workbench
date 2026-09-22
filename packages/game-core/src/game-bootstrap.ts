/** Paired, game-cluster bootstrap of a sample-weighted loss difference. */
export function gameLossInterval(
  games: readonly { sum: number; samples: number }[],
  repetitions = 1200,
  seed = 73129,
): { low: number; high: number } | null {
  const supported = games.filter((g) => g.samples > 0);
  if (supported.length < 2) return null;
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const estimates: number[] = [];
  for (let b = 0; b < repetitions; b++) {
    let sum = 0,
      samples = 0;
    for (let i = 0; i < supported.length; i++) {
      const game = supported[Math.floor(random() * supported.length)];
      if (game === undefined) throw new Error("Bootstrap index outside support");
      sum += game.sum;
      samples += game.samples;
    }
    estimates.push(sum / samples);
  }
  estimates.sort((a, b) => a - b);
  const low = estimates[Math.floor(repetitions * 0.025)],
    high = estimates[Math.min(repetitions - 1, Math.floor(repetitions * 0.975))];
  return low === undefined || high === undefined ? null : { low, high };
}
