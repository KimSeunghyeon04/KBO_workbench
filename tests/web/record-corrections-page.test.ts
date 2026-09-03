// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { RecordCorrectionsPage } from "../../apps/web/src/pages/record-corrections-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KBO 기록정정 운영 콘솔", () => {
  it("기본 미처리 큐는 경량 목록만 받고 선택한 공지 상세만 조회한다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(input);
      const pathname = new URL(requestPath, "http://local.test").pathname;
      if (pathname === "/api/v2/record-corrections/summary") {
        return Response.json(summary());
      }
      if (pathname === "/api/v2/record-correction-jobs" && init?.method === "POST") {
        return Response.json({ jobId: "anon-record-job", status: "queued" }, { status: 202 });
      }
      if (pathname === "/api/v2/record-correction-jobs") return Response.json({ jobs: [] });
      if (pathname === "/api/v2/record-corrections/2024%3A0%3A10") {
        return Response.json(recordCorrectionCase());
      }
      if (pathname === "/api/v2/record-corrections") {
        return Response.json({ cases: [recordCorrectionListItem()] });
      }
      throw new Error(`unexpected request: ${requestPath}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "anon-record-idempotency-key" });
    const queryClient = renderPage("/record-corrections");

    const row = await screen.findByRole("option", { name: /안타 → 실책/ });
    expect(detailRequests(fetchMock)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "미처리 6" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "완료·제외 15" })).toBeTruthy();

    await userEvent.setup().click(row);
    expect(await screen.findByText("정확한 비식별 PA를 찾았습니다.")).toBeTruthy();
    expect(screen.getByText("파생 검증")).toBeTruthy();
    expect(screen.getByText("현 범위 제외")).toBeTruthy();
    expect(detailRequests(fetchMock)).toHaveLength(1);

    await userEvent.setup().click(screen.getByRole("button", { name: "지금 동기화" }));
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/v2/record-correction-jobs" &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(true);
    queryClient.clear();
  });

  it("공지 784건은 DOM 2,000개 미만의 가상 목록으로 렌더링한다", async () => {
    const correctionCases = Array.from({ length: 784 }, (_, index) =>
      recordCorrectionListItem(index + 1),
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const requestPath = String(input);
      const pathname = new URL(requestPath, "http://local.test").pathname;
      if (pathname === "/api/v2/record-corrections/summary") {
        return Response.json({
          ...summary(),
          counts: {
            actionRequired: 0,
            alreadyApplied: 0,
            manualReview: 784,
            outOfScope: 0,
            unmatched: 0,
            resolved: 0,
            dismissed: 0,
          },
          alertCount: 784,
        });
      }
      if (pathname === "/api/v2/record-correction-jobs") return Response.json({ jobs: [] });
      if (pathname === "/api/v2/record-corrections") {
        return Response.json({ cases: correctionCases });
      }
      throw new Error(`unexpected request: ${requestPath}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = renderPage("/record-corrections?queue=needs_action");

    await waitFor(() => expect(screen.getByRole("button", { name: "미처리 784" })).toBeTruthy());
    expect(document.querySelectorAll(".operation-list-row").length).toBeLessThan(30);
    expect(document.querySelectorAll("*").length).toBeLessThan(2_000);
    expect(detailRequests(fetchMock)).toHaveLength(0);
    queryClient.clear();
  });

  it("처리 완료 후 다음 미처리 공지를 선택하고 남은 수를 알린다", async () => {
    let resolved = false;
    const first = { ...recordCorrectionListItem(10), status: "manual_review" };
    const second = { ...recordCorrectionListItem(11), status: "manual_review" };
    const firstDetail = {
      ...recordCorrectionCase(),
      status: "manual_review",
      candidates: [
        ...recordCorrectionCase().candidates,
        {
          ...recordCorrectionCase().candidates[0],
          candidateId: "anon-candidate-2",
          label: "비식별 후보 2",
        },
      ],
    };
    const secondDetail = {
      ...recordCorrectionCase(),
      noticeId: "2024:0:11",
      reasonMessage: "다음 비식별 공지입니다.",
      notice: { ...recordCorrectionCase().notice, noticeId: "2024:0:11", recordNumber: 11 },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(input);
      const pathname = new URL(requestPath, "http://local.test").pathname;
      if (pathname === "/api/v2/record-corrections/summary") return Response.json(summary());
      if (pathname === "/api/v2/record-correction-jobs") return Response.json({ jobs: [] });
      if (
        pathname === "/api/v2/record-corrections/2024%3A0%3A10/review-actions" &&
        init?.method === "POST"
      ) {
        resolved = true;
        return Response.json({ ...firstDetail, status: "resolved", caseVersion: 2 });
      }
      if (pathname === "/api/v2/record-corrections/2024%3A0%3A10") {
        return Response.json(firstDetail);
      }
      if (pathname === "/api/v2/record-corrections/2024%3A0%3A11") {
        return Response.json(secondDetail);
      }
      if (pathname === "/api/v2/record-corrections") {
        return Response.json({ cases: resolved ? [second] : [first, second] });
      }
      throw new Error(`unexpected request: ${requestPath}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = renderPage("/record-corrections?notice=2024%3A0%3A10");

    await userEvent.setup().click(await screen.findByRole("button", { name: "비식별 후보" }));
    expect((await screen.findByRole("status")).textContent).toContain("1건 남았습니다");
    expect(await screen.findByText("다음 비식별 공지입니다.")).toBeTruthy();
    queryClient.clear();
  });
});

function renderPage(initialEntry: string): QueryClient {
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
        createElement(RecordCorrectionsPage),
      ),
    ),
  );
  return queryClient;
}

function detailRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    ([input]) =>
      new URL(String(input), "http://local.test").pathname ===
      "/api/v2/record-corrections/2024%3A0%3A10",
  );
}

function summary() {
  return {
    counts: {
      actionRequired: 1,
      alreadyApplied: 0,
      manualReview: 2,
      outOfScope: 6,
      unmatched: 3,
      resolved: 4,
      dismissed: 5,
    },
    alertCount: 3,
    lastSuccessfulAt: "2026-09-01T00:00:00.000Z",
    nextScheduledAt: "2026-09-02T00:00:00.000Z",
  };
}

function recordCorrectionListItem(recordNumber = 10) {
  return {
    noticeId: `2024:0:${String(recordNumber)}`,
    caseVersion: 1,
    season: 2024,
    status: recordNumber === 10 ? "action_required" : "manual_review",
    gameId: "anon-game",
    gameDate: "2024-09-15",
    awayTeamName: "비식별원정",
    homeTeamName: "비식별홈",
    venueName: "비식별구장",
    beforeRecordText: "안타",
    afterRecordText: "실책",
    assessedAt: "2026-09-01T00:00:00.000Z",
  };
}

function recordCorrectionCase() {
  return {
    noticeId: "2024:0:10",
    season: 2024,
    sourceRevision: 1,
    caseVersion: 1,
    status: "action_required",
    gameId: "anon-game",
    gameRevision: 1,
    eventId: "anon-event",
    reasonCode: "supported_change_available",
    reasonMessage: "정확한 비식별 PA를 찾았습니다.",
    proposalHash: null,
    appliedRevision: null,
    assessedAt: "2026-09-01T00:00:00.000Z",
    notice: {
      noticeId: "2024:0:10",
      noticeHash: "a".repeat(64),
      sourceRequestKey: "records:2024:0:1",
      sourceRowIndex: 0,
      seriesId: 0,
      seriesName: "정규시즌",
      recordNumber: 10,
      gameDate: "2024-09-15",
      weekdayText: "일",
      awayTeamName: "비식별원정",
      homeTeamName: "비식별홈",
      doubleheaderNumber: null,
      venueName: "비식별구장",
      inning: 5,
      half: "top",
      battingOrder: 8,
      decisionBefore: "hit",
      decisionAfter: "error",
      beforeRecordText: "안타",
      afterRecordText: "실책",
      contentText: "비식별 원문",
      correctionDateText: "09/25",
      participants: [
        {
          participantIndex: 0,
          rawTeamName: "비식별원정",
          rawPlayerName: "가상타자",
          role: "batter",
          parenthesized: false,
        },
      ],
      statChanges: [
        {
          statIndex: 0,
          participantIndex: 0,
          rawStatName: "루타",
          statCode: "total_bases",
          scope: "batter",
          beforeValue: 4,
          afterValue: 3,
          supportKind: "derived",
        },
        {
          statIndex: 1,
          participantIndex: 0,
          rawStatName: "실책",
          statCode: "fielding_errors",
          scope: "fielder",
          beforeValue: 0,
          afterValue: 1,
          supportKind: "evidence_only",
        },
      ],
    },
    candidates: [
      {
        candidateId: "anon-candidate",
        gameId: "anon-game",
        revision: 1,
        documentHash: "b".repeat(64),
        eventId: "anon-event",
        batterPlayerId: "anon-batter",
        pitcherPlayerId: "anon-pitcher",
        label: "비식별 후보",
        confidenceReason: "비식별 근거",
      },
    ],
  };
}
