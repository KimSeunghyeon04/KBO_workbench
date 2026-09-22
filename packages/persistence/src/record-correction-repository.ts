import {
  parseRecordCorrectionSeasonDataset,
  recordCorrectionSupportKind,
  type RecordCorrectionCase,
  type RecordCorrectionCaseStatus,
  type RecordCorrectionJob,
  type RecordCorrectionListItem,
  type RecordCorrectionMatchCandidate,
  type RecordCorrectionNotice,
  type RecordCorrectionReviewActionRequest,
  type RecordCorrectionSeasonDataset,
  type RecordCorrectionSummary,
  type RecordCorrectionQueue,
} from "@kbo/contracts";
import type { Pool, PoolClient } from "pg";

export interface RecordCorrectionImportedSeason {
  readonly season: number;
  readonly revision: number | null;
  readonly sourceBundleHash: string;
  readonly noticeCount: number;
  readonly noChange: boolean;
}

export interface RecordCorrectionGameCandidate {
  readonly gameId: string;
  readonly revision: number;
  readonly documentHash: string;
  readonly sourceGameId: string;
  readonly gameDate: string;
  readonly stadium: string | null;
  readonly awayTeamName: string;
  readonly homeTeamName: string;
}

export interface RecordCorrectionResumableJob {
  readonly jobId: string;
  readonly seasons: readonly number[];
  readonly hasChanges: boolean;
}

export interface RecordCorrectionAssessmentInput {
  readonly noticeId: string;
  readonly status: RecordCorrectionCaseStatus;
  readonly gameId: string | null;
  readonly gameRevision: number | null;
  readonly documentHash: string | null;
  readonly eventId: string | null;
  readonly batterPlayerId: string | null;
  readonly pitcherPlayerId: string | null;
  readonly reasonCode: string;
  readonly reasonMessage: string;
  readonly proposalHash: string | null;
  readonly candidates: readonly RecordCorrectionMatchCandidate[];
  readonly assessedAt: string;
}

interface NoticeLocation {
  readonly season: number;
  readonly sourceRevision: number;
  readonly noticeSequence: number;
  readonly noticeHash: string;
}

export class RecordCorrectionRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly expectedMigrationVersion: string,
  ) {}

  public async seasonsWithSealedGames(): Promise<number[]> {
    const result = await this.pool.query<{ readonly season: number }>(
      `SELECT DISTINCT r.season
       FROM workbench.games g JOIN workbench.game_revisions r
         ON r.game_id=g.game_id AND r.revision=g.current_revision
       WHERE r.sealed ORDER BY r.season`,
    );
    return result.rows.map((row) => row.season);
  }

  public async createJob(
    jobId: string,
    trigger: "manual" | "scheduled",
    idempotencyKey: string,
    seasons: readonly number[],
    createdAt: string,
  ): Promise<{ readonly created: boolean; readonly job: RecordCorrectionJob }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertContract(client, this.expectedMigrationVersion);
      const existing = await client.query<{ readonly run_id: string }>(
        "SELECT run_id FROM record_correction.collection_runs WHERE idempotency_key=$1",
        [idempotencyKey],
      );
      if (existing.rows[0] !== undefined) {
        await client.query("COMMIT");
        return { created: false, job: await this.job(existing.rows[0].run_id) };
      }
      await client.query(
        `INSERT INTO record_correction.collection_runs
           (run_id,trigger_kind,idempotency_key,status,created_at)
         VALUES ($1,$2,$3,'queued',$4)`,
        [jobId, trigger, idempotencyKey, createdAt],
      );
      for (const [seasonOrder, season] of seasons.entries())
        await client.query(
          `INSERT INTO record_correction.collection_run_seasons
             (run_id,season,season_order,status)
           VALUES ($1,$2,$3,'queued')`,
          [jobId, season, seasonOrder],
        );
      await client.query("COMMIT");
      return { created: true, job: await this.job(jobId) };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async setJobRunning(jobId: string, startedAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE record_correction.collection_runs
       SET status='running',started_at=COALESCE(started_at,$2),finished_at=NULL,
           error_category=NULL,error_message=NULL WHERE run_id=$1`,
      [jobId, startedAt],
    );
  }

  public async resumableJobs(): Promise<RecordCorrectionResumableJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertContract(client, this.expectedMigrationVersion);
      const interrupted = await client.query<{ readonly run_id: string }>(
        `SELECT run_id FROM record_correction.collection_runs
         WHERE status IN ('queued','running') ORDER BY created_at,run_id FOR UPDATE`,
      );
      const jobs: RecordCorrectionResumableJob[] = [];
      for (const row of interrupted.rows) {
        await client.query(
          `UPDATE record_correction.collection_run_seasons SET status='queued'
           WHERE run_id=$1 AND status='running'`,
          [row.run_id],
        );
        const seasons = await client.query<{ readonly season: number; readonly status: string }>(
          `SELECT season,status FROM record_correction.collection_run_seasons
           WHERE run_id=$1 ORDER BY season_order`,
          [row.run_id],
        );
        const pending = seasons.rows.filter((item) => item.status === "queued");
        if (pending.length > 0) {
          jobs.push({
            jobId: row.run_id,
            seasons: pending.map((item) => item.season),
            hasChanges: seasons.rows.some((item) => item.status === "succeeded"),
          });
        } else {
          await client.query(
            `UPDATE record_correction.collection_runs
             SET status=$2,finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP)
             WHERE run_id=$1`,
            [
              row.run_id,
              seasons.rows.some((item) => item.status === "succeeded") ? "succeeded" : "no_change",
            ],
          );
        }
      }
      await client.query(
        `UPDATE record_correction.collection_runs SET status='cancelled',finished_at=CURRENT_TIMESTAMP
         WHERE status='cancelling'`,
      );
      await client.query("COMMIT");
      return jobs;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async setJobCancelling(jobId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE record_correction.collection_runs SET status='cancelling'
       WHERE run_id=$1 AND status IN ('queued','running')`,
      [jobId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async finishJob(
    jobId: string,
    status: "cancelled" | "succeeded" | "failed" | "no_change",
    finishedAt: string,
    errorCategory: "source" | "domain" | "persistence" | null = null,
    errorMessage: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE record_correction.collection_runs
       SET status=$2,finished_at=$3,error_category=$4,error_message=$5 WHERE run_id=$1`,
      [jobId, status, finishedAt, errorCategory, errorMessage],
    );
  }

  public async markSeasonRunning(jobId: string, season: number): Promise<void> {
    await this.pool.query(
      `UPDATE record_correction.collection_run_seasons SET status='running'
       WHERE run_id=$1 AND season=$2`,
      [jobId, season],
    );
  }

  public async markSeasonFailed(jobId: string, season: number): Promise<void> {
    await this.pool.query(
      `UPDATE record_correction.collection_run_seasons SET status='failed'
       WHERE run_id=$1 AND season=$2`,
      [jobId, season],
    );
  }

  public async importSeason(
    runId: string,
    input: unknown,
    sourceBundleHash: string,
  ): Promise<RecordCorrectionImportedSeason> {
    const dataset = parseRecordCorrectionSeasonDataset(input);
    if (!/^[0-9a-f]{64}$/.test(sourceBundleHash))
      throw new Error("record correction source bundle hash가 올바르지 않습니다.");
    assertDatasetComplete(dataset);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertContract(client, this.expectedMigrationVersion);
      await client.query(
        `INSERT INTO record_correction.season_current_revisions (season,current_revision)
         VALUES ($1,NULL) ON CONFLICT DO NOTHING`,
        [dataset.season],
      );
      const current = await client.query<{
        readonly current_revision: number | null;
        readonly source_bundle_hash: string | null;
      }>(
        `SELECT c.current_revision,r.source_bundle_hash
         FROM record_correction.season_current_revisions c
         LEFT JOIN record_correction.season_revisions r
           ON r.season=c.season AND r.revision=c.current_revision
         WHERE c.season=$1 FOR UPDATE OF c`,
        [dataset.season],
      );
      const currentRow = current.rows[0];
      if (currentRow?.source_bundle_hash === sourceBundleHash) {
        await client.query(
          `UPDATE record_correction.collection_run_seasons
           SET status='no_change',source_bundle_hash=$3,notice_count=$4
           WHERE run_id=$1 AND season=$2`,
          [runId, dataset.season, sourceBundleHash, dataset.notices.length],
        );
        await client.query("COMMIT");
        return {
          season: dataset.season,
          revision: currentRow.current_revision,
          sourceBundleHash,
          noticeCount: dataset.notices.length,
          noChange: true,
        };
      }
      const revision = (currentRow?.current_revision ?? 0) + 1;
      await client.query(
        `INSERT INTO record_correction.season_revisions
           (season,revision,run_id,source_bundle_hash,source_page_count,notice_count)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          dataset.season,
          revision,
          runId,
          sourceBundleHash,
          dataset.sourcePages.length,
          dataset.notices.length,
        ],
      );
      const pageSequences = new Map<string, number>();
      for (const [pageSequence, page] of dataset.sourcePages.entries()) {
        pageSequences.set(page.requestKey, pageSequence);
        await client.query(
          `INSERT INTO record_correction.source_pages
             (season,revision,page_sequence,page_kind,request_key,series_id,page_number,
              artifact_key,content_hash,collected_at,row_count,total_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            dataset.season,
            revision,
            pageSequence,
            page.pageKind,
            page.requestKey,
            page.seriesId,
            page.pageNumber,
            page.artifactKey,
            page.contentHash,
            page.collectedAt,
            page.rowCount,
            page.totalCount,
          ],
        );
      }
      for (const [noticeSequence, notice] of dataset.notices.entries()) {
        const pageSequence = pageSequences.get(notice.sourceRequestKey);
        if (pageSequence === undefined)
          throw new Error(`record correction source page 참조가 없습니다: ${notice.noticeId}`);
        await insertNotice(client, dataset.season, revision, noticeSequence, pageSequence, notice);
      }
      await client.query(
        `UPDATE record_correction.season_revisions
         SET sealed=TRUE,sealed_at=CURRENT_TIMESTAMP WHERE season=$1 AND revision=$2`,
        [dataset.season, revision],
      );
      await client.query(
        `UPDATE record_correction.season_current_revisions
         SET current_revision=$2 WHERE season=$1`,
        [dataset.season, revision],
      );
      await initializeAssessments(client, dataset, revision);
      await client.query(
        `UPDATE record_correction.collection_run_seasons
         SET status='succeeded',source_bundle_hash=$3,imported_revision=$4,notice_count=$5
         WHERE run_id=$1 AND season=$2`,
        [runId, dataset.season, sourceBundleHash, revision, dataset.notices.length],
      );
      await client.query("COMMIT");
      return {
        season: dataset.season,
        revision,
        sourceBundleHash,
        noticeCount: dataset.notices.length,
        noChange: false,
      };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

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

  public async currentNotice(noticeId: string): Promise<RecordCorrectionNotice | null> {
    const location = await this.noticeLocation(noticeId);
    if (location === null) return null;
    return loadNotice(this.pool, location.season, location.sourceRevision, location.noticeSequence);
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
    const location = await this.noticeLocation(input.noticeId);
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

  public async job(jobId: string): Promise<RecordCorrectionJob> {
    const result = await this.pool.query<{
      readonly run_id: string;
      readonly status: RecordCorrectionJob["status"];
      readonly trigger_kind: RecordCorrectionJob["trigger"];
      readonly created_at: Date | string;
      readonly started_at: Date | string | null;
      readonly finished_at: Date | string | null;
      readonly error_message: string | null;
    }>("SELECT * FROM record_correction.collection_runs WHERE run_id=$1", [jobId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`record correction job이 없습니다: ${jobId}`);
    const seasons = await this.pool.query<{
      readonly season: number;
      readonly status: string;
    }>(
      `SELECT season,status FROM record_correction.collection_run_seasons
       WHERE run_id=$1 ORDER BY season_order`,
      [jobId],
    );
    return {
      jobId: row.run_id,
      status: row.status,
      trigger: row.trigger_kind,
      seasons: seasons.rows.map((season) => season.season),
      createdAt: iso(row.created_at),
      startedAt: nullableIso(row.started_at),
      finishedAt: nullableIso(row.finished_at),
      completedSeasons: seasons.rows.filter((season) =>
        ["succeeded", "failed", "no_change"].includes(season.status),
      ).length,
      totalSeasons: seasons.rows.length,
      error: row.error_message,
    };
  }

  public async jobs(): Promise<RecordCorrectionJob[]> {
    const result = await this.pool.query<{ readonly run_id: string }>(
      "SELECT run_id FROM record_correction.collection_runs ORDER BY created_at DESC LIMIT 100",
    );
    return Promise.all(result.rows.map((row) => this.job(row.run_id)));
  }

  private async noticeLocation(noticeId: string): Promise<NoticeLocation | null> {
    const result = await this.pool.query<{
      readonly season: number;
      readonly source_revision: number;
      readonly notice_sequence: number;
      readonly notice_hash: string;
    }>(
      `SELECT n.season,n.revision source_revision,n.notice_sequence,n.notice_hash
       FROM record_correction.season_current_revisions c
       JOIN record_correction.notices n
         ON n.season=c.season AND n.revision=c.current_revision
       WHERE n.notice_id=$1`,
      [noticeId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          season: row.season,
          sourceRevision: row.source_revision,
          noticeSequence: row.notice_sequence,
          noticeHash: row.notice_hash,
        };
  }
}

export class RecordCorrectionStaleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RecordCorrectionStaleError";
  }
}

async function assertContract(client: PoolClient, expectedMigrationVersion: string): Promise<void> {
  const migration = await client.query<{ readonly version: string }>(
    "SELECT version FROM workbench.schema_migrations ORDER BY version DESC LIMIT 1",
  );
  const contract = await client.query<{
    readonly analytics_contract_version: number;
    readonly projection_version: number;
    readonly registry_contract_version: number;
    readonly record_correction_contract_version: number;
  }>(
    `SELECT analytics_contract_version,projection_version,registry_contract_version,
            record_correction_contract_version
     FROM workbench.contract_metadata WHERE singleton`,
  );
  const row = contract.rows[0];
  if (
    migration.rows[0]?.version !== expectedMigrationVersion ||
    row?.analytics_contract_version !== 4 ||
    row.projection_version !== 4 ||
    row.registry_contract_version !== 1 ||
    row.record_correction_contract_version !== 2
  )
    throw new Error("record correction DB contract가 4/4/1/2와 일치하지 않습니다.");
}

function assertDatasetComplete(dataset: RecordCorrectionSeasonDataset): void {
  if (!dataset.sourcePages.some((page) => page.pageKind === "landing"))
    throw new Error("record correction landing source가 없습니다.");
  if (
    !dataset.sourcePages.some(
      (page) =>
        page.pageKind === "control" && page.requestKey === `control:years:${dataset.season}`,
    ) ||
    !dataset.sourcePages.some(
      (page) =>
        page.pageKind === "control" && page.requestKey === `control:series:${dataset.season}`,
    )
  )
    throw new Error("record correction 시즌/시리즈 control source가 없습니다.");
  const recordPages = dataset.sourcePages.filter((page) => page.pageKind === "records");
  if (recordPages.length === 0) throw new Error("record correction records source가 없습니다.");
  const pageKeys = new Set(dataset.sourcePages.map((page) => page.requestKey));
  if (dataset.notices.some((notice) => !pageKeys.has(notice.sourceRequestKey)))
    throw new Error("record correction notice source 참조가 완전하지 않습니다.");
  for (const seriesId of new Set(recordPages.map((page) => page.seriesId))) {
    if (seriesId === null) throw new Error("record correction records series ID가 없습니다.");
    const pages = recordPages
      .filter((page) => page.seriesId === seriesId)
      .sort((left, right) => (left.pageNumber ?? 0) - (right.pageNumber ?? 0));
    const totalCount = pages[0]?.totalCount;
    if (
      totalCount === null ||
      totalCount === undefined ||
      pages.some(
        (page, index) =>
          page.pageNumber !== index + 1 ||
          page.totalCount !== totalCount ||
          dataset.notices.filter((notice) => notice.sourceRequestKey === page.requestKey).length !==
            page.rowCount,
      ) ||
      pages.reduce((sum, page) => sum + page.rowCount, 0) !== totalCount
    )
      throw new Error(
        `record correction series ${String(seriesId)} pagination이 완전하지 않습니다.`,
      );
  }
}

async function insertNotice(
  client: PoolClient,
  season: number,
  revision: number,
  noticeSequence: number,
  sourcePageSequence: number,
  notice: RecordCorrectionNotice,
): Promise<void> {
  await client.query(
    `INSERT INTO record_correction.notices
       (season,revision,notice_sequence,notice_id,notice_hash,source_page_sequence,
        source_row_index,series_id,series_name,record_number,game_date,weekday_text,
        away_team_name,home_team_name,doubleheader_number,venue_name,inning,half,
        batting_order,decision_before,decision_after,before_record_text,after_record_text,
        content_text,correction_date_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23,$24,$25)`,
    [
      season,
      revision,
      noticeSequence,
      notice.noticeId,
      notice.noticeHash,
      sourcePageSequence,
      notice.sourceRowIndex,
      notice.seriesId,
      notice.seriesName,
      notice.recordNumber,
      notice.gameDate,
      notice.weekdayText,
      notice.awayTeamName,
      notice.homeTeamName,
      notice.doubleheaderNumber,
      notice.venueName,
      notice.inning,
      notice.half,
      notice.battingOrder,
      notice.decisionBefore,
      notice.decisionAfter,
      notice.beforeRecordText,
      notice.afterRecordText,
      notice.contentText,
      notice.correctionDateText,
    ],
  );
  for (const participant of notice.participants)
    await client.query(
      `INSERT INTO record_correction.notice_participants
         (season,revision,notice_sequence,participant_index,raw_team_name,
          raw_player_name,role,parenthesized)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        season,
        revision,
        noticeSequence,
        participant.participantIndex,
        participant.rawTeamName,
        participant.rawPlayerName,
        participant.role,
        participant.parenthesized,
      ],
    );
  for (const stat of notice.statChanges)
    await client.query(
      `INSERT INTO record_correction.notice_stat_changes
         (season,revision,notice_sequence,stat_index,participant_index,raw_stat_name,
          stat_code,scope,before_value,after_value,support_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        season,
        revision,
        noticeSequence,
        stat.statIndex,
        stat.participantIndex,
        stat.rawStatName,
        stat.statCode,
        stat.scope,
        stat.beforeValue,
        stat.afterValue,
        stat.supportKind,
      ],
    );
}

async function initializeAssessments(
  client: PoolClient,
  dataset: RecordCorrectionSeasonDataset,
  revision: number,
): Promise<void> {
  for (const [noticeSequence, notice] of dataset.notices.entries()) {
    const existing = await client.query<{
      readonly source_revision: number;
      readonly case_version: number;
      readonly notice_hash: string;
    }>(
      `SELECT a.source_revision,a.case_version,n.notice_hash
       FROM record_correction.match_assessments a
       JOIN record_correction.notices n
         ON n.season=a.season AND n.revision=a.source_revision
        AND n.notice_sequence=a.notice_sequence
       WHERE a.notice_id=$1`,
      [notice.noticeId],
    );
    const previous = existing.rows[0];
    const changed = previous !== undefined && previous.notice_hash !== notice.noticeHash;
    await client.query(
      `INSERT INTO record_correction.match_assessments
         (notice_id,season,source_revision,notice_sequence,case_version,status,
          reason_code,reason_message,assessed_at)
       VALUES ($1,$2,$3,$4,1,'manual_review','awaiting_assessment',
               '수집된 공지를 아직 평가하지 않았습니다.',$5)
       ON CONFLICT (notice_id) DO UPDATE SET
         season=EXCLUDED.season,source_revision=EXCLUDED.source_revision,
         notice_sequence=EXCLUDED.notice_sequence,
         case_version=CASE WHEN $6 THEN record_correction.match_assessments.case_version+1
                           ELSE record_correction.match_assessments.case_version END,
         status=CASE WHEN $6 THEN 'manual_review' ELSE record_correction.match_assessments.status END,
         reason_code=CASE WHEN $6 THEN 'notice_source_changed'
                          ELSE record_correction.match_assessments.reason_code END,
         reason_message=CASE WHEN $6 THEN 'KBO 공지 내용이 변경되어 재검토가 필요합니다.'
                             ELSE record_correction.match_assessments.reason_message END,
         proposal_hash=CASE WHEN $6 THEN NULL ELSE record_correction.match_assessments.proposal_hash END,
         approved_document_hash=CASE WHEN $6 THEN NULL ELSE record_correction.match_assessments.approved_document_hash END,
         applied_revision=CASE WHEN $6 THEN NULL ELSE record_correction.match_assessments.applied_revision END,
         assessed_at=CASE WHEN $6 THEN EXCLUDED.assessed_at
                          ELSE record_correction.match_assessments.assessed_at END`,
      [notice.noticeId, dataset.season, revision, noticeSequence, dataset.collectedAt, changed],
    );
  }
}

async function loadNotice(
  pool: Pool,
  season: number,
  revision: number,
  noticeSequence: number,
): Promise<RecordCorrectionNotice> {
  const result = await pool.query<{
    readonly notice_id: string;
    readonly notice_hash: string;
    readonly request_key: string;
    readonly source_row_index: number;
    readonly series_id: number;
    readonly series_name: string;
    readonly record_number: number;
    readonly game_date: string;
    readonly weekday_text: string;
    readonly away_team_name: string;
    readonly home_team_name: string;
    readonly doubleheader_number: number | null;
    readonly venue_name: string;
    readonly inning: number;
    readonly half: "top" | "bottom";
    readonly batting_order: number;
    readonly decision_before: RecordCorrectionNotice["decisionBefore"];
    readonly decision_after: RecordCorrectionNotice["decisionAfter"];
    readonly before_record_text: string;
    readonly after_record_text: string;
    readonly content_text: string;
    readonly correction_date_text: string;
  }>(
    `SELECT n.*,n.game_date::text AS game_date,p.request_key FROM record_correction.notices n
     JOIN record_correction.source_pages p
       ON p.season=n.season AND p.revision=n.revision
      AND p.page_sequence=n.source_page_sequence
     WHERE n.season=$1 AND n.revision=$2 AND n.notice_sequence=$3`,
    [season, revision, noticeSequence],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("record correction notice source가 없습니다.");
  const participants = await pool.query<{
    readonly participant_index: number;
    readonly raw_team_name: string | null;
    readonly raw_player_name: string;
    readonly role: RecordCorrectionNotice["participants"][number]["role"];
    readonly parenthesized: boolean;
  }>(
    `SELECT * FROM record_correction.notice_participants
     WHERE season=$1 AND revision=$2 AND notice_sequence=$3 ORDER BY participant_index`,
    [season, revision, noticeSequence],
  );
  const stats = await pool.query<{
    readonly stat_index: number;
    readonly participant_index: number | null;
    readonly raw_stat_name: string;
    readonly stat_code: RecordCorrectionNotice["statChanges"][number]["statCode"];
    readonly scope: RecordCorrectionNotice["statChanges"][number]["scope"];
    readonly before_value: number;
    readonly after_value: number;
    readonly support_kind: RecordCorrectionNotice["statChanges"][number]["supportKind"];
  }>(
    `SELECT * FROM record_correction.notice_stat_changes
     WHERE season=$1 AND revision=$2 AND notice_sequence=$3 ORDER BY stat_index`,
    [season, revision, noticeSequence],
  );
  return {
    noticeId: row.notice_id,
    noticeHash: row.notice_hash,
    sourceRequestKey: row.request_key,
    sourceRowIndex: row.source_row_index,
    seriesId: row.series_id,
    seriesName: row.series_name,
    recordNumber: row.record_number,
    gameDate: row.game_date,
    weekdayText: row.weekday_text,
    awayTeamName: row.away_team_name,
    homeTeamName: row.home_team_name,
    doubleheaderNumber: row.doubleheader_number,
    venueName: row.venue_name,
    inning: row.inning,
    half: row.half,
    battingOrder: row.batting_order,
    decisionBefore: row.decision_before,
    decisionAfter: row.decision_after,
    beforeRecordText: row.before_record_text,
    afterRecordText: row.after_record_text,
    contentText: row.content_text,
    correctionDateText: row.correction_date_text,
    participants: participants.rows.map((participant) => ({
      participantIndex: participant.participant_index,
      rawTeamName: participant.raw_team_name,
      rawPlayerName: participant.raw_player_name,
      role: participant.role,
      parenthesized: participant.parenthesized,
    })),
    statChanges: stats.rows.map((stat) => ({
      statIndex: stat.stat_index,
      participantIndex: stat.participant_index,
      rawStatName: stat.raw_stat_name,
      statCode: stat.stat_code,
      scope: stat.scope,
      beforeValue: stat.before_value,
      afterValue: stat.after_value,
      supportKind:
        stat.support_kind === "unknown" || stat.support_kind === "evidence_only"
          ? stat.support_kind
          : recordCorrectionSupportKind(stat.scope, stat.stat_code),
    })),
  };
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

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}
