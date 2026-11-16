import type { PitcherChangesResponse } from "@kbo/contracts";

export type PitchChangeMetric = PitcherChangesResponse["changes"][number]["metrics"][number];
export type PitchChangeMetricKey = PitchChangeMetric["metric"];

export const pitchChangeMetrics: Record<PitchChangeMetricKey, { label: string; unit: string }> = {
  speedKph: { label: "구속", unit: "km/h" },
  usage: { label: "사용률", unit: "%" },
  xCm: { label: "보정 가로", unit: "cm" },
  zCm: { label: "보정 세로", unit: "cm" },
  arrivalMs: { label: "보정 도착 시간", unit: "ms" },
};

export const pitchChangeDescriptions: Record<PitchChangeMetricKey, string> = {
  speedKph: "원천 구속의 평균입니다. 차이가 +면 최근이 더 빠르고, −면 더 느립니다.",
  usage: "구종 투구 수 / 전체 실제 투구 수입니다. 차이는 최근−이전의 퍼센트포인트(%p)입니다.",
  xCm: "출발 위치·방향을 맞추고, 같은 시즌·대회에서 분석 종료일까지의 평균 직구가 도착하는 순간을 비교합니다. 평균 직구를 0으로 한 가로 상대 위치이며 +는 원천 +x 방향(구질 그래프의 가로축 +), −는 반대입니다. 차이는 최근−이전입니다. 실제 투구 코스나 IVB가 아닙니다.",
  zCm: "출발 위치·방향을 맞추고, 같은 시즌·대회에서 분석 종료일까지의 평균 직구가 도착하는 순간을 비교합니다. 평균 직구를 0으로 한 세로 상대 위치이며 +는 위, −는 아래입니다. 차이가 −면 최근의 상대 위치가 이전보다 아래라는 뜻입니다. 실제 투구 높이나 IVB가 아닙니다.",
  arrivalMs:
    "50ft 지점에서 홈플레이트 중간면까지 보정된 궤적의 도착 시간입니다. 직구와의 시간차가 아닌 소요 시간이며, 최근−이전의 차이가 +면 더 늦게 도착합니다.",
};

export function formatPitchChange(
  metric: PitchChangeMetricKey,
  value: number | null,
  difference = false,
): string {
  if (value === null) return "—";
  const scaled = metric === "usage" ? value * 100 : value;
  const decimals = metric === "usage" ? 1 : 2;
  const rounded = Number(scaled.toFixed(decimals));
  const unit = metric === "usage" && difference ? "%p" : pitchChangeMetrics[metric].unit;
  return `${difference && rounded > 0 ? "+" : ""}${rounded.toFixed(decimals)}${unit}`;
}

export function pitchChangeInterval(metric: PitchChangeMetric): string {
  if (metric.status === "unavailable") return "비교 자료 없음";
  if (metric.status === "small_sample") return "소표본 · 구간 미산출";
  if (metric.lower === null || metric.upper === null) return "구간 미확인";
  return `${formatPitchChange(metric.metric, metric.lower, true)} ~ ${formatPitchChange(metric.metric, metric.upper, true)}`;
}

export function pitchChangeInterpretation(metric: PitchChangeMetric): string {
  if (metric.difference === null || metric.status === "unavailable") return "비교 자료 없음";
  if (metric.status === "small_sample") return "소표본 · 판단 보류";
  if (metric.lower === null || metric.upper === null) return "구간 미확인 · 판단 보류";
  if (metric.lower > 0) return "관측 증가";
  if (metric.upper < 0) return "관측 감소";
  return "변화 방향 불확실";
}
