import type {
  RecordCorrectionApprovalReference,
  RecordCorrectionCase,
  RecordCorrectionCaseStatus,
  RecordCorrectionListItem,
  RecordCorrectionMatchCandidate,
  RecordCorrectionNotice,
  RecordCorrectionQueue,
  RecordCorrectionReviewActionRequest,
  RecordCorrectionSummary,
} from "@kbo/contracts";
import { canonicalStringify } from "@kbo/contracts";
import type { Pool, PoolClient } from "pg";
import { iso, nullableIso } from "./record-correction-db.js";
import {
  advanceMatchupGenerations,
  lockMatchupAssessment,
  lockMatchupChanges,
  readMatchupGeneration,
  noticeMatchup,
  readMatchupCandidates,
  readRevisionMatchups,
  matchesRecordCorrectionDoubleheader,
  type Matchup,
} from "./record-correction-matchups.js";
import {
  currentRecordCorrectionSelectionSql,
  readApprovalEvidence,
  readApprovalHistory,
} from "./record-correction-publication.js";
import { loadNotice, loadNotices } from "./record-correction-sources.js";
import {
  RecordCorrectionStaleError,
  type RecordCorrectionApprovalEvidence,
  type RecordCorrectionApprovalInput,
  type RecordCorrectionApprovalHistory,
  type RecordCorrectionMatchup,
  type RecordCorrectionMatchupContext,
  type RecordCorrectionAssessmentInput,
  type RecordCorrectionCaseSnapshot,
  type RecordCorrectionAssessmentBasis,
  type RecordCorrectionGameCandidate,
} from "./record-correction-types.js";
import { RevisionConflictError } from "./revision-types.js";

interface AssessmentRow {
  readonly season: number;
  readonly source_revision: number;
  readonly notice_sequence: number;
  readonly case_version: number;
  readonly status: RecordCorrectionCaseStatus;
  readonly game_id: string | null;
  readonly game_revision: number | null;
  readonly document_hash: string | null;
  readonly event_id: string | null;
  readonly batter_player_id: string | null;
  readonly pitcher_player_id: string | null;
  readonly reason_code: string;
  readonly reason_message: string;
  readonly proposal_hash: string | null;
  readonly applied_revision: number | null;
  readonly assessed_at: Date | string;
  readonly notice_hash: string;
  readonly publication: number;
  readonly decision_sequence: number;
  readonly matchup_generation: number;
  readonly checked_matchup_generation: number | null;
  readonly assessment_current: boolean;
  readonly effective_status: RecordCorrectionCaseStatus;
  readonly doubleheader_number: number | null;
}

export class RecordCorrectionCases {
  public constructor(private readonly pool: Pool) {}
  public async gameCandidates(
    notice: RecordCorrectionNotice,
  ): Promise<RecordCorrectionGameCandidate[]> {
    return readMatchupCandidates(this.pool, noticeMatchup(notice));
  }

  public async assessmentBasis(
    notice: RecordCorrectionNotice,
  ): Promise<RecordCorrectionAssessmentBasis> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const row = await activeAssessment(client, notice.noticeId);
      if (row === undefined || row.notice_hash !== notice.noticeHash)
        throw new RecordCorrectionStaleError("평가 중 기록정정 공지 발행이 변경되었습니다.");
      const matchup = noticeMatchup(notice);
      const games = await readMatchupCandidates(client, matchup);
      const peers = await scopedNotices(client, matchup);
      const peer = peers.find((item) => item.notice.noticeId === notice.noticeId);
      const selection =
        peer === undefined ? await readSelection(client, notice.noticeId) : peer.selection;
      const actionSequence = (await nextActionSequence(client, notice.noticeId)) - 1;
      await client.query("COMMIT");
      return {
        caseVersion: row.case_version,
        publication: row.publication,
        matchupGeneration: row.matchup_generation,
        actionSequence,
        selection,
        games,
        peers,
      };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async matchupContext(
    notice: RecordCorrectionMatchup,
  ): Promise<RecordCorrectionMatchupContext> {
    const client = await this.pool.connect();
    const matchup = noticeMatchup(notice);
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const generation = await readMatchupGeneration(client, matchup);
      const games = await readMatchupCandidates(client, matchup);
      const notices = await scopedNotices(client, matchup);
      await client.query("COMMIT");
      return { generation, games, notices };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async approvalEvidence(
    references: readonly RecordCorrectionApprovalReference[],
  ): Promise<RecordCorrectionApprovalEvidence[]> {
    if (references.length === 0) return [];
    return readApprovalEvidence(this.pool, references);
  }

  public async approvalHistory(
    references: readonly RecordCorrectionApprovalReference[],
    scope: Pick<RecordCorrectionApprovalEvidence, "gameId" | "revision" | "baseHash">,
    matchup: RecordCorrectionMatchup,
  ): Promise<RecordCorrectionApprovalHistory> {
    if (references.length === 0) return { active: [], recorded: [], unknown: false };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const history = await readApprovalHistory(client, references, scope, noticeMatchup(matchup));
      await client.query("COMMIT");
      return history;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async pendingNoticeIds(after: string, limit: number, season?: number): Promise<string[]> {
    const result = await this.pool.query<{ notice_id: string }>(
      `SELECT notice_id FROM record_correction.active_assessments
       WHERE notice_id > $1 AND NOT assessment_current AND status <> 'dismissed'
         AND ($3::integer IS NULL OR season=$3)
       ORDER BY notice_id LIMIT $2`,
      [after, limit, season ?? null],
    );
    return result.rows.map((row) => row.notice_id);
  }

  public async seasonHasPendingAssessments(season: number): Promise<boolean> {
    return (await this.pendingNoticeIds("", 1, season)).length > 0;
  }

  public async assess(input: RecordCorrectionAssessmentInput): Promise<RecordCorrectionCase> {
    const matchup = noticeMatchup(input.matchup);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const gameBases = [...(input.gameBases ?? [])].sort((a, b) =>
        a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0,
      );
      for (const { gameId, revision, documentHash } of gameBases) {
        if (!(await isCurrentSealedRevision(client, gameId, revision, documentHash))) {
          throw new RevisionConflictError("기록정정 평가 중 current revision이 변경되었습니다.");
        }
      }
      await lockMatchupAssessment(client, matchup);
      await lockNotice(client, input.noticeId);
      const old = await activeAssessment(client, input.noticeId);
      if (
        old === undefined ||
        old.notice_hash !== input.noticeHash ||
        old.case_version !== input.caseVersion ||
        input.basis.publication !== old.publication ||
        input.basis.actionSequence !== (await nextActionSequence(client, input.noticeId)) - 1
      ) {
        throw new RecordCorrectionStaleError("평가 중 기록정정 공지나 사례가 갱신되었습니다.");
      }
      if (input.basis.matchupGeneration !== old.matchup_generation)
        throw new RevisionConflictError("기록정정 평가 중 대진의 경기 후보가 변경되었습니다.");
      if (input.gameBases !== null) {
        const candidates = await readMatchupCandidates(client, matchup);
        if (
          candidates.length !== input.gameBases.length ||
          candidates.some((candidate, index) => {
            const expected = input.gameBases?.[index];
            return (
              candidate.gameId !== expected?.gameId ||
              candidate.revision !== expected.revision ||
              candidate.documentHash !== expected.documentHash
            );
          })
        ) {
          throw new RevisionConflictError("기록정정 평가 중 대진의 경기 후보가 변경되었습니다.");
        }
      }

      const resolved =
        input.status === "already_applied" && input.gameRevision !== null && input.gameRevision > 1;
      const status = old.status === "dismissed" ? old.status : resolved ? "resolved" : input.status;
      const reasonCode =
        status === "dismissed"
          ? old.reason_code
          : resolved
            ? "sealed_revision_satisfies_kbo_after_state"
            : input.reasonCode;
      const reasonMessage =
        status === "dismissed"
          ? old.reason_message
          : resolved
            ? "현재 봉인된 교정 revision이 KBO 정정 후 상태를 만족합니다."
            : input.reasonMessage;
      const appliedRevision = resolved ? input.gameRevision : null;
      const proposalHash = input.proposalHash;
      const next = [
        status,
        input.gameId,
        input.gameRevision,
        input.documentHash,
        input.eventId,
        input.batterPlayerId,
        input.pitcherPlayerId,
        reasonCode,
        reasonMessage,
        proposalHash,
        appliedRevision,
      ];
      const previous = [
        old.status,
        old.game_id,
        old.game_revision,
        old.document_hash,
        old.event_id,
        old.batter_player_id,
        old.pitcher_player_id,
        old.reason_code,
        old.reason_message,
        old.proposal_hash,
        old.applied_revision,
      ];
      const changed =
        canonicalStringify(next) !== canonicalStringify(previous) ||
        canonicalStringify(input.candidates) !==
          canonicalStringify(
            await readAssessmentCandidates(client, input.noticeId, old.case_version),
          );
      const version = old.case_version + Number(changed);
      if (changed && status !== "dismissed") {
        await client.query(
          `UPDATE record_correction.match_assessments SET
             status=$2,game_id=$3,game_revision=$4,document_hash=$5,event_id=$6,
             batter_player_id=$7,pitcher_player_id=$8,reason_code=$9,reason_message=$10,
             proposal_hash=$11,applied_revision=$12,case_version=$13,assessed_at=$14
           WHERE notice_id=$1`,
          [input.noticeId, ...next, version, input.assessedAt],
        );
        await writeCandidates(client, input.noticeId, version, input.candidates);
        if (resolved) {
          await client.query(
            `INSERT INTO record_correction.review_actions
             (notice_id,action_sequence,case_version,action_kind,document_hash,applied_revision,notice_publication,target_game_id)
             SELECT $1,$2,$3,'resolved',$4,$5,$6,$7
             WHERE NOT EXISTS (SELECT 1 FROM record_correction.review_actions
               WHERE notice_id=$1 AND action_kind='resolved' AND notice_publication=$6
                 AND document_hash=$4 AND target_game_id=$7)`,
            [
              input.noticeId,
              await nextActionSequence(client, input.noticeId),
              version,
              input.documentHash,
              appliedRevision,
              old.publication,
              input.gameId,
            ],
          );
        }
      }
      await client.query(
        `UPDATE record_correction.match_assessments SET
           checked_matchup_generation=$2,checked_decision_sequence=decision_sequence WHERE notice_id=$1`,
        [input.noticeId, old.matchup_generation],
      );
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const result = await this.case(input.noticeId);
    if (result === null)
      throw new RecordCorrectionStaleError("평가 중 기록정정 공지가 비활성화되었습니다.");
    return result;
  }

  public async reviewAction(
    noticeId: string,
    request: RecordCorrectionReviewActionRequest,
  ): Promise<RecordCorrectionCase> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const before = await activeAssessment(client, noticeId);
      if (before === undefined) throw new RecordCorrectionStaleError("현재 공지 발행이 없습니다.");
      const notice = await loadNotice(
        client,
        before.season,
        before.source_revision,
        before.notice_sequence,
      );
      const matchup = noticeMatchup(notice);
      const lockedMatchups = await lockMatchupChanges(client, [matchup]);
      await lockNotice(client, noticeId);
      const row = await activeAssessment(client, noticeId);
      if (
        row === undefined ||
        row.publication !== before.publication ||
        row.case_version !== request.caseVersion
      )
        throw new RecordCorrectionStaleError("record correction case version이 변경되었습니다.");
      if (
        (row.status === "dismissed" && request.action !== "reopen") ||
        (request.action === "reopen" && row.status !== "dismissed")
      ) {
        throw new RecordCorrectionStaleError("현재 검토 상태에서 실행할 수 없는 작업입니다.");
      }
      const actionSequence = await nextActionSequence(client, noticeId);
      if (request.action === "select_candidate") {
        if (request.candidateId === null)
          throw new Error("후보 선택에는 candidateId가 필요합니다.");
        const candidate = await client.query<{
          readonly game_id: string;
          readonly game_revision: number;
          readonly document_hash: string;
          readonly event_id: string | null;
          readonly batter_player_id: string | null;
          readonly pitcher_player_id: string | null;
        }>(
          `SELECT game_id,game_revision,document_hash,event_id,batter_player_id,pitcher_player_id
           FROM record_correction.match_candidates
           WHERE notice_id=$1 AND case_version=$2 AND candidate_id=$3`,
          [noticeId, request.caseVersion, request.candidateId],
        );
        const selected = candidate.rows[0];
        const games = await readMatchupCandidates(client, matchup);
        if (
          selected === undefined ||
          selected.event_id === null ||
          !games.some(
            (game) =>
              game.gameId === selected.game_id &&
              game.revision === selected.game_revision &&
              game.documentHash === selected.document_hash &&
              matchesRecordCorrectionDoubleheader(game.sourceGameId, row.doubleheader_number),
          )
        ) {
          throw new RecordCorrectionStaleError("현재 공지에서 유효한 경기·타석 후보가 아닙니다.");
        }
        await insertReviewAction(client, noticeId, actionSequence, request, row.publication);
        await client.query(
          `UPDATE record_correction.match_assessments SET
             status='manual_review',game_id=$2,game_revision=$3,document_hash=$4,event_id=$5,
             batter_player_id=$6,pitcher_player_id=$7,reason_code='manual_candidate_selected',
             reason_message='사용자가 경기/플레이 후보를 선택했습니다.',
             proposal_hash=NULL,applied_revision=NULL,assessed_at=CURRENT_TIMESTAMP
           WHERE notice_id=$1`,
          [
            noticeId,
            selected.game_id,
            selected.game_revision,
            selected.document_hash,
            selected.event_id,
            selected.batter_player_id,
            selected.pitcher_player_id,
          ],
        );
      } else {
        if (request.action === "dismiss" && request.reason === null)
          throw new Error("무시에는 사유가 필요합니다.");
        await insertReviewAction(client, noticeId, actionSequence, request, row.publication);
        await client.query(
          `UPDATE record_correction.match_assessments SET status=$2,
             reason_code=$3,reason_message=$4,proposal_hash=NULL,applied_revision=NULL,assessed_at=CURRENT_TIMESTAMP
           WHERE notice_id=$1`,
          [
            noticeId,
            request.action === "dismiss" ? "dismissed" : "manual_review",
            request.action === "dismiss" ? "dismissed_by_reviewer" : "reopened_by_reviewer",
            request.reason ?? "사용자가 재검토를 요청했습니다.",
          ],
        );
      }
      const nextVersion = request.caseVersion + 1;
      await client.query(
        `INSERT INTO record_correction.match_candidates
           (notice_id,case_version,candidate_id,candidate_order,game_id,game_revision,
            document_hash,event_id,batter_player_id,pitcher_player_id,label,confidence_reason)
         SELECT notice_id,$3,candidate_id,candidate_order,game_id,game_revision,
                document_hash,event_id,batter_player_id,pitcher_player_id,label,confidence_reason
         FROM record_correction.match_candidates WHERE notice_id=$1 AND case_version=$2`,
        [noticeId, request.caseVersion, nextVersion],
      );
      await client.query(
        "UPDATE record_correction.match_assessments SET case_version=$2,decision_sequence=$3 WHERE notice_id=$1",
        [noticeId, nextVersion, actionSequence],
      );
      await advanceMatchupGenerations(client, lockedMatchups);
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const result = await this.case(noticeId);
    if (result === null) throw new Error("record correction case가 없습니다.");
    return result;
  }

  public async markProposalApplied(
    input: RecordCorrectionApprovalInput,
  ): Promise<RecordCorrectionApprovalReference> {
    const [first] = await this.markProposalBundle(input);
    if (first === undefined) throw new Error("Missing recorded approval");
    return first;
  }

  public async markProposalBundle(
    input: RecordCorrectionApprovalInput,
  ): Promise<RecordCorrectionApprovalReference[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const before = await activeAssessment(client, input.noticeId);
      if (before === undefined) throw staleApproval();
      const notice = await loadNotice(
        client,
        before.season,
        before.source_revision,
        before.notice_sequence,
      );
      const matchup = noticeMatchup(notice);
      await lockMatchupAssessment(client, matchup);
      const previous = input.plan?.previous ?? [];
      const otherReferences = previous.filter(({ noticeId }) => noticeId !== input.noticeId);
      if (new Set(previous.map(({ noticeId }) => noticeId)).size !== previous.length)
        throw staleApproval();
      const ids = [input.noticeId, ...otherReferences.map(({ noticeId }) => noticeId)].sort();
      if (new Set(ids).size !== ids.length) throw staleApproval();
      for (const id of ids) await lockNotice(client, id);
      const row = await activeAssessment(client, input.noticeId);
      if (
        row === undefined ||
        row.publication !== before.publication ||
        row.case_version !== input.caseVersion ||
        !row.assessment_current ||
        (input.generation !== undefined && row.matchup_generation !== input.generation) ||
        row.status === "dismissed" ||
        row.status === "resolved" ||
        row.game_id === null ||
        row.game_revision === null ||
        row.event_id === null ||
        row.document_hash === null
      )
        throw staleApproval();

      const history = await readApprovalHistory(
        client,
        otherReferences,
        { gameId: row.game_id, revision: row.game_revision, baseHash: row.document_hash },
        matchup,
      );
      const carried = input.plan?.carry ?? [];
      const actual = history.active.map(({ noticeId, actionSequence }) => ({
        noticeId,
        actionSequence,
      }));
      if (
        history.unknown ||
        canonicalStringify(actual) !== canonicalStringify(carried) ||
        history.recorded.length !== otherReferences.length ||
        (input.plan?.kind === "extend" && actual.length !== otherReferences.length)
      )
        throw staleApproval();

      const references = new Map<string, RecordCorrectionApprovalReference>();
      references.set(
        input.noticeId,
        await recordApproval(client, input, row, input.proposalHash, row.event_id),
      );
      for (const proof of history.active) {
        const peer = await activeAssessment(client, proof.noticeId);
        if (
          peer === undefined ||
          proof.gameId !== row.game_id ||
          proof.revision !== row.game_revision ||
          proof.baseHash !== row.document_hash ||
          (input.plan?.kind === "extend" && proof.documentHash !== input.plan.previousDocumentHash)
        )
          throw staleApproval();
        references.set(
          proof.noticeId,
          await recordApproval(
            client,
            { ...input, noticeId: proof.noticeId },
            {
              ...peer,
              game_id: proof.gameId,
              game_revision: proof.revision,
              document_hash: proof.baseHash,
            },
            proof.proposalHash,
            proof.eventId,
          ),
        );
      }
      const order = [...new Set([...previous.map(({ noticeId }) => noticeId), input.noticeId])];
      await client.query("COMMIT");
      return order.flatMap((noticeId) => {
        const reference = references.get(noticeId);
        return reference === undefined ? [] : [reference];
      });
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async summary(nextScheduledAt: string | null): Promise<RecordCorrectionSummary> {
    const counts = await this.pool.query<{
      readonly status: RecordCorrectionCaseStatus;
      readonly count: string;
    }>(
      `SELECT a.effective_status AS status,COUNT(*)::text count
       FROM record_correction.active_assessments a
       GROUP BY a.effective_status`,
    );
    const byStatus = new Map(counts.rows.map((row) => [row.status, Number(row.count)]));
    const last = await this.pool.query<{ readonly finished_at: Date | string | null }>(
      `SELECT finished_at FROM record_correction.collection_runs
       WHERE status IN ('succeeded','no_change') ORDER BY finished_at DESC LIMIT 1`,
    );
    const actionRequired = byStatus.get("action_required") ?? 0;
    const manualReview = byStatus.get("manual_review") ?? 0;
    return {
      counts: {
        actionRequired,
        alreadyApplied: byStatus.get("already_applied") ?? 0,
        manualReview,
        outOfScope: byStatus.get("out_of_scope") ?? 0,
        unmatched: byStatus.get("unmatched") ?? 0,
        resolved: byStatus.get("resolved") ?? 0,
        dismissed: byStatus.get("dismissed") ?? 0,
      },
      alertCount: actionRequired + manualReview,
      lastSuccessfulAt: nullableIso(last.rows[0]?.finished_at ?? null),
      nextScheduledAt,
    };
  }

  public async listCases(
    filters: {
      readonly season?: number;
      readonly status?: RecordCorrectionCaseStatus;
      readonly search?: string;
    } = {},
  ): Promise<RecordCorrectionCase[]> {
    const noticeIds = await this.listCaseNoticeIds(filters);
    const cases = await Promise.all(noticeIds.map((noticeId) => this.case(noticeId)));
    return cases.filter(
      (item): item is RecordCorrectionCase =>
        item !== null && (filters.status === undefined || filters.status === item.status),
    );
  }

  private async listCaseNoticeIds(
    filters: {
      readonly season?: number;
      readonly status?: RecordCorrectionCaseStatus;
      readonly search?: string;
    },
    matchups?: readonly Matchup[],
  ): Promise<string[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.season !== undefined) {
      values.push(filters.season);
      conditions.push(`a.season=$${String(values.length)}`);
    }
    if (filters.status !== undefined) {
      values.push(filters.status);
      conditions.push(`a.effective_status=$${String(values.length)}`);
    }
    if (filters.search !== undefined && filters.search.trim().length > 0) {
      values.push(`%${filters.search.trim()}%`);
      conditions.push(
        `(n.away_team_name ILIKE $${String(values.length)} OR n.home_team_name ILIKE $${String(values.length)} OR n.content_text ILIKE $${String(values.length)})`,
      );
    }
    if (matchups !== undefined) {
      if (matchups.length === 0) return [];
      conditions.push("NOT a.assessment_current AND a.status <> 'dismissed'");
      const predicates = matchups.map((matchup) => {
        const index = values.length;
        values.push(...matchup);
        return `(n.season=$${index + 1} AND n.game_date=$${index + 2}
          AND n.away_team_name=$${index + 3} AND n.home_team_name=$${index + 4})`;
      });
      conditions.push(`(${predicates.join(" OR ")})`);
    }
    const result = await this.pool.query<{ readonly notice_id: string }>(
      `SELECT a.notice_id FROM record_correction.active_assessments a
       JOIN record_correction.notices n
         ON n.season=a.season AND n.revision=a.source_revision
        AND n.notice_sequence=a.notice_sequence
       ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
       ORDER BY n.game_date DESC,n.record_number DESC,a.notice_id`,
      values,
    );
    return result.rows.map(({ notice_id }) => notice_id);
  }

  public async listNoticeIdsForImport(gameId: string, revision: number): Promise<string[]> {
    return this.listCaseNoticeIds({}, await readRevisionMatchups(this.pool, gameId, revision));
  }

  public async listCaseSummaries(
    filters: {
      readonly season?: number;
      readonly status?: RecordCorrectionCaseStatus;
      readonly queue?: RecordCorrectionQueue;
      readonly search?: string;
    } = {},
  ): Promise<RecordCorrectionListItem[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.season !== undefined) {
      values.push(filters.season);
      conditions.push(`a.season=$${String(values.length)}`);
    }
    if (filters.status !== undefined) {
      values.push(filters.status);
      conditions.push(`a.effective_status=$${String(values.length)}`);
    }
    if (filters.queue === "needs_action") {
      conditions.push(`a.effective_status IN ('action_required','manual_review','unmatched')`);
    } else if (filters.queue === "completed") {
      conditions.push(
        `a.effective_status IN ('already_applied','out_of_scope','resolved','dismissed')`,
      );
    }
    if (filters.search !== undefined && filters.search.trim().length > 0) {
      values.push(`%${filters.search.trim()}%`);
      conditions.push(
        `(n.away_team_name ILIKE $${String(values.length)} OR n.home_team_name ILIKE $${String(values.length)} OR n.content_text ILIKE $${String(values.length)})`,
      );
    }
    const result = await this.pool.query<{
      readonly notice_id: string;
      readonly case_version: number;
      readonly status: RecordCorrectionCaseStatus;
      readonly season: number;
      readonly game_id: string | null;
      readonly assessed_at: Date | string;
      readonly game_date: string;
      readonly away_team_name: string;
      readonly home_team_name: string;
      readonly venue_name: string;
      readonly before_record_text: string;
      readonly after_record_text: string;
    }>(
      `SELECT a.notice_id,a.case_version,a.effective_status AS status,a.season,
              CASE WHEN a.assessment_current THEN a.game_id END AS game_id,a.assessed_at,
              n.game_date::text AS game_date,n.away_team_name,n.home_team_name,n.venue_name,
              n.before_record_text,n.after_record_text
       FROM record_correction.active_assessments a
       JOIN record_correction.notices n
         ON n.season=a.season AND n.revision=a.source_revision
        AND n.notice_sequence=a.notice_sequence
       ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
       ORDER BY n.game_date DESC,n.record_number DESC,a.notice_id`,
      values,
    );
    return result.rows.map((row) => ({
      noticeId: row.notice_id,
      caseVersion: row.case_version,
      status: row.status,
      season: row.season,
      gameId: row.game_id,
      assessedAt: iso(row.assessed_at),
      gameDate: row.game_date,
      awayTeamName: row.away_team_name,
      homeTeamName: row.home_team_name,
      venueName: row.venue_name,
      beforeRecordText: row.before_record_text,
      afterRecordText: row.after_record_text,
    }));
  }

  public async case(noticeId: string): Promise<RecordCorrectionCase | null> {
    return (await this.caseSnapshot(noticeId))?.item ?? null;
  }

  public async caseSnapshot(noticeId: string): Promise<RecordCorrectionCaseSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const row = await activeAssessment(client, noticeId);
      if (row === undefined) {
        await client.query("COMMIT");
        return null;
      }
      const notice = await loadNotice(client, row.season, row.source_revision, row.notice_sequence);
      const pending = !row.assessment_current && row.status !== "dismissed";
      const candidates =
        pending && row.reason_code !== "manual_candidate_selected"
          ? []
          : await readAssessmentCandidates(client, noticeId, row.case_version);
      await client.query("COMMIT");
      return {
        assessmentCurrent: row.assessment_current,
        publication: row.publication,
        decisionSequence: row.decision_sequence,
        item: {
          noticeId,
          season: row.season,
          sourceRevision: row.source_revision,
          caseVersion: row.case_version,
          status: row.effective_status,
          gameId: pending ? null : row.game_id,
          gameRevision: pending ? null : row.game_revision,
          eventId: pending ? null : row.event_id,
          reasonCode:
            pending && row.checked_matchup_generation !== null
              ? "awaiting_assessment"
              : row.reason_code,
          reasonMessage:
            pending && row.checked_matchup_generation !== null
              ? "현재 경기와 검토 근거를 재평가하고 있습니다."
              : row.reason_message,
          proposalHash: pending ? null : row.proposal_hash,
          appliedRevision: pending ? null : row.applied_revision,
          assessedAt: iso(row.assessed_at),
          notice,
          candidates,
          ...(pending ? { assessmentPending: true as const } : {}),
        },
      };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockNotice(client: PoolClient, noticeId: string): Promise<void> {
  await client.query(
    "SELECT notice_id FROM record_correction.match_assessments WHERE notice_id=$1 FOR UPDATE",
    [noticeId],
  );
}

async function activeAssessment(
  client: PoolClient,
  noticeId: string,
): Promise<AssessmentRow | undefined> {
  return (
    await client.query<AssessmentRow>(
      "SELECT * FROM record_correction.active_assessments WHERE notice_id=$1",
      [noticeId],
    )
  ).rows[0];
}

const matchCandidateColumns = `c.candidate_id AS "candidateId",c.game_id AS "gameId",
  c.game_revision AS revision,c.document_hash AS "documentHash",c.event_id AS "eventId",
  c.batter_player_id AS "batterPlayerId",c.pitcher_player_id AS "pitcherPlayerId",
  c.label,c.confidence_reason AS "confidenceReason"`;

function selectedCandidateSql(
  noticeId: Parameters<typeof currentRecordCorrectionSelectionSql>[0],
): string {
  return `SELECT ${matchCandidateColumns}
    FROM (${currentRecordCorrectionSelectionSql(noticeId)}) decision
    JOIN record_correction.match_candidates c
      ON (c.notice_id,c.case_version,c.candidate_id)=
        (${noticeId},decision.case_version,decision.candidate_id)`;
}

async function readSelection(
  client: PoolClient,
  noticeId: string,
): Promise<RecordCorrectionMatchCandidate | null> {
  const result = await client.query<RecordCorrectionMatchCandidate>(selectedCandidateSql("$1"), [
    noticeId,
  ]);
  return result.rows[0] ?? null;
}

async function writeCandidates(
  client: PoolClient,
  noticeId: string,
  caseVersion: number,
  candidates: readonly RecordCorrectionMatchCandidate[],
): Promise<void> {
  for (const [order, candidate] of candidates.entries()) {
    await client.query(
      `INSERT INTO record_correction.match_candidates
       (notice_id,case_version,candidate_id,candidate_order,game_id,game_revision,document_hash,event_id,
        batter_player_id,pitcher_player_id,label,confidence_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        noticeId,
        caseVersion,
        candidate.candidateId,
        order,
        candidate.gameId,
        candidate.revision,
        candidate.documentHash,
        candidate.eventId,
        candidate.batterPlayerId,
        candidate.pitcherPlayerId,
        candidate.label,
        candidate.confidenceReason,
      ],
    );
  }
}

function staleApproval(): RecordCorrectionStaleError {
  return new RecordCorrectionStaleError("승인 중 현재 공지·경기·사례가 갱신되었습니다.");
}

async function scopedNotices(
  client: PoolClient,
  matchup: Matchup,
): Promise<RecordCorrectionMatchupContext["notices"]> {
  const result = await client.query<
    Pick<AssessmentRow, "season" | "source_revision" | "notice_sequence"> & {
      selection: RecordCorrectionMatchCandidate | null;
    }
  >(
    `SELECT a.season,a.source_revision,a.notice_sequence,row_to_json(candidate) AS selection
     FROM record_correction.active_assessments a
     JOIN record_correction.notices n ON (n.season,n.revision,n.notice_sequence)=
       (a.season,a.source_revision,a.notice_sequence)
     LEFT JOIN LATERAL (${selectedCandidateSql("a.notice_id")}) candidate ON TRUE
     WHERE a.season=$1 AND n.game_date=$2 AND n.away_team_name=$3 AND n.home_team_name=$4
       AND a.status <> 'dismissed' ORDER BY a.notice_id`,
    [...matchup],
  );
  const notices = await loadNotices(client, result.rows);
  return notices.map((notice, index) => ({
    notice,
    selection: result.rows[index]?.selection ?? null,
  }));
}

async function recordApproval(
  client: PoolClient,
  input: RecordCorrectionApprovalInput,
  row: AssessmentRow,
  proposalHash: string,
  eventId: string,
): Promise<RecordCorrectionApprovalReference> {
  const existing = await client.query<{ action_sequence: number }>(
    `SELECT action_sequence FROM record_correction.active_review_actions
     WHERE notice_id=$1 AND action_kind='proposal_applied' AND target_decision_sequence=$2
       AND target_game_id=$3 AND target_game_revision=$4 AND target_event_id=$5
       AND proposal_hash=$6 AND document_hash=$7 AND verified_matchup_generation IS NOT DISTINCT FROM $8
     ORDER BY action_sequence DESC LIMIT 1`,
    [
      input.noticeId,
      row.decision_sequence,
      row.game_id,
      row.game_revision,
      eventId,
      proposalHash,
      input.documentHash,
      input.generation ?? null,
    ],
  );
  const reused = existing.rows[0]?.action_sequence;
  if (reused !== undefined) return { noticeId: input.noticeId, actionSequence: reused };
  const actionSequence = await nextActionSequence(client, input.noticeId);
  await client.query(
    `INSERT INTO record_correction.review_actions
       (notice_id,action_sequence,case_version,action_kind,session_id,proposal_hash,document_hash,
        notice_publication,target_decision_sequence,target_game_id,target_game_revision,target_document_hash,
        target_event_id,verified_matchup_generation)
     VALUES ($1,$2,$3,'proposal_applied',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      input.noticeId,
      actionSequence,
      row.case_version,
      input.sessionId,
      proposalHash,
      input.documentHash,
      row.publication,
      row.decision_sequence,
      row.game_id,
      row.game_revision,
      row.document_hash,
      eventId,
      input.generation ?? null,
    ],
  );
  return { noticeId: input.noticeId, actionSequence };
}

async function readAssessmentCandidates(
  executor: Pool | PoolClient,
  noticeId: string,
  caseVersion: number,
): Promise<RecordCorrectionMatchCandidate[]> {
  const result = await executor.query<RecordCorrectionMatchCandidate>(
    `SELECT ${matchCandidateColumns}
     FROM record_correction.match_candidates c
     WHERE c.notice_id=$1 AND c.case_version=$2 ORDER BY c.candidate_order`,
    [noticeId, caseVersion],
  );
  return result.rows;
}

async function isCurrentSealedRevision(
  client: PoolClient,
  gameId: string,
  revision: number,
  documentHash: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM workbench.games g
     JOIN workbench.game_revisions r ON r.game_id=g.game_id AND r.revision=g.current_revision
     WHERE g.game_id=$1 AND g.current_revision=$2 AND r.sealed AND r.document_hash=$3
     FOR SHARE OF g`,
    [gameId, revision, documentHash],
  );
  return result.rows.length === 1;
}

async function nextActionSequence(client: PoolClient, noticeId: string): Promise<number> {
  const result = await client.query<{ readonly next: number }>(
    `SELECT COALESCE(MAX(action_sequence),0)+1 next
     FROM record_correction.review_actions WHERE notice_id=$1`,
    [noticeId],
  );
  return result.rows[0]?.next ?? 1;
}

async function insertReviewAction(
  client: PoolClient,
  noticeId: string,
  actionSequence: number,
  request: RecordCorrectionReviewActionRequest,
  publication: number,
): Promise<void> {
  await client.query(
    `INSERT INTO record_correction.review_actions
       (notice_id,action_sequence,case_version,action_kind,candidate_id,reason,notice_publication)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      noticeId,
      actionSequence,
      request.caseVersion,
      request.action,
      request.candidateId,
      request.reason,
      publication,
    ],
  );
}
