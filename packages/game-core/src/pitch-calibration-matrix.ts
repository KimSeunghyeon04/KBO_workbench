/** Small symmetric matrices only: fixed effects are removed before this solver. */
export function symmetricInverse(matrix: readonly number[][], tolerance = 1e-11) {
  const size = matrix.length;
  const a = matrix.map((row) => [...row]);
  const vectors = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => Number(i === j)),
  );
  const scale = Math.max(1, ...a.map((row, i) => Math.abs(row[i] ?? 0)));
  let converged = false;
  for (let iteration = 0; iteration < 100 * size * size; iteration++) {
    let p = 0;
    let q = 0;
    let largest = 0;
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) {
        const value = Math.abs(a[i]?.[j] ?? 0);
        if (value > largest) {
          largest = value;
          p = i;
          q = j;
        }
      }
    }
    if (largest < scale * 1e-14) {
      converged = true;
      break;
    }
    const ap = a[p];
    const aq = a[q];
    if (ap === undefined || aq === undefined) throw new Error("Invalid calibration matrix");
    const pp = ap[p] ?? 0;
    const qq = aq[q] ?? 0;
    const pq = ap[q] ?? 0;
    const angle = 0.5 * Math.atan2(2 * pq, qq - pp);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    for (let i = 0; i < size; i++) {
      const row = a[i];
      const vector = vectors[i];
      if (row === undefined || vector === undefined) throw new Error("Invalid calibration matrix");
      if (i !== p && i !== q) {
        const ip = row[p] ?? 0;
        const iq = row[q] ?? 0;
        const nextP = c * ip - s * iq;
        const nextQ = s * ip + c * iq;
        row[p] = nextP;
        ap[i] = nextP;
        row[q] = nextQ;
        aq[i] = nextQ;
      }
      const vp = vector[p] ?? 0;
      const vq = vector[q] ?? 0;
      vector[p] = c * vp - s * vq;
      vector[q] = s * vp + c * vq;
    }
    ap[p] = c * c * pp - 2 * s * c * pq + s * s * qq;
    aq[q] = s * s * pp + 2 * s * c * pq + c * c * qq;
    ap[q] = 0;
    aq[p] = 0;
  }
  const values = a.map((row, i) => row[i] ?? 0);
  const cutoff = Math.max(...values.map(Math.abs), 0) * tolerance;
  const inverse = Array.from({ length: size }, () => Array<number>(size).fill(0));
  const projection = Array.from({ length: size }, () => Array<number>(size).fill(0));
  let rank = 0;
  values.forEach((value, k) => {
    if (value <= cutoff) return;
    rank++;
    for (let i = 0; i < size; i++) {
      const out = inverse[i];
      const projected = projection[i];
      if (out === undefined || projected === undefined)
        throw new Error("Invalid calibration matrix");
      for (let j = 0; j < size; j++) {
        const product = (vectors[i]?.[k] ?? 0) * (vectors[j]?.[k] ?? 0);
        out[j] = (out[j] ?? 0) + product / value;
        projected[j] = (projected[j] ?? 0) + product;
      }
    }
  });
  return { inverse, projection, rank, converged, values, vectors };
}

export function multiply(a: readonly number[][], b: readonly number[][]): number[][] {
  const columns = b[0]?.length ?? 0;
  return a.map((row) =>
    Array.from({ length: columns }, (_, j) =>
      row.reduce((sum, value, k) => sum + value * (b[k]?.[j] ?? 0), 0),
    ),
  );
}
