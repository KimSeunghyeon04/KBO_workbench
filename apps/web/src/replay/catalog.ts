import type { GameCatalogItem } from "@kbo/contracts";

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

export function filterStoredGames(
  games: readonly GameCatalogItem[],
  search: string,
  seasonFilter: string,
  selectedDate: string | null,
): readonly GameCatalogItem[] {
  const query = search.trim().toLocaleLowerCase("ko-KR");
  return games.filter((game) => {
    if (seasonFilter !== "all" && String(game.season) !== seasonFilter) return false;
    if (selectedDate !== null && catalogGameIdentity(game)?.isoDate !== selectedDate) return false;
    if (query === "") return true;
    return (
      game.gameId.toLocaleLowerCase("ko-KR").includes(query) ||
      (game.season !== null && String(game.season).includes(query)) ||
      (game.authority === "database" &&
        [game.gameDate, game.teams.away.name, game.teams.home.name].some((value) =>
          value.toLocaleLowerCase("ko-KR").includes(query),
        ))
    );
  });
}

export function catalogSeasons(games: readonly GameCatalogItem[]): readonly number[] {
  return [...new Set(games.flatMap((game) => (game.season === null ? [] : [game.season])))].sort(
    (left, right) => right - left,
  );
}

export function catalogMonths(
  games: readonly GameCatalogItem[],
  seasonFilter: string,
): readonly string[] {
  return [
    ...new Set(
      games.flatMap((game) => {
        if (seasonFilter !== "all" && String(game.season) !== seasonFilter) return [];
        const identity = catalogGameIdentity(game);
        return identity === null ? [] : [identity.isoDate.slice(0, 7)];
      }),
    ),
  ].sort();
}

export function catalogDateCounts(
  games: readonly GameCatalogItem[],
  seasonFilter: string,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const game of games) {
    if (seasonFilter !== "all" && String(game.season) !== seasonFilter) continue;
    const identity = catalogGameIdentity(game);
    if (identity === null) continue;
    counts.set(identity.isoDate, (counts.get(identity.isoDate) ?? 0) + 1);
  }
  return counts;
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
