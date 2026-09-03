// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
          session: { ...openedSession, authority: "staging" },
          committedAuthority: "staging",
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
    await screen.findByRole("option", { name: "test-game · 검토 필요" });
    await user.selectOptions(screen.getByLabelText("경기"), "quarantine:test-game");
    await user.click(screen.getByRole("button", { name: "작업 사본 열기" }));
    await user.click(await screen.findByRole("button", { name: "staging으로 승격" }));

    expect(await screen.findByText("test-game 저장 완료")).toBeTruthy();
    expect(
      screen.getByText("staging으로 승격되어 DB 적재 가능한 현재 원장이 되었습니다."),
    ).toBeTruthy();
    expect(screen.getByText(/작업 사본을 닫았습니다/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "작업 사본 저장" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "test-game을 staging으로 승격했습니다",
    );
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
