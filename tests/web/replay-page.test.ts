// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReplayFrame, ReplayManifest, ReplayState } from "@kbo/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ReplayPage } from "../../apps/web/src/pages/replay-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("경기 재생 UI", () => {
  it("달력에서 날짜를 선택해 해당 날짜의 DB 경기만 좁힌다", async () => {
    vi.stubGlobal("fetch", calendarFetchMock());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const user = userEvent.setup();
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(QueryClientProvider, { client: queryClient }, createElement(ReplayPage)),
      ),
    );

    const august30 = await screen.findByRole("button", {
      name: "2026년 8월 30일, 경기 2개",
    });
    expect(screen.queryByRole("button", { name: /9999년/ })).toBeNull();
    await user.click(august30);
    expect(screen.getByText("검색 결과 2 / 5")).toBeTruthy();
    expect(
      within(screen.getByRole("listbox", { name: "DB 경기 목록" })).getAllByRole("option"),
    ).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "전체 날짜 보기" }));
    expect(screen.getByText("검색 결과 5 / 5")).toBeTruthy();
    await user.click(
      within(screen.getByRole("group", { name: "시즌 필터" })).getByRole("button", {
        name: /^2025/,
      }),
    );
    expect(await screen.findByRole("button", { name: "2025년 7월 1일, 경기 1개" })).toBeTruthy();
    expect(screen.getByText("검색 결과 1 / 5")).toBeTruthy();
    queryClient.clear();
  });

  it("경기를 검색하고 typed movement, 상태, tracking과 재생 경계를 표시한다", async () => {
    vi.stubGlobal("fetch", replayFetchMock());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const user = userEvent.setup();
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(QueryClientProvider, { client: queryClient }, createElement(ReplayPage)),
      ),
    );

    const search = await screen.findByPlaceholderText("게임 ID 또는 시즌");
    await user.type(search, "2025");
    expect(screen.getByText("검색 결과 1 / 2")).toBeTruthy();
    const game2025 = screen.getByRole("option", { name: /anon-game-2025/ });
    await user.click(game2025);
    expect(game2025.getAttribute("aria-selected")).toBe("true");
    await user.clear(search);
    expect(screen.getByText("검색 결과 2 / 2")).toBeTruthy();
    await user.click(
      within(screen.getByRole("group", { name: "시즌 필터" })).getByRole("button", {
        name: /^2025/,
      }),
    );
    expect(screen.getByText("검색 결과 1 / 2")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /anon-game-2026/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^전체/ }));
    const game2026 = screen.getByRole("option", { name: /anon-game-2026/ });
    await user.click(game2026);
    expect(game2026.getAttribute("aria-selected")).toBe("true");

    const loadButton = await screen.findByRole("button", { name: "선택 경기 재생" });
    await screen.findByRole("option", { name: "1 · current" });
    await user.click(loadButton);

    expect(await screen.findByText(/원장 기록/)).toBeTruthy();
    expect(screen.queryByPlaceholderText("게임 ID 또는 시즌")).toBeNull();
    await user.click(screen.getByRole("button", { name: "경기 변경" }));
    const reopenedSearch = screen.getByPlaceholderText("게임 ID 또는 시즌");
    expect(reopenedSearch).toBeTruthy();
    expect(document.activeElement).toBe(reopenedSearch);
    await user.click(screen.getByRole("button", { name: "선택 닫기" }));
    expect(screen.queryByPlaceholderText("게임 ID 또는 시즌")).toBeNull();
    expect(screen.getByRole("img", { name: "비식별 주자: 타석에서 1루, 세이프" })).toBeTruthy();
    expect(
      screen.getByRole("img", { name: /1루 비식별 주자, 책임 투수 비식별 투수/ }),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: /수비 배치: 유격수 비식별 유격수/ })).toBeTruthy();
    expect(screen.getByText("비식별 유격수")).toBeTruthy();
    const strikeZone = screen.getByRole("img", { name: /홈플레이트 통과 위치/ });
    expect(strikeZone).toBeTruthy();
    const centerLine = strikeZone.querySelector("line");
    const pitchPoint = strikeZone.querySelector("circle");
    expect(Number(pitchPoint?.getAttribute("cx"))).toBeGreaterThan(
      Number(centerLine?.getAttribute("x1")),
    );
    expect(screen.getByRole("img", { name: "볼 0, 스트라이크 0, 아웃 0" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "재생 위치" }).getAttribute("aria-valuetext")).toBe(
      "1 / 2",
    );

    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(screen.getAllByText("1구 스트라이크")).toHaveLength(2);
    expect(
      screen.getByText("좌표 metric이 완전하지 않아 스트라이크존을 표시하지 않습니다."),
    ).toBeTruthy();
    expect(screen.getByRole("slider", { name: "재생 위치" }).getAttribute("aria-valuetext")).toBe(
      "2 / 2",
    );
    expect(screen.getByRole("button", { name: "끝" }).getAttribute("disabled")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "재생", exact: true }));
    expect(screen.getByRole("button", { name: "일시정지" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("img", { name: "비식별 주자: 타석에서 1루, 세이프" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "일시정지" }));
    expect(screen.getByRole("button", { name: "재생", exact: true })).toBeTruthy();

    expect(screen.getAllByText("비식별 타자 : 안타")).toHaveLength(1);
    expect(screen.getAllByText("비식별 주자 : 1루까지 진루")).toHaveLength(1);
    queryClient.clear();
  });
});

function calendarFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/api/v2/games") {
      return Response.json({
        games: [
          catalogGame("20260830AABB02026", 2026, "2026-08-30"),
          catalogGame("20260830CCDD02026", 2026, "2026-08-30"),
          catalogGame("20260831EEFF02026", 2026, "2026-08-31"),
          catalogGame("20250701AABB02025", 2025, "2025-07-01"),
          catalogGame("99990706WEEA02026", 2026, "2026-07-06"),
        ],
      });
    }
    if (path.endsWith("/revisions")) {
      const gameId = path.split("/").at(-2) ?? "";
      return Response.json({
        gameId,
        currentRevision: 1,
        revisions: [
          {
            revision: 1,
            documentHash: "f".repeat(64),
            projectionHash: "0".repeat(64),
            sealed: true,
            createdAt: "2026-08-30T00:00:00.000Z",
            sealedAt: "2026-08-30T00:00:01.000Z",
            original: true,
            current: true,
          },
        ],
      });
    }
    throw new Error(`unexpected request: ${path}`);
  });
}

function replayFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/api/v2/games") {
      return Response.json({
        games: [
          catalogGame("anon-game-2026", 2026, "2026-08-30"),
          catalogGame("anon-game-2025", 2025, "2025-07-01"),
          {
            gameId: "anon-staging",
            season: 2026,
            authority: "staging",
            gameDate: "2026-08-30",
            teams: {
              away: { teamId: "away", name: "비식별 원정" },
              home: { teamId: "home", name: "비식별 홈" },
            },
            updatedAt: "2026-08-30T00:00:00.000Z",
            blockingFindings: 0,
            warningFindings: 0,
            supersededCount: 0,
          },
        ],
      });
    }
    if (path === "/api/v2/games/anon-game-2026/revisions") {
      return Response.json({
        gameId: "anon-game-2026",
        currentRevision: 1,
        revisions: [
          {
            revision: 1,
            documentHash: "a".repeat(64),
            projectionHash: "b".repeat(64),
            sealed: true,
            createdAt: "2026-08-30T00:00:00.000Z",
            sealedAt: "2026-08-30T00:00:01.000Z",
            original: true,
            current: true,
          },
        ],
      });
    }
    if (path === "/api/v2/games/anon-game-2025/revisions") {
      return Response.json({
        gameId: "anon-game-2025",
        currentRevision: 1,
        revisions: [
          {
            revision: 1,
            documentHash: "d".repeat(64),
            projectionHash: "e".repeat(64),
            sealed: true,
            createdAt: "2026-08-30T00:00:00.000Z",
            sealedAt: "2026-08-30T00:00:01.000Z",
            original: true,
            current: true,
          },
        ],
      });
    }
    if (path.endsWith("/replay-manifest")) return Response.json(manifest());
    if (path.includes("/replay-frames?")) {
      return Response.json({
        gameId: "anon-game-2026",
        revision: 1,
        documentHash: "a".repeat(64),
        frameHash: "c".repeat(64),
        startIndex: 0,
        frames: frames(),
        nextCursor: null,
      });
    }
    throw new Error(`unexpected request: ${path}`);
  });
}

function catalogGame(gameId: string, season: number, gameDate: string) {
  return {
    gameId,
    season,
    authority: "database" as const,
    gameDate,
    teams: {
      away: { teamId: "away", name: "비식별 원정" },
      home: { teamId: "home", name: "비식별 홈" },
    },
    currentRevision: 1,
    revisionCount: 1,
    updatedAt: "2026-08-30T00:00:00.000Z",
    blockingFindings: 0,
    warningFindings: 0,
  };
}

function manifest(): ReplayManifest {
  return {
    schemaVersion: 2,
    gameId: "anon-game-2026",
    revision: 1,
    documentHash: "a".repeat(64),
    projectionHash: "b".repeat(64),
    frameHash: "c".repeat(64),
    frameCount: 2,
    trackingCount: 2,
    gameDate: "2026-08-30",
    status: "final",
    teams: {
      away: { teamId: "away", name: "비식별 원정" },
      home: { teamId: "home", name: "비식별 홈" },
    },
    finalState: pitchState(),
    unlinkedTracking: [],
    blockingCount: 0,
    warningCount: 0,
    defaultChunkSize: 250,
  };
}

function frames(): ReplayFrame[] {
  const before = emptyState();
  const after = runnerState();
  return [
    {
      gameId: "anon-game-2026",
      revision: 1,
      playId: "play-1",
      playNumber: 1,
      sequence: 0,
      kind: "plate_result",
      inning: 1,
      half: "top",
      applied: true,
      relayEvents: [
        {
          eventId: "event-1",
          sequence: 0,
          kind: "plate_result",
          relayText: "비식별 타자 : 안타",
        },
        {
          eventId: "event-2",
          sequence: 1,
          kind: "runner_advance",
          relayText: "비식별 주자 : 1루까지 진루",
        },
      ],
      before,
      after,
      movements: [
        {
          movementId: "movement-1",
          sourceEventId: "event-2",
          runner: { playerId: "runner-1", name: "비식별 주자" },
          fromBase: 0,
          toBase: 1,
          outcome: "safe",
          outKind: null,
          supersedesThirdOut: null,
          responsiblePitcher: { playerId: "pitcher-1", name: "비식별 투수" },
          derived: false,
          sequence: 1,
        },
      ],
      fielders: [
        {
          side: "home",
          player: { playerId: "fielder-1", name: "비식별 유격수" },
          battingOrder: 1,
          positions: ["유격수"],
        },
      ],
      plateAppearance: null,
      tracking: [validTracking()],
    },
    {
      gameId: "anon-game-2026",
      revision: 1,
      playId: "play-2",
      playNumber: 2,
      sequence: 2,
      kind: "pitch",
      inning: 1,
      half: "top",
      applied: true,
      relayEvents: [
        {
          eventId: "event-3",
          sequence: 2,
          kind: "pitch",
          relayText: "1구 스트라이크",
        },
      ],
      before: after,
      after: pitchState(),
      movements: [],
      fielders: [],
      plateAppearance: pitchState().plateAppearance,
      tracking: [
        {
          ...validTracking(),
          trackingId: "tracking-2",
          vx0: -145,
          crossPlateY: null,
        },
      ],
    },
  ];
}

function emptyState(): ReplayState {
  return {
    inning: 1,
    half: "top",
    halfActive: true,
    balls: 0,
    strikes: 0,
    outs: 0,
    bases: [null, null, null],
    awayScore: 0,
    homeScore: 0,
    batter: null,
    pitcher: { playerId: "pitcher-1", name: "비식별 투수" },
    activePitchers: {
      away: { playerId: "pitcher-2", name: "비식별 원정 투수" },
      home: { playerId: "pitcher-1", name: "비식별 투수" },
    },
    plateAppearance: null,
  };
}

function runnerState(): ReplayState {
  return {
    ...emptyState(),
    bases: [
      {
        runner: { playerId: "runner-1", name: "비식별 주자" },
        responsiblePitcher: { playerId: "pitcher-1", name: "비식별 투수" },
      },
      null,
      null,
    ],
  };
}

function pitchState(): ReplayState {
  return {
    ...runnerState(),
    strikes: 1,
    batter: { playerId: "batter-2", name: "비식별 타자 2" },
    plateAppearance: {
      startEventId: "event-pa-2",
      batter: { playerId: "batter-2", name: "비식별 타자 2" },
      pitcher: { playerId: "pitcher-1", name: "비식별 투수" },
      actualPitchCount: 1,
    },
  };
}

function validTracking() {
  return {
    trackingId: "tracking-1",
    sourcePitchId: "source-pitch-1",
    pitchEventId: "event-1",
    sourcePitchOrdinal: 1,
    sequence: 0,
    pitcher: { playerId: "pitcher-1", name: "비식별 투수" },
    batter: { playerId: "batter-1", name: "비식별 타자" },
    observedAt: "2026-08-30T00:00:00.000Z",
    stance: "R" as const,
    x0: null,
    y0: 50,
    z0: 5.78675,
    vx0: null,
    vy0: -129.265,
    vz0: -4.59198,
    ax: null,
    ay: 23.8626,
    az: -16.4274,
    crossPlateX: 0.8,
    crossPlateY: 0.7083,
    topSz: 3.067,
    bottomSz: 1.504,
  };
}
