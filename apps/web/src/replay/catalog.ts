import type { GameCatalogItem, ReplayCatalogCalendar } from "@kbo/contracts";

export interface CatalogGameIdentity {
  readonly isoDate: string;
  readonly date: string;
  readonly away: string;
  readonly home: string;
}

export interface CalendarDay {
  readonly isoDate: string;
  readonly day: number;
}

export function summarizeReplayCalendar(calendar: ReplayCatalogCalendar, seasonFilter: string) {
  const seasonCounts = new Map<number, number>();
  const dateCounts = new Map<string, number>();
  let total = 0;
  for (const { season, gameDate, count } of calendar) {
    total += count;
    seasonCounts.set(season, (seasonCounts.get(season) ?? 0) + count);
    if (seasonFilter === "all" || String(season) === seasonFilter) {
      dateCounts.set(gameDate, (dateCounts.get(gameDate) ?? 0) + count);
    }
  }
  return {
    total,
    seasons: [...seasonCounts].sort(([left], [right]) => right - left),
    months: [...new Set([...dateCounts.keys()].map((date) => date.slice(0, 7)))].sort(),
    dateCounts,
  };
}

export function catalogGameTitle(game: GameCatalogItem): string {
  const identity = catalogGameIdentity(game);
  if (identity === null) return game.gameId;
  return `${identity.date} · ${identity.away} vs ${identity.home}`;
}

export function catalogGameIdentity(game: GameCatalogItem): CatalogGameIdentity | null {
  if (game.authority !== "database") return null;
  const [year, month, day] = game.gameDate.split("-");
  if (year === undefined || month === undefined || day === undefined) return null;
  return {
    isoDate: game.gameDate,
    date: `${year}.${month}.${day}`,
    away: game.teams.away.name,
    home: game.teams.home.name,
  };
}

export function calendarDays(month: string): readonly (CalendarDay | null)[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return [];
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (!Number.isInteger(year) || monthNumber < 1 || monthNumber > 12) return [];
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cellCount = Math.ceil((firstWeekday + dayCount) / 7) * 7;
  return Array.from({ length: cellCount }, (_, index) => {
    const day = index - firstWeekday + 1;
    if (day < 1 || day > dayCount) return null;
    return {
      isoDate: `${String(year).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      day,
    };
  });
}

export function formatCalendarMonth(month: string): string {
  const [year, monthNumber] = month.split("-");
  if (year === undefined || monthNumber === undefined) return "날짜 미상";
  return `${year}년 ${String(Number(monthNumber))}월`;
}

export function formatCalendarDate(date: string): string {
  const [year, month, day] = date.split("-");
  if (year === undefined || month === undefined || day === undefined) return date;
  return `${year}년 ${String(Number(month))}월 ${String(Number(day))}일`;
}
