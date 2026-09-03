// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { CollectPage } from "../../apps/web/src/pages/collect-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("수집 운영 콘솔", () => {
  it("목록은 식별 정보만 보이고 작업 이력은 drawer와 상세에서 연다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const requestPath = String(input);
      if (requestPath === "/api/v2/games") {
        return Response.json({
          games: [
            {
              gameId: "anon-collected-game",
              season: 2026,
              authority: "staging",
              gameDate: "2026-08-30",
              teams: {
                away: { teamId: "away", name: "비식별 원정" },
                home: { teamId: "home", name: "비식별 홈" },
              },
              updatedAt: "2026-08-30T00:00:00.000Z",
              blockingFindings: 0,
              warningFindings: 1,
              supersededCount: 0,
            },
          ],
        });
      }
      if (requestPath === "/api/v2/collection-jobs") {
        return Response.json({
          jobs: [
            {
              jobId: "anon-collection-job",
              kind: "collection",
              status: "succeeded",
              createdAt: "2026-08-30T00:00:00.000Z",
              startedAt: "2026-08-30T00:00:01.000Z",
              finishedAt: "2026-08-30T00:00:02.000Z",
              completedItems: 1,
              totalItems: 2,
              currentGameId: null,
              scope: {
                kind: "date_range",
                startDate: "2026-08-30",
                endDate: "2026-08-30",
              },
              summary: { ready: 1, quarantined: 0, sourceFailures: 0 },
              skippedItems: 1,
              error: null,
              errorCategory: null,
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
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(MemoryRouter, null, createElement(CollectPage)),
      ),
    );

    const game = await screen.findByRole("option", { name: /비식별 원정 vs 비식별 홈/ });
    expect(within(game).queryByText(/차단|경고/)).toBeNull();
    expect(within(game).queryByRole("button")).toBeNull();
    await userEvent.setup().click(game);
    expect(await screen.findByText("차단 0 · 경고 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "보정 작업 사본 열기" })).toBeTruthy();

    await userEvent.setup().click(screen.getByRole("button", { name: "활동 기록 1" }));
    expect(await screen.findByRole("option", { name: /2026-08-30.*1 \/ 2/ })).toBeTruthy();
    expect(container.querySelectorAll(".operation-list-row").length).toBeLessThan(30);
    queryClient.clear();
  });
});
