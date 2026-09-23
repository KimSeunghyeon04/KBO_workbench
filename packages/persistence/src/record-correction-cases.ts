import type {
  RecordCorrectionCase,
  RecordCorrectionCaseStatus,
  RecordCorrectionListItem,
  RecordCorrectionNotice,
  RecordCorrectionQueue,
  RecordCorrectionReviewActionRequest,
  RecordCorrectionSummary,
} from "@kbo/contracts";
import type { Pool, PoolClient } from "pg";
import { iso, nullableIso } from "./record-correction-db.js";
import { RecordCorrectionSources, loadNotice } from "./record-correction-sources.js";
import {
  RecordCorrectionStaleError,
  type RecordCorrectionAssessmentInput,
  type RecordCorrectionGameCandidate,
} from "./record-correction-types.js";
export class RecordCorrectionCases {
  public constructor(
    private readonly pool: Pool,
    private readonly sources: RecordCorrectionSources,
  ) {}
  public async gameCandidates(
    notice: RecordCorrectionNotice,
  ): Promise<RecordCorrectionGameCandidate[]> {
    const result = await this.pool.query<{
      readonly game_id: string;
      readonly revision: number;
      readonly document_hash: string;
      readonly source_game_id: string;
      readonly game_date: string;
      readonly stadium: string | null;
      readonly away_team_name: string;
      readonly home_team_name: string;
    }>(
      `SELECT r.game_id,r.revision,r.document_hash,r.source_game_id,r.game_date::text,
              r.stadium,away_team.team_name away_team_name,home_team.team_name home_team_name
       FROM workbench.games g
       JOIN workbench.game_revisions r
         ON r.game_id=g.game_id AND r.revision=g.current_revision AND r.sealed
       JOIN workbench.game_team_snapshots away_team
         ON away_team.game_id=r.game_id AND away_team.revision=r.revision AND away_team.side='away'
       JOIN workbench.game_team_snapshots home_team
         ON home_team.game_id=r.game_id AND home_team.revision=r.revision AND home_team.side='home'
       WHERE r.season=$1 AND r.game_date=$2 AND away_team.team_name=$3
         AND home_team.team_name=$4
       ORDER BY r.source_game_id,r.game_id`,
      [
        Number(notice.gameDate.slice(0, 4)),
        notice.gameDate,
        notice.awayTeamName,
        notice.homeTeamName,
      ],
    );
    return result.rows.map((row) => ({
      gameId: row.game_id,
      revision: row.revision,
      documentHash: row.document_hash,
      sourceGameId: row.source_game_id,
      gameDate: row.game_date,
      stadium: row.stadium,
      awayTeamName: row.away_team_name,
      homeTeamName: row.home_team_name,
    }));
  }

  public async seasonHasPendingAssessments(season: number): Promise<boolean> {
    const result = await this.pool.query<{ readonly pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM record_correction.match_assessments a
         JOIN record_correction.season_current_revisions c
           ON c.season=a.season AND c.current_revision=a.source_revision
         WHERE a.season=$1
           AND a.reason_code IN ('awaiting_assessment','notice_source_changed')
       ) AS pending`,
      [season],
    );
    return result.rows[0]?.pending === true;
  }

  public async assess(input: RecordCorrectionAssessmentInput): Promise<RecordCorrectionCase> {
    const location = await this.sources.noticeLocation(input.noticeId);
    if (location === null)
      throw new Error(`record correction notice가 없습니다: ${input.noticeId}`);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        readonly case_version: number;
        readonly status: RecordCorrectionCaseStatus;
        readonly source_revision: number;
      }>(
        `SELECT case_version,status,source_revision
         FROM record_correction.match_assessments WHERE notice_id=$1 FOR UPDATE`,
        [input.noticeId],
      );
      const old = current.rows[0];
      const preserveDecision =
        old?.source_revision === location.sourceRevision &&
        (old.status === "dismissed" || old.status === "resolved");
      const caseVersion = (old?.case_version ?? 0) + 1;
      const status = preserveDecision && old !== undefined ? old.status : input.status;
      await client.query(
        `INSERT INTO record_correction.match_assessments
           (notice_id,season,source_revision,notice_sequence,case_version,status,game_id,
            game_revision,document_hash,event_id,batter_player_id,pitcher_player_id,
            reason_code,reason_message,proposal_hash,assessed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (notice_id) DO UPDATE SET
           season=EXCLUDED.season,source_revision=EXCLUDED.source_revision,
           notice_sequence=EXCLUDED.notice_sequence,case_version=EXCLUDED.case_version,
           status=EXCLUDED.status,game_id=EXCLUDED.game_id,game_revision=EXCLUDED.game_revision,
           document_hash=EXCLUDED.document_hash,event_id=EXCLUDED.event_id,
           batter_player_id=EXCLUDED.batter_player_id,
           pitcher_player_id=EXCLUDED.pitcher_player_id,reason_code=EXCLUDED.reason_code,
           reason_message=EXCLUDED.reason_message,proposal_hash=EXCLUDED.proposal_hash,
           assessed_at=EXCLUDED.assessed_at`,
        [
          input.noticeId,
          location.season,
          location.sourceRevision,
          location.noticeSequence,
          caseVersion,
          status,
          input.gameId,
          input.gameRevision,
          input.documentHash,
          input.eventId,
          input.batterPlayerId,
          input.pitcherPlayerId,
          input.reasonCode,
          input.reasonMessage,
          input.proposalHash,
          input.assessedAt,
        ],
      );
      for (const [candidateOrder, candidate] of input.candidates.entries())
        await client.query(
          `INSERT INTO record_correction.match_candidates
             (notice_id,case_version,candidate_id,candidate_order,game_id,game_revision,
              document_hash,event_id,batter_player_id,pitcher_player_id,label,confidence_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            input.noticeId,
            caseVersion,
            candidate.candidateId,
            candidateOrder,
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
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const result = await this.case(input.noticeId);
    if (result === null) throw new Error("record correction assessment 저장에 실패했습니다.");
    return result;
  }

  public async reviewAction(
    noticeId: string,
    request: RecordCorrectionReviewActionRequest,
  ): Promise<RecordCorrectionCase> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const assessment = await client.query<{
        readonly case_version: number;
      }>(
        `SELECT case_version FROM record_correction.match_assessments
         WHERE notice_id=$1 FOR UPDATE`,
        [noticeId],
      );
      if (assessment.rows[0] === undefined) throw new Error("record correction case가 없습니다.");
      if (assessment.rows[0].case_version !== request.caseVersion)
        throw new RecordCorrectionStaleError("record correction case version이 변경되었습니다.");
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
        if (selected === undefined) throw new Error("선택한 record correction 후보가 없습니다.");
        await insertReviewAction(client, noticeId, actionSequence, request, null);
        await client.query(
          `UPDATE record_correction.match_assessments SET
             status='manual_review',game_id=$2,game_revision=$3,document_hash=$4,event_id=$5,
             batter_player_id=$6,pitcher_player_id=$7,reason_code='manual_candidate_selected',
             reason_message='사용자가 경기/플레이 후보를 선택했습니다.',
             proposal_hash=NULL,assessed_at=CURRENT_TIMESTAMP
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
        await insertReviewAction(client, noticeId, actionSequence, request, null);
        await client.query(
          `UPDATE record_correction.match_assessments SET status=$2,
             reason_code=$3,reason_message=$4,assessed_at=CURRENT_TIMESTAMP
           WHERE notice_id=$1`,
          [
            noticeId,
            request.action === "dismiss" ? "dismissed" : "manual_review",
            request.action === "dismiss" ? "dismissed_by_reviewer" : "reopened_by_reviewer",
            request.reason ?? "사용자가 재검토를 요청했습니다.",
          ],
        );
      }
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

  public async markProposalApplied(input: {
    readonly noticeId: string;
    readonly caseVersion: number;
    readonly sessionId: string;
    readonly proposalHash: string;
    readonly documentHash: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actionSequence = await nextActionSequence(client, input.noticeId);
      await client.query(
        `INSERT INTO record_correction.review_actions
           (notice_id,action_sequence,case_version,action_kind,session_id,proposal_hash,document_hash)
         VALUES ($1,$2,$3,'proposal_applied',$4,$5,$6)`,
        [
          input.noticeId,
          actionSequence,
          input.caseVersion,
          input.sessionId,
          input.proposalHash,
          input.documentHash,
        ],
      );
      await client.query(
        `UPDATE record_correction.match_assessments
         SET approved_document_hash=$2,reason_code='proposal_applied_to_draft',
             reason_message='정정 제안을 correction session에 적용했습니다.',
             assessed_at=CURRENT_TIMESTAMP WHERE notice_id=$1`,
        [input.noticeId, input.documentHash],
      );
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async markResolvedIfImported(
    gameId: string,
    revision: number,
    documentHash: string,
  ): Promise<string[]> {
    const result = await this.pool.query<{ readonly notice_id: string }>(
      `UPDATE record_correction.match_assessments SET
         status='resolved',applied_revision=$2,reason_code='sealed_revision_matches_approval',
         reason_message='승인된 문서가 새 current revision으로 봉인되었습니다.',
         assessed_at=CURRENT_TIMESTAMP
       WHERE game_id=$1 AND approved_document_hash=$3 AND status <> 'dismissed'
       RETURNING notice_id`,
      [gameId, revision, documentHash],
    );
    for (const notice of result.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const assessment = await client.query<{ readonly case_version: number }>(
          "SELECT case_version FROM record_correction.match_assessments WHERE notice_id=$1",
          [notice.notice_id],
        );
        const caseVersion = assessment.rows[0]?.case_version;
        if (caseVersion !== undefined)
          await client.query(
            `INSERT INTO record_correction.review_actions
               (notice_id,action_sequence,case_version,action_kind,document_hash,applied_revision)
             VALUES ($1,$2,$3,'resolved',$4,$5)`,
            [
              notice.notice_id,
              await nextActionSequence(client, notice.notice_id),
              caseVersion,
              documentHash,
              revision,
            ],
          );
        await client.query("COMMIT");
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    return result.rows.map((row) => row.notice_id);
  }

  public async markResolvedAfterReassessment(input: {
    readonly noticeId: string;
    readonly caseVersion: number;
    readonly gameId: string;
    readonly revision: number;
    readonly documentHash: string;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ readonly case_version: number }>(
        `UPDATE record_correction.match_assessments SET
           status='resolved',applied_revision=$4,
           reason_code='manual_import_satisfies_kbo_after_state',
           reason_message='수동 교정 revision이 KBO 정정 후 상태를 만족합니다.',
           assessed_at=CURRENT_TIMESTAMP
         WHERE notice_id=$1 AND case_version=$2 AND game_id=$3 AND game_revision=$4
           AND document_hash=$5 AND status='already_applied'
         RETURNING case_version`,
        [input.noticeId, input.caseVersion, input.gameId, input.revision, input.documentHash],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO record_correction.review_actions
           (notice_id,action_sequence,case_version,action_kind,document_hash,applied_revision)
         VALUES ($1,$2,$3,'resolved',$4,$5)`,
        [
          input.noticeId,
          await nextActionSequence(client, input.noticeId),
          row.case_version,
          input.documentHash,
          input.revision,
        ],
      );
      await client.query("COMMIT");
      return true;
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
      `SELECT a.status,COUNT(*)::text count
       FROM record_correction.match_assessments a
       JOIN record_correction.season_current_revisions c
         ON c.season=a.season AND c.current_revision=a.source_revision
       GROUP BY a.status`,
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
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.season !== undefined) {
      values.push(filters.season);
      conditions.push(`a.season=$${String(values.length)}`);
    }
    if (filters.status !== undefined) {
      values.push(filters.status);
      conditions.push(`a.status=$${String(values.length)}`);
    }
    if (filters.search !== undefined && filters.search.trim().length > 0) {
      values.push(`%${filters.search.trim()}%`);
      conditions.push(
        `(n.away_team_name ILIKE $${String(values.length)} OR n.home_team_name ILIKE $${String(values.length)} OR n.content_text ILIKE $${String(values.length)})`,
      );
    }
    const result = await this.pool.query<{ readonly notice_id: string }>(
      `SELECT a.notice_id FROM record_correction.match_assessments a
       JOIN record_correction.season_current_revisions c
         ON c.season=a.season AND c.current_revision=a.source_revision
       JOIN record_correction.notices n
         ON n.season=a.season AND n.revision=a.source_revision
        AND n.notice_sequence=a.notice_sequence
       ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
       ORDER BY n.game_date DESC,n.record_number DESC,a.notice_id`,
      values,
    );
    return Promise.all(
      result.rows.map(async (row) => {
        const item = await this.case(row.notice_id);
        if (item === null) throw new Error("record correction case 조회가 일관되지 않습니다.");
        return item;
      }),
    );
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
      conditions.push(`a.status=$${String(values.length)}`);
    }
    if (filters.queue === "needs_action") {
      conditions.push(`a.status IN ('action_required','manual_review','unmatched')`);
    } else if (filters.queue === "completed") {
      conditions.push(`a.status IN ('already_applied','out_of_scope','resolved','dismissed')`);
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
      `SELECT a.notice_id,a.case_version,a.status,a.season,a.game_id,a.assessed_at,
              n.game_date::text AS game_date,n.away_team_name,n.home_team_name,n.venue_name,
              n.before_record_text,n.after_record_text
       FROM record_correction.match_assessments a
       JOIN record_correction.season_current_revisions c
         ON c.season=a.season AND c.current_revision=a.source_revision
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
    const result = await this.pool.query<{
      readonly season: number;
      readonly source_revision: number;
      readonly notice_sequence: number;
      readonly case_version: number;
      readonly status: RecordCorrectionCaseStatus;
      readonly game_id: string | null;
      readonly game_revision: number | null;
      readonly event_id: string | null;
      readonly reason_code: string;
      readonly reason_message: string;
      readonly proposal_hash: string | null;
      readonly applied_revision: number | null;
      readonly assessed_at: Date | string;
    }>("SELECT * FROM record_correction.match_assessments WHERE notice_id=$1", [noticeId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    const notice = await loadNotice(
      this.pool,
      row.season,
      row.source_revision,
      row.notice_sequence,
    );
    const candidates = await this.pool.query<{
      readonly candidate_id: string;
      readonly game_id: string;
      readonly game_revision: number;
      readonly document_hash: string;
      readonly event_id: string | null;
      readonly batter_player_id: string | null;
      readonly pitcher_player_id: string | null;
      readonly label: string;
      readonly confidence_reason: string;
    }>(
      `SELECT * FROM record_correction.match_candidates
       WHERE notice_id=$1 AND case_version=$2 ORDER BY candidate_order`,
      [noticeId, row.case_version],
    );
    return {
      noticeId,
      season: row.season,
      sourceRevision: row.source_revision,
      caseVersion: row.case_version,
      status: row.status,
      gameId: row.game_id,
      gameRevision: row.game_revision,
      eventId: row.event_id,
      reasonCode: row.reason_code,
      reasonMessage: row.reason_message,
      proposalHash: row.proposal_hash,
      appliedRevision: row.applied_revision,
      assessedAt: iso(row.assessed_at),
      notice,
      candidates: candidates.rows.map((candidate) => ({
        candidateId: candidate.candidate_id,
        gameId: candidate.game_id,
        revision: candidate.game_revision,
        documentHash: candidate.document_hash,
        eventId: candidate.event_id,
        batterPlayerId: candidate.batter_player_id,
        pitcherPlayerId: candidate.pitcher_player_id,
        label: candidate.label,
        confidenceReason: candidate.confidence_reason,
      })),
    };
  }
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
  sessionId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO record_correction.review_actions
       (notice_id,action_sequence,case_version,action_kind,candidate_id,reason,session_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      noticeId,
      actionSequence,
      request.caseVersion,
      request.action,
      request.candidateId,
      request.reason,
      sessionId,
    ],
  );
}
