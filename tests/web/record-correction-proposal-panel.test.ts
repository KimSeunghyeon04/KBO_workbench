// @vitest-environment jsdom

import {
  parseStagingGameDocumentV2,
  type CorrectionSession,
  type RecordCorrectionCase,
  type RecordCorrectionProposal,
} from "@kbo/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecordCorrectionProposalPanel } from "../../apps/web/src/correction/record-correction-proposal-panel.js";
import { makeDocument } from "../helpers/game-document.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("보정 화면의 KBO 기록정정 내용", () => {
  it("검토함에서 이동하면 공지 원문과 선수별 전후 공식 기록을 표시한다", async () => {
    const correctionCase = anonymizedCorrectionCase();
    const proposal = anonymizedProposal();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path === "/api/v2/record-corrections/2024%3A0%3A10")
          return Response.json(correctionCase);
        if (
          path ===
          "/api/v2/correction-sessions/anonymous-session/record-correction-proposals/2024%3A0%3A10"
        )
          return Response.json(proposal);
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RecordCorrectionProposalPanel, {
          session: anonymizedSession(),
          noticeId: correctionCase.noticeId,
          onApplied: vi.fn(),
        }),
      ),
    );

    expect(await screen.findByRole("heading", { name: "기록정정 내용" })).toBeTruthy();
    expect(screen.getByText(/2024-09-15 · 비식별원정 vs 비식별홈 · 비식별구장/)).toBeTruthy();
    expect(screen.getByText("5회 초 · 8번 타자")).toBeTruthy();
    expect(screen.getByText("안타 → 실책")).toBeTruthy();
    expect(screen.getByText("사용자가 비식별 경기와 플레이 후보를 선택했습니다.")).toBeTruthy();
    expect(screen.getByText("비식별 원정팀 가상타자 기록과 판정 정정")).toBeTruthy();
    expect(screen.getByText("안타: 3 → 2")).toBeTruthy();
    expect(screen.getByText("파생 검증")).toBeTruthy();
    queryClient.clear();
  });
});

function anonymizedSession(): CorrectionSession {
  const document = parseStagingGameDocumentV2(
    makeDocument([{ kind: "half_inning_start", payload: {}, relayText: "1회초 시작" }]),
  );
  return {
    sessionId: "anonymous-session",
    authority: "quarantine",
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

function anonymizedCorrectionCase(): RecordCorrectionCase {
  return {
    noticeId: "2024:0:10",
    season: 2024,
    sourceRevision: 1,
    caseVersion: 1,
    status: "manual_review",
    gameId: "anonymous-game",
    gameRevision: 1,
    eventId: "anonymous-event",
    reasonCode: "manual_candidate_selected",
    reasonMessage: "사용자가 비식별 경기와 플레이 후보를 선택했습니다.",
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
      contentText: "비식별 원정팀 가상타자 기록과 판정 정정",
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
          rawStatName: "안타",
          statCode: "hits",
          scope: "batter",
          beforeValue: 3,
          afterValue: 2,
          supportKind: "direct",
        },
        {
          statIndex: 1,
          participantIndex: 0,
          rawStatName: "루타",
          statCode: "total_bases",
          scope: "batter",
          beforeValue: 4,
          afterValue: 3,
          supportKind: "derived",
        },
      ],
    },
    candidates: [],
  };
}

function anonymizedProposal(): RecordCorrectionProposal {
  return {
    noticeId: "2024:0:10",
    caseVersion: 1,
    sessionId: "anonymous-session",
    sessionVersion: 0,
    baseDocumentHash: "0".repeat(64),
    noticeSourceHash: "a".repeat(64),
    proposalHash: "b".repeat(64),
    eligible: false,
    reasons: ["수동 확인이 필요합니다."],
    changes: [],
    batch: null,
    preview: null,
  };
}
