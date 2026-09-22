// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DatabasePage } from "../../apps/web/src/pages/database-page.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("데이터베이스 운영 콘솔", () => {
  it("서버가 확정한 선택은 필터 변경에도 유지하고 선택 ID로 한 번만 실행한다", async () => {
    let batchPosted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(input),
        url = new URL(requestPath, "http://localhost");
      if (url.pathname === "/api/v2/database/status") return Response.json(databaseOverview());
      if (url.pathname === "/api/v2/database/games")
        return Response.json({
          games: url.searchParams.get("season") === "2025" ? [] : gameCatalog().games,
          total: url.searchParams.get("season") === "2025" ? 0 : 2,
          page: 1,
          limit: 50,
          seasons: [2026, 2025],
        });
      if (url.pathname === "/api/v2/import-history")
        return Response.json(historyPage(batchPosted ? completedJobs() : []));
      if (url.pathname === "/api/v2/import-selections") {
        expect(JSON.parse(String(init?.body))).toEqual({ season: 2026 });
        return Response.json({
          selectionId: "confirmed-selection",
          count: 2,
          createdAt: "2026-08-30T00:00:00.000Z",
          criteria: { season: 2026 },
        });
      }
      if (url.pathname === "/api/v2/import-jobs/batch") {
        batchPosted = true;
        return Response.json(
          {
            batchId: "anon-batch-1",
            createdCount: 2,
            skippedCount: 0,
            jobs: completedJobs().map((job) => ({
              jobId: job.jobId,
              gameId: job.gameId,
              status: "queued",
            })),
          },
          { status: 202 },
        );
      }
      throw new Error(`unexpected request: ${requestPath}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "anon-batch-idempotency-key" });
    const queryClient = renderDatabase("/database?scope=ready&season=2026");
    const user = userEvent.setup();
    const choose = await screen.findByRole("button", { name: "현재 조건 전체 선택" });
    await waitFor(() => expect((choose as HTMLButtonElement).disabled).toBe(false));
    await user.click(choose);
    await screen.findByRole("button", { name: "2경기 일괄 적재 시작" });
    await user.selectOptions(screen.getByLabelText("시즌"), "2025");
    expect(await screen.findByText("적재할 경기가 없습니다.")).toBeTruthy();
    expect(screen.getByText(/2026 시즌.*2경기 확정/)).toBeTruthy();
    expect(batchRequests(fetchMock)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "2경기 일괄 적재 시작" }));
    expect(await screen.findByText("선택한 일괄 작업")).toBeTruthy();
    expect(await screen.findByText("완료 1")).toBeTruthy();
    expect(screen.getByText("실패 1")).toBeTruthy();
    expect(batchRequests(fetchMock)).toHaveLength(1);
    expect(JSON.parse(String(batchRequests(fetchMock)[0]?.[1]?.body))).toEqual({
      selectionId: "confirmed-selection",
      idempotencyKey: "anon-batch-idempotency-key",
    });
    queryClient.clear();
  });

  it("저장 경기 10,000개를 50개씩 요청하고 시즌 필터에서 빠진 상세를 닫는다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost"),
        page = Number(url.searchParams.get("page") ?? 1);
      if (url.pathname === "/api/v2/database/status")
        return Response.json({
          ...databaseOverview(),
          counts: { readyToImport: 0, stored: 10_000 },
        });
      if (url.pathname === "/api/v2/database/games")
        return Response.json({
          games:
            url.searchParams.get("season") === "2025"
              ? []
              : Array.from({ length: 50 }, (_, index) => databaseGame((page - 1) * 50 + index)),
          total: url.searchParams.get("season") === "2025" ? 0 : 10_000,
          page,
          limit: 50,
          seasons: [2026, 2025],
        });
      if (url.pathname === "/api/v2/import-history") return Response.json(historyPage([]));
      if (url.pathname.endsWith("/revisions"))
        return Response.json({ gameId: "anon-db-000", currentRevision: 2, revisions: [] });
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = renderDatabase("/database?scope=stored");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("option", { name: /anon-db-000/ }));
    expect(await screen.findByRole("button", { name: "current 교정 초안 열기" })).toBeTruthy();
    expect(revisionRequests(fetchMock)).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText("시즌"), "2025");
    expect(await screen.findByText("저장된 경기가 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "current 교정 초안 열기" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("시즌"), "2026");
    await screen.findByRole("option", { name: /anon-db-000/ });
    await user.click(screen.getByRole("button", { name: "다음", exact: true }));
    expect(await screen.findByRole("option", { name: /anon-db-050/ })).toBeTruthy();
    expect(document.querySelectorAll(".operation-list-row").length).toBeLessThan(30);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("page=2&limit=50"))).toBe(
      true,
    );
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/v2/games")).toBe(false);
    queryClient.clear();
  });

  it("적재 기록을 페이지 조회하며 전체 이력을 요청하지 않는다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost"),
        page = Number(url.searchParams.get("page") ?? 1);
      if (url.pathname === "/api/v2/database/status") return Response.json(databaseOverview());
      if (url.pathname === "/api/v2/import-history")
        return Response.json({
          ...historyPage(
            Array.from({ length: 50 }, (_, index) => importJob((page - 1) * 50 + index)),
          ),
          total: 784,
          page,
        });
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = renderDatabase("/database?scope=jobs");
    expect(await screen.findByRole("option", { name: /anon-import-game-000/ })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "다음", exact: true }));
    expect(await screen.findByRole("option", { name: /anon-import-game-050/ })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/v2/import-jobs")).toBe(
      false,
    );
    queryClient.clear();
  });
});
function historyPage(jobs: ReturnType<typeof importJob>[]) {
  return {
    jobs,
    total: jobs.length,
    page: 1,
    limit: 50,
    summary: {
      total: jobs.length,
      queued: 0,
      running: 0,
      succeeded: jobs.filter((job) => job.status === "succeeded").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      cancelled: 0,
    },
  };
}
function renderDatabase(initialEntry: string): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, { initialEntries: [initialEntry] }, createElement(DatabasePage)),
    ),
  );
  return queryClient;
}

function batchRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => String(input) === "/api/v2/import-jobs/batch");
}

function revisionRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/revisions"));
}

function databaseGame(index: number) {
  const gameId = `anon-db-${String(index).padStart(3, "0")}`;
  return {
    gameId,
    season: 2026,
    authority: "database",
    gameDate: "2026-08-30",
    teams: {
      away: { teamId: "away", name: "비식별 원정" },
      home: { teamId: "home", name: "비식별 홈" },
    },
    currentRevision: 2,
    revisionCount: 2,
    updatedAt: "2026-08-30T00:00:00.000Z",
    blockingFindings: 0,
    warningFindings: 0,
  };
}

function databaseOverview() {
  return {
    database: {
      reachable: true,
      healthy: true,
      serverMajorVersion: 16,
      expectedServerMajorVersion: 16,
      migrationVersion: "0004_pitch_metadata",
      expectedMigrationVersion: "0004_pitch_metadata",
      message: "정상",
    },
    counts: { readyToImport: 2, stored: 0 },
  };
}

function importJob(index: number) {
  return {
    jobId: `anon-import-job-${String(index).padStart(3, "0")}`,
    kind: "import",
    status: "succeeded",
    gameId: `anon-import-game-${String(index).padStart(3, "0")}`,
    createdAt: "2026-08-30T00:00:02.000Z",
    startedAt: "2026-08-30T00:00:03.000Z",
    finishedAt: "2026-08-30T00:00:04.000Z",
    revision: 1,
    documentHash: "a".repeat(64),
    projectionHash: "b".repeat(64),
    error: null,
    errorCategory: null,
  };
}

function gameCatalog() {
  return {
    games: [
      readyGame("anon-game-a", "2026-08-30T00:00:00.000Z", 0),
      readyGame("anon-game-b", "2026-08-30T00:00:01.000Z", 1),
    ],
  };
}

function readyGame(gameId: string, updatedAt: string, warningFindings: number) {
  return {
    gameId,
    season: 2026,
    authority: "staging",
    gameDate: "2026-08-30",
    teams: {
      away: { teamId: "away", name: "비식별 원정" },
      home: { teamId: "home", name: "비식별 홈" },
    },
    updatedAt,
    blockingFindings: 0,
    warningFindings,
    supersededCount: 0,
  };
}

function completedJobs() {
  return [
    { ...importJob(1), jobId: "anon-job-1", gameId: "anon-game-a" },
    {
      ...importJob(2),
      jobId: "anon-job-2",
      gameId: "anon-game-b",
      status: "failed",
      revision: null,
      documentHash: null,
      projectionHash: null,
      error: "비식별 적재 오류",
      errorCategory: "persistence",
    },
  ];
}
