import type { PitchAnalysisPoint, PitchProfile, PitchProfileGroup } from "@kbo/contracts";
interface ActualPitch {
  gameDate: string;
  pitchType: string | null;
  speedKph: number | null;
  swing: boolean;
  whiff: boolean;
}
type Point = Pick<
  PitchAnalysisPoint,
  "gameDate" | "pitchType" | "xCm" | "zCm" | "arrivalMs" | "calibrationStatus"
>;
const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return m === null || xs.length < 2
    ? null
    : Math.sqrt(xs.reduce((n, x) => n + (x - m) ** 2, 0) / (xs.length - 1));
};
function groups(rows: readonly ActualPitch[], points: readonly Point[]): PitchProfileGroup[] {
  return [...new Set(rows.map((r) => r.pitchType))]
    .sort((a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1))
    .map((pitchType) => {
      const actual = rows.filter((r) => r.pitchType === pitchType),
        shapes = points.filter((p) => p.pitchType === pitchType);
      const calibrated = shapes.filter((p) => p.calibrationStatus === "applied");
      const speeds = actual.flatMap((r) =>
        r.speedKph !== null && Number.isFinite(r.speedKph) && r.speedKph > 0 ? [r.speedKph] : [],
      );
      const swings = actual.filter((r) => r.swing).length,
        whiffs = actual.filter((r) => r.whiff).length;
      return {
        pitchType,
        actualPitches: actual.length,
        usageRate: actual.length / rows.length,
        speedCount: speeds.length,
        meanSpeedKph: mean(speeds),
        shapeCount: shapes.length,
        calibratedCount: calibrated.length,
        meanXCm: mean(shapes.map((p) => p.xCm)),
        meanZCm: mean(shapes.map((p) => p.zCm)),
        sdXCm: sd(shapes.map((p) => p.xCm)),
        sdZCm: sd(shapes.map((p) => p.zCm)),
        meanArrivalMs: mean(shapes.map((p) => p.arrivalMs)),
        calibratedXCm: mean(calibrated.map((p) => p.xCm)),
        calibratedZCm: mean(calibrated.map((p) => p.zCm)),
        calibratedArrivalMs: mean(calibrated.map((p) => p.arrivalMs)),
        swings,
        whiffs,
        whiffRate: swings === 0 ? null : whiffs / swings,
      };
    });
}
export function summarizePitchProfile(
  rows: readonly ActualPitch[],
  points: readonly Point[],
): PitchProfile {
  return {
    groups: groups(rows, points),
    months: [...new Set(rows.map((r) => r.gameDate.slice(0, 7)))].sort().map((month) => {
      const actual = rows.filter((r) => r.gameDate.startsWith(month));
      return {
        month,
        actualPitches: actual.length,
        groups: groups(
          actual,
          points.filter((p) => p.gameDate.startsWith(month)),
        ),
      };
    }),
  };
}
