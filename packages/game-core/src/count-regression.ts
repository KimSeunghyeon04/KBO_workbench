export interface CountRegressionRow {
  game: string;
  indices: readonly number[];
  exposure: number;
  y: number;
}
export function countMean(row: CountRegressionRow, coefficients: readonly number[]) {
  const logMean =
    Math.log(row.exposure) + row.indices.reduce((s, i) => s + (coefficients[i] ?? 0), 0);
  return Math.exp(Math.max(-30, Math.min(30, logMean)));
}
/** Pivoted elimination for the small categorical design; singular designs stay unidentified. */
export function invertCountInformation(matrix: readonly number[][]): number[][] | null {
  const n = matrix.length,
    a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => Number(i === j))]),
    scale = Math.max(1, ...matrix.map((r, i) => Math.abs(r[i] ?? 0)));
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++)
      if (Math.abs(a[i]?.[k] ?? 0) > Math.abs(a[pivot]?.[k] ?? 0)) pivot = i;
    const row = a[pivot],
      current = a[k];
    if (row === undefined || current === undefined || Math.abs(row[k] ?? 0) < 1e-10 * scale)
      return null;
    a[pivot] = current;
    a[k] = row;
    const divisor = row[k] ?? 0;
    for (let j = 0; j < 2 * n; j++) row[j] = (row[j] ?? 0) / divisor;
    for (let i = 0; i < n; i++)
      if (i !== k) {
        const other = a[i];
        if (other === undefined) throw new Error("Invalid information matrix");
        const factor = other[k] ?? 0;
        for (let j = 0; j < 2 * n; j++) other[j] = (other[j] ?? 0) - factor * (row[j] ?? 0);
      }
  }
  return a.map((r) => r.slice(n));
}
export function countInformation(
  rows: readonly CountRegressionRow[],
  coefficients: readonly number[],
  alpha: number,
) {
  const matrix = Array.from({ length: coefficients.length }, () =>
    Array<number>(coefficients.length).fill(0),
  );
  for (const row of rows) {
    const mu = countMean(row, coefficients),
      w = mu / (1 + alpha * mu) / rows.length;
    for (const i of row.indices)
      for (const j of row.indices) {
        const target = matrix[i];
        if (target !== undefined) target[j] = (target[j] ?? 0) + w;
      }
  }
  return matrix;
}
export function fitCountRegression(
  rows: readonly CountRegressionRow[],
  width: number,
  lambda: number,
  alpha: number,
) {
  let coefficients = Array<number>(width).fill(0),
    converged = false;
  const y = rows.reduce((s, r) => s + r.y, 0),
    exposure = rows.reduce((s, r) => s + r.exposure, 0);
  if (width === 0 || exposure === 0 || y === 0) return { coefficients, converged };
  coefficients[0] = Math.log(y / exposure);
  const objective = (beta: readonly number[]) => {
    let loss = 0;
    for (const row of rows) {
      const mu = countMean(row, beta);
      loss +=
        (alpha === 0 ? mu : (row.y + 1 / alpha) * Math.log1p(alpha * mu)) - row.y * Math.log(mu);
    }
    return (
      loss / rows.length + beta.reduce((s, b, i) => s + (i === 0 ? 0 : (lambda * b * b) / 2), 0)
    );
  };
  let loss = objective(coefficients);
  for (let iteration = 0; iteration < 80; iteration++) {
    const gradient = Array<number>(width).fill(0),
      information = countInformation(rows, coefficients, alpha);
    for (const row of rows) {
      const mu = countMean(row, coefficients),
        delta = (mu - row.y) / (1 + alpha * mu) / rows.length;
      for (const i of row.indices) gradient[i] = (gradient[i] ?? 0) + delta;
    }
    for (let i = 1; i < width; i++) {
      gradient[i] = (gradient[i] ?? 0) + lambda * (coefficients[i] ?? 0);
      const r = information[i];
      if (r !== undefined) r[i] = (r[i] ?? 0) + lambda;
    }
    if (Math.max(...gradient.map(Math.abs)) < 1e-7) {
      converged = true;
      break;
    }
    const inverse = invertCountInformation(information);
    if (inverse === null) break;
    const delta = inverse.map((row) => row.reduce((s, v, i) => s + v * (gradient[i] ?? 0), 0));
    let step = 1,
      candidate = coefficients,
      next = Infinity;
    for (let backtrack = 0; backtrack < 25; backtrack++) {
      candidate = coefficients.map((b, i) => b - step * (delta[i] ?? 0));
      next = objective(candidate);
      if (Number.isFinite(next) && next <= loss) break;
      step /= 2;
    }
    if (!Number.isFinite(next) || next > loss) break;
    coefficients = candidate;
    if (Math.abs(loss - next) < 1e-10 && Math.max(...delta.map((v) => Math.abs(v * step))) < 1e-5) {
      converged = true;
      break;
    }
    loss = next;
  }
  return { coefficients, converged };
}
export function countContrastEvaluator(
  rows: readonly CountRegressionRow[],
  coefficients: readonly number[],
  lambda: number,
  alpha: number,
) {
  const information = countInformation(rows, coefficients, alpha);
  for (let i = 1; i < coefficients.length; i++) {
    const row = information[i];
    if (row !== undefined) row[i] = (row[i] ?? 0) + lambda;
  }
  const inverse = invertCountInformation(information),
    scores = new Map<string, number[]>();
  for (const row of rows) {
    const mu = countMean(row, coefficients),
      delta = (row.y - mu) / (1 + alpha * mu) / rows.length,
      score = scores.get(row.game) ?? Array<number>(coefficients.length).fill(0);
    for (const i of row.indices) score[i] = (score[i] ?? 0) + delta;
    scores.set(row.game, score);
  }
  return (contrast: readonly number[]) => {
    if (inverse === null || scores.size < 2) return null;
    const direction = inverse.map((row) => row.reduce((s, v, i) => s + v * (contrast[i] ?? 0), 0)),
      projected = [...scores.values()].map((row) =>
        row.reduce((s, v, i) => s + v * (direction[i] ?? 0), 0),
      ),
      mean = projected.reduce((s, v) => s + v, 0) / projected.length,
      variance =
        (projected.reduce((s, v) => s + (v - mean) ** 2, 0) * scores.size) / (scores.size - 1),
      center = coefficients.reduce((s, b, i) => s + b * (contrast[i] ?? 0), 0),
      se = Math.sqrt(variance);
    if (!Number.isFinite(se) || Math.abs(center) + 1.96 * se > 20) return null;
    return {
      index: 100 * Math.exp(center),
      low95: 100 * Math.exp(center - 1.96 * se),
      high95: 100 * Math.exp(center + 1.96 * se),
    };
  };
}
