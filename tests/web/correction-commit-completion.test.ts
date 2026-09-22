// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseStagingGameDocumentV2, type CorrectionSession } from "@kbo/contracts";
import { CorrectPage } from "../../apps/web/src/pages/correct-page.js";
import { makeDocument } from "../helpers/game-document.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("보정 저장 완료 UI", () => {
  it("clean quarantine 승격 뒤 작업대를 닫고 완료 상태를 표시한다", async () => {
    const document = parseStagingGameDocumentV2(makeDocument([]));
    const openedSession = session(document, "quarantine");
    let promoted = false;
    let jobReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v2/correction-games") {
        return Response.json({
          games: promoted
            ? []
            : [
                {
                  gameId: document.metadata.gameId,
                  season: document.metadata.season,
                  authority: "quarantine",
                  gameDate: document.metadata.gameDate,
                  teams: document.teams,
                  updatedAt: "2026-09-03T00:00:00.000Z",
                },
              ],
        });
      }
      if (path === "/api/v2/correction-sessions" && init?.method === "POST") {
        return Response.json(openedSession, { status: 201 });
      }
      if (path === "/api/v2/correction-sessions/anonymous-session/original") {
        return Response.json(document);
      }
      if (path === "/api/v2/correction-sessions/anonymous-session/commit") {
        promoted = true;
        return Response.json({
          session: { ...openedSession, authority: "staging", sessionVersion: 1 },
          committedAuthority: "staging",
        });
      }
      if (
        path === "/api/v2/correction-sessions/anonymous-session?expectedSessionVersion=1" &&
        init?.method === "DELETE"
      )
        return new Response(null, { status: 204 });
      if (path === "/api/v2/import-jobs" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          gameId: "test-game",
          expectedDocumentHash: "1".repeat(64),
        });
        return Response.json({ jobId: "saved-game-import", status: "queued" }, { status: 202 });
      }
      if (path === "/api/v2/import-jobs/saved-game-import") {
        jobReads += 1;
        return Response.json({
          jobId: "saved-game-import",
          gameId: "test-game",
          kind: "import",
          status: "succeeded",
          createdAt: "2026-09-03T00:00:00.000Z",
          startedAt: null,
          finishedAt: "2026-09-03T00:00:01.000Z",
          revision: 1,
          documentHash: "1".repeat(64),
          projectionHash: "2".repeat(64),
          error: null,
          errorCategory: null,
          followUpPending: jobReads === 1,
        });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/correct"] },
        createElement(QueryClientProvider, { client: queryClient }, createElement(CorrectPage)),
      ),
    );

    const user = userEvent.setup();
    await screen.findByRole("option", { name: /2026-08-20 원정–홈.*검토 필요.*test-game/ });
    await user.selectOptions(screen.getByLabelText("경기"), "quarantine:test-game");
    await user.click(screen.getByRole("button", { name: "작업 사본 열기" }));
    await user.click(await screen.findByRole("button", { name: "staging으로 승격" }));

    expect(await screen.findByText(/2026-08-20 원정–홈 · 보정 저장 완료/)).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v2/correction-sessions/anonymous-session?expectedSessionVersion=1",
        expect.objectContaining({ method: "DELETE", keepalive: true }),
      ),
    );
    expect(screen.getByRole("button", { name: "이 경기 DB 적재" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "작업 사본 저장" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "test-game을 staging으로 승격했습니다",
    );
    await user.click(screen.getByRole("button", { name: "이 경기 DB 적재" }));
    expect(await screen.findByRole("link", { name: "저장 경기 재생" })).toBeTruthy();
    await waitFor(() => expect(jobReads).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    expect(await screen.findByText("검증된 경기 기록을 DB에 저장했습니다.")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/v2/correction-games").length,
    ).toBeGreaterThanOrEqual(3);
    queryClient.clear();
  });
});

function session(
  document: ReturnType<typeof parseStagingGameDocumentV2>,
  authority: "staging" | "quarantine",
): CorrectionSession {
  return {
    sessionId: "anonymous-session",
    authority,
    gameId: document.metadata.gameId,
    baseDocumentHash: "0".repeat(64),
    sessionVersion: 0,
    draftDocumentHash: "1".repeat(64),
    draftDocument: document,
    storedFindings: [],
    findings: [],
    eventContexts: [],
    calculatedRecords: { batters: [], pitchers: [] },
    blockingCount: 0,
    warningCount: 0,
    canUndo: false,
    canRedo: false,
    dirty: false,
  };
}
