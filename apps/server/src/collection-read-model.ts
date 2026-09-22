import {
  compareCanonicalStrings,
  type CollectionCounts,
  type CollectionDateRange,
  type CollectionGameSummary,
  type CollectionScheduleEntry,
  type CollectionItemResult,
  type GameCatalogItem,
} from "@kbo/contracts";
import { InvalidCollectionRequestError } from "./jobs/collection-job-manager.js";

export function assertCollectionRange(
  range: CollectionDateRange,
  parent?: CollectionDateRange,
): void {
  for (const value of [range.startDate, range.endDate]) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new InvalidCollectionRequestError("실재하는 날짜를 입력해야 합니다.");
    }
  }
  if (
    range.startDate > range.endDate ||
    (parent !== undefined && (range.startDate < parent.startDate || range.endDate > parent.endDate))
  ) {
    throw new InvalidCollectionRequestError("선택 범위 안의 날짜를 지정해야 합니다.");
  }
}

/** Display summaries only: neither ledger hydration nor compilation belongs in this read path. */
export function collectionInventory(
  schedule: readonly CollectionScheduleEntry[],
  workspace: readonly GameCatalogItem[],
  database: readonly GameCatalogItem[],
  known: readonly CollectionItemResult[] = [],
): CollectionGameSummary[] {
  const games = new Map<string, CollectionGameSummary>();
  const knownGames = new Map(known.map((game) => [game.gameId, game]));
  for (const entry of schedule)
    games.set(entry.gameId, {
      ...entry,
      state: "uncollected",
      databaseRevision: null,
      workspace: null,
      updatedAt: null,
      blockingFindings: 0,
      warningFindings: 0,
    });
  for (const item of [...database, ...workspace]) {
    const previous = games.get(item.gameId);
    const remembered = knownGames.get(item.gameId);
    games.set(item.gameId, {
      gameId: item.gameId,
      gameDate:
        item.authority === "source_failure"
          ? (previous?.gameDate ?? remembered?.gameDate ?? null)
          : item.gameDate,
      label:
        item.authority === "source_failure"
          ? (previous?.label ?? remembered?.label ?? item.gameId)
          : `${item.teams.away.name} vs ${item.teams.home.name}`,
      scheduledAt: previous?.scheduledAt ?? null,
      state: item.authority,
      databaseRevision:
        item.authority === "database" ? item.currentRevision : (previous?.databaseRevision ?? null),
      workspace: item.authority === "database" ? null : item,
      updatedAt: item.updatedAt,
      blockingFindings: item.blockingFindings,
      warningFindings: item.warningFindings,
    });
  }
  return [...games.values()].sort(
    (a, b) =>
      compareCanonicalStrings(a.gameDate ?? "", b.gameDate ?? "") ||
      compareCanonicalStrings(a.scheduledAt ?? "", b.scheduledAt ?? "") ||
      compareCanonicalStrings(a.gameId, b.gameId),
  );
}

export function inCollectionRange(
  game: CollectionGameSummary,
  range: CollectionDateRange,
): boolean {
  return (
    game.gameDate !== null && game.gameDate >= range.startDate && game.gameDate <= range.endDate
  );
}

export function collectionCounts(
  games: readonly CollectionGameSummary[],
  complete: boolean,
): CollectionCounts {
  const counts: CollectionCounts = {
    total: games.length,
    uncollected: complete ? 0 : null,
    staging: 0,
    quarantine: 0,
    source_failure: 0,
    database: 0,
  };
  for (const game of games) {
    if (game.state === "uncollected") {
      if (counts.uncollected !== null) counts.uncollected += 1;
    } else if (game.state !== "database") counts[game.state] += 1;
    if (game.databaseRevision !== null) counts.database += 1;
  }
  return counts;
}

export function pageOf<T>(
  items: readonly T[],
  page = 1,
  limit = 50,
): { items: T[]; total: number; page: number; limit: number } {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new InvalidCollectionRequestError("페이지는 1 이상, 페이지 크기는 1~200이어야 합니다.");
  }
  return { items: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit };
}
