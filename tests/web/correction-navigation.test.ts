// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  parseStagingGameDocumentV2,
  type CorrectionGameCatalogItem,
  type CorrectionSession,
} from "@kbo/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CorrectPage } from "../../apps/web/src/pages/correct-page.js";
import { makeDocument } from "../helpers/game-document.js";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("보정 문제와 원장 탐색", () => {
  it("멀리 있는 문제 행을 드러내고 상세에서 같은 행과 문제 위치·필터·포커스로 돌아간다", async () => {
    const { client, fetchMock, view } = setup([catalogItem("test-game", "quarantine")]);
    const user = userEvent.setup();
    await waitFor(() =>
      expect((screen.getByLabelText("경기") as HTMLSelectElement).value).toBe(
        "quarantine:test-game",
      ),
    );
    await user.click(await screen.findByRole("button", { name: "작업 사본 열기" }));
    await screen.findByRole("heading", { name: "현재 보정할 문제" });
    const gameSummary = screen.getByRole("region", { name: "현재 보정 경기" });
    expect(gameSummary.textContent).toContain("2026-08-20 · 원정 vs 홈");
    expect(within(gameSummary).getByText("test-game")).toBeTruthy();
    await user.type(screen.getByLabelText("원장 행 검색"), "일치하지 않는 검색어");
    await user.type(screen.getByLabelText("검증 문제 검색"), "선택 행");
    await user.selectOptions(screen.getByLabelText("검증 문제 범주"), "domain");
    const source = screen.getByRole("button", { name: /선택 행 원문을 확인하세요/ });
    const problems = source.closest<HTMLElement>(".finding-list");
    if (problems === null) throw new Error("problem list missing");
    problems.scrollTop = 144;
    vi.stubGlobal("scrollY", 678);
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    await user.click(source);
    await waitFor(() => {
      const selected = view.container.querySelector('.event-row-select[aria-pressed="true"]');
      expect(selected?.textContent).toContain("#71");
      expect(selected).toBe(document.activeElement);
    });
    expect((screen.getByLabelText("원장 행 검색") as HTMLInputElement).value).toBe("");
    expect(view.container.querySelectorAll(".event-row").length).toBeLessThan(30);
    await user.click(screen.getByRole("button", { name: "선택한 행 상세 보기" }));
    expect(document.activeElement?.id).toBe("correction-selection-detail");
    expect(
      [...view.container.querySelectorAll(".event-related-findings > article > strong")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["선택 행 원문을 확인하세요", "다른 차단 문제", "앞서 저장된 경고"]);
    const detailNavigation = screen.getByRole("navigation", { name: "상세에서 돌아가기" });
    await user.click(
      within(detailNavigation).getByRole("button", { name: "선택한 행으로 돌아가기" }),
    );
    await waitFor(() => expect(document.activeElement?.textContent).toContain("#71"));
    const rowNavigation = screen.getByRole("navigation", { name: "원장에서 이동" });
    await user.click(within(rowNavigation).getByRole("button", { name: "문제 목록으로 돌아가기" }));
    expect(document.activeElement).toBe(source);
    expect(problems.scrollTop).toBe(144);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 678, behavior: "instant" });
    expect((screen.getByLabelText("검증 문제 검색") as HTMLInputElement).value).toBe("선택 행");
    expect((screen.getByLabelText("검증 문제 범주") as HTMLSelectElement).value).toBe("domain");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    view.unmount();
    client.clear();
  });

  it("DB 경고 검토 링크는 요청한 두 번째 적재 가능 경기를 선택한다", async () => {
    const { client, view } = setup(
      [
        catalogItem("review-game", "quarantine"),
        catalogItem("first-ready", "staging"),
        catalogItem("second-ready", "staging"),
      ],
      "/correct?game=second-ready&scope=ready",
    );
    await waitFor(() =>
      expect((screen.getByLabelText("경기") as HTMLSelectElement).value).toBe(
        "staging:second-ready",
      ),
    );
    expect(screen.getByRole("button", { name: "적재 가능 2" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByRole("option", { name: /review-game/ })).toBeNull();
    view.unmount();
    client.clear();
  });

  it("요청한 적재 가능 경기가 없으면 검토 필요 경기로 바꾸거나 임의로 열지 않는다", async () => {
    const { client, fetchMock, view } = setup(
      [catalogItem("review-game", "quarantine"), catalogItem("other-ready", "staging")],
      "/correct?game=missing-ready&scope=ready",
    );
    expect(await screen.findByText(/요청한 경기가 이 보정 대상 범위에 없습니다/)).toBeTruthy();
    expect((screen.getByLabelText("경기") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("button", { name: "적재 가능 1" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      (screen.getByRole("button", { name: "작업 사본 열기" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    await userEvent.setup().selectOptions(screen.getByLabelText("경기"), "staging:other-ready");
    await waitFor(() =>
      expect((screen.getByLabelText("경기") as HTMLSelectElement).value).toBe(
        "staging:other-ready",
      ),
    );
    expect(
      (screen.getByRole("button", { name: "작업 사본 열기" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    view.unmount();
    client.clear();
  });
});

function setup(games: readonly CorrectionGameCatalogItem[], entry = "/correct") {
  const gameDocument = parseStagingGameDocumentV2(
    makeDocument(
      Array.from({ length: 80 }, (_, index) => ({
        kind: "administrative",
        payload: { code: "announcement" },
        relayText: `비식별 중계 ${String(index + 1)}`,
      })),
    ),
  );
  const opened: CorrectionSession = {
    sessionId: "navigation-session",
    authority: "quarantine",
    gameId: gameDocument.metadata.gameId,
    baseDocumentHash: "0".repeat(64),
    draftDocumentHash: "1".repeat(64),
    sessionVersion: 0,
    draftDocument: gameDocument,
    storedFindings: [],
    findings: [
      {
        code: "anonymous_warning",
        category: "source",
        severity: "warning",
        gameId: gameDocument.metadata.gameId,
        eventId: "e70",
        eventSequence: 70,
        message: "앞서 저장된 경고",
        details: [],
      },
      {
        code: "anonymous_other_blocker",
        category: "domain",
        severity: "blocking",
        gameId: gameDocument.metadata.gameId,
        eventId: "e70",
        eventSequence: 70,
        message: "다른 차단 문제",
        details: [],
      },
      {
        code: "anonymous_source_check",
        category: "domain",
        severity: "blocking",
        gameId: gameDocument.metadata.gameId,
        eventId: "e70",
        eventSequence: 70,
        message: "선택 행 원문을 확인하세요",
        details: [],
      },
    ],
    eventContexts: [],
    calculatedRecords: { batters: [], pitchers: [] },
    blockingCount: 2,
    warningCount: 1,
    canUndo: false,
    canRedo: false,
    dirty: false,
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/v2/correction-games") return Response.json({ games });
    if (path === "/api/v2/correction-sessions" && init?.method === "POST")
      return Response.json(opened, { status: 201 });
    if (path.endsWith("/original")) return Response.json(gameDocument);
    if (path.includes("/source-evidence/"))
      return Response.json({
        eventId: path.split("/").at(-1),
        endpoint: "test-relay",
        blockIndex: 0,
        eventIndex: 70,
        relayRows: [],
        trackingRows: [],
      });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      createElement(QueryClientProvider, { client }, createElement(CorrectPage)),
    ),
  );
  return { client, fetchMock, view };
}

function catalogItem(
  gameId: string,
  authority: "staging" | "quarantine",
): CorrectionGameCatalogItem {
  return {
    gameId,
    season: 2026,
    authority,
    gameDate: "2026-08-20",
    teams: {
      away: { teamId: "AWAY", name: "비식별 원정" },
      home: { teamId: "HOME", name: "비식별 홈" },
    },
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}
