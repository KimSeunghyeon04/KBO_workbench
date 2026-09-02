import { describe, expect, it } from "vitest";

import type { GameCatalogItem } from "@kbo/contracts";

import {
  calendarDays,
  catalogDateCounts,
  catalogGameIdentity,
  catalogMonths,
  catalogSeasons,
  filterStoredGames,
} from "../../apps/web/src/replay/catalog.js";

describe("replay 경기 catalog 모델", () => {
  const validGame = game("anon-game-a", 2026, "2026-08-30", "원정 A", "홈 B");
  const games = [
    validGame,
    game("anon-game-b", 2026, "2026-08-30", "원정 C", "홈 D"),
    game("anon-game-c", 2025, "2025-07-01", "원정 A", "홈 B"),
    game("nonstandard-id", 2026, "2026-09-01", "원정 E", "홈 F"),
  ];

  it("시즌·월·날짜 집계를 같은 game ID 해석 규칙에서 계산한다", () => {
    expect(catalogSeasons(games)).toEqual([2026, 2025]);
    expect(catalogMonths(games, "all")).toEqual(["2025-07", "2026-08", "2026-09"]);
    expect([...catalogDateCounts(games, "2026")]).toEqual([
      ["2026-08-30", 2],
      ["2026-09-01", 1],
    ]);
  });

  it("검색, 시즌, 팀 이름과 날짜 조건을 합성한다", () => {
    expect(filterStoredGames(games, "홈 B", "all", null)).toEqual([games[0], games[2]]);
    expect(filterStoredGames(games, "", "2026", "2026-08-30")).toEqual([games[0], games[1]]);
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
