/** Row-major numeric storage keeps the repeated offline fits free of per-pitch allocations. */
export interface BinaryDesign {
  values: Float64Array;
  width: number;
}
export function logistic(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}
export function binaryPredict(
  design: BinaryDesign,
  row: number,
  coefficients: readonly number[],
): number {
  let z = 0;
  const offset = row * design.width;
  for (let j = 0; j < design.width; j++)
    z += (design.values[offset + j] ?? 0) * (coefficients[j] ?? 0);
  return logistic(z);
}
export function fitBinaryLogit(
  design: BinaryDesign,
  labels: Uint8Array,
  indices: Uint32Array,
  lambda: number,
  maxIterations = 400,
) {
  const width = design.width,
    n = indices.length;
  let beta = Array.from({ length: width }, () => 0),
    converged = false,
    iterations = 0;
  let positives = 0;
  for (const i of indices) positives += labels[i] ?? 0;
  if (n === 0 || positives === 0 || positives === n)
    return { coefficients: beta, converged, iterations };
  beta[0] = Math.log(positives / (n - positives));
  function objective(b: readonly number[], gradient: boolean) {
    const g = new Float64Array(width);
    let loss = 0;
    for (const i of indices) {
      let z = 0;
      const start = i * width,
        y = labels[i] ?? 0;
      for (let j = 0; j < width; j++) z += (design.values[start + j] ?? 0) * (b[j] ?? 0);
      loss += Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z))) - y * z;
      if (gradient) {
        const delta = (logistic(z) - y) / n;
        for (let j = 0; j < width; j++)
          g[j] = (g[j] ?? 0) + delta * (design.values[start + j] ?? 0);
      }
    }
    loss /= n;
    for (let j = 1; j < width; j++) {
      const coefficient = b[j] ?? 0;
      loss += (lambda * coefficient ** 2) / 2;
      g[j] = (g[j] ?? 0) + lambda * coefficient;
    }
    return { loss, g };
  }
  let current = objective(beta, true),
    step = 1;
  for (; iterations < maxIterations; iterations++) {
    let norm = 0;
    for (const g of current.g) norm += g * g;
    if (norm < 1e-12) {
      converged = true;
      break;
    }
    let alpha = step,
      candidate = beta,
      loss = Infinity;
    for (let trial = 0; trial < 30; trial++) {
      candidate = beta.map((b, j) => b - alpha * (current.g[j] ?? 0));
      loss = objective(candidate, false).loss;
      if (Number.isFinite(loss) && loss <= current.loss - 1e-4 * alpha * norm) break;
      alpha /= 2;
    }
    if (!Number.isFinite(loss) || loss > current.loss) break;
    const previous = current;
    beta = candidate;
    current = objective(beta, true);
    let sy = 0,
      ss = 0;
    for (let j = 0; j < width; j++) {
      const delta = -alpha * (previous.g[j] ?? 0);
      ss += delta * delta;
      sy += delta * ((current.g[j] ?? 0) - (previous.g[j] ?? 0));
    }
    step = sy > 0 ? Math.min(100, Math.max(1e-5, ss / sy)) : 1;
  }
  return { coefficients: beta, converged, iterations };
}
