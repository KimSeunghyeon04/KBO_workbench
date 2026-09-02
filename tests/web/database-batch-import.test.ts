// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QueryClient,
  QueryClientProvider,
} from "../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js";
import { DatabasePage } from "../../apps/web/src/pages/database-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("데이터베이스 일괄 적재 UI", () => {
  it("명시적 확인 뒤 적재 가능한 경기 전체를 서버 batch로 한 번만 등록한다", async () => {
    let batchPosted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v2/database/status") return Response.json(databaseOverview());
      if (path === "/api/v2/games") return Response.json(gameCatalog());
      if (path === "/api/v2/import-jobs" && init?.method !== "POST")
        return Response.json({ jobs: batchPosted ? completedJobs() : [] });
      if (path === "/api/v2/import-jobs/batch" && init?.method === "POST") {
        batchPosted = true;
        return Response.json(
          {
            batchId: "anon-batch-1",
            createdCount: 2,
            skippedCount: 1,
            jobs: [
              { jobId: "anon-job-1", gameId: "anon-game-a", status: "queued" },
              { jobId: "anon-job-2", gameId: "anon-game-b", status: "queued" },
            ],
          },
          { status: 202 },
        );
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "anon-batch-idempotency-key" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(DatabasePage)),
    );

    const openConfirmation = await screen.findByRole("button", {
      name: "적재 가능한 2경기 일괄 적재",
    });
    await userEvent.setup().click(openConfirmation);
    expect(screen.getByRole("alert").textContent).toContain("2경기를 일괄 적재");
    expect(batchRequests(fetchMock)).toHaveLength(0);

    await userEvent.setup().click(screen.getByRole("button", { name: "일괄 적재 시작" }));
    expect(await screen.findByText("최근 일괄 적재")).toBeTruthy();
    expect(screen.getByText("등록 2")).toBeTruthy();
    expect(await screen.findByText("완료 1")).toBeTruthy();
    expect(screen.getByText("실패 1")).toBeTruthy();
    expect(screen.getByText("진행·대기 0")).toBeTruthy();
    expect(screen.getByText("이미 저장·진행 중 제외 1")).toBeTruthy();
    expect(batchRequests(fetchMock)).toHaveLength(1);
    expect(batchRequests(fetchMock)[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idempotencyKey: "anon-batch-idempotency-key" }),
      }),
    );
    queryClient.clear();
  });

  it("저장 경기 784개는 50개만 렌더링하고 revision 이력은 펼칠 때 한 번만 요청한다", async () => {
    const storedGames = Array.from({ length: 784 }, (_, index) => databaseGame(index));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const requestPath = String(input);
      if (requestPath === "/api/v2/database/status") {
        return Response.json({ ...databaseOverview(), counts: { readyToImport: 0, stored: 784 } });
      }
      if (requestPath === "/api/v2/games") return Response.json({ games: storedGames });
      if (requestPath === "/api/v2/import-jobs") return Response.json({ jobs: [] });
      if (requestPath.endsWith("/revisions")) {
        return Response.json({
          gameId: "anon-db-000",
          currentRevision: 2,
          revisions: [
            {
              revision: 2,
              documentHash: "a".repeat(64),
              projectionHash: "b".repeat(64),
              sealed: true,
              createdAt: "2026-08-30T00:00:00.000Z",
              sealedAt: "2026-08-30T00:00:01.000Z",
              original: false,
              current: true,
            },
          ],
        });
      }
      throw new Error(`unexpected request: ${requestPath}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { container } = render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(DatabasePage)),
    );

    expect(await screen.findByText("anon-db-000")).toBeTruthy();
    expect(container.querySelectorAll(".stored-game-row")).toHaveLength(50);
    expect(revisionRequests(fetchMock)).toHaveLength(0);
    const [revisionHistoryButton] = screen.getAllByRole("button", {
      name: "revision 이력 보기",
    });
    expect(revisionHistoryButton).toBeDefined();
    if (!revisionHistoryButton) {
      throw new Error("revision history button was not rendered");
    }
    await userEvent.setup().click(revisionHistoryButton);
    expect(await screen.findByText(/r2 · aaaaaaaaaa/)).toBeTruthy();
    expect(revisionRequests(fetchMock)).toHaveLength(1);
    queryClient.clear();
  });
});

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
      migrationVersion: "0003_record_correction_scope_classification",
      expectedMigrationVersion: "0003_record_correction_scope_classification",
      message: "정상",
    },
    counts: { readyToImport: 2, stored: 0 },
  };
}

function gameCatalog() {
  return {
    games: [
      {
        gameId: "anon-game-a",
        season: 2026,
        authority: "staging",
        updatedAt: "2026-08-30T00:00:00.000Z",
        blockingFindings: 0,
        warningFindings: 0,
      },
      {
        gameId: "anon-game-b",
        season: 2026,
        authority: "staging",
        updatedAt: "2026-08-30T00:00:01.000Z",
        blockingFindings: 0,
        warningFindings: 1,
      },
    ],
  };
}

function completedJobs() {
  return [
    {
      jobId: "anon-job-1",
      kind: "import",
      status: "succeeded",
      gameId: "anon-game-a",
      createdAt: "2026-08-30T00:00:02.000Z",
      startedAt: "2026-08-30T00:00:03.000Z",
      finishedAt: "2026-08-30T00:00:04.000Z",
      revision: 1,
      documentHash: "a".repeat(64),
      projectionHash: "b".repeat(64),
      error: null,
      errorCategory: null,
    },
    {
      jobId: "anon-job-2",
      kind: "import",
      status: "failed",
      gameId: "anon-game-b",
      createdAt: "2026-08-30T00:00:02.000Z",
      startedAt: "2026-08-30T00:00:03.000Z",
      finishedAt: "2026-08-30T00:00:04.000Z",
      revision: null,
      documentHash: null,
      projectionHash: null,
      error: "비식별 적재 오류",
      errorCategory: "persistence",
    },
  ];
}
