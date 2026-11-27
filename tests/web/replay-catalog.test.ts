import { describe, expect, it } from "vitest";

import type { GameCatalogItem } from "@kbo/contracts";

import {
  calendarDays,
  catalogGameIdentity,
  summarizeReplayCalendar,
} from "../../apps/web/src/replay/catalog.js";

describe("replay 경기 catalog 모델", () => {
  const validGame = game("anon-game-a", 2026, "2026-08-30", "원정 A", "홈 B");
  const calendar = [
    { season: 2026, gameDate: "2026-08-30", count: 2 },
    { season: 2026, gameDate: "2026-09-01", count: 1 },
    { season: 2025, gameDate: "2025-07-01", count: 1 },
  ];

  it("시즌 합계와 달력 건수를 목록 페이지에 상관없이 표시한다", () => {
    expect(summarizeReplayCalendar(calendar, "all")).toMatchObject({
      total: 4,
      seasons: [
        [2026, 3],
        [2025, 1],
      ],
      months: ["2025-07", "2026-08", "2026-09"],
    });
    const filtered = summarizeReplayCalendar(calendar, "2026");
    expect(filtered.months).toEqual(["2026-08", "2026-09"]);
    expect(filtered.total).toBe(4);
    expect([...filtered.dateCounts]).toEqual([
      ["2026-08-30", 2],
      ["2026-09-01", 1],
    ]);
  });

  it("달력 identity는 database catalog의 typed 날짜와 팀을 사용한다", () => {
    expect(catalogGameIdentity(validGame)).toEqual({
      isoDate: "2026-08-30",
      date: "2026.08.30",
      away: "원정 A",
      home: "홈 B",
    });
    expect(
      catalogGameIdentity({ ...validGame, authority: "staging" } as GameCatalogItem),
    ).toBeNull();
  });

  it("월 달력은 일요일 시작 padding과 전체 주 행을 결정적으로 만든다", () => {
    const days = calendarDays("2026-08");
    expect(days).toHaveLength(42);
    expect(days.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(days[6]).toEqual({ isoDate: "2026-08-01", day: 1 });
    expect(days[36]).toEqual({ isoDate: "2026-08-31", day: 31 });
    expect(calendarDays("2026-13")).toEqual([]);
  });
});

function game(
  gameId: string,
  season: number,
  gameDate: string,
  away: string,
  home: string,
): GameCatalogItem {
  return {
    gameId,
    season,
    authority: "database",
    gameDate,
    teams: {
      away: { teamId: `${gameId}-away`, name: away },
      home: { teamId: `${gameId}-home`, name: home },
    },
    currentRevision: 1,
    revisionCount: 1,
    updatedAt: "2026-08-30T00:00:00.000Z",
    blockingFindings: 0,
    warningFindings: 0,
  };
}
