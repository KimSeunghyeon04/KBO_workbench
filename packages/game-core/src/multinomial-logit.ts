/** Small dense multinomial fit; rows can be aggregated before this numerical boundary. */
export interface MultinomialRow {
  x: readonly number[];
  counts: readonly number[];
}
export function softmax(logits: readonly number[]): number[] {
  const max = Math.max(...logits),
    exps = logits.map((x) => Math.exp(x - max)),
    sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / sum);
}
export function multinomialPredict(
  x: readonly number[],
  coefficients: readonly number[],
  classes: number,
) {
  return softmax(
    Array.from({ length: classes }, (_, c) =>
      x.reduce((s, v, i) => s + v * (coefficients[c * x.length + i] ?? 0), 0),
    ),
  );
}
export function fitMultinomial(
  rows: readonly MultinomialRow[],
  classes: number,
  lambda: number,
  maxIterations = 500,
) {
  const width = rows[0]?.x.length ?? 0,
    size = width * classes,
    total = rows.reduce((s, r) => s + r.counts.reduce((a, b) => a + b, 0), 0);
  let coefficients = Array.from({ length: size }, () => 0),
    converged = false,
    iterations = 0;
  if (total === 0 || width === 0) return { coefficients, converged, iterations };
  function objective(beta: readonly number[], gradient: boolean) {
    const g = Array.from({ length: size }, () => 0);
    let loss = 0;
    for (const row of rows) {
      const logits = Array.from({ length: classes }, (_, c) =>
          row.x.reduce((s, v, i) => s + v * (beta[c * width + i] ?? 0), 0),
        ),
        max = Math.max(...logits),
        lse = max + Math.log(logits.reduce((s, v) => s + Math.exp(v - max), 0)),
        n = row.counts.reduce((a, b) => a + b, 0);
      for (let c = 0; c < classes; c++) {
        const logit = logits[c] ?? 0,
          y = row.counts[c] ?? 0;
        loss += (y * (lse - logit)) / total;
        if (gradient) {
          const delta = (n * Math.exp(logit - lse) - y) / total;
          for (let i = 0; i < width; i++) {
            const index = c * width + i;
            g[index] = (g[index] ?? 0) + delta * (row.x[i] ?? 0);
          }
        }
      }
    }
    for (let i = 0; i < size; i++)
      if (i % width !== 0) {
        const b = beta[i] ?? 0;
        loss += (lambda * b * b) / 2;
        g[i] = (g[i] ?? 0) + lambda * b;
      }
    return { loss, g };
  }
  let current = objective(coefficients, true),
    step = 1;
  for (iterations = 0; iterations < maxIterations; iterations++) {
    const norm = current.g.reduce((s, g) => s + g * g, 0);
    if (norm < 1e-12) {
      converged = true;
      break;
    }
    let candidate: number[] = [];
    let loss = Infinity,
      alpha = step;
    for (let search = 0; search < 30; search++) {
      candidate = coefficients.map((b, i) => b - alpha * (current.g[i] ?? 0));
      loss = objective(candidate, false).loss;
      if (Number.isFinite(loss) && loss <= current.loss - 1e-4 * alpha * norm) break;
      alpha /= 2;
    }
    if (!Number.isFinite(loss) || loss > current.loss) break;
    const previous = current;
    coefficients = candidate;
    current = objective(coefficients, true);
    // Barzilai-Borwein step with Armijo backtracking avoids a dense Hessian.
    let sy = 0,
      ss = 0;
    for (let i = 0; i < size; i++) {
      const delta = -alpha * (previous.g[i] ?? 0);
      ss += delta * delta;
      sy += delta * ((current.g[i] ?? 0) - (previous.g[i] ?? 0));
    }
    step = sy > 0 ? Math.min(100, Math.max(1e-5, ss / sy)) : 1;
    if (Math.abs(previous.loss - current.loss) < 1e-11 && Math.sqrt(norm) < 1e-4) {
      converged = true;
      break;
    }
  }
  return { coefficients, converged, iterations };
}
