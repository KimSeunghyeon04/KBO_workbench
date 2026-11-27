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

const PITCH_COMPARISON_START_FEET = 50;

export function crossingTime(distance: number, vy: number, ay: number): number | null {
  if (!(distance > 0) || !(vy < 0)) return null;
  const discriminant = vy * vy - 2 * ay * distance;
  if (!(discriminant >= 0) || !Number.isFinite(discriminant)) return null;
  // Rationalized first root avoids cancellation and also handles linear motion.
  const time = (2 * distance) / (-vy + Math.sqrt(discriminant));
  return time > 0 && Number.isFinite(time) && vy + ay * time < 0 ? time : null;
}

/** Signed time along the same inbound branch, including before the original reference plane. */
export function pitchTimeAtPlane(y0: number, vy0: number, ay: number, y: number): number | null {
  const distance = y0 - y;
  if (distance === 0) return 0;
  if (distance > 0) return crossingTime(distance, vy0, ay);
  const backward = crossingTime(-distance, vy0, -ay);
  return backward === null ? null : -backward;
}

/** Position and velocity at a plane reached by the original trajectory. */
export function pitchStateAtPlane(
  input: Omit<PitchTrajectoryInput, "crossPlateY">,
  y: number,
  allowBackward = false,
) {
  const { x0, y0, z0, vx0, vy0, vz0, ax, ay, az } = input;
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
    ![x0, y0, z0, vx0, vy0, vz0, ax, ay, az, y].every(Number.isFinite) ||
    z0 < 0 ||
    vy0 >= 0 ||
    y < 0 ||
    (!allowBackward && y > y0)
  )
    return null;

  const seconds = pitchTimeAtPlane(y0, vy0, ay, y);
  if (seconds === null) return null;
  const state = {
    y,
    seconds,
    x: x0 + vx0 * seconds + (ax * seconds * seconds) / 2,
    z: z0 + vz0 * seconds + (az * seconds * seconds) / 2,
    vx: vx0 + ax * seconds,
    vy: vy0 + ay * seconds,
    vz: vz0 + az * seconds,
  };
  return state.z >= 0 && Object.values(state).every(Number.isFinite) ? state : null;
}

export function pitchComparisonStart(input: Omit<PitchTrajectoryInput, "crossPlateY">) {
  return pitchStateAtPlane(input, PITCH_COMPARISON_START_FEET);
}

/** Approach angles of the observed trajectory at an explicit plane, before tangent alignment or park correction. */
export function pitchApproachAngles(input: PitchTrajectoryInput, plateYFeet: number) {
  const state = pitchStateAtPlane(input, plateYFeet);
  if (state === null || state.seconds === 0) return null;
  const result = {
    vaaDegrees: (Math.atan2(state.vz, -state.vy) * 180) / Math.PI,
    haaDegrees: (Math.atan2(state.vx, -state.vy) * 180) / Math.PI,
    heightCm: state.z * 30.48,
    sideCm: state.x * 30.48,
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

export function alignPitchTrajectory(
  input: PitchTrajectoryInput,
  releaseY?: number,
): AlignedPitchTrajectory | null {
  const { ax, ay, az, crossPlateY } = input;
  const start =
    releaseY === undefined ? pitchComparisonStart(input) : pitchStateAtPlane(input, releaseY, true);
  if (
    start === null ||
    ax === null ||
    ay === null ||
    az === null ||
    crossPlateY === null ||
    !Number.isFinite(crossPlateY) ||
    crossPlateY < 0
  )
    return null;
  const distance = start.y - crossPlateY;
  const arrivalSeconds = crossingTime(distance, start.vy, ay);
  if (arrivalSeconds === null) return null;
  const height = start.z + start.vz * arrivalSeconds + (az * arrivalSeconds ** 2) / 2;
  if (!(height >= 0) || !Number.isFinite(height)) return null;
  // Remove the initial tangent in distance space: x - x0 - (vx0/vy0)*(y-y0).
  // This aligns location and direction while retaining the observed flight clock.
  const result = {
    distance,
    vy: start.vy,
    ay,
    lateralAcceleration: ax - (start.vx * ay) / start.vy,
    verticalAcceleration: az - (start.vz * ay) / start.vy,
    speedKph: Math.hypot(start.vx, start.vy, start.vz) * 1.09728,
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
