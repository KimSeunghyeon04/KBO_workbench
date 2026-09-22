import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  RecordCorrectionNoticeSchema,
  StagingGameDocumentV2Schema,
  type RecordCorrectionCase,
  type StoredFinding,
} from "@kbo/contracts";
import { stagingDocumentHash } from "@kbo/game-core";
import {
  RevisionConflictError,
  StagingWorkspace,
  type RecordCorrectionAssessmentInput,
} from "@kbo/persistence";
import { describe, expect, it, vi } from "vitest";

import { CorrectionSessionManager } from "../../apps/server/src/correction-session-manager.js";
import { inlineComputation } from "../../apps/server/src/computation.js";
import {
  RecordCorrectionConflictError,
  RecordCorrectionService,
} from "../../apps/server/src/record-correction-service.js";

describe("기록정정 초안의 current revision과 작업본 보존", () => {
  it("여러 공지가 같은 작업본을 참조해도 요청당 한 번 읽고 다음 조회에서 재검증한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-notice-shared-read-"));
    const fixture = await setup(temporary.path, 8);
    const compute = vi.spyOn(inlineComputation, "run");
    try {
      await fixture.service.createDraft(fixture.notice.noticeId);
      const read = vi.spyOn(fixture.workspace, "readCurrentDocumentSnapshot");
      const list = await fixture.service.listCaseSummaries();
      expect(list).toHaveLength(8);
      expect(read).toHaveBeenCalledTimes(1);
      const initialProposals = compute.mock.calls.filter(
        ([input]) => input.kind === "proposal",
      ).length;
      expect(initialProposals).toBeGreaterThan(0);
      await fixture.service.listCaseSummaries();
      expect(read).toHaveBeenCalledTimes(2);
      expect(compute.mock.calls.filter(([input]) => input.kind === "proposal")).toHaveLength(
        initialProposals,
      );
    } finally {
      compute.mockRestore();
      fixture.sessions.close();
      await fixture.workspace.close();
    }
  });
  it("제안 적용만으로 완료 표시하지 않고 저장·되돌림에 따라 목록과 상세 진행 상태를 재검증한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-notice-progress-"));
    const fixture = await setup(temporary.path);
    try {
      expect((await fixture.service.case(fixture.notice.noticeId))?.draftProgress).toBeUndefined();
      const opened = await fixture.service.createDraft(fixture.notice.noticeId);
      const before = await fixture.service.case(fixture.notice.noticeId);
      expect(before?.draftProgress?.state).toBe("needs_review");
      const proposal = await fixture.service.proposal(opened.sessionId, opened.noticeId);
      const applied = await fixture.service.applyProposal(
        opened.sessionId,
        opened.noticeId,
        opened.sessionVersion,
        proposal.proposalHash,
      );
      expect((await fixture.service.case(opened.noticeId))?.draftProgress?.state).toBe(
        "needs_review",
      );
      await fixture.sessions.commit(opened.sessionId, {
        expectedSessionVersion: applied.session.sessionVersion,
        allowBlockingStaging: false,
      });
      const saved = await fixture.service.case(opened.noticeId);
      expect(saved).toMatchObject({
        status: "action_required",
        caseVersion: before?.caseVersion,
        draftProgress: { state: "ready_to_import", blockingCount: 0 },
      });
      const list = await fixture.service.listCaseSummaries();
      expect(list[0]?.draftProgress).toEqual(saved?.draftProgress);
      expect(list[0]).not.toHaveProperty("notice");
      expect(fixture.assess).toHaveBeenCalledOnce();
      await fixture.workspace.saveReady(fixture.document, []);
      expect((await fixture.service.case(opened.noticeId))?.draftProgress?.state).toBe(
        "needs_review",
      );
    } finally {
      fixture.sessions.close();
      await fixture.workspace.close();
    }
  });

  it("저장된 정정이 맞아도 원천 차단 또는 stale base가 있으면 적재 대기로 표시하지 않는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-notice-progress-"));
    const fixture = await setup(temporary.path);
    try {
      const opened = await fixture.service.createDraft(fixture.notice.noticeId);
      const proposal = await fixture.service.proposal(opened.sessionId, opened.noticeId);
      const applied = await fixture.service.applyProposal(
        opened.sessionId,
        opened.noticeId,
        opened.sessionVersion,
        proposal.proposalHash,
      );
      const corrected = applied.session.draftDocument;
      await fixture.workspace.saveQuarantine(corrected, [
        {
          producer: "collection",
          lifecycle: "persistent",
          category: "source",
          severity: "blocking",
          code: "source.manual_review",
          message: "비식별 검토",
        },
      ]);
      expect((await fixture.service.case(opened.noticeId))?.draftProgress).toMatchObject({
        state: "needs_review",
        blockingCount: 1,
      });
      await fixture.workspace.saveReady(
        {
          ...corrected,
          revisionBase: { kind: "sealed_revision", revision: 1, documentHash: "c".repeat(64) },
        },
        [],
      );
      expect((await fixture.service.case(opened.noticeId))?.draftProgress?.state).toBe(
        "stale_base",
      );
    } finally {
      fixture.sessions.close();
      await fixture.workspace.close();
    }
  });
  it("구속 보완 뒤 남은 revision 1 공지를 재평가하고 revision 2 초안을 연다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-notice-draft-"));
    const fixture = await setup(temporary.path);
    try {
      const opened = await fixture.service.createDraft(fixture.notice.noticeId);
      const session = fixture.sessions.get(opened.sessionId);
      expect(session.draftDocument).toEqual(fixture.document);
      expect(fixture.loadCorrectionDraft.mock.calls.every((call) => call[1] === 2)).toBe(true);
      expect(fixture.assess).toHaveBeenCalledWith(
        expect.objectContaining({ status: "action_required", gameRevision: 2 }),
      );
      const proposal = await fixture.service.proposal(opened.sessionId, opened.noticeId);
      expect(proposal.eligible).toBe(true);
      expect(proposal.changes.filter((change) => change.state === "change")).toEqual([
        expect.objectContaining({ field: "sacrificeBunts", beforeValue: 0, afterValue: 1 }),
      ]);
      const repeated = await fixture.service.createDraft(fixture.notice.noticeId);
      expect(fixture.sessions.get(repeated.sessionId).draftDocument).toEqual(fixture.document);
      expect(fixture.assess).toHaveBeenCalledOnce();
    } finally {
      fixture.sessions.close();
      await fixture.workspace.close();
    }
  });

  it.each(["staging", "quarantine"] as const)(
    "기존 %s 작업본의 수동 수정·구속·구종·이전 base와 findings를 그대로 연다",
    async (authority) => {
      await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-notice-draft-"));
      const fixture = await setup(temporary.path);
      try {
        const edited = {
          ...fixture.document,
          revisionBase: {
            kind: "sealed_revision" as const,
            revision: 1,
            documentHash: "c".repeat(64),
          },
          events: fixture.document.events.map((event) =>
            event.kind === "pitch"
              ? {
                  ...event,
                  relayText: "수동 확인한 투구",
                  payload: { ...event.payload, speedKph: 149.5, pitchType: "직구" },
                }
              : event,
          ),
        };
        const findings: StoredFinding[] =
          authority === "quarantine"
            ? [
                {
                  producer: "collection",
                  lifecycle: "persistent",
                  category: "source",
                  severity: "blocking",
                  code: "source.manual_review",
                  message: "비식별 원천 수동 검토",
                },
              ]
            : [];
        if (authority === "quarantine") await fixture.workspace.saveQuarantine(edited, findings);
        else await fixture.workspace.saveReady(edited, findings);
        const before = await fixture.workspace.readCurrentDocumentSnapshot(edited.metadata.gameId);
        const opened = await fixture.service.createDraft(fixture.notice.noticeId);
        const session = fixture.sessions.get(opened.sessionId);
        expect(session.draftDocument).toEqual(edited);
        expect(session.authority).toBe(authority);
        expect(await fixture.workspace.readCurrentDocumentSnapshot(edited.metadata.gameId)).toEqual(
          before,
        );
        expect(fixture.loadCorrectionDraft).not.toHaveBeenCalled();
        expect(fixture.assess).not.toHaveBeenCalled();
        // A draft that appeared during the DB read is also authoritative at the write boundary.
        vi.spyOn(fixture.workspace, "readCurrentDocumentSnapshot").mockResolvedValueOnce(null);
        expect(await fixture.workspace.ensureCorrectionDraft(fixture.document, [])).toEqual(before);
      } finally {
        fixture.sessions.close();
        await fixture.workspace.close();
      }
    },
  );

  it("새 revision에서 대상 타석이 사라지면 후보를 갱신하고 초안을 만들지 않는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-notice-draft-"));
    const fixture = await setup(temporary.path);
    try {
      fixture.loadCorrectionDraft.mockResolvedValue({
        ...fixture.document,
        events: fixture.document.events
          .filter((event) => event.identity.eventId !== fixture.eventId)
          .map((event, sequence) => ({ ...event, sequence })),
      });
      await expect(fixture.service.createDraft(fixture.notice.noticeId)).rejects.toThrow(
        RecordCorrectionConflictError,
      );
      expect(fixture.assess).toHaveBeenCalledWith(
        expect.objectContaining({ status: "manual_review", eventId: null }),
      );
      expect(
        await fixture.workspace.readCurrentDocumentSnapshot(fixture.document.metadata.gameId),
      ).toBeNull();
    } finally {
      fixture.sessions.close();
      await fixture.workspace.close();
    }
  });
});

async function setup(root: string, copies = 1) {
  const source = Value.Parse(
    Type.Object(
      {
        notice: RecordCorrectionNoticeSchema,
        document: StagingGameDocumentV2Schema,
        assessedRevision: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    JSON.parse(
      await readFile(
        "tests/fixtures/correction/record-correction-stale-revision.anonymized.json",
        "utf8",
      ),
    ) as unknown,
  );
  const { document, notice } = source;
  const base = document.revisionBase;
  if (base.kind !== "sealed_revision") throw new Error("sealed fixture base 필요");
  const batterName = notice.participants.find(
    (participant) => participant.role === "batter",
  )?.rawPlayerName;
  const batter = document.rosters.home.players.find((player) => player.name === batterName);
  const event = document.events.find(
    (event) =>
      event.kind === "plate_result" &&
      event.inning === notice.inning &&
      event.half === notice.half &&
      event.payload.batterId === batter?.playerId,
  );
  if (event?.kind !== "plate_result") throw new Error("비식별 실제 타석 fixture 필요");
  let item: RecordCorrectionCase = {
    noticeId: notice.noticeId,
    season: document.metadata.season,
    sourceRevision: 1,
    caseVersion: 1,
    status: "action_required",
    gameId: document.metadata.gameId,
    gameRevision: source.assessedRevision,
    eventId: event.identity.eventId,
    reasonCode: "supported_change_available",
    reasonMessage: "이전 revision에서 평가한 정정",
    proposalHash: null,
    appliedRevision: null,
    assessedAt: "2026-09-01T00:00:00.000Z",
    notice,
    candidates: [],
  };
  const assess = vi.fn(async (input: RecordCorrectionAssessmentInput) => {
    item = {
      ...item,
      caseVersion: item.caseVersion + 1,
      status: input.status,
      gameId: input.gameId,
      gameRevision: input.gameRevision,
      eventId: input.eventId,
      reasonCode: input.reasonCode,
      reasonMessage: input.reasonMessage,
      candidates: [...input.candidates],
    };
    return item;
  });
  const loadCorrectionDraft = vi.fn(async (_gameId: string, revision: number) => {
    if (revision !== base.revision)
      throw new RevisionConflictError("current revision만 교정 초안으로 열 수 있습니다: current=2");
    return document;
  });
  const workspace = await StagingWorkspace.open(root);
  const sessions = new CorrectionSessionManager(workspace);
  const service = new RecordCorrectionService(
    {
      case: async () => item,
      assess,
      gameCandidates: async () => [
        {
          gameId: document.metadata.gameId,
          revision: base.revision,
          documentHash: base.documentHash,
          sourceGameId: document.source.sourceGameId,
          gameDate: document.metadata.gameDate,
          stadium: document.metadata.stadium ?? "비식별구장",
          awayTeamName: document.teams.away.name,
          homeTeamName: document.teams.home.name,
        },
      ],
      listCases: async () => [item],
      listCaseSummaries: async () =>
        Array.from({ length: copies }, (_, i) => ({
          noticeId: `${item.noticeId}-${String(i)}`,
          caseVersion: item.caseVersion,
          status: item.status,
          season: item.season,
          gameId: item.gameId,
          assessedAt: item.assessedAt,
          gameDate: notice.gameDate,
          awayTeamName: notice.awayTeamName,
          homeTeamName: notice.homeTeamName,
          venueName: notice.venueName,
          beforeRecordText: notice.beforeRecordText,
          afterRecordText: notice.afterRecordText,
        })),
      markProposalApplied: async () => undefined,
      markResolvedAfterReassessment: async () => false,
      markResolvedIfImported: async () => [],
      reviewAction: async () => item,
    },
    {
      loadCorrectionDraft,
      currentRevisionBase: async () => ({
        revision: base.revision,
        documentHash: base.documentHash,
        sourceBundleHash: document.source.sourceBundleHash,
      }),
    },
    workspace,
    sessions,
  );
  expect(stagingDocumentHash(document)).toMatch(/^[a-f0-9]{64}$/);
  return {
    workspace,
    sessions,
    service,
    document,
    notice,
    assess,
    loadCorrectionDraft,
    eventId: event.identity.eventId,
  };
}
