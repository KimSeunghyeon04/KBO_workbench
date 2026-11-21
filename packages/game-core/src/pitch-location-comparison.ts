import type {
  PitchLocationResponse,
  PitchLocationComparisonQuery,
  PitchLocationComparisonResponse,
} from "@kbo/contracts";
import { comparePitchRatePeriods } from "./analysis-period-comparison.js";

export function comparePitchLocations(
  query: PitchLocationComparisonQuery,
  pitcherId: string,
  first: PitchLocationResponse,
  second: PitchLocationResponse,
): PitchLocationComparisonResponse {
  const period = (data: PitchLocationResponse) => ({
    query: data.query,
    scope: data.scope,
    sourceHash: data.sourceHash,
    coverage: data.coverage,
    total: data.total,
    cells: data.cells.map((cell) => ({
      ...cell,
      usageRate:
        data.coverage.locationPitches === 0 ? null : cell.pitches / data.coverage.locationPitches,
    })),
  });
  const a = period(first),
    b = period(second);
  const difference = (x: number | null, y: number | null) =>
    x === null || y === null ? null : y - x;
  return {
    query,
    pitcherId,
    first: a,
    second: b,
    metrics: comparePitchRatePeriods("전체", first.total, second.total),
    differences: a.cells.map((cell, index) => {
      const other = b.cells[index];
      if (other === undefined) throw new Error("Missing comparison location cell");
      return {
        cell: index,
        usageRate: difference(cell.usageRate, other.usageRate),
        whiffRate: difference(cell.whiffRate, other.whiffRate),
        cswRate: difference(cell.cswRate, other.cswRate),
        inPlayHitRate: difference(cell.inPlayHitRate, other.inPlayHitRate),
      };
    }),
  };
}
