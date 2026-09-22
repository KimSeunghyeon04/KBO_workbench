export interface PitchTrajectoryInput {
  readonly x0: number | null;
  readonly y0: number | null;
  readonly z0: number | null;
  readonly vx0: number | null;
  readonly vy0: number | null;
  readonly vz0: number | null;
  readonly ax: number | null;
  readonly ay: number | null;
  readonly az: number | null;
  readonly crossPlateY: number | null;
}

export interface AlignedPitchTrajectory {
  readonly distance: number;
  readonly vy: number;
  readonly ay: number;
  readonly lateralAcceleration: number;
  readonly verticalAcceleration: number;
  readonly speedKph: number;
  readonly arrivalSeconds: number;
}

export interface PitchTrajectoryComparison {
  readonly xCm: number;
  readonly zCm: number;
  readonly arrivalMs: number;
  readonly timingDifferenceMs: number;
  readonly distanceToPlateCm: number;
  readonly extrapolated: boolean;
}

export function crossingTime(distance: number, vy: number, ay: number): number | null {
  if (!(distance > 0) || !(vy < 0)) return null;
  const discriminant = vy * vy - 2 * ay * distance;
  if (!(discriminant >= 0) || !Number.isFinite(discriminant)) return null;
  // Rationalized first root avoids cancellation and also handles linear motion.
  const time = (2 * distance) / (-vy + Math.sqrt(discriminant));
  return time > 0 && Number.isFinite(time) && vy + ay * time < 0 ? time : null;
}

/** Approach angles of the observed trajectory at an explicit plane, before tangent alignment or park correction. */
export function pitchApproachAngles(input: PitchTrajectoryInput, plateYFeet: number) {
  const trajectory = alignPitchTrajectory({ ...input, crossPlateY: plateYFeet });
  const { vx0, vy0, vz0, ax, ay, az, x0, z0 } = input;
  if (
    trajectory === null ||
    vx0 === null ||
    vy0 === null ||
    vz0 === null ||
    ax === null ||
    ay === null ||
    az === null ||
    x0 === null ||
    z0 === null
  )
    return null;
  const t = trajectory.arrivalSeconds,
    vx = vx0 + ax * t,
    vy = vy0 + ay * t,
    vz = vz0 + az * t;
  const result = {
    vaaDegrees: (Math.atan2(vz, -vy) * 180) / Math.PI,
    haaDegrees: (Math.atan2(vx, -vy) * 180) / Math.PI,
    heightCm: (z0 + vz0 * t + (az * t * t) / 2) * 30.48,
    sideCm: (x0 + vx0 * t + (ax * t * t) / 2) * 30.48,
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

export function alignPitchTrajectory(input: PitchTrajectoryInput): AlignedPitchTrajectory | null {
  const { x0, y0, z0, vx0, vy0, vz0, ax, ay, az, crossPlateY } = input;
  if (
    x0 === null ||
    y0 === null ||
    z0 === null ||
    vx0 === null ||
    vy0 === null ||
    vz0 === null ||
    ax === null ||
    ay === null ||
    az === null ||
    crossPlateY === null ||
    ![x0, y0, z0, vx0, vy0, vz0, ax, ay, az, crossPlateY].every(Number.isFinite) ||
    Math.abs(y0 - 50) > 1e-6 ||
    z0 < 0 ||
    crossPlateY < 0 ||
    crossPlateY >= y0
  )
    return null;
  const arrivalSeconds = crossingTime(y0 - crossPlateY, vy0, ay);
  if (arrivalSeconds === null) return null;
  const height = z0 + vz0 * arrivalSeconds + (az * arrivalSeconds ** 2) / 2;
  if (!(height >= 0) || !Number.isFinite(height)) return null;
  // Remove the initial tangent in distance space: x - x0 - (vx0/vy0)*(y-y0).
  // This aligns location and direction while retaining the observed flight clock.
  const result = {
    distance: y0 - crossPlateY,
    vy: vy0,
    ay,
    lateralAcceleration: ax - (vx0 * ay) / vy0,
    verticalAcceleration: az - (vz0 * ay) / vy0,
    speedKph: Math.hypot(vx0, vy0, vz0) * 1.09728,
    arrivalSeconds,
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

export function averagePitchTrajectory(
  samples: readonly AlignedPitchTrajectory[],
): AlignedPitchTrajectory | null {
  if (samples.length === 0) return null;
  const mean = (key: keyof AlignedPitchTrajectory): number => {
    let sum = 0;
    let correction = 0;
    for (const sample of samples) {
      const value = sample[key] / samples.length - correction;
      const next = sum + value;
      correction = next - sum - value;
      sum = next;
    }
    return sum;
  };
  const distance = mean("distance");
  const vy = mean("vy");
  const ay = mean("ay");
  // The crossing of the mean trajectory is not the mean of individual arrival times.
  const arrivalSeconds = crossingTime(distance, vy, ay);
  if (arrivalSeconds === null) return null;
  return {
    distance,
    vy,
    ay,
    arrivalSeconds,
    lateralAcceleration: mean("lateralAcceleration"),
    verticalAcceleration: mean("verticalAcceleration"),
    speedKph: mean("speedKph"),
  };
}

export function comparePitchTrajectory(
  pitch: AlignedPitchTrajectory,
  reference: AlignedPitchTrajectory,
): PitchTrajectoryComparison | null {
  const t = reference.arrivalSeconds;
  const result = {
    xCm: (((pitch.lateralAcceleration - reference.lateralAcceleration) * t ** 2) / 2) * 30.48,
    zCm: (((pitch.verticalAcceleration - reference.verticalAcceleration) * t ** 2) / 2) * 30.48,
    arrivalMs: pitch.arrivalSeconds * 1000,
    timingDifferenceMs: (pitch.arrivalSeconds - t) * 1000,
    distanceToPlateCm: (pitch.distance + pitch.vy * t + (pitch.ay * t ** 2) / 2) * 30.48,
    extrapolated: pitch.arrivalSeconds < t,
  };
  return [
    result.xCm,
    result.zCm,
    result.arrivalMs,
    result.timingDifferenceMs,
    result.distanceToPlateCm,
  ].every(Number.isFinite)
    ? result
    : null;
}
