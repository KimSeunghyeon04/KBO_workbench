import type { CollectionDateRange, CollectionGameState } from "@kbo/contracts";

export const collectionNavigationKey = "kbo.collection.navigation.v1";
export function koreaToday(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function validDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function readRange(params: URLSearchParams, today = koreaToday()): CollectionDateRange {
  const startDate = params.get("start"),
    endDate = params.get("end");
  return validDate(startDate) && validDate(endDate) && startDate <= endDate
    ? { startDate, endDate }
    : { startDate: today, endDate: today };
}
export function readLocation(
  params: URLSearchParams,
  range: CollectionDateRange,
): CollectionDateRange {
  const startDate = params.get("from"),
    endDate = params.get("to");
  return validDate(startDate) &&
    validDate(endDate) &&
    startDate <= endDate &&
    startDate >= range.startDate &&
    endDate <= range.endDate
    ? { startDate, endDate }
    : range;
}
export function collectionLevel(range: CollectionDateRange): "month" | "day" | "games" {
  return range.startDate === range.endDate
    ? "games"
    : range.startDate.slice(0, 7) === range.endDate.slice(0, 7)
      ? "day"
      : "month";
}
export function restoredParams(
  url: URLSearchParams,
  saved: string | null,
  today = koreaToday(),
): URLSearchParams {
  const params = url.size > 0 ? new URLSearchParams(url) : new URLSearchParams(saved ?? "");
  const range = readRange(params, today);
  params.set("start", range.startDate);
  params.set("end", range.endDate);
  const location = readLocation(params, range);
  params.set("from", location.startDate);
  params.set("to", location.endDate);
  return params;
}
export function positivePage(value: string | null): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}
export function gameState(value: string | null): CollectionGameState | undefined {
  return value === "uncollected" ||
    value === "staging" ||
    value === "quarantine" ||
    value === "source_failure" ||
    value === "database"
    ? value
    : undefined;
}
export const storageLabel = {
  uncollected: "미수집",
  staging: "적재 가능",
  quarantine: "검토 필요",
  source_failure: "원천 실패",
  database: "DB 저장",
};
export const outcomeLabel = {
  ready: "성공",
  quarantined: "검토 필요",
  source_failure: "원천 실패",
  unchanged: "변경 없음",
  skipped: "건너뜀",
  interrupted: "중단",
};
export const jobStatusLabel = {
  queued: "대기",
  running: "수집 중",
  cancelling: "중단 중",
  cancelled: "중단",
  failed: "중단",
  succeeded: "완료",
};
export function rangeLabel(range: CollectionDateRange): string {
  return range.startDate === range.endDate
    ? range.startDate
    : `${range.startDate} ~ ${range.endDate}`;
}
export function dateTimeLabel(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}
