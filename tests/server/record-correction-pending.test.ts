import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseStagingGameDocumentV2,
  type RecordCorrectionCase,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { StagingWorkspace, type RecordCorrectionAssessmentInput } from "@kbo/persistence";
import { describe, expect, it, vi } from "vitest";

import { CorrectionSessionManager } from "../../apps/server/src/correction-session-manager.js";
import { RecordCorrectionService } from "../../apps/server/src/record-correction-service.js";
import { recordCorrectionFixture } from "../helpers/record-correction-fixture.js";

describe("미처리 기록정정 실제 자료 회귀", () => {
  it("누락 2루타는 KBO 공지로 보완하고 제안·undo/redo·저장 대기까지 기존 경로를 따른다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-notice-fill-"));
    const fixture = await setup(temporary.path, "missing-double");
    try {
      const item = await fixture.service.assessNotice(fixture.notice);
      expect(item.status).toBe("action_required");
      const opened = await fixture.service.createDraft(item.noticeId);
      const proposal = await fixture.service.proposal(opened.sessionId, item.noticeId);
      expect(proposal.eligible).toBe(true);
      expect(proposal.changes).toContainEqual(
        expect.objectContaining({
          kind: "official_batter",
          field: "doubles",
          beforeValue: null,
          afterValue: 1,
          state: "change",
        }),
      );
      expect(proposal.batch?.commands).toHaveLength(1);
      const applied = await fixture.service.applyProposal(
        opened.sessionId,
        item.noticeId,
        opened.sessionVersion,
        proposal.proposalHash,
      );
      expect(applied.session.blockingCount).toBe(0);
      expect(applied.session.draftDocument.events).toEqual(fixture.document.events);
      const undone = await fixture.sessions.undo(opened.sessionId, applied.session.sessionVersion);
      expect(undone.session.draftDocument).toEqual(fixture.document);
      const redone = await fixture.sessions.redo(opened.sessionId, undone.session.sessionVersion);
      await fixture.sessions.commit(opened.sessionId, {
        expectedSessionVersion: redone.session.sessionVersion,
        allowBlockingStaging: false,
      });
      expect((await fixture.service.case(item.noticeId))?.draftProgress?.state).toBe(
        "ready_to_import",
      );
    } finally {
      fixture.sessions.close();
      await fixture.workspace.close();
    }
  });

  it("명시적으로 저장된 충돌값은 미제공 보완으로 덮어쓰지 않는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-notice-conflict-"));
    const fixture = await setup(temporary.path, "missing-double");
    try {
      fixture.setDocument(
        parseStagingGameDocumentV2({
          ...fixture.document,
          officialRecords: {
            ...fixture.document.officialRecords,
            batters: fixture.document.officialRecords.batters.map((line) => ({
              ...line,
              doubles: 0,
            })),
          },
        }),
      );
      expect(await fixture.service.assessNotice(fixture.notice)).toMatchObject({
        status: "manual_review",
        reasonCode: "proposal_conflict",
      });
    } finally {
      fixture.sessions.close();
      await fixture.workspace.close();
    }
  });

  it("공지의 여러 투수와 각 자책점을 분리하고 참가자 나열 순서에 의존하지 않는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-notice-pitchers-"));
    const fixture = await setup(temporary.path, "multiple-pitchers");
    try {
      const before = await fixture.service.assessNotice(fixture.notice);
      expect(before.reasonMessage).not.toContain("자책점");
      expect(before.eventId).not.toBeNull();
      const corrected = parseStagingGameDocumentV2({
        ...fixture.document,
        events: fixture.document.events.map((event) =>
          event.identity.eventId === before.eventId && event.kind === "plate_result"
            ? { ...event, payload: { ...event.payload, result: "reached_on_error" } }
            : event,
        ),
      });
      fixture.setDocument(corrected);
      for (const participants of [
        fixture.notice.participants,
        [...fixture.notice.participants].reverse(),
      ]) {
        expect(
          await fixture.service.assessNotice({ ...fixture.notice, participants }),
        ).toMatchObject({ status: "already_applied", eventId: before.eventId });
      }
      await fixture.workspace.saveReady(corrected, []);
      const opened = await fixture.service.createDraft(fixture.notice.noticeId);
      const proposal = await fixture.service.proposal(opened.sessionId, fixture.notice.noticeId);
      expect(proposal.reasons).toEqual([]);
      const earnedRuns = proposal.changes.filter(
        (change) => change.kind === "official_pitcher" && change.field === "earnedRuns",
      );
      expect(new Set(earnedRuns.map((change) => change.playerId)).size).toBe(2);
      expect(earnedRuns.map((change) => change.afterValue).sort()).toEqual([0, 2]);
      expect(earnedRuns.every((change) => change.state === "already_applied")).toBe(true);
    } finally {
      fixture.sessions.close();
      await fixture.workspace.close();
    }
  });

  it("대주자의 교체 타순은 수비위치 변경 뒤에도 유지하고 타순 불일치는 계속 거부한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-notice-order-"));
    const fixture = await setup(temporary.path, "pinch-runner-order");
    try {
      const before = JSON.stringify(fixture.document);
      const item = await fixture.service.assessNotice(fixture.notice);
      expect(item.status).toBe("already_applied");
      const batterId = item.candidates[0]?.batterPlayerId;
      expect(
        fixture.document.rosters.away.players.find((player) => player.playerId === batterId)
          ?.battingOrder,
      ).toBeUndefined();
      expect(
        await fixture.service.assessNotice({ ...fixture.notice, battingOrder: 9 }),
      ).toMatchObject({ reasonCode: "play_not_found" });
      expect(JSON.stringify(fixture.document)).toBe(before);
      fixture.setDocument(
        parseStagingGameDocumentV2({
          ...fixture.document,
          events: fixture.document.events.map((event) => {
            if (event.kind !== "substitution" || event.payload.incomingPlayerId !== batterId)
              return event;
            const payload = { ...event.payload };
            delete payload.battingOrder;
            return { ...event, payload };
          }),
        }),
      );
      expect(await fixture.service.assessNotice(fixture.notice)).toMatchObject({
        status: "already_applied",
      });
    } finally {
      fixture.sessions.close();
      await fixture.workspace.close();
    }
  });
});

async function setup(root: string, name: Parameters<typeof recordCorrectionFixture>[0]) {
  const source = await recordCorrectionFixture(name);
  const gameId = source.document.metadata.gameId;
  let document = parseStagingGameDocumentV2({
    ...source.document,
    revisionBase: { kind: "sealed_revision", revision: 1, documentHash: "b".repeat(64) },
  });
  const workspace = await StagingWorkspace.open(root);
  const sessions = new CorrectionSessionManager(workspace);
  let item: RecordCorrectionCase | null = null;
  const assess = vi.fn(
    async (input: RecordCorrectionAssessmentInput): Promise<RecordCorrectionCase> => {
      item = {
        ...input,
        season: document.metadata.season,
        sourceRevision: 1,
        caseVersion: (item?.caseVersion ?? 0) + 1,
        appliedRevision: null,
        notice: source.notice,
        candidates: [...input.candidates],
      };
      return item;
    },
  );
  const service = new RecordCorrectionService(
    {
      assess,
      case: async () => item,
      gameCandidates: async () => [
        {
          gameId,
          revision: 1,
          documentHash: "b".repeat(64),
          sourceGameId: document.source.sourceGameId,
          gameDate: document.metadata.gameDate,
          stadium: document.metadata.stadium ?? null,
          awayTeamName: document.teams.away.name,
          homeTeamName: document.teams.home.name,
        },
      ],
      listCases: async () => (item === null ? [] : [item]),
      listCaseSummaries: async () => [],
      markProposalApplied: async () => undefined,
      markResolvedIfImported: async () => [],
      markResolvedAfterReassessment: async () => true,
      reviewAction: async () => {
        throw new Error("unexpected review action");
      },
    },
    {
      loadCorrectionDraft: async () => document,
      currentRevisionBase: async () => ({
        revision: 1,
        documentHash: "b".repeat(64),
        sourceBundleHash: document.source.sourceBundleHash,
      }),
    },
    workspace,
    sessions,
  );
  return {
    document,
    notice: source.notice,
    service,
    workspace,
    sessions,
    setDocument(value: StagingGameDocumentV2) {
      document = value;
    },
  };
}
