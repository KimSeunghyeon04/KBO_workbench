import { createHash } from "node:crypto";

import {
  canonicalStringify,
  recordCorrectionSupportKind,
  type CorrectionMutationResult,
  type CorrectionSession,
  type RecordCorrectionCase,
  type RecordCorrectionMatchCandidate,
  type RecordCorrectionNotice,
  type RecordCorrectionProposal,
  type RecordCorrectionReviewActionRequest,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { normalizeKboRecordCorrectionNotice } from "@kbo/collection";
import {
  buildRecordCorrectionBatchProposal,
  type RecordCorrectionProposalBinding,
} from "@kbo/correction";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import type {
  GameRevisionStore,
  RecordCorrectionGameCandidate,
  RecordCorrectionRepository,
  StagingWorkspace,
} from "@kbo/persistence";

import type { CorrectionSessionManager } from "./correction-session-manager.js";
import { storedCompilerFindings } from "./source-projection.js";

type RevisionStore = Pick<GameRevisionStore, "loadCorrectionDraft">;
type SessionManager = Pick<CorrectionSessionManager, "command" | "create" | "get">;
type Workspace = Pick<StagingWorkspace, "saveQuarantine" | "saveReady">;
type Repository = Pick<
  RecordCorrectionRepository,
  | "assess"
  | "case"
  | "gameCandidates"
  | "listCases"
  | "markProposalApplied"
  | "markResolvedAfterReassessment"
  | "markResolvedIfImported"
  | "reviewAction"
>;

export class RecordCorrectionNotFoundError extends Error {}
export class RecordCorrectionConflictError extends Error {}

export class RecordCorrectionService {
  public constructor(
    private readonly repository: Repository,
    private readonly revisionStore: RevisionStore,
    private readonly workspace: Workspace,
    private readonly sessions: SessionManager,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
        reasonMessage: "시즌·날짜·원정/홈 팀·구장이 모두 일치하는 DB 경기가 없습니다.",
        proposalHash: null,
        candidates: [],
        assessedAt: this.now().toISOString(),
      });

    const selectedGameCandidates = selectDoubleheaderCandidates(notice, exactGameCandidates);
    const gameIdentityAmbiguous =
      exactGameCandidates.length > 1 && selectedGameCandidates.length !== 1;
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
              ? "같은 날 같은 대진이 여러 경기지만 DH 번호와 Naver 경기 identity로 하나를 확정할 수 없습니다."
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
    const built =
      binding === null ? null : buildRecordCorrectionBatchProposal(document, notice, binding);
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
    return normalizeCase(await this.repository.reviewAction(noticeId, request));
  }

  public async listCases(
    filters: Parameters<RecordCorrectionRepository["listCases"]>[0] = {},
  ): Promise<RecordCorrectionCase[]> {
    return (await this.repository.listCases(filters)).map(normalizeCase);
  }

  public async case(noticeId: string): Promise<RecordCorrectionCase | null> {
    const item = await this.repository.case(noticeId);
    return item === null ? null : normalizeCase(item);
  }

  public async createDraft(noticeId: string): Promise<{
    readonly sessionId: string;
    readonly sessionVersion: number;
    readonly noticeId: string;
  }> {
    const item = await this.requiredCase(noticeId);
    if (item.status === "out_of_scope")
      throw new RecordCorrectionConflictError(
        "현재 지원 범위 밖의 공지는 보정 작업을 만들 수 없습니다.",
      );
    if (item.gameId === null || item.gameRevision === null || item.eventId === null)
      throw new RecordCorrectionConflictError("먼저 경기와 플레이 후보를 확정해야 합니다.");
    const document = await this.revisionStore.loadCorrectionDraft(item.gameId, item.gameRevision);
    const replay = compileStagingGameDocumentV2(document);
    const authority = replay.findings.some((finding) => finding.severity === "blocking")
      ? "quarantine"
      : "staging";
    const findings = storedCompilerFindings(replay.findings);
    if (authority === "quarantine") await this.workspace.saveQuarantine(document, findings);
    else await this.workspace.saveReady(document, findings);
    const session = await this.sessions.create({ gameId: item.gameId, authority });
    return { sessionId: session.sessionId, sessionVersion: session.sessionVersion, noticeId };
  }

  public async proposal(sessionId: string, noticeId: string): Promise<RecordCorrectionProposal> {
    const item = await this.requiredCase(noticeId);
    const session = this.sessions.get(sessionId);
    return buildSessionProposal(session, item);
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
    const proposal = buildSessionProposal(session, item);
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
      if (
        resolved.has(item.noticeId) ||
        item.gameId !== gameId ||
        item.gameRevision === null ||
        item.gameRevision >= revision ||
        item.status === "dismissed" ||
        item.status === "resolved"
      )
        continue;
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
    const item = await this.case(noticeId);
    if (item === null) throw new RecordCorrectionNotFoundError("기록정정 공지를 찾을 수 없습니다.");
    return item;
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
  const pitcherParticipant = notice.participants.find(
    (participant) => participant.role === "pitcher",
  );
  if (batterParticipant === undefined || pitcherParticipant === undefined) return [];
  const batters = document.rosters[battingSide].players.filter(
    (player) =>
      player.name === batterParticipant.rawPlayerName &&
      player.battingOrder === notice.battingOrder,
  );
  const pitchers = document.rosters[pitchingSide].players.filter(
    (player) => player.name === pitcherParticipant.rawPlayerName,
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
                batters.length === 1 && pitchers.length === 1
                  ? "날짜·팀·구장·이닝·초말·타순·타자·투수가 모두 일치합니다."
                  : "동명이인 후보입니다. 선수 ID를 확인해 수동 선택해야 합니다.",
            },
          ];
        }),
    ),
  );
}

function selectDoubleheaderCandidates(
  notice: RecordCorrectionNotice,
  candidates: readonly RecordCorrectionGameCandidate[],
): RecordCorrectionGameCandidate[] {
  if (candidates.length <= 1) return [...candidates];
  if (notice.doubleheaderNumber === null) return [];
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
    if (participant.role === "batter") {
      participantPlayerIds[String(participant.participantIndex)] = candidate.batterPlayerId;
      continue;
    }
    if (participant.role === "pitcher") {
      participantPlayerIds[String(participant.participantIndex)] = candidate.pitcherPlayerId;
      continue;
    }
    const preferredSide = pitchingSide;
    const preferred = document.rosters[preferredSide].players.filter(
      (player) => player.name === participant.rawPlayerName,
    );
    const all = [...document.rosters.away.players, ...document.rosters.home.players].filter(
      (player) => player.name === participant.rawPlayerName,
    );
    const candidates = preferred.length === 1 ? preferred : all;
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

function buildSessionProposal(
  session: CorrectionSession,
  item: RecordCorrectionCase,
): RecordCorrectionProposal {
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
      : buildRecordCorrectionBatchProposal(session.draftDocument, item.notice, binding);
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
