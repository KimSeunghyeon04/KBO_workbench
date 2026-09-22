import type { DisciplineRow } from "@kbo/contracts";
import { crossingTime } from "./pitch-trajectory.js";
import { resolveBatterStrikeZone, STRIKE_ZONE_HALF_WIDTH_FEET } from "./strike-zone.js";
type Input = Pick<
  DisciplineRow,
  | "season"
  | "batterHeightCm"
  | "supported"
  | "trackingId"
  | "inZone"
  | "crossPlateX"
  | "crossPlateY"
  | "y0"
  | "z0"
  | "vy0"
  | "vz0"
  | "ay"
  | "az"
>;
/** Actual observed course. This intentionally does not apply the middle-plane shape calibration. */
export function observedPitchLocation(row: Input) {
  const { crossPlateX: x, crossPlateY: y, y0, z0, vy0, vz0, ay, az } = row;
  const zone = resolveBatterStrikeZone(row.season, row.batterHeightCm);
  if (zone === null) return null;
  const { bottomFeet, topFeet } = zone;
  if (
    !row.supported ||
    row.trackingId === null ||
    row.inZone === null ||
    x === null ||
    y === null ||
    y0 === null ||
    z0 === null ||
    vy0 === null ||
    vz0 === null ||
    ay === null ||
    az === null ||
    ![x, y, y0, z0, vy0, vz0, ay, az, bottomFeet, topFeet].every(Number.isFinite) ||
    Math.abs(y0 - 50) > 1e-6 ||
    bottomFeet < 0 ||
    topFeet <= bottomFeet ||
    y < 0
  )
    return null;
  const crossingSeconds = crossingTime(y0 - y, vy0, ay);
  if (crossingSeconds === null) return null;
  const z = z0 + vz0 * crossingSeconds + (az * crossingSeconds ** 2) / 2;
  const normalizedX = x / STRIKE_ZONE_HALF_WIDTH_FEET,
    normalizedZ = (z - (bottomFeet + topFeet) / 2) / ((topFeet - bottomFeet) / 2);
  if (z < 0 || ![normalizedX, normalizedZ, x * 30.48, z * 30.48].every(Number.isFinite))
    return null;
  const bin = (value: number) => {
    const index = [-1, -1 / 3, 1 / 3, 1].findIndex((c) => value < c);
    return index < 0 ? 4 : index;
  };
  return {
    xFeet: x,
    zFeet: z,
    xCm: x * 30.48,
    zCm: z * 30.48,
    normalizedX,
    normalizedZ,
    crossingSeconds,
    bottomFeet,
    topFeet,
    inZone: row.inZone,
    cell: bin(normalizedZ) * 5 + bin(normalizedX),
  };
}
