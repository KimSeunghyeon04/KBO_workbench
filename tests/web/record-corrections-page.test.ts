// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QueryClient,
  QueryClientProvider,
} from "../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js";
import { MemoryRouter } from "../../apps/web/node_modules/react-router-dom/dist/index.mjs";
import { RecordCorrectionsPage } from "../../apps/web/src/pages/record-corrections-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KBO 기록정정 검토함", () => {
  it("상태·근거·범위 제외를 표시하고 수동 동기화를 job으로 등록한다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestPath = String(input);
      if (requestPath === "/api/v2/record-corrections/summary")
        return Response.json({
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
        });
      if (requestPath === "/api/v2/record-correction-jobs" && init?.method === "POST")
        return Response.json({ jobId: "anon-record-job", status: "queued" }, { status: 202 });
      if (requestPath === "/api/v2/record-correction-jobs") return Response.json({ jobs: [] });
      if (requestPath.startsWith("/api/v2/record-corrections"))
        return Response.json({ cases: [recordCorrectionCase()] });
      throw new Error(`unexpected request: ${requestPath}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "anon-record-idempotency-key" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(MemoryRouter, null, createElement(RecordCorrectionsPage)),
      ),
    );

    expect(await screen.findByText("파생 검증")).toBeTruthy();
    expect(screen.getByText("현 범위 제외")).toBeTruthy();
    expect(screen.getByText("정확한 비식별 PA를 찾았습니다.")).toBeTruthy();
    expect(
      screen
        .getAllByText("수동 검토")
        .some((item) => item.parentElement?.textContent?.includes("2")),
    ).toBe(true);
    expect(
      screen
        .getAllByText("지원 범위 외")
        .some((item) => item.parentElement?.textContent?.includes("6")),
    ).toBe(true);
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
});

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
