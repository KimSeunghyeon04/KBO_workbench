import { createHash } from "node:crypto";

import {
  canonicalStringify,
  recordCorrectionSupportKind,
  type CorrectionMutationResult,
  type CorrectionSession,
  type ImportTarget,
  type RecordCorrectionApprovalReference,
  type RecordCorrectionCase,
  type RecordCorrectionDraftProgress,
  type RecordCorrectionListItem,
  type RecordCorrectionMatchCandidate,
  type RecordCorrectionNotice,
  type RecordCorrectionProposal,
  type RecordCorrectionReviewActionRequest,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { normalizeKboRecordCorrectionNotice } from "@kbo/collection";
import {
  type RecordCorrectionAfterFact,
  type RecordCorrectionProposalBinding,
  type BuiltRecordCorrectionProposal,
} from "@kbo/correction";
import { stagingDocumentHash } from "@kbo/game-core";
import {
  RecordCorrectionStaleError,
  RevisionConflictError,
  matchesRecordCorrectionDoubleheader,
  recordCorrectionEligibleGames,
} from "@kbo/persistence";
import type {
  GameRevisionStore,
  RecordCorrectionApprovalEvidence,
  RecordCorrectionApprovalPlan,
  RecordCorrectionGameCandidate,
  RecordCorrectionMatchupContext,
  RecordCorrectionRepository,
  StagingWorkspace,
} from "@kbo/persistence";

import type { CorrectionSessionManager } from "./correction-session-manager.js";
import { mergePersistentSourceFindings } from "./correction-session-manager.js";
import {
  openCorrectionDraft,
  type DraftRevisionStore,
  type DraftWorkspace,
} from "./open-correction-draft.js";
import { BoundedReadCache } from "./bounded-read-cache.js";
import { compileDocument, inlineComputation, type ComputationRunner } from "./computation.js";

type RevisionStore = DraftRevisionStore & Pick<GameRevisionStore, "currentRevisionBase">;
type SessionManager = Pick<
  CorrectionSessionManager,
  "approvalReferences" | "approveCurrent" | "command" | "create" | "get"
> &
  Partial<Pick<CorrectionSessionManager, "hasIndependentRecordCorrectionBase">>;
type Workspace = DraftWorkspace & Pick<StagingWorkspace, "correctionGameCatalog">;
type Repository = Pick<
  RecordCorrectionRepository,
  | "assess"
  | "assessmentBasis"
  | "pendingNoticeIds"
  | "case"
  | "caseSnapshot"
  | "listCases"
  | "listNoticeIdsForImport"
  | "listCaseSummaries"
  | "markProposalApplied"
  | "reviewAction"
> &
  Partial<
    Pick<
      RecordCorrectionRepository,
      "approvalEvidence" | "approvalHistory" | "markProposalBundle" | "matchupContext"
    >
  >;

interface CandidateIntent {
  readonly notice: RecordCorrectionNotice;
  readonly binding: RecordCorrectionProposalBinding;
}

interface PreparedProposal {
  readonly proposal: RecordCorrectionProposal;
  readonly generation?: number;
  readonly documentHash?: string;
  readonly approvalPlan?: RecordCorrectionApprovalPlan;
}

const conflictingNotice =
  "같은 경기의 유효한 다른 공지와 충돌합니다. 공지와 경기·타석 선택을 검토하세요.";
const unprovedDraft =
  "현재 작업 사본의 KBO 기록정정 승인을 확인할 수 없습니다. 작업본 전체와 공지를 다시 검토하세요.";

export class RecordCorrectionNotFoundError extends Error {}
export class RecordCorrectionConflictError extends Error {}

export class RecordCorrectionService {
  private drain: Promise<void> | undefined;
  private pendingTimer: ReturnType<typeof setInterval> | undefined;
  private pendingCursor = "";
  private readonly proposals = new BoundedReadCache<BuiltRecordCorrectionProposal>(
    8 * 1024 * 1024,
    128,
    300_000,
  );
  private readonly compiled = new BoundedReadCache<Awaited<ReturnType<typeof compileDocument>>>(
    16 * 1024 * 1024,
    16,
    300_000,
  );
  public constructor(
    private readonly repository: Repository,
    private readonly revisionStore: RevisionStore,
    private readonly workspace: Workspace,
    private readonly sessions: SessionManager,
    private readonly now: () => Date = () => new Date(),
    private readonly computation: ComputationRunner = inlineComputation,
  ) {}

  public startPendingReconciliation(onError: (error: unknown) => void): void {
    if (this.pendingTimer !== undefined) return;
    const tick = () => {
      if (this.drain !== undefined) return;
      this.drain = this.reconcilePending(onError)
        .catch(onError)
        .finally(() => {
          this.drain = undefined;
        });
    };
    this.pendingTimer = setInterval(tick, 5_000);
    this.pendingTimer.unref();
    tick();
  }

  public async close(): Promise<void> {
    clearInterval(this.pendingTimer);
    await this.drain;
    this.proposals.clear();
    this.compiled.clear();
  }

  private async buildProposal(
    document: StagingGameDocumentV2,
    notice: RecordCorrectionNotice,
    binding: RecordCorrectionProposalBinding,
    documentHash = stagingDocumentHash(document),
  ): Promise<BuiltRecordCorrectionProposal> {
    const key = createHash("sha256")
      .update(canonicalStringify([documentHash, notice, binding]))
      .digest("hex");
    const value = await this.proposals.load(key, async () => {
      const result = await this.computation.run({ kind: "proposal", document, notice, binding });
      if (result.kind !== "proposal") throw new Error("Unexpected proposal result");
      return result.value;
    });
    return structuredClone(value);
  }

  public async assessSeason(season: number): Promise<void> {
    let after = "";
    for (;;) {
      const page = await this.repository.pendingNoticeIds(after, 32, season);
      for (const noticeId of page) await this.assessForJob(noticeId);
      const last = page.at(-1);
      if (last === undefined) return;
      after = last;
    }
  }

  public async assessNotice(notice: RecordCorrectionNotice): Promise<RecordCorrectionCase> {
    notice = normalizeKboRecordCorrectionNotice(notice);
    const {
      games: exactGameCandidates,
      selection,
      peers,
      caseVersion,
      ...basis
    } = await this.repository.assessmentBasis(notice);
    if (!hasActionableCorrection(notice))
      return this.assessCase(notice, {
        caseVersion,
        basis,
        gameBases: null,
        status: "out_of_scope",
        gameId: null,
        gameRevision: null,
        documentHash: null,
        eventId: null,
        batterPlayerId: null,
        pitcherPlayerId: null,
        reasonCode: "evidence_only_notice",
        reasonMessage:
          "현재 원장 계약에서 적용하거나 검증할 수 있는 플레이·통계 변경이 없어 원문 증거로만 보존합니다.",
        proposalHash: null,
        candidates: [],
        assessedAt: this.now().toISOString(),
      });
    if (exactGameCandidates.length === 0)
      return this.assessCase(notice, {
        caseVersion,
        basis,
        gameBases: [],
        status: selection === null ? "unmatched" : "manual_review",
        gameId: null,
        gameRevision: null,
        documentHash: null,
        eventId: null,
        batterPlayerId: null,
        pitcherPlayerId: null,
        reasonCode: selection === null ? "game_not_found" : "manual_candidate_stale",
        reasonMessage: "날짜와 원정·홈 팀이 일치하는 DB 경기를 찾지 못했습니다.",
        proposalHash: null,
        candidates: [],
        assessedAt: this.now().toISOString(),
      });

    const gameCandidates = recordCorrectionEligibleGames(
      exactGameCandidates,
      notice.doubleheaderNumber,
      null,
    );
    const eligible = gameCandidates.filter(
      (game) => selection === null || game.gameId === selection.gameId,
    );
    const candidates: RecordCorrectionMatchCandidate[] = [];
    const documents = new Map<string, StagingGameDocumentV2>();
    for (const game of gameCandidates) {
      const document = await this.revisionStore.loadCorrectionDraft(game.gameId, game.revision);
      documents.set(game.gameId, document);
      candidates.push(...(await this.matchCandidates(notice, game, document)));
    }
    const matches = candidates.filter(
      (candidate) => selection === null || samePlateAppearance(candidate, selection),
    );
    const gameIdentityAmbiguous = eligible.length !== 1;
    const candidate = gameIdentityAmbiguous || matches.length !== 1 ? undefined : matches[0];
    if (candidate === undefined) {
      const reasonCode =
        selection !== null
          ? "manual_candidate_stale"
          : gameCandidates.length === 0
            ? "specified_game_not_found"
            : gameIdentityAmbiguous
              ? "ambiguous_game_identity"
              : candidates.length === 0
                ? "play_not_found"
                : "ambiguous_play_match";
      return this.assessCase(notice, {
        caseVersion,
        basis,
        gameBases: exactGameCandidates,
        status: "manual_review",
        gameId: null,
        gameRevision: null,
        documentHash: null,
        eventId: null,
        batterPlayerId: null,
        pitcherPlayerId: null,
        reasonCode,
        reasonMessage:
          selection !== null
            ? "선택한 타석의 근거를 현재 경기에서 확인할 수 없습니다."
            : "공지와 현재 경기 정보로 유일한 경기·타석을 확정할 수 없습니다.",
        proposalHash: null,
        candidates,
        assessedAt: this.now().toISOString(),
      });
    }
    const document = documents.get(candidate.gameId);
    if (document === undefined) throw new Error("record correction 후보 원장 누락");
    const binding = buildBinding(document, notice, candidate);
    const built = binding === null ? null : await this.buildProposal(document, notice, binding);
    const hasChange = built?.changes.some((change) => change.state === "change") === true;
    const supported = built?.changes.some((change) => change.kind !== "evidence_only") === true;
    const selectedGame = gameCandidates.find((game) => game.gameId === candidate.gameId);
    const relatedConflict =
      selectedGame !== undefined &&
      binding !== null &&
      peers !== undefined &&
      (await this.hasPeerConflict(
        document,
        built?.eligible && built.batch !== null
          ? await this.applyBatch(document, built.batch)
          : document,
        selectedGame,
        { games: exactGameCandidates, notices: peers },
        [{ notice, binding }],
      ));
    const conflicts = (built?.reasons.length ?? 0) + Number(relatedConflict);
    const cannotApply = hasChange && (built?.eligible !== true || built.batch === null);
    const status =
      built === null || conflicts > 0 || !supported || cannotApply
        ? !supported && built !== null && conflicts === 0
          ? "out_of_scope"
          : "manual_review"
        : hasChange
          ? "action_required"
          : "already_applied";
    return this.assessCase(notice, {
      caseVersion,
      basis,
      gameBases: exactGameCandidates,
      status,
      gameId: candidate.gameId,
      gameRevision: candidate.revision,
      documentHash: candidate.documentHash,
      eventId: candidate.eventId,
      batterPlayerId: candidate.batterPlayerId,
      pitcherPlayerId: candidate.pitcherPlayerId,
      reasonCode:
        built === null
          ? "participant_resolution_failed"
          : relatedConflict
            ? "conflicting_active_notices"
            : conflicts > 0
              ? "proposal_conflict"
              : !supported
                ? "evidence_only_notice"
                : cannotApply
                  ? "proposal_not_applicable"
                  : hasChange
                    ? "supported_change_available"
                    : "kbo_after_state_satisfied",
      reasonMessage:
        built === null
          ? "공지 참가자를 경기 roster에서 유일하게 식별할 수 없습니다."
          : (relatedConflict ? conflictingNotice : built.reasons.join(" ")) ||
            (!supported
              ? "현 계약 범위 밖의 변경만 있어 증거로 보존했습니다."
              : cannotApply
                ? "미반영 변경이 있지만 적용 가능한 정정 명령을 만들 수 없어 수동 검토가 필요합니다."
                : hasChange
                  ? "검증 가능한 원자적 정정 제안을 만들었습니다."
                  : "현재 플레이와 지원 기록이 이미 KBO 정정 후 값입니다."),
      proposalHash: null,
      candidates,
      assessedAt: this.now().toISOString(),
    });
  }

  public async reviewAction(
    noticeId: string,
    request: RecordCorrectionReviewActionRequest,
  ): Promise<RecordCorrectionCase> {
    return this.withDraftProgress(
      normalizeCase(await this.repository.reviewAction(noticeId, request)),
    );
  }

  public async listCases(
    filters: Parameters<RecordCorrectionRepository["listCases"]>[0] = {},
  ): Promise<RecordCorrectionCase[]> {
    return (await this.repository.listCases(filters)).map(normalizeCase);
  }

  public async listCaseSummaries(
    filters: Parameters<RecordCorrectionRepository["listCaseSummaries"]>[0] = {},
  ): Promise<RecordCorrectionListItem[]> {
    const items = await this.repository.listCaseSummaries(filters);
    const candidates = new Set(
      items.flatMap((item) => (item.gameId !== null && isPendingCase(item) ? [item.gameId] : [])),
    );
    if (candidates.size === 0) return items;
    const workingGames = new Set(
      (await this.workspace.correctionGameCatalog([...candidates])).games.map(
        (game) => game.gameId,
      ),
    );
    const result: RecordCorrectionListItem[] = [];
    const drafts = new Map<
      string,
      ReturnType<RecordCorrectionService["readDraftProgressSource"]>
    >();
    // Only saved work for notices in this list needs compilation; keep other rows lightweight.
    for (let offset = 0; offset < items.length; offset += 4) {
      result.push(
        ...(await Promise.all(
          items.slice(offset, offset + 4).map(async (item) => {
            if (item.gameId === null || !workingGames.has(item.gameId) || !isPendingCase(item))
              return item;
            const detail = await this.repository.case(item.noticeId);
            if (detail === null) return item;
            const decorated = await this.withDraftProgress(normalizeCase(detail), drafts);
            return decorated.draftProgress === undefined
              ? item
              : { ...item, draftProgress: decorated.draftProgress };
          }),
        )),
      );
    }
    return result;
  }

  public async case(noticeId: string): Promise<RecordCorrectionCase | null> {
    const item = await this.repository.case(noticeId);
    return item === null ? null : this.withDraftProgress(normalizeCase(item));
  }

  private async readDraftProgressSource(gameId: string) {
    const saved = await this.workspace.readCurrentDocumentSnapshot(gameId);
    if (saved === null) return null;
    const documentHash = stagingDocumentHash(saved.document);
    const compiled = await this.compiled.load(documentHash, () =>
      compileDocument(this.computation, saved.document),
    );
    const blockingCount = mergePersistentSourceFindings(
      saved.findings,
      compiled.findings,
      saved.document,
    ).filter((finding) => finding.severity === "blocking").length;
    const base = await this.revisionStore.currentRevisionBase(gameId);
    return { saved, blockingCount, base, documentHash };
  }

  private async withDraftProgress(
    item: RecordCorrectionCase,
    drafts = new Map<string, ReturnType<RecordCorrectionService["readDraftProgressSource"]>>(),
  ): Promise<RecordCorrectionCase> {
    if (item.gameId === null || !isPendingCase(item)) return item;
    let pending = drafts.get(item.gameId);
    if (pending === undefined) {
      pending = this.readDraftProgressSource(item.gameId);
      drafts.set(item.gameId, pending);
    }
    const source = await pending;
    if (source === null) return item;
    const { saved, blockingCount, base, documentHash } = source;
    const savedBase = saved.document.revisionBase;
    let draftProgress: RecordCorrectionDraftProgress;
    if (
      base === null ||
      savedBase.kind !== "sealed_revision" ||
      savedBase.revision !== base.revision ||
      savedBase.documentHash !== base.documentHash
    ) {
      draftProgress = {
        state: "stale_base",
        blockingCount,
        message:
          "작업본 저장 후 기준 DB 기록이 달라졌습니다. 기존 작업본과 현재 DB 기록을 확인하세요.",
      };
    } else {
      const candidate = await this.currentDraftCandidate(saved.document, item);
      const binding =
        candidate === undefined ? null : buildBinding(saved.document, item.notice, candidate);
      const built =
        binding === null
          ? null
          : await this.buildProposal(saved.document, item.notice, binding, documentHash);
      const corrected = built !== null && satisfiesOfficialAfterState(built);
      let approvalCurrent = true;
      if (corrected && saved.recordCorrectionApprovals?.length) {
        try {
          await this.verifySavedApprovals(
            saved.document,
            documentHash,
            saved.recordCorrectionApprovals,
          );
        } catch (error: unknown) {
          if (!(error instanceof RevisionConflictError)) throw error;
          approvalCurrent = false;
        }
      }
      const ready =
        corrected && approvalCurrent && blockingCount === 0 && saved.authority === "staging";
      draftProgress = {
        state: ready ? "ready_to_import" : "needs_review",
        blockingCount,
        message: ready
          ? "정정 후 내용이 작업본에 저장됐습니다. DB에 적재하면 정정 처리가 완료됩니다."
          : blockingCount > 0
            ? `작업본은 저장됐지만 차단 오류 ${String(blockingCount)}건이 남아 있습니다.`
            : "작업본이 저장돼 있습니다. 남은 정정 항목을 확인하세요.",
      };
    }
    return { ...item, draftProgress };
  }

  public async createDraft(
    noticeId: string,
    expectedCaseVersion: number,
  ): Promise<{
    readonly sessionId: string;
    readonly sessionVersion: number;
    readonly noticeId: string;
  }> {
    const snapshot = await this.repository.caseSnapshot(noticeId);
    if (snapshot === null)
      throw new RecordCorrectionNotFoundError("기록정정 공지를 찾을 수 없습니다.");
    if (!snapshot.assessmentCurrent || snapshot.item.caseVersion !== expectedCaseVersion)
      throw new RecordCorrectionConflictError(
        "공지 평가가 바뀌었습니다. 최신 경기와 플레이 후보를 다시 확인하세요.",
      );
    const selected = selectedDraftTarget(snapshot.item);
    if (selected === undefined)
      throw new RecordCorrectionConflictError("먼저 경기와 플레이 후보를 확정해야 합니다.");
    const { gameId } = selected;
    let current;
    try {
      current = await openCorrectionDraft(
        this.workspace,
        this.revisionStore,
        gameId,
        selected.revision,
        "resume",
      );
    } catch (error: unknown) {
      if (!(error instanceof RevisionConflictError)) throw error;
      const assessed = await this.assessForJob(noticeId);
      const refreshed = await this.repository.caseSnapshot(noticeId);
      const target = refreshed === null ? undefined : selectedDraftTarget(refreshed.item);
      if (
        assessed === null ||
        refreshed === null ||
        !refreshed.assessmentCurrent ||
        refreshed.item.caseVersion !== assessed.caseVersion ||
        refreshed.publication !== snapshot.publication ||
        refreshed.decisionSequence !== snapshot.decisionSequence ||
        target === undefined ||
        !samePlateAppearance(selected, target)
      )
        throw new RecordCorrectionConflictError(
          "최신 DB revision으로 재검토했습니다. 경기와 플레이 후보를 다시 확인하세요.",
        );
      current = await openCorrectionDraft(
        this.workspace,
        this.revisionStore,
        gameId,
        target.revision,
        "resume",
      );
    }
    const session = await this.sessions.create({ gameId, authority: current.authority }, current);
    return { sessionId: session.sessionId, sessionVersion: session.sessionVersion, noticeId };
  }

  public async proposal(sessionId: string, noticeId: string): Promise<RecordCorrectionProposal> {
    const item = await this.requiredCase(noticeId, true);
    const session = this.sessions.get(sessionId);
    return (await this.sessionProposal(session, item)).proposal;
  }

  public async applyProposal(
    sessionId: string,
    noticeId: string,
    expectedSessionVersion: number,
    proposalHash: string,
  ): Promise<CorrectionMutationResult> {
    const item = await this.requiredCase(noticeId, true);
    const session = this.sessions.get(sessionId);
    if (session.sessionVersion !== expectedSessionVersion)
      throw new RecordCorrectionConflictError("correction session version이 변경되었습니다.");
    const {
      proposal,
      generation,
      documentHash: provedHash,
      approvalPlan,
    } = await this.sessionProposal(session, item);
    if (proposal.proposalHash !== proposalHash)
      throw new RecordCorrectionConflictError("KBO 정정 제안이 stale 상태입니다.");
    if (!proposal.eligible)
      throw new RecordCorrectionConflictError("현재 제안은 적용할 수 없습니다.");
    const approve = async (documentHash: string) => {
      if (provedHash !== undefined && documentHash !== provedHash)
        throw new RecordCorrectionConflictError(unprovedDraft);
      const input = {
        noticeId,
        caseVersion: item.caseVersion,
        sessionId,
        proposalHash,
        documentHash,
      };
      return this.repository.markProposalBundle === undefined || generation === undefined
        ? [
            ...this.sessions
              .approvalReferences(sessionId)
              .filter((ref) => ref.noticeId !== noticeId),
            await this.repository.markProposalApplied(input),
          ]
        : this.repository.markProposalBundle({
            ...input,
            generation,
            ...(approvalPlan === undefined ? {} : { plan: approvalPlan }),
          });
    };
    if (proposal.batch === null)
      return this.sessions.approveCurrent(sessionId, expectedSessionVersion, approve);
    return this.sessions.command(sessionId, expectedSessionVersion, proposal.batch, true, approve);
  }

  public async afterImport(gameId: string, revision: number): Promise<void> {
    const noticeIds = await this.repository.listNoticeIdsForImport(gameId, revision);
    for (const noticeId of noticeIds) await this.assessForJob(noticeId);
  }

  public async reconcilePending(onError: (error: unknown) => void): Promise<void> {
    const pending = await this.repository.pendingNoticeIds(this.pendingCursor, 16);
    this.pendingCursor = pending.length < 16 ? "" : (pending.at(-1) ?? "");
    for (const noticeId of pending) {
      try {
        await this.assessForJob(noticeId);
      } catch (error: unknown) {
        onError(error);
      }
    }
  }

  private async assessForJob(noticeId: string): Promise<RecordCorrectionCase | null> {
    for (let attempt = 0; ; attempt += 1) {
      const current = await this.repository.case(noticeId);
      if (current === null || current.status === "dismissed") return current;
      try {
        return await this.assessNotice(current.notice);
      } catch (error: unknown) {
        if (
          attempt >= 2 ||
          !(error instanceof RevisionConflictError || error instanceof RecordCorrectionStaleError)
        )
          throw error;
      }
    }
  }

  private async requiredCase(noticeId: string, refresh = false): Promise<RecordCorrectionCase> {
    const item = await this.repository.case(noticeId);
    if (item === null) throw new RecordCorrectionNotFoundError("기록정정 공지를 찾을 수 없습니다.");
    if (refresh && ["awaiting_assessment", "notice_source_changed"].includes(item.reasonCode)) {
      const refreshed = await this.assessForJob(noticeId);
      if (refreshed === null)
        throw new RecordCorrectionNotFoundError("기록정정 공지를 찾을 수 없습니다.");
      return normalizeCase(refreshed);
    }
    return normalizeCase(item);
  }

  private async matchCandidates(
    notice: RecordCorrectionNotice,
    game: RecordCorrectionGameCandidate,
    document: StagingGameDocumentV2,
  ) {
    const result = await this.computation.run({
      kind: "record_correction_match",
      notice,
      game,
      document,
    });
    if (result.kind !== "record_correction_match") throw new Error("Unexpected matching result");
    return result.value;
  }

  private async sessionProposal(
    session: CorrectionSession,
    item: RecordCorrectionCase,
  ): Promise<PreparedProposal> {
    if (
      item.status === "dismissed" ||
      item.gameId === null ||
      item.gameId !== session.gameId ||
      item.eventId === null ||
      item.gameRevision === null
    ) {
      throw new RecordCorrectionConflictError(
        "공지와 correction session 경기·타석이 일치하지 않습니다.",
      );
    }
    const selected = await this.currentDraftCandidate(session.draftDocument, item);
    const proposal = await buildSessionProposal(session, item, selected, (doc, notice, binding) =>
      this.buildProposal(doc, notice, binding, session.draftDocumentHash),
    );
    if (selected === undefined) return { proposal };
    const approvals = this.sessions.approvalReferences(session.sessionId);
    if (
      !proposal.eligible &&
      (proposal.batch !== null || !approvals.some((ref) => ref.noticeId === item.noticeId))
    )
      return { proposal };

    const group = await this.repository.matchupContext?.(item.notice);
    if (group === undefined) return { proposal };
    const reject = (reason: string): PreparedProposal => ({
      proposal: { ...proposal, eligible: false, reasons: [...proposal.reasons, reason] },
    });
    const game = group.games.find(
      (game) =>
        game.gameId === item.gameId &&
        game.revision === item.gameRevision &&
        game.documentHash === selected.documentHash,
    );
    const active = group.notices.find(
      (peer) =>
        peer.notice.noticeId === item.noticeId && peer.notice.noticeHash === item.notice.noticeHash,
    );
    if (game === undefined || active === undefined) return reject(unprovedDraft);

    const base = await this.revisionStore.loadCorrectionDraft(game.gameId, game.revision);
    const own = await this.authorizedIntent(base, game, group, active, selected.eventId);
    if (own === null) return reject(unprovedDraft);
    const prior = approvals.filter((ref) => ref.noticeId !== item.noticeId);
    const evidence = (await this.repository.approvalEvidence?.(approvals)) ?? [];
    const history = (await this.repository.approvalHistory?.(
      prior,
      { gameId: game.gameId, revision: game.revision, baseHash: game.documentHash },
      item.notice,
    )) ?? {
      active: evidence.filter((proof) => proof.noticeId !== item.noticeId),
      recorded: evidence.filter((proof) => proof.noticeId !== item.noticeId),
      unknown: false,
    };
    if (
      history.unknown ||
      history.recorded.length !== prior.length ||
      history.active.some(
        (proof) =>
          proof.gameId !== game.gameId ||
          proof.revision !== game.revision ||
          proof.baseHash !== game.documentHash,
      )
    )
      return reject(unprovedDraft);
    const approvedIntents = await this.authorizedIntents(base, game, group, history.active);
    if (approvedIntents === null) return reject(unprovedDraft);

    const candidate =
      proposal.batch === null
        ? session.draftDocument
        : await this.applyBatch(session.draftDocument, proposal.batch);
    const documentHash = stagingDocumentHash(candidate);
    const independentlyOpened =
      this.sessions.hasIndependentRecordCorrectionBase?.(session.sessionId) === true;
    const byNotice = new Map(
      [...approvedIntents, own].map((intent) => [intent.notice.noticeId, intent]),
    );
    const order = [
      ...new Set([...approvals.map((reference) => reference.noticeId), item.noticeId]),
    ];
    const intents = order.flatMap((noticeId) => {
      const intent = byNotice.get(noticeId);
      return intent === undefined ? [] : [intent];
    });
    const canExtend =
      approvals.length === 0
        ? independentlyOpened
        : history.active.length === prior.length &&
          history.active.every((proof) => proof.documentHash === session.draftDocumentHash) &&
          (!approvals.some((reference) => reference.noticeId === item.noticeId) ||
            evidence.some(
              (proof) =>
                proof.noticeId === item.noticeId &&
                proof.gameId === game.gameId &&
                proof.revision === game.revision &&
                proof.baseHash === game.documentHash &&
                proof.eventId === selected.eventId &&
                proof.documentHash === session.draftDocumentHash,
            ));
    if (!canExtend) {
      const reproduced = await this.reproduceEffects(base, intents);
      if (reproduced === null || stagingDocumentHash(reproduced) !== documentHash)
        return reject(unprovedDraft);
    }
    if (!(await this.satisfiesIntents(candidate, intents))) return reject(unprovedDraft);
    if (await this.hasPeerConflict(base, candidate, game, group, intents))
      return reject(conflictingNotice);
    return {
      proposal: { ...proposal, eligible: true, reasons: [] },
      generation: group.generation,
      documentHash,
      approvalPlan: {
        kind: canExtend ? "extend" : "rebuild",
        previousDocumentHash: session.draftDocumentHash,
        previous: approvals,
        carry: history.active.map(({ noticeId, actionSequence }) => ({ noticeId, actionSequence })),
      },
    };
  }

  public async verifyPublication(
    document: StagingGameDocumentV2,
    target: ImportTarget,
  ): Promise<number | undefined> {
    return this.verifySavedApprovals(
      document,
      target.documentHash,
      target.recordCorrection?.approvals ?? [],
    );
  }

  private async verifySavedApprovals(
    document: StagingGameDocumentV2,
    documentHash: string,
    references: readonly RecordCorrectionApprovalReference[],
  ): Promise<number | undefined> {
    if (references.length === 0) return undefined;
    const fail = () => new RevisionConflictError(unprovedDraft);
    const group = await this.repository.matchupContext?.({
      gameDate: document.metadata.gameDate,
      awayTeamName: document.teams.away.name,
      homeTeamName: document.teams.home.name,
    });
    const base = document.revisionBase;
    if (group === undefined || base.kind !== "sealed_revision") throw fail();
    const game = group.games.find(
      (game) =>
        game.gameId === document.metadata.gameId &&
        game.revision === base.revision &&
        game.documentHash === base.documentHash,
    );
    if (game === undefined) throw fail();
    const before = await this.revisionStore.loadCorrectionDraft(game.gameId, game.revision);
    const evidence = (await this.repository.approvalEvidence?.(references)) ?? [];
    if (
      evidence.length !== references.length ||
      evidence.some(
        (proof) =>
          proof.gameId !== game.gameId ||
          proof.revision !== game.revision ||
          proof.baseHash !== game.documentHash ||
          proof.documentHash !== documentHash,
      )
    )
      throw fail();
    const intents = await this.authorizedIntents(before, game, group, evidence);
    if (intents === null || !(await this.satisfiesIntents(document, intents))) throw fail();
    if (await this.hasPeerConflict(before, document, game, group, intents))
      throw new RevisionConflictError(conflictingNotice);
    return group.generation;
  }

  private async authorizedIntents(
    base: StagingGameDocumentV2,
    game: RecordCorrectionGameCandidate,
    group: RecordCorrectionMatchupContext,
    evidence: readonly RecordCorrectionApprovalEvidence[],
  ): Promise<CandidateIntent[] | null> {
    const intents: CandidateIntent[] = [];
    for (const proof of evidence) {
      const entry = group.notices.find((peer) => peer.notice.noticeId === proof.noticeId);
      if (entry === undefined) return null;
      const intent = await this.authorizedIntent(base, game, group, entry, proof.eventId);
      if (intent === null) return null;
      intents.push(intent);
    }
    return intents;
  }

  private async authorizedIntent(
    base: StagingGameDocumentV2,
    game: RecordCorrectionGameCandidate,
    group: Pick<RecordCorrectionMatchupContext, "games">,
    entry: RecordCorrectionMatchupContext["notices"][number],
    eventId: string | null,
  ): Promise<CandidateIntent | null> {
    const bindings = await this.intentCandidates(base, game, group, entry);
    const single = bindings.length === 1 ? bindings[0] : undefined;
    return single?.binding.eventId === eventId ? single : null;
  }

  private async intentCandidates(
    base: StagingGameDocumentV2,
    game: RecordCorrectionGameCandidate,
    group: Pick<RecordCorrectionMatchupContext, "games">,
    entry: RecordCorrectionMatchupContext["notices"][number],
  ): Promise<CandidateIntent[]> {
    const notice = normalizeKboRecordCorrectionNotice(entry.notice);
    if (!hasActionableCorrection(notice)) return [];
    const eligible = recordCorrectionEligibleGames(
      group.games,
      notice.doubleheaderNumber,
      entry.selection?.gameId ?? null,
    );
    if (eligible.length !== 1 || eligible[0]?.gameId !== game.gameId) return [];
    const matches = (await this.matchCandidates(notice, game, base)).filter(
      (candidate) => entry.selection === null || samePlateAppearance(candidate, entry.selection),
    );
    const intents: CandidateIntent[] = [];
    for (const match of matches) {
      const binding = buildBinding(base, notice, match);
      if (binding === null) return [];
      intents.push({ notice, binding });
    }
    return intents;
  }

  private async applyBatch(
    document: StagingGameDocumentV2,
    command: NonNullable<BuiltRecordCorrectionProposal["batch"]>,
  ) {
    const result = await this.computation.run({ kind: "command", document, command });
    if (result.kind !== "command") throw new Error("Unexpected correction result");
    return result.value.document;
  }

  private async reproduceEffects(base: StagingGameDocumentV2, intents: readonly CandidateIntent[]) {
    let document = base;
    for (const { notice, binding } of intents) {
      const proposal = await this.buildProposal(document, notice, binding);
      if (proposal.batch === null) {
        if (!satisfiesOfficialAfterState(proposal)) return null;
      } else {
        if (!proposal.eligible) return null;
        document = await this.applyBatch(document, proposal.batch);
      }
    }
    return document;
  }

  private async facts(document: StagingGameDocumentV2, intents: readonly CandidateIntent[]) {
    const result = await this.computation.run({
      kind: "record_correction_facts",
      document,
      targets: intents,
    });
    if (result.kind !== "record_correction_facts") throw new Error("Unexpected correction facts");
    return result.value;
  }

  private async satisfiesIntents(
    document: StagingGameDocumentV2,
    intents: readonly CandidateIntent[],
  ) {
    const facts = await this.facts(document, intents);
    return facts.every(
      (group) => group.length > 0 && group.every((fact) => fact.key !== null && fact.satisfied),
    );
  }

  private async hasPeerConflict(
    base: StagingGameDocumentV2,
    proposed: StagingGameDocumentV2,
    game: RecordCorrectionGameCandidate,
    group: Pick<RecordCorrectionMatchupContext, "games" | "notices">,
    own: readonly CandidateIntent[],
  ): Promise<boolean> {
    const batches: CandidateIntent[][] = [];
    for (const entry of group.notices) {
      if (own.some(({ notice }) => notice.noticeId === entry.notice.noticeId)) continue;
      const intents = await this.intentCandidates(base, game, group, entry);
      if (intents.length > 0) batches.push(intents);
    }
    const ownFacts = (await this.facts(proposed, own)).flat();
    if (
      ownFacts.some((left, index) =>
        ownFacts.slice(index + 1).some((right) => incompatible(left, right)),
      )
    )
      return true;
    if (batches.length === 0) return false;
    const intents = batches.flat();
    const before = await this.facts(base, intents);
    const after = proposed === base ? before : await this.facts(proposed, intents);
    let offset = 0;
    for (const batch of batches) {
      const end = offset + batch.length;
      const baseline = commonFacts(before.slice(offset, end));
      const final = commonFacts(after.slice(offset, end));
      if (
        baseline.some(
          (fact) =>
            ownFacts.some((candidate) => incompatible(fact, candidate)) ||
            (fact.satisfied &&
              !final.some((candidate) => sameFact(fact, candidate) && candidate.satisfied)),
        )
      )
        return true;
      offset = end;
    }
    return false;
  }

  private async currentDraftCandidate(document: StagingGameDocumentV2, item: RecordCorrectionCase) {
    const selected = item.candidates.find(
      (candidate) => candidate.gameId === item.gameId && candidate.eventId === item.eventId,
    );
    if (
      selected === undefined ||
      document.metadata.gameDate !== item.notice.gameDate ||
      document.teams.away.name !== item.notice.awayTeamName ||
      document.teams.home.name !== item.notice.homeTeamName ||
      !matchesRecordCorrectionDoubleheader(
        document.source.sourceGameId,
        item.notice.doubleheaderNumber,
      ) ||
      document.revisionBase.kind !== "sealed_revision" ||
      document.revisionBase.revision !== selected.revision ||
      document.revisionBase.documentHash !== selected.documentHash
    ) {
      return undefined;
    }
    const candidates = await this.matchCandidates(
      item.notice,
      {
        ...selected,
        sourceGameId: document.source.sourceGameId,
        gameDate: document.metadata.gameDate,
        stadium: document.metadata.stadium ?? null,
        awayTeamName: document.teams.away.name,
        homeTeamName: document.teams.home.name,
      },
      document,
    );
    return candidates.some((candidate) => samePlateAppearance(selected, candidate))
      ? selected
      : undefined;
  }

  private async assessCase(
    notice: RecordCorrectionNotice,
    input: Omit<
      Parameters<RecordCorrectionRepository["assess"]>[0],
      "noticeId" | "noticeHash" | "matchup"
    >,
  ): Promise<RecordCorrectionCase> {
    return normalizeCase(
      await this.repository.assess({
        ...input,
        noticeId: notice.noticeId,
        noticeHash: notice.noticeHash,
        matchup: notice,
      }),
    );
  }
}

function sameFact(left: RecordCorrectionAfterFact, right: RecordCorrectionAfterFact): boolean {
  return (
    left.key !== null &&
    left.key === right.key &&
    left.values.length === right.values.length &&
    left.values.every((value) => right.values.includes(value))
  );
}

function incompatible(left: RecordCorrectionAfterFact, right: RecordCorrectionAfterFact): boolean {
  return (
    left.key !== null &&
    left.key === right.key &&
    !left.values.some((value) => right.values.includes(value))
  );
}

function commonFacts(groups: readonly RecordCorrectionAfterFact[][]): RecordCorrectionAfterFact[] {
  const [first, ...others] = groups;
  return (
    first?.flatMap((fact) => {
      if (fact.key === null) return [];
      const variants = others.map((group) => group.find((item) => sameFact(fact, item)));
      return variants.some((item) => item === undefined)
        ? []
        : [{ ...fact, satisfied: fact.satisfied && variants.every((item) => item?.satisfied) }];
    }) ?? []
  );
}

function normalizeCase(item: RecordCorrectionCase): RecordCorrectionCase {
  return { ...item, notice: normalizeKboRecordCorrectionNotice(item.notice) };
}

function isPendingCase(item: Pick<RecordCorrectionCase, "status">): boolean {
  return ["action_required", "manual_review", "unmatched"].includes(item.status);
}

function hasActionableCorrection(notice: RecordCorrectionNotice): boolean {
  if (notice.decisionAfter === "unknown") return false;
  const eventChangeSupported = notice.decisionBefore !== notice.decisionAfter;
  if (eventChangeSupported) return true;
  return notice.statChanges.some((stat) => {
    if (stat.supportKind === "unknown" || stat.supportKind === "evidence_only") return false;
    const supportKind = recordCorrectionSupportKind(stat.scope, stat.statCode);
    return supportKind === "direct" || supportKind === "derived";
  });
}

function satisfiesOfficialAfterState(proposal: BuiltRecordCorrectionProposal): boolean {
  return (
    proposal.reasons.length === 0 &&
    proposal.changes.some((change) => change.kind !== "evidence_only") &&
    !proposal.changes.some((change) => change.state === "change" || change.state === "conflict")
  );
}

function selectedDraftTarget(
  item: RecordCorrectionCase,
): RecordCorrectionMatchCandidate | undefined {
  if (
    item.status === "dismissed" ||
    item.status === "out_of_scope" ||
    item.status === "resolved" ||
    item.gameId === null ||
    item.gameRevision === null ||
    item.eventId === null
  )
    return undefined;
  return item.candidates.find(
    (candidate) =>
      candidate.gameId === item.gameId &&
      candidate.eventId === item.eventId &&
      candidate.revision === item.gameRevision,
  );
}

function samePlateAppearance(
  left: RecordCorrectionMatchCandidate,
  right: RecordCorrectionMatchCandidate,
): boolean {
  return (
    left.gameId === right.gameId &&
    left.eventId !== null &&
    left.eventId === right.eventId &&
    left.batterPlayerId === right.batterPlayerId &&
    left.pitcherPlayerId === right.pitcherPlayerId
  );
}

function buildBinding(
  document: StagingGameDocumentV2,
  notice: RecordCorrectionNotice,
  candidate: RecordCorrectionMatchCandidate,
): RecordCorrectionProposalBinding | null {
  if (
    candidate.eventId === null ||
    candidate.batterPlayerId === null ||
    candidate.pitcherPlayerId === null
  )
    return null;
  const battingSide = notice.half === "top" ? "away" : "home";
  const pitchingSide = battingSide === "away" ? "home" : "away";
  const participantPlayerIds: Record<string, string> = {};
  for (const participant of notice.participants) {
    const preferredSide = participant.role === "batter" ? battingSide : pitchingSide;
    if (
      participant.rawTeamName !== null &&
      participant.rawTeamName !== document.teams[preferredSide].name
    )
      return null;
    const preferred = document.rosters[preferredSide].players.filter(
      (player) => player.name === participant.rawPlayerName,
    );
    const matchedId =
      participant.role === "batter"
        ? candidate.batterPlayerId
        : participant.role === "pitcher"
          ? candidate.pitcherPlayerId
          : null;
    const matched = preferred.find((player) => player.playerId === matchedId);
    const candidates = matched === undefined ? preferred : [matched];
    if (candidates.length !== 1) return null;
    const player = candidates[0];
    if (player === undefined) return null;
    participantPlayerIds[String(participant.participantIndex)] = player.playerId;
  }
  return {
    eventId: candidate.eventId,
    batterPlayerId: candidate.batterPlayerId,
    pitcherPlayerId: candidate.pitcherPlayerId,
    participantPlayerIds,
  };
}

async function buildSessionProposal(
  session: CorrectionSession,
  item: RecordCorrectionCase,
  selected: RecordCorrectionMatchCandidate | undefined,
  build: (
    document: StagingGameDocumentV2,
    notice: RecordCorrectionNotice,
    binding: RecordCorrectionProposalBinding,
  ) => Promise<BuiltRecordCorrectionProposal>,
): Promise<RecordCorrectionProposal> {
  if (item.gameId === null || item.eventId === null || item.gameId !== session.gameId)
    throw new RecordCorrectionConflictError("공지와 correction session 경기가 일치하지 않습니다.");
  const binding =
    selected === undefined ? null : buildBinding(session.draftDocument, item.notice, selected);
  const built =
    binding === null
      ? {
          eligible: false,
          reasons: ["현재 작업 사본에서 공지와 일치하는 타석·참가자를 확인할 수 없습니다."],
          changes: [],
          batch: null,
          preview: null,
        }
      : await build(session.draftDocument, item.notice, binding);
  const hashInput = {
    noticeId: item.noticeId,
    noticeSourceHash: item.notice.noticeHash,
    caseVersion: item.caseVersion,
    sessionId: session.sessionId,
    sessionVersion: session.sessionVersion,
    baseDocumentHash: session.baseDocumentHash,
    draftDocumentHash: stagingDocumentHash(session.draftDocument),
    batch: built.batch,
  };
  return {
    noticeId: item.noticeId,
    caseVersion: item.caseVersion,
    sessionId: session.sessionId,
    sessionVersion: session.sessionVersion,
    baseDocumentHash: session.baseDocumentHash,
    noticeSourceHash: item.notice.noticeHash,
    proposalHash: createHash("sha256").update(canonicalStringify(hashInput), "utf8").digest("hex"),
    eligible: built.eligible,
    reasons: [...built.reasons],
    changes: [...built.changes],
    batch: built.batch,
    preview: built.preview,
  };
}
