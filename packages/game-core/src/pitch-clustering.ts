import { PITCH_CLUSTER_PARAMETERS, type PitchClusterResult } from "@kbo/contracts";

export { PITCH_CLUSTER_PARAMETERS } from "@kbo/contracts";
interface Point3D {
  readonly xCm: number;
  readonly zCm: number;
  readonly distanceToPlateCm: number;
}
type Vector = [number, number, number];
// Symmetric covariance / lower triangular Cholesky: xx, zx, yx, zz, yz, yy.
type Matrix = [number, number, number, number, number, number];
interface Component {
  mean: Vector;
  covariance: Matrix;
  weight: number;
}
const axes = [0, 1, 2] as const;
const zero = (): Vector => [0, 0, 0];
const distance = (a: Vector, b: Vector): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const compare = (a: Vector, b: Vector): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function initialize(rows: Vector[], k: number, seed: number): Float64Array {
  const random = randomSource(seed);
  const centers: Vector[] = [[...(rows[Math.floor(random() * rows.length)] ?? zero())]];
  const nearest = rows.map(() => Infinity);
  while (centers.length < k) {
    const last = centers.at(-1) ?? zero();
    let total = 0;
    rows.forEach((row, i) => {
      nearest[i] = Math.min(nearest[i] ?? Infinity, distance(row, last));
      total += nearest[i] ?? 0;
    });
    let target = random() * total;
    let chosen = centers.length % rows.length;
    if (total > 0) {
      for (let i = 0; i < rows.length; i++) {
        target -= nearest[i] ?? 0;
        if (target < 0) {
          chosen = i;
          break;
        }
      }
    }
    centers.push([...(rows[chosen] ?? zero())]);
  }
  const assignments = new Int32Array(rows.length).fill(-1);
  for (let iteration = 0; iteration < 50; iteration++) {
    let changed = false;
    const sums = centers.map(zero);
    const counts = new Float64Array(k);
    rows.forEach((row, i) => {
      let best = 0,
        bestDistance = Infinity;
      centers.forEach((center, j) => {
        const d = distance(row, center);
        if (d < bestDistance) {
          bestDistance = d;
          best = j;
        }
      });
      if (assignments[i] !== best) changed = true;
      assignments[i] = best;
      counts[best] = (counts[best] ?? 0) + 1;
      const sum = sums[best];
      if (sum !== undefined) for (const axis of axes) sum[axis] += row[axis];
    });
    centers.forEach((center, j) => {
      const sum = sums[j],
        count = counts[j] ?? 0;
      if (sum !== undefined && count > 0) for (const axis of axes) center[axis] = sum[axis] / count;
    });
    if (!changed) break;
  }
  const responsibilities = new Float64Array(rows.length * k);
  assignments.forEach((label, i) => {
    responsibilities[i * k + label] = 1;
  });
  return responsibilities;
}

function maximize(rows: Vector[], responsibilities: Float64Array, k: number): Component[] {
  const components: Component[] = [];
  const reg = PITCH_CLUSTER_PARAMETERS.regularization;
  for (let j = 0; j < k; j++) {
    const mean = zero();
    let mass = 0;
    rows.forEach((row, i) => {
      const weight = responsibilities[i * k + j] ?? 0;
      mass += weight;
      for (const axis of axes) mean[axis] += weight * row[axis];
    });
    if (mass <= 1e-12) {
      components.push({
        mean: [...(rows[j % rows.length] ?? zero())],
        covariance: [1, 0, 0, 1, 0, 1],
        weight: 1e-12,
      });
      continue;
    }
    for (const axis of axes) mean[axis] /= mass;
    const cov: Matrix = [0, 0, 0, 0, 0, 0];
    rows.forEach((row, i) => {
      const w = (responsibilities[i * k + j] ?? 0) / mass;
      const x = row[0] - mean[0],
        z = row[1] - mean[1],
        y = row[2] - mean[2];
      cov[0] += w * x * x;
      cov[1] += w * z * x;
      cov[2] += w * y * x;
      cov[3] += w * z * z;
      cov[4] += w * y * z;
      cov[5] += w * y * y;
    });
    cov[0] += reg;
    cov[3] += reg;
    cov[5] += reg;
    components.push({ mean, covariance: cov, weight: mass / rows.length });
  }
  const total = components.reduce((sum, c) => sum + c.weight, 0);
  for (const c of components) c.weight /= total;
  return components;
}

function cholesky(c: Matrix): Matrix {
  const a = Math.sqrt(c[0]),
    b = c[1] / a,
    d = c[2] / a;
  const e = Math.sqrt(c[3] - b * b),
    f = (c[4] - d * b) / e;
  return [a, b, d, e, f, Math.sqrt(c[5] - d * d - f * f)];
}

function expectation(
  rows: Vector[],
  components: Component[],
  responsibilities: Float64Array,
): number {
  const k = components.length;
  const factors = components.map((c) => {
    const l = cholesky(c.covariance);
    return {
      l,
      base: Math.log(c.weight) - 1.5 * Math.log(2 * Math.PI) - Math.log(l[0] * l[3] * l[5]),
    };
  });
  let likelihood = 0;
  const logs = new Float64Array(k);
  rows.forEach((row, i) => {
    let maximum = -Infinity;
    components.forEach((component, j) => {
      const factor = factors[j];
      if (factor === undefined) return;
      const { l, base } = factor,
        m = component.mean;
      const x = (row[0] - m[0]) / l[0];
      const z = (row[1] - m[1] - l[1] * x) / l[3];
      const y = (row[2] - m[2] - l[2] * x - l[4] * z) / l[5];
      const log = base - 0.5 * (x * x + z * z + y * y);
      logs[j] = log;
      maximum = Math.max(maximum, log);
    });
    let total = 0;
    for (let j = 0; j < k; j++) total += Math.exp((logs[j] ?? -Infinity) - maximum);
    const normalizer = maximum + Math.log(total);
    likelihood += normalizer / rows.length;
    for (let j = 0; j < k; j++)
      responsibilities[i * k + j] = Math.exp((logs[j] ?? -Infinity) - normalizer);
  });
  return likelihood;
}

/** Fixed-K full-covariance GMM. Only geometry enters fitting; labels retain original input order. */
export function clusterPitchPositions(
  points: readonly Point3D[],
  componentCount: number,
  options: { readonly maxIterations?: number } = {},
): PitchClusterResult {
  const empty: PitchClusterResult = {
    status: "empty",
    componentCount,
    clusterCount: 0,
    unassignedCount: points.length,
    iterations: 0,
    labels: points.map(() => null),
  };
  if (
    !Number.isSafeInteger(componentCount) ||
    componentCount < (points.length === 0 ? 0 : 1) ||
    componentCount > points.length
  )
    throw new Error("GMM component count must be between 1 and the sample size");
  const maxIterations = options.maxIterations ?? PITCH_CLUSTER_PARAMETERS.maxIterations;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1)
    throw new Error("Invalid GMM iteration limit");
  const ordered = points.map((p, index) => ({
    index,
    vector: [p.xCm, p.zCm, p.distanceToPlateCm] satisfies Vector,
  }));
  if (ordered.some((p) => p.vector.some((value) => !Number.isFinite(value))))
    throw new Error("GMM requires finite coordinates");
  ordered.sort((a, b) => compare(a.vector, b.vector));
  if (points.length === 0) return empty;
  const rows = ordered.map((p) => p.vector);
  for (const axis of axes) {
    const mean = rows.reduce((sum, row) => sum + row[axis] / rows.length, 0);
    const sd = Math.sqrt(rows.reduce((sum, row) => sum + (row[axis] - mean) ** 2 / rows.length, 0));
    if (!Number.isFinite(mean) || !Number.isFinite(sd))
      throw new Error("GMM coordinate range is not supported");
    for (const row of rows) row[axis] = sd > 0 ? (row[axis] - mean) / sd : 0;
  }
  let bestLikelihood = -Infinity;
  let result: PitchClusterResult = { ...empty, status: "not_converged" };
  for (let run = 0; run < PITCH_CLUSTER_PARAMETERS.initializations; run++) {
    const responsibilities = initialize(rows, componentCount, PITCH_CLUSTER_PARAMETERS.seed + run);
    let previous = -Infinity;
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const components = maximize(rows, responsibilities, componentCount);
      const likelihood = expectation(rows, components, responsibilities);
      if (!Number.isFinite(likelihood)) break;
      if (Math.abs(likelihood - previous) < PITCH_CLUSTER_PARAMETERS.tolerance) {
        if (likelihood > bestLikelihood) {
          bestLikelihood = likelihood;
          const canonical = components
            .map((c, index) => ({ ...c, index }))
            .sort((a, b) => compare(a.mean, b.mean) || a.index - b.index);
          const labels: (number | null)[] = points.map(() => null);
          rows.forEach((_, i) => {
            let best = -1,
              label = 1;
            canonical.forEach((c, j) => {
              const probability = responsibilities[i * componentCount + c.index] ?? 0;
              if (probability > best) {
                best = probability;
                label = j + 1;
              }
            });
            const original = ordered[i];
            if (original !== undefined) labels[original.index] = label;
          });
          result = {
            status: "ready",
            componentCount,
            clusterCount: new Set(labels).size,
            unassignedCount: 0,
            iterations: iteration,
            labels,
          };
        }
        break;
      }
      previous = likelihood;
    }
  }
  return result;
}
