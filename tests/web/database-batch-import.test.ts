// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, Fragment } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { DatabasePage } from "../../apps/web/src/pages/database-page.js";
import { AppShell } from "../../apps/web/src/components/app-shell.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("데이터베이스 운영 콘솔", () => {
  it("첫 조회는 DB 상태가 기본 탭을 확정한 뒤 필요한 경기 목록만 요청한다", async () => {
    const overview = Promise.withResolvers<Response>();
    const authorities: (string | null)[] = [];
    const historyViews: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/v2/database/status") return overview.promise;
        if (url.pathname === "/api/v2/import-history") {
          historyViews.push(url.searchParams.get("view"));
          return Response.json({ ...historyPage(completedJobs()), jobs: [] });
        }
        if (url.pathname === "/api/v2/database/games") {
          authorities.push(url.searchParams.get("authority"));
          return Response.json({ ...gameCatalog(), total: 2, page: 1, limit: 50, seasons: [2026] });
        }
        throw new Error(`unexpected request: ${url.pathname}`);
      }),
    );
    const client = renderDatabase("/database");
    await waitFor(() => expect(historyViews).toContain("activity"));
    expect(authorities).toEqual([]);
    overview.resolve(Response.json(databaseOverview()));
    const list = await screen.findByRole("listbox", { name: "적재 대기 경기" });
    await within(list).findByRole("option", { name: /anon-game-a/ });
    expect(
      within(list)
        .getAllByRole("option")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("anon-game-a"), expect.stringContaining("anon-game-b")]);
    expect(authorities).toEqual(["staging"]);
    expect(historyViews).toEqual(["activity"]);
    client.clear();
  });

  it("모바일 경기 직접 링크에서 목록으로 돌아오면 상세를 닫고 같은 조회 범위를 유지한다", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/v2/database/status") return Response.json(databaseOverview());
        if (url.pathname === "/api/v2/database/games")
          return Response.json({
            ...gameCatalog(),
            total: 2,
            page: 1,
            limit: 50,
            seasons: [2026],
          });
        if (url.pathname === "/api/v2/import-history") return Response.json(historyPage([]));
        throw new Error(`unexpected request: ${url.pathname}`);
      }),
    );
    const queryClient = renderDatabase("/database?scope=ready&season=2026&game=anon-game-b", true);
    await screen.findByRole("link", { name: "보정에서 경고 검토" });
    expect(document.querySelector(".operation-console.has-selection")).not.toBeNull();
    const user = userEvent.setup();
    screen.getByRole("button", { name: "← 목록으로" }).focus();
    await user.keyboard("{End}{Enter}");
    await waitFor(() =>
      expect(document.querySelector(".operation-console.has-selection")).toBeNull(),
    );
    const params = new URLSearchParams(screen.getByTestId("database-location").textContent ?? "");
    expect(params.has("game")).toBe(false);
    expect(params.get("scope")).toBe("ready");
    expect(params.get("season")).toBe("2026");
    const list = screen.getByRole("listbox", { name: "적재 대기 경기" });
    expect(document.activeElement).toBe(list);
    const previousRow = screen.getByRole("option", { name: /anon-game-b/ });
    expect(list.getAttribute("aria-activedescendant")).toBe(previousRow.id);
    expect(previousRow.getAttribute("aria-selected")).toBe("false");
    await user.keyboard("{Enter}");
    await screen.findByRole("link", { name: "보정에서 경고 검토" });
    expect(document.querySelector(".operation-console.has-selection")).not.toBeNull();
    expect(
      new URLSearchParams(screen.getByTestId("database-location").textContent ?? "").get("game"),
    ).toBe("anon-game-b");
    await user.click(screen.getByRole("button", { name: "← 목록으로" }));
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute("aria-activedescendant")).toBe(previousRow.id);
    await user.keyboard(" ");
    expect(
      new URLSearchParams(screen.getByTestId("database-location").textContent ?? "").get("game"),
    ).toBe("anon-game-b");
    queryClient.clear();
  });

  it("경고 검토 링크를 키보드로 열면 선택한 경기와 적재 가능 범위를 유지한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/v2/database/status") return Response.json(databaseOverview());
        if (url.pathname === "/api/v2/database/games")
          return Response.json({
            ...gameCatalog(),
            total: 2,
            page: 1,
            limit: 50,
            seasons: [2026],
          });
        if (url.pathname === "/api/v2/import-history") return Response.json(historyPage([]));
        throw new Error(`unexpected request: ${url.pathname}`);
      }),
    );
    const queryClient = renderDatabase("/database?scope=ready&game=anon-game-b");
    const reviewLink = await screen.findByRole("link", { name: "보정에서 경고 검토" });
    const target = new URL(reviewLink.getAttribute("href") ?? "", "http://localhost");
    expect(target.pathname).toBe("/correct");
    expect(target.searchParams.get("game")).toBe("anon-game-b");
    expect(target.searchParams.get("scope")).toBe("ready");
    expect(screen.getByText("차단 없음 · 경고 1건")).toBeTruthy();
    expect(screen.getByText(/경고가 있어도 적재할 수 있습니다/)).toBeTruthy();
    reviewLink.focus();
    await userEvent.setup().keyboard("{Enter}");
    const params = new URLSearchParams(screen.getByTestId("database-location").textContent ?? "");
    expect(params.get("game")).toBe("anon-game-b");
    expect(params.get("scope")).toBe("ready");
    queryClient.clear();
  });

  it.each([0, 2])("경고 %i건은 단건 적재를 차단하지 않는다", async (warningFindings) => {
    const gameId = "anon-game-warning";
    const job = { ...importJob(0), jobId: "anon-warning-job", gameId };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v2/database/status") return Response.json(databaseOverview());
      if (url.pathname === "/api/v2/database/games")
        return Response.json({
          games: [readyGame(gameId, "2026-08-30T00:00:00.000Z", warningFindings)],
          total: 1,
          page: 1,
          limit: 50,
          seasons: [2026],
        });
      if (url.pathname === "/api/v2/import-history") return Response.json(historyPage([]));
      if (url.pathname === "/api/v2/import-jobs" && init?.method === "POST")
        return Response.json({ jobId: job.jobId, status: "queued" }, { status: 202 });
      if (url.pathname === `/api/v2/import-jobs/${job.jobId}`) return Response.json(job);
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "anon-warning-import-key" });
    const queryClient = renderDatabase(`/database?scope=ready&game=${gameId}`);
    const importButton = await screen.findByRole("button", { name: "새 기록 버전 적재" });
    await waitFor(() => expect((importButton as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("link", { name: "보정에서 경고 검토" }) !== null).toBe(
      warningFindings > 0,
    );
    await userEvent.setup().click(importButton);
    await screen.findByRole("button", { name: "저장 경기 재생" });
    const requests = fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/v2/import-jobs",
    );
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.[1]?.body))).toEqual({
      gameId,
      idempotencyKey: "anon-warning-import-key",
    });
    queryClient.clear();
  });

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
    expect(await screen.findByText("조건에 맞는 적재 대기 경기가 없습니다.")).toBeTruthy();
    expect(screen.getByText(/2026 시즌.*2경기 확정/)).toBeTruthy();
    expect(batchRequests(fetchMock)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect((screen.getByLabelText("시즌") as HTMLSelectElement).value).toBe("all");
    expect(screen.getByText(/2026 시즌.*2경기 확정/)).toBeTruthy();
    expect(
      new URLSearchParams(screen.getByTestId("database-location").textContent ?? "").get("scope"),
    ).toBe("ready");
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
    expect(
      await screen.findByRole("button", { name: "최신 기록을 보정 작업 사본으로 열기" }),
    ).toBeTruthy();
    expect(revisionRequests(fetchMock)).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText("시즌"), "2025");
    expect(await screen.findByText("조건에 맞는 저장 경기가 없습니다.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "최신 기록을 보정 작업 사본으로 열기" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect((screen.getByLabelText("시즌") as HTMLSelectElement).value).toBe("all");
    await screen.findByRole("option", { name: /anon-db-000/ });
    const pager = screen.getByRole("navigation", { name: "목록 페이지" });
    await user.click(within(pager).getByRole("button", { name: "다음", exact: true }));
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

  it.each([
    ["ready", "조건에 맞는 적재 대기 경기가 없습니다."],
    ["stored", "조건에 맞는 저장 경기가 없습니다."],
    ["jobs", "조건에 맞는 작업 기록이 없습니다."],
  ])(
    "%s의 빈 검색 결과에서 표시 필터만 초기화하고 현재 범위를 유지한다",
    async (scope, message) => {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/v2/database/status") return Response.json(databaseOverview());
        if (url.pathname === "/api/v2/database/games") {
          const filtered = url.searchParams.has("search") || url.searchParams.has("season");
          const games = filtered ? [] : scope === "ready" ? gameCatalog().games : [databaseGame(0)];
          return Response.json({
            games,
            total: games.length,
            page: 1,
            limit: 50,
            seasons: [2026, 2025],
          });
        }
        if (url.pathname === "/api/v2/import-history") {
          const filtered = ["search", "status", "batchId"].some((key) => url.searchParams.has(key));
          return Response.json(historyPage(filtered ? [] : [importJob(0)]));
        }
        throw new Error(`unexpected request: ${url.pathname}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const queryClient = renderDatabase(
        `/database?scope=${scope}&q=없는팀&season=2025&result=failed&batch=anon-batch-1&page=2`,
      );
      expect(await screen.findByText(message)).toBeTruthy();
      screen.getByRole("button", { name: "필터 초기화" }).focus();
      await userEvent.setup().keyboard("{Enter}");
      await screen.findByRole("option", {
        name:
          scope === "ready"
            ? /anon-game-a/
            : scope === "stored"
              ? /anon-db-000/
              : /anon-import-game-000/,
      });
      expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "검색" }));
      const params = new URLSearchParams(screen.getByTestId("database-location").textContent ?? "");
      expect(params.get("scope")).toBe(scope);
      for (const key of ["q", "season", "result", "batch", "page"])
        expect(params.has(key)).toBe(false);
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const url = new URL(String(input), "http://localhost");
          return scope === "jobs"
            ? url.pathname === "/api/v2/import-history" &&
                !url.searchParams.has("search") &&
                !url.searchParams.has("status") &&
                !url.searchParams.has("batchId") &&
                url.searchParams.get("page") === "1"
            : url.pathname === "/api/v2/database/games" &&
                url.searchParams.get("authority") ===
                  (scope === "ready" ? "staging" : "database") &&
                !url.searchParams.has("search") &&
                !url.searchParams.has("season") &&
                url.searchParams.get("page") === "1";
        }),
      ).toBe(true);
      queryClient.clear();
    },
  );

  it.each([
    ["ready", "적재할 경기가 없습니다."],
    ["stored", "저장된 경기가 없습니다."],
    ["jobs", "적재 작업이 없습니다."],
  ])(
    "%s에 실제 데이터가 없고 필터가 없으면 검색 결과로 표현하지 않는다",
    async (scope, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = new URL(String(input), "http://localhost");
          if (url.pathname === "/api/v2/database/status")
            return Response.json({
              ...databaseOverview(),
              counts: { readyToImport: 0, stored: 0 },
            });
          if (url.pathname === "/api/v2/database/games")
            return Response.json({ games: [], total: 0, page: 1, limit: 50, seasons: [] });
          if (url.pathname === "/api/v2/import-history") return Response.json(historyPage([]));
          throw new Error(`unexpected request: ${url.pathname}`);
        }),
      );
      const queryClient = renderDatabase(`/database?scope=${scope}`);
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "필터 초기화" })).toBeNull();
      queryClient.clear();
    },
  );
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
function renderDatabase(initialEntry: string, withShell = false): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: [initialEntry] },
        createElement(
          Fragment,
          null,
          withShell
            ? createElement(AppShell, null, createElement(DatabasePage))
            : createElement(DatabasePage),
          createElement(DatabaseLocation),
        ),
      ),
    ),
  );
  return queryClient;
}

function DatabaseLocation() {
  return createElement(
    "span",
    { hidden: true, "data-testid": "database-location" },
    useLocation().search,
  );
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
