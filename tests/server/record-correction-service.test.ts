import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseStagingGameDocumentV2,
  type CorrectionSession,
  type RecordCorrectionCase,
  type RecordCorrectionNotice,
} from "@kbo/contracts";
import {
  StagingWorkspace,
  type RecordCorrectionAssessmentInput,
  type RecordCorrectionGameCandidate,
} from "@kbo/persistence";
import { describe, expect, it, vi } from "vitest";

import { CorrectionSessionManager } from "../../apps/server/src/correction-session-manager.js";
import {
  RecordCorrectionConflictError,
  RecordCorrectionService,
} from "../../apps/server/src/record-correction-service.js";

describe("RecordCorrectionService 매칭", () => {
  it("날짜·팀·구장과 유일한 PA가 맞으면 미반영 제안을 분류한다", async () => {
    const fixture = await setup([game("anon-game", "anon_DH1")]);

    await expect(fixture.service.assessNotice(fixture.notice)).resolves.toMatchObject({
      status: "action_required",
      reasonCode: "supported_change_available",
      gameId: "anon-game",
      eventId: "e10",
    });
  });

  it("복수 경기에서 DH identity를 확정할 수 없으면 단일 PA 후보여도 수동 검토한다", async () => {
    const fixture = await setup([game("anon-game-1", "anon_DH1"), game("anon-game-2", "anon_DH2")]);

    await expect(fixture.service.assessNotice(fixture.notice)).resolves.toMatchObject({
      status: "manual_review",
      reasonCode: "ambiguous_game_identity",
    });
    expect(fixture.assess.mock.calls[0]?.[0].candidates).toHaveLength(2);
  });

  it("공지 DH1과 Naver source identity가 맞는 경기만 자동 선택한다", async () => {
    const fixture = await setup([game("anon-game-1", "anon_DH1"), game("anon-game-2", "anon_DH2")]);

    await expect(
      fixture.service.assessNotice({ ...fixture.notice, doubleheaderNumber: 1 }),
    ).resolves.toMatchObject({
      status: "action_required",
      gameId: "anon-game-1",
    });
  });

  it("적용하거나 검증할 수 없는 변경만 있으면 수동 검토가 아닌 지원 범위 외로 분류한다", async () => {
    const fixture = await setup([game("anon-game", "anon_DH1")]);
    const notice: RecordCorrectionNotice = {
      ...fixture.notice,
      decisionBefore: "unknown",
      decisionAfter: "unknown",
      beforeRecordText: "비식별 판정",
      afterRecordText: "비식별 판정",
      statChanges: [
        {
          statIndex: 0,
          participantIndex: 1,
          rawStatName: "희비",
          statCode: "unknown",
          scope: "pitcher",
          beforeValue: 1,
          afterValue: 0,
          supportKind: "unknown",
        },
      ],
    };

    await expect(fixture.service.assessNotice(notice)).resolves.toMatchObject({
      status: "out_of_scope",
      reasonCode: "evidence_only_notice",
      gameId: null,
      eventId: null,
      candidates: [],
    });
  });

  it("proposal hash가 stale이면 session을 바꾸지 않고 정상 batch는 한 번에 undo한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-record-correction-"));
    const fixture = await setup([game("golden-game-1", "anon_DH1")]);
    const item = await fixture.service.assessNotice(fixture.notice);
    const workspace = await StagingWorkspace.open(temporary.path);
    await workspace.saveReady(fixture.document, []);
    const sessions = new CorrectionSessionManager(workspace);
    const service = new RecordCorrectionService(
      fixture.repository,
      { loadCorrectionDraft: async () => fixture.document },
      workspace,
      sessions,
      () => new Date("2026-09-01T00:00:00.000Z"),
    );
    const session = await sessions.create({
      gameId: fixture.document.metadata.gameId,
      authority: "staging",
    });
    const proposal = await service.proposal(session.sessionId, item.noticeId);
    await expect(
      service.applyProposal(
        session.sessionId,
        item.noticeId,
        session.sessionVersion,
        "f".repeat(64),
      ),
    ).rejects.toThrow(RecordCorrectionConflictError);
    expect(sessions.get(session.sessionId).sessionVersion).toBe(session.sessionVersion);

    const applied = await service.applyProposal(
      session.sessionId,
      item.noticeId,
      session.sessionVersion,
      proposal.proposalHash,
    );
    expect(applied.session.sessionVersion).toBe(session.sessionVersion + 1);
    expect(fixture.markProposalApplied).toHaveBeenCalledOnce();
    const undone = sessions.undo(session.sessionId, applied.session.sessionVersion);
    expect(resultOf(undone.session, "e10")).toBe("single");
    sessions.close();
    await workspace.close();
  });

  it("수동으로 고친 새 revision이 정정 후 상태이면 import 뒤 해결 처리한다", async () => {
    const fixture = await setup([game("anon-game", "anon_DH1")]);
    await expect(fixture.service.assessNotice(fixture.notice)).resolves.toMatchObject({
      status: "action_required",
      gameRevision: 1,
    });
    const corrected = parseStagingGameDocumentV2({
      ...fixture.document,
      events: fixture.document.events.map((event) =>
        event.identity.eventId === "e10" && event.kind === "plate_result"
          ? { ...event, payload: { ...event.payload, result: "reached_on_error" } }
          : event,
      ),
    });
    fixture.setDocument(corrected);
    fixture.setGameCandidates([
      { ...game("anon-game", "anon_DH1"), revision: 2, documentHash: "c".repeat(64) },
    ]);

    await fixture.service.afterImport("anon-game", 2, "c".repeat(64));

    expect(fixture.assess).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "already_applied", gameRevision: 2 }),
    );
    expect(fixture.markResolvedAfterReassessment).toHaveBeenCalledWith({
      noticeId: fixture.notice.noticeId,
      caseVersion: 2,
      gameId: "anon-game",
      revision: 2,
      documentHash: "c".repeat(64),
    });
  });
});

async function setup(gameCandidates: readonly RecordCorrectionGameCandidate[]) {
  let document = parseStagingGameDocumentV2(
    JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
  );
  let candidates = [...gameCandidates];
  const notice: RecordCorrectionNotice = {
    noticeId: "2024:0:700",
    noticeHash: "a".repeat(64),
    sourceRequestKey: "records:2024:0:1",
    sourceRowIndex: 0,
    seriesId: 0,
    seriesName: "정규시즌",
    recordNumber: 700,
    gameDate: document.metadata.gameDate,
    weekdayText: "",
    awayTeamName: document.teams.away.name,
    homeTeamName: document.teams.home.name,
    doubleheaderNumber: null,
    venueName: document.metadata.stadium ?? "비식별구장",
    inning: 1,
    half: "top",
    battingOrder: 2,
    decisionBefore: "hit",
    decisionAfter: "error",
    beforeRecordText: "안타",
    afterRecordText: "실책",
    contentText: "비식별 fixture",
    correctionDateText: "01.01",
    participants: [
      {
        participantIndex: 0,
        rawTeamName: null,
        rawPlayerName: "원정2",
        role: "batter",
        parenthesized: false,
      },
      {
        participantIndex: 1,
        rawTeamName: null,
        rawPlayerName: "선발투수",
        role: "pitcher",
        parenthesized: true,
      },
    ],
    statChanges: [],
  };
  let currentCase: RecordCorrectionCase | null = null;
  const assess = vi.fn(
    async (input: RecordCorrectionAssessmentInput): Promise<RecordCorrectionCase> => {
      currentCase = {
        noticeId: input.noticeId,
        season: 2024,
        sourceRevision: 1,
        caseVersion: (currentCase?.caseVersion ?? 0) + 1,
        status: input.status,
        gameId: input.gameId,
        gameRevision: input.gameRevision,
        eventId: input.eventId,
        reasonCode: input.reasonCode,
        reasonMessage: input.reasonMessage,
        proposalHash: input.proposalHash,
        appliedRevision: null,
        assessedAt: input.assessedAt,
        notice,
        candidates: [...input.candidates],
      };
      return currentCase;
    },
  );
  const markProposalApplied = vi.fn(async () => undefined);
  const markResolvedAfterReassessment = vi.fn(async () => true);
  const repository = {
    assess,
    case: async () => currentCase,
    gameCandidates: async () => [...candidates],
    listCases: async () => (currentCase === null ? [] : [currentCase]),
    markProposalApplied,
    markResolvedAfterReassessment,
    markResolvedIfImported: async () => [],
    reviewAction: async () => {
      throw new Error("unexpected review action");
    },
  };
  const service = new RecordCorrectionService(
    repository,
    { loadCorrectionDraft: async () => document },
    {
      saveQuarantine: async () => undefined,
      saveReady: async () => undefined,
    },
    {
      command: () => {
        throw new Error("unexpected command");
      },
      create: async () => {
        throw new Error("unexpected create");
      },
      get: () => {
        throw new Error("unexpected get");
      },
    },
    () => new Date("2026-09-01T00:00:00.000Z"),
  );
  return {
    assess,
    document,
    markProposalApplied,
    markResolvedAfterReassessment,
    notice,
    repository,
    service,
    setDocument(value: typeof document): void {
      document = value;
    },
    setGameCandidates(value: readonly RecordCorrectionGameCandidate[]): void {
      candidates = [...value];
    },
  };
}

function resultOf(session: CorrectionSession, eventId: string): string | null {
  const event = session.draftDocument.events.find((item) => item.identity.eventId === eventId);
  return event?.kind === "plate_result" ? event.payload.result : null;
}

function game(gameId: string, sourceGameId: string): RecordCorrectionGameCandidate {
  return {
    gameId,
    revision: 1,
    documentHash: "b".repeat(64),
    sourceGameId,
    gameDate: "2024-01-01",
    stadium: "비식별구장",
    awayTeamName: "비식별원정",
    homeTeamName: "비식별홈",
  };
}
