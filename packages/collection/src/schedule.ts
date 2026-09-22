import { chromium, type Browser, type BrowserContext } from "playwright";

import {
  CollectionCancelledError,
  NaverHttpError,
  NaverSourceFormatError,
  NaverTransportError,
  throwIfCancelled,
} from "./errors.js";
import { NaverEndpoints } from "./endpoints.js";
import type { ScheduleEntry } from "./types.js";

const maxScheduleGames = 50_000;
const pageSize = 500;

export interface SchedulePagePayload {
  readonly status: number;
  readonly url: string;
  readonly payload: unknown;
}

export type SchedulePageFetcher = (
  startDate: string,
  endDate: string,
  page: number,
  signal: AbortSignal,
) => Promise<SchedulePagePayload>;

export type SchedulePageObserver = (page: number, response: SchedulePagePayload) => Promise<void>;

export class PlaywrightScheduleExplorer {
  public constructor(
    private readonly fetchPage?: SchedulePageFetcher,
    private readonly endpoints = new NaverEndpoints(),
  ) {}

  public async discoverRange(
    startDate: string,
    endDate: string,
    signal: AbortSignal,
    observePage?: SchedulePageObserver,
  ): Promise<readonly ScheduleEntry[]> {
    assertDateRange(startDate, endDate);
    if (this.fetchPage !== undefined) {
      return discoverPages(startDate, endDate, signal, this.fetchPage, observePage);
    }

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    const closeOnAbort = (): void => {
      void context?.close().catch(() => undefined);
      void browser?.close().catch(() => undefined);
    };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      throwIfCancelled(signal);
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ locale: "ko-KR" });
      context.setDefaultTimeout(15_000);
      const page = await context.newPage();
      await page.goto(
        `https://m.sports.naver.com/kbaseball/schedule/index?date=${encodeURIComponent(startDate)}`,
        { waitUntil: "domcontentloaded", timeout: 20_000 },
      );
      const request = context.request;
      return await discoverPages(
        startDate,
        endDate,
        signal,
        async (from, to, pageNumber) => {
          throwIfCancelled(signal);
          const response = await request.get(this.endpoints.schedule(), {
            params: {
              fields: "basic,schedule,baseball,manualRelayUrl",
              upperCategoryId: "kbaseball",
              categoryIds: "kbo",
              fromDate: from,
              toDate: to,
              size: pageSize,
              page: pageNumber,
            },
            timeout: 20_000,
          });
          return { status: response.status(), url: response.url(), payload: await response.json() };
        },
        observePage,
      );
    } catch (error: unknown) {
      if (signal.aborted || error instanceof CollectionCancelledError) {
        throw new CollectionCancelledError();
      }
      if (error instanceof NaverHttpError || error instanceof NaverSourceFormatError) throw error;
      throw new NaverTransportError("Playwright 일정 탐색에 실패했습니다.", error);
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}

export async function discoverPages(
  startDate: string,
  endDate: string,
  signal: AbortSignal,
  fetchPage: SchedulePageFetcher,
  observePage?: SchedulePageObserver,
): Promise<readonly ScheduleEntry[]> {
  assertDateRange(startDate, endDate);
  const found: ScheduleEntry[] = [];
  let total: number | null = null;
  let fetched = 0;
  for (let page = 1; total === null || fetched < total; page += 1) {
    throwIfCancelled(signal);
    const response = await fetchPage(startDate, endDate, page, signal);
    await observePage?.(page, response);
    if (response.status !== 200) throw new NaverHttpError(response.status);
    const parsed = parseSchedulePayload(response.payload, startDate, endDate);
    if (total === null) total = parsed.total;
    else if (total !== parsed.total) {
      throw new NaverSourceFormatError("일정 pagination 중 gameTotalCount가 변경되었습니다.");
    }
    if (parsed.pageCount === 0 && fetched < total) {
      throw new NaverSourceFormatError("gameTotalCount 전에 일정 page가 끝났습니다.");
    }
    fetched += parsed.pageCount;
    if (fetched > total) {
      throw new NaverSourceFormatError("일정 경기 수가 gameTotalCount보다 많습니다.");
    }
    found.push(...parsed.games);
  }
  const unique = new Map<string, ScheduleEntry>();
  for (const entry of found.sort(compareScheduleEntries)) unique.set(entry.gameId, entry);
  return [...unique.values()];
}

export function parseSchedulePayload(
  payload: unknown,
  startDate: string,
  endDate: string,
): {
  readonly games: readonly ScheduleEntry[];
  readonly total: number;
  readonly pageCount: number;
} {
  const root = asRecord(payload, "일정 응답");
  if (root.code !== 200 || root.success !== true) {
    throw new NaverSourceFormatError("일정 응답이 실패 상태입니다.");
  }
  const result = asRecord(root.result, "일정 result");
  if (!Array.isArray(result.games) || result.games.some((game) => !isRecord(game))) {
    throw new NaverSourceFormatError("일정 games는 객체 배열이어야 합니다.");
  }
  const total = result.gameTotalCount;
  if (!Number.isInteger(total) || (total as number) < 0 || (total as number) > maxScheduleGames) {
    throw new NaverSourceFormatError("일정 gameTotalCount가 올바르지 않습니다.");
  }
  const games = (result.games as Array<Readonly<Record<string, unknown>>>)
    .filter((game) => requestedGame(game, startDate, endDate))
    .map(parseScheduleGame);
  return { games, total: total as number, pageCount: result.games.length };
}

function requestedGame(
  game: Readonly<Record<string, unknown>>,
  startDate: string,
  endDate: string,
): boolean {
  if (game.categoryId !== "kbo" || game.statusCode !== "RESULT" || game.cancel !== false)
    return false;
  const date = requiredString(game.gameDate, "gameDate");
  return date >= startDate && date <= endDate;
}

function parseScheduleGame(game: Readonly<Record<string, unknown>>): ScheduleEntry {
  const gameId = requiredString(game.gameId, "gameId");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(gameId)) {
    throw new NaverSourceFormatError("일정 gameId 형식이 올바르지 않습니다.");
  }
  const gameDate = requiredString(game.gameDate, "gameDate");
  const dateTime = requiredString(game.gameDateTime, "gameDateTime");
  const away = nullableString(game.awayTeamName);
  const home = nullableString(game.homeTeamName);
  return {
    gameId,
    gameDate,
    scheduledAt: /(?:Z|[+-]\d{2}:\d{2})$/.test(dateTime) ? dateTime : `${dateTime}+09:00`,
    label: away !== null && home !== null ? `${away} 대 ${home}` : gameId,
  };
}

function assertDateRange(startDate: string, endDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new NaverSourceFormatError("일정 범위는 ISO 날짜여야 합니다.");
  }
  if (endDate < startDate) throw new NaverSourceFormatError("종료일이 시작일보다 빠릅니다.");
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (
    start.toISOString().slice(0, 10) !== startDate ||
    end.toISOString().slice(0, 10) !== endDate
  ) {
    throw new NaverSourceFormatError("실재하는 일정 날짜가 아닙니다.");
  }
}

function compareScheduleEntries(left: ScheduleEntry, right: ScheduleEntry): number {
  return (
    compareText(left.gameDate, right.gameDate) ||
    compareText(left.scheduledAt, right.scheduledAt) ||
    compareText(left.gameId, right.gameId)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new NaverSourceFormatError(`${label}은 객체여야 합니다.`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new NaverSourceFormatError(`일정 ${field}는 문자열이어야 합니다.`);
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
