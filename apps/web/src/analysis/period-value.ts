import type { PeriodMetric } from "@kbo/contracts";
export const formatPeriodValue = (
  value: number | null,
  unit: PeriodMetric["unit"],
  difference = false,
) => {
  if (value === null) return "—";
  const sign = difference && value > 0 ? "+" : "";
  if (unit === "rate") return `${sign}${(value * 100).toFixed(1)}${difference ? "%p" : "%"}`;
  if (unit === "outs")
    return difference
      ? `${sign}${value}아웃`
      : `${Math.floor(value / 3)}${value % 3 === 0 ? "" : ` ${value % 3}/3`}`;
  return `${sign}${unit === "number" ? value.toLocaleString("ko-KR", { maximumFractionDigits: 3 }) : value.toFixed(2)}${unit === "number" ? "" : ` ${unit}`}`;
};
