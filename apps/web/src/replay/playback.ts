import type { ReplayTrackingCandidate } from "@kbo/contracts";

export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;

export interface StrikeZonePlot {
  readonly xFeet: number;
  readonly zFeet: number;
  readonly bottomFeet: number;
  readonly topFeet: number;
  readonly halfWidthFeet: number;
}

export function nextReplayIndex(current: number, frameCount: number): number {
  if (frameCount <= 0) return -1;
  return Math.min(Math.max(current, -1) + 1, frameCount - 1);
}

export function replayDelay(speed: number): number {
  return Math.max(100, Math.round(1_200 / speed));
}

export function strikeZonePlot(observation: ReplayTrackingCandidate): StrikeZonePlot | null {
  const xFeet = observation.crossPlateX;
  const zFeet = trajectoryHeightAtPlate(observation);
  const zone = observation.strikeZone;
  if (zone === null) return null;
  const { bottomFeet, topFeet, halfWidthFeet } = zone;
  if (
    xFeet === null ||
    zFeet === null ||
    bottomFeet === null ||
    topFeet === null ||
    !Number.isFinite(xFeet) ||
    !Number.isFinite(zFeet) ||
    !Number.isFinite(bottomFeet) ||
    !Number.isFinite(topFeet) ||
    zFeet < 0 ||
    bottomFeet < 0 ||
    topFeet <= bottomFeet
  ) {
    return null;
  }
  return { xFeet, zFeet, bottomFeet, topFeet, halfWidthFeet };
}

function trajectoryHeightAtPlate(observation: ReplayTrackingCandidate): number | null {
  const { y0, z0, vy0, vz0, ay, az, crossPlateY } = observation;
  if (
    y0 === null ||
    z0 === null ||
    vy0 === null ||
    vz0 === null ||
    ay === null ||
    az === null ||
    crossPlateY === null ||
    ![y0, z0, vy0, vz0, ay, az, crossPlateY].every(Number.isFinite)
  ) {
    return null;
  }

  // Naver의 crossPlateY는 높이가 아니라 투구 궤적이 홈플레이트에 닿는 종방향 y 좌표다.
  // y(t)의 첫 비음수 교차 시점을 구한 뒤 같은 시점의 z(t)를 높이로 사용한다.
  const crossingTime = firstNonNegativeRoot(ay / 2, vy0, y0 - crossPlateY);
  if (crossingTime === null) return null;
  const height = z0 + vz0 * crossingTime + (az * crossingTime * crossingTime) / 2;
  return Number.isFinite(height) ? height : null;
}

function firstNonNegativeRoot(a: number, b: number, c: number): number | null {
  const epsilon = 1e-9;
  if (Math.abs(a) <= epsilon) {
    if (Math.abs(b) <= epsilon) return Math.abs(c) <= epsilon ? 0 : null;
    const root = -c / b;
    return root >= 0 && Number.isFinite(root) ? root : null;
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0 || !Number.isFinite(discriminant)) return null;
  const squareRoot = Math.sqrt(discriminant);
  const roots = [(-b - squareRoot) / (2 * a), (-b + squareRoot) / (2 * a)]
    .filter((root) => root >= 0 && Number.isFinite(root))
    .sort((left, right) => left - right);
  return roots[0] ?? null;
}
