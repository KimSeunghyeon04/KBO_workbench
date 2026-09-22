import type { PitchAnalysisPoint } from "@kbo/contracts";

export type ColorMode = "provider" | "cluster";
const colors = [
  "#2878bd",
  "#cf6630",
  "#258568",
  "#a650a1",
  "#b39424",
  "#6976b5",
  "#9b6150",
  "#288e98",
];
export function groupLabel(point: PitchAnalysisPoint, mode: ColorMode): string {
  return mode === "provider"
    ? (point.pitchType ?? "구종 미상")
    : point.clusterId === null
      ? "미배정"
      : `클러스터 ${point.clusterId}`;
}
export function pointColor(
  point: PitchAnalysisPoint,
  mode: ColorMode,
  types: readonly string[],
): string {
  if (mode === "cluster" && point.clusterId === null) return "#8b9690";
  const index =
    mode === "cluster" ? (point.clusterId ?? 1) - 1 : types.indexOf(point.pitchType ?? "구종 미상");
  return colors[Math.max(0, index)] ?? `hsl(${(index * 137.508) % 360} 55% 42%)`;
}
