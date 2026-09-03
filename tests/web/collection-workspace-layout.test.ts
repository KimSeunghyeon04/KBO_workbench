// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollectPage } from "../../apps/web/src/pages/collect-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("수집 작업공간", () => {
  it("수집 결과와 작업 이력을 같은 탭 영역에서 전환한다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const requestPath = String(input);
      if (requestPath === "/api/v2/games") {
        return Response.json({
          games: [
            {
              gameId: "anon-collected-game",
              season: 2026,
              authority: "staging",
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
              totalItems: 1,
              currentGameId: null,
              summary: { ready: 1, quarantined: 0, sourceFailures: 0 },
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
      createElement(QueryClientProvider, { client: queryClient }, createElement(CollectPage)),
    );

    expect(await screen.findByText("anon-collected-game")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "수집 결과 1" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(container.querySelectorAll(".job-row")).toHaveLength(0);

    await userEvent.setup().click(screen.getByRole("tab", { name: "진행·작업 기록 1" }));
    expect(await screen.findByText("ready 1")).toBeTruthy();
    expect(container.querySelectorAll(".job-row")).toHaveLength(1);
    expect(screen.queryByText("anon-collected-game")).toBeNull();
    queryClient.clear();
  });
});
