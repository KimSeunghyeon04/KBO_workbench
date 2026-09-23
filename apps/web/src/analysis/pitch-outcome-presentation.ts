export const outcomePercent = (value: number | null): string =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;

const groupLabels: Readonly<Record<string, string>> = {
  all: "전체",
  L: "좌타석",
  R: "우타석",
  S: "양타석",
  unknown: "미상",
};
export function outcomeGroupLabel(key: string): string {
  return groupLabels[key] ?? key;
}
