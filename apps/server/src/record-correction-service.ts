import { createHash } from "node:crypto";

import {
  canonicalStringify,
  recordCorrectionSupportKind,
  type CorrectionMutationResult,
  type CorrectionSession,
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
  type RecordCorrectionProposalBinding,
  type BuiltRecordCorrectionProposal,
} from "@kbo/correction";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import type {
  GameRevisionStore,
  RecordCorrectionGameCandidate,
  RecordCorrectionRepository,
  StagingWorkspace,
} from "@kbo/persistence";

import type { CorrectionSessionManager } from "./correction-session-manager.js";
import { mergePersistentSourceFindings } from "./correction-session-manager.js";
import { storedCompilerFindings } from "./source-projection.js";
import { BoundedReadCache } from "./bounded-read-cache.js";
import { compileDocument, inlineComputation, type ComputationRunner } from "./computation.js";

type RevisionStore = Pick<GameRevisionStore, "loadCorrectionDraft" | "currentRevisionBase">;
type SessionManager = Pick<CorrectionSessionManager, "command" | "create" | "get">;
type Workspace = Pick<
  StagingWorkspace,
  "ensureCorrectionDraft" | "readCurrentDocumentSnapshot" | "correctionGameCatalog"
>;
type Repository = Pick<
  RecordCorrectionRepository,
  | "assess"
  | "case"
  | "gameCandidates"
  | "listCases"
  | "listCaseSummaries"
  | "markProposalApplied"
  | "markResolvedAfterReassessment"
  | "markResolvedIfImported"
  | "reviewAction"
>;

export class RecordCorrectionNotFoundError extends Error {}
export class RecordCorrectionConflictError extends Error {}

export class RecordCorrectionService {
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

  public close(): void {
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
    const cases = await this.repository.listCases({ season });
    for (const item of cases) await this.assessNotice(item.notice);
  }

  public async assessNotice(notice: RecordCorrectionNotice): Promise<RecordCorrectionCase> {
    notice = normalizeKboRecordCorrectionNotice(notice);
    if (!hasActionableCorrection(notice))
      return this.assessCase({
        noticeId: notice.noticeId,
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
    const exactGameCandidates = await this.repository.gameCandidates(notice);
    if (exactGameCandidates.length === 0)
      return this.assessCase({
        noticeId: notice.noticeId,
        status: "unmatched",
        gameId: null,
        gameRevision: null,
        documentHash: null,
        eventId: null,
        batterPlayerId: null,
        pitcherPlayerId: null,
        reasonCode: "game_not_found",
        reasonMessage: "날짜와 원정·홈 팀이 일치하는 DB 경기를 찾지 못했습니다.",
        proposalHash: null,
        candidates: [],
        assessedAt: this.now().toISOString(),
      });

    const selectedGameCandidates = selectDoubleheaderCandidates(notice, exactGameCandidates);
    const gameIdentityAmbiguous = selectedGameCandidates.length !== 1;
    const gameCandidates =
      selectedGameCandidates.length === 0 ? exactGameCandidates : selectedGameCandidates;

    const candidates: RecordCorrectionMatchCandidate[] = [];
    for (const game of gameCandidates) {
      const document = await this.revisionStore.loadCorrectionDraft(game.gameId, game.revision);
      candidates.push(...matchPlateAppearances(notice, game, document));
    }
    if (gameIdentityAmbiguous || candidates.length !== 1) {
      return this.assessCase({
        noticeId: notice.noticeId,
        status: "manual_review",
        gameId: null,
        gameRevision: null,
        documentHash: null,
        eventId: null,
        batterPlayerId: null,
        pitcherPlayerId: null,
        reasonCode:
          candidates.length === 0
            ? "play_not_found"
            : gameIdentityAmbiguous
              ? "ambiguous_game_identity"
              : "ambiguous_play_match",
        reasonMessage:
          candidates.length === 0
            ? "이닝·초말·타순·타자·투수가 모두 일치하는 타석을 찾지 못했습니다."
            : gameIdentityAmbiguous
              ? "같은 날짜·대진의 경기에서 공지의 DH 번호와 저장된 경기 정보로 하나를 확정할 수 없습니다."
              : "같은 강도의 타석 후보가 둘 이상이므로 자동 선택하지 않았습니다.",
        proposalHash: null,
        candidates,
        assessedAt: this.now().toISOString(),
      });
    }
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("record correction 후보 계산 오류");
    const document = await this.revisionStore.loadCorrectionDraft(
      candidate.gameId,
      candidate.revision,
    );
    const binding = buildBinding(document, notice, candidate);
    const built = binding === null ? null : await this.buildProposal(document, notice, binding);
    const hasChange = built?.changes.some((change) => change.state === "change") === true;
    const supported = built?.changes.some((change) => change.kind !== "evidence_only") === true;
    const conflicts = built?.reasons.length ?? 0;
    const status =
      built === null || conflicts > 0 || !supported
        ? !supported && built !== null && conflicts === 0
          ? "out_of_scope"
          : "manual_review"
        : hasChange
          ? "action_required"
          : "already_applied";
    return this.assessCase({
      noticeId: notice.noticeId,
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
          : conflicts > 0
            ? "proposal_conflict"
            : !supported
              ? "evidence_only_notice"
              : hasChange
                ? "supported_change_available"
                : "kbo_after_state_satisfied",
      reasonMessage:
        built === null
          ? "공지 참가자를 경기 roster에서 유일하게 식별할 수 없습니다."
          : built.reasons.join(" ") ||
            (!supported
              ? "현 계약 범위 밖의 변경만 있어 증거로 보존했습니다."
              : hasChange
                ? "검증 가능한 원자적 정정 제안을 만들었습니다."
                : "현재 플레이와 지원 공식 기록이 이미 KBO 정정 후 값입니다."),
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
    const workingGames = new Set(
      (await this.workspace.correctionGameCatalog()).games.map((game) => game.gameId),
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
      const candidate = item.candidates.find(
        (candidate) => candidate.gameId === item.gameId && candidate.eventId === item.eventId,
      );
      const binding =
        candidate === undefined ? null : buildBinding(saved.document, item.notice, candidate);
      const built =
        binding === null
          ? null
          : await this.buildProposal(saved.document, item.notice, binding, documentHash);
      const corrected =
        built !== null &&
        built.reasons.length === 0 &&
        built.changes.some((change) => change.kind !== "evidence_only") &&
        !built.changes.some((change) => change.state === "change" || change.state === "conflict");
      const ready = corrected && blockingCount === 0 && saved.authority === "staging";
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

  public async createDraft(noticeId: string): Promise<{
    readonly sessionId: string;
    readonly sessionVersion: number;
    readonly noticeId: string;
  }> {
    let item = await this.requiredCase(noticeId);
    if (item.status === "out_of_scope")
      throw new RecordCorrectionConflictError(
        "현재 지원 범위 밖의 공지는 보정 작업을 만들 수 없습니다.",
      );
    if (item.gameId === null || item.gameRevision === null || item.eventId === null)
      throw new RecordCorrectionConflictError("먼저 경기와 플레이 후보를 확정해야 합니다.");
    const gameId = item.gameId;
    let current = await this.workspace.readCurrentDocumentSnapshot(gameId);
    if (current === null) {
      const base = await this.revisionStore.currentRevisionBase(gameId);
      if (base === null)
        throw new RecordCorrectionConflictError("정정 대상의 현재 DB revision을 찾을 수 없습니다.");
      if (item.gameRevision !== base.revision) {
        // Re-match the play as well as the revision: later corrections may remove or move it.
        item = await this.assessNotice(item.notice);
        if (item.gameId !== gameId || item.eventId === null || item.gameRevision === null)
          throw new RecordCorrectionConflictError(
            "최신 DB revision으로 재검토했습니다. 경기와 플레이 후보를 다시 확인하세요.",
          );
      }
      const document = await this.revisionStore.loadCorrectionDraft(gameId, item.gameRevision);
      const replay = await compileDocument(this.computation, document);
      current = await this.workspace.ensureCorrectionDraft(
        document,
        storedCompilerFindings(replay.findings),
      );
    }
    const session = await this.sessions.create({ gameId, authority: current.authority });
    return { sessionId: session.sessionId, sessionVersion: session.sessionVersion, noticeId };
  }

  public async proposal(sessionId: string, noticeId: string): Promise<RecordCorrectionProposal> {
    const item = await this.requiredCase(noticeId);
    const session = this.sessions.get(sessionId);
    return buildSessionProposal(session, item, (document, notice, binding) =>
      this.buildProposal(document, notice, binding, session.draftDocumentHash),
    );
  }

  public async applyProposal(
    sessionId: string,
    noticeId: string,
    expectedSessionVersion: number,
    proposalHash: string,
  ): Promise<CorrectionMutationResult> {
    const item = await this.requiredCase(noticeId);
    const session = this.sessions.get(sessionId);
    if (session.sessionVersion !== expectedSessionVersion)
      throw new RecordCorrectionConflictError("correction session version이 변경되었습니다.");
    const proposal = await buildSessionProposal(session, item, (document, notice, binding) =>
      this.buildProposal(document, notice, binding, session.draftDocumentHash),
    );
    if (proposal.proposalHash !== proposalHash)
      throw new RecordCorrectionConflictError("KBO 정정 제안이 stale 상태입니다.");
    if (!proposal.eligible || proposal.batch === null)
      throw new RecordCorrectionConflictError("현재 제안은 적용할 수 없습니다.");
    const result = await this.sessions.command(
      sessionId,
      expectedSessionVersion,
      proposal.batch,
      true,
    );
    await this.repository.markProposalApplied({
      noticeId,
      caseVersion: item.caseVersion,
      sessionId,
      proposalHash,
      documentHash: result.session.draftDocumentHash,
    });
    return result;
  }

  public async afterImport(gameId: string, revision: number, documentHash: string): Promise<void> {
    const resolved = new Set(
      await this.repository.markResolvedIfImported(gameId, revision, documentHash),
    );
    const cases = await this.repository.listCases({});
    for (const item of cases) {
      if (resolved.has(item.noticeId) || item.status === "dismissed" || item.status === "resolved")
        continue;
      if (item.gameId === null && item.status === "unmatched") {
        const candidates = await this.repository.gameCandidates(item.notice);
        if (!candidates.some((candidate) => candidate.gameId === gameId)) continue;
      } else if (
        item.gameId !== gameId ||
        item.gameRevision === null ||
        item.gameRevision >= revision
      ) {
        continue;
      }
      const reassessed = await this.assessNotice(item.notice);
      if (
        reassessed.status === "already_applied" &&
        reassessed.gameId === gameId &&
        reassessed.gameRevision === revision
      )
        await this.repository.markResolvedAfterReassessment({
          noticeId: reassessed.noticeId,
          caseVersion: reassessed.caseVersion,
          gameId,
          revision,
          documentHash,
        });
    }
  }

  private async requiredCase(noticeId: string): Promise<RecordCorrectionCase> {
    const item = await this.repository.case(noticeId);
    if (item === null) throw new RecordCorrectionNotFoundError("기록정정 공지를 찾을 수 없습니다.");
    return normalizeCase(item);
  }

  private async assessCase(
    input: Parameters<RecordCorrectionRepository["assess"]>[0],
  ): Promise<RecordCorrectionCase> {
    return normalizeCase(await this.repository.assess(input));
  }
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

function matchPlateAppearances(
  notice: RecordCorrectionNotice,
  game: RecordCorrectionGameCandidate,
  document: StagingGameDocumentV2,
): RecordCorrectionMatchCandidate[] {
  const battingSide = notice.half === "top" ? "away" : "home";
  const pitchingSide = battingSide === "away" ? "home" : "away";
  const batterParticipant =
    notice.participants.find((participant) => participant.role === "batter") ??
    notice.participants[0];
  const pitcherParticipants = notice.participants.filter(
    (participant) => participant.role === "pitcher",
  );
  if (batterParticipant === undefined || pitcherParticipants.length === 0) return [];
  const batters = document.rosters[battingSide].players.filter(
    (player) => player.name === batterParticipant.rawPlayerName,
  );
  const pitchers = document.rosters[pitchingSide].players.filter((player) =>
    pitcherParticipants.some((participant) => player.name === participant.rawPlayerName),
  );
  if (batters.length === 0 || pitchers.length === 0) return [];
  const replay = compileStagingGameDocumentV2(document);
  return batters.flatMap((batter) =>
    pitchers.flatMap((pitcher) =>
      replay.plateAppearances
        .filter(
          (plateAppearance) =>
            plateAppearance.inning === notice.inning &&
            plateAppearance.half === notice.half &&
            plateAppearance.batterId === batter.playerId &&
            plateAppearance.pitcherId === pitcher.playerId &&
            plateAppearance.completed &&
            plateAppearance.endEventId !== null,
        )
        .flatMap((plateAppearance) => {
          const eventId = plateAppearance.endEventId;
          if (eventId === null) return [];
          if (
            battingOrderAt(document, battingSide, batter.playerId, eventId) !== notice.battingOrder
          )
            return [];
          return [
            {
              candidateId: `candidate:${createHash("sha256")
                .update(
                  canonicalStringify([
                    game.gameId,
                    game.revision,
                    eventId,
                    batter.playerId,
                    pitcher.playerId,
                  ]),
                  "utf8",
                )
                .digest("hex")}`,
              gameId: game.gameId,
              revision: game.revision,
              documentHash: game.documentHash,
              eventId,
              batterPlayerId: batter.playerId,
              pitcherPlayerId: pitcher.playerId,
              label: `${game.gameId} · ${notice.gameDate} ${notice.inning}회 ${notice.half === "top" ? "초" : "말"} ${batter.name}(${batter.playerId}) / ${pitcher.name}(${pitcher.playerId})`,
              confidenceReason:
                batters.length === 1 &&
                pitchers.filter((player) => player.name === pitcher.name).length === 1
                  ? "날짜·원정/홈 팀·이닝·초말·타순·타자·투수가 모두 일치합니다."
                  : "동명이인 후보입니다. 선수 ID를 확인해 수동 선택해야 합니다.",
            },
          ];
        }),
    ),
  );
}

function battingOrderAt(
  document: StagingGameDocumentV2,
  side: "away" | "home",
  playerId: string,
  eventId: string,
): number | undefined {
  const orders = new Map<string, number>();
  for (const player of document.rosters[side].players) {
    if (player.battingOrder !== undefined) orders.set(player.playerId, player.battingOrder);
  }
  for (const event of document.events) {
    if (event.identity.eventId === eventId) return orders.get(playerId);
    if (event.kind !== "substitution" || event.payload.side !== side) continue;
    const { incomingPlayerId, outgoingPlayerId, battingOrder } = event.payload;
    // Position-only changes retain the slot inherited by an earlier pinch runner/hitter.
    const order =
      battingOrder ?? (outgoingPlayerId === undefined ? undefined : orders.get(outgoingPlayerId));
    if (order !== undefined) orders.set(incomingPlayerId, order);
  }
  return undefined;
}

function selectDoubleheaderCandidates(
  notice: RecordCorrectionNotice,
  candidates: readonly RecordCorrectionGameCandidate[],
): RecordCorrectionGameCandidate[] {
  if (notice.doubleheaderNumber === null) return candidates.length <= 1 ? [...candidates] : [];
  return candidates.filter(
    (candidate) => sourceDoubleheaderNumber(candidate.sourceGameId) === notice.doubleheaderNumber,
  );
}

function sourceDoubleheaderNumber(sourceGameId: string): number | null {
  const explicit = /(?:DH|_)([12])(?:_|$)/i.exec(sourceGameId)?.[1];
  if (explicit !== undefined) return Number(explicit);
  const naverGameNumber = /([12])\d{4}$/.exec(sourceGameId)?.[1];
  return naverGameNumber === undefined ? null : Number(naverGameNumber);
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
  build: (
    document: StagingGameDocumentV2,
    notice: RecordCorrectionNotice,
    binding: RecordCorrectionProposalBinding,
  ) => Promise<BuiltRecordCorrectionProposal>,
): Promise<RecordCorrectionProposal> {
  if (item.gameId === null || item.eventId === null || item.gameId !== session.gameId)
    throw new RecordCorrectionConflictError("공지와 correction session 경기가 일치하지 않습니다.");
  const selected = item.candidates.find(
    (candidate) => candidate.gameId === item.gameId && candidate.eventId === item.eventId,
  ) ?? {
    candidateId: "selected",
    gameId: item.gameId,
    revision: item.gameRevision ?? 1,
    documentHash: session.baseDocumentHash,
    eventId: item.eventId,
    batterPlayerId: null,
    pitcherPlayerId: null,
    label: "selected",
    confidenceReason: "manual",
  };
  const binding = buildBinding(session.draftDocument, item.notice, selected);
  const built =
    binding === null
      ? {
          eligible: false,
          reasons: ["공지 참가자를 현재 session roster에서 유일하게 식별할 수 없습니다."],
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
