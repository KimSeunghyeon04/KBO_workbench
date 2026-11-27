import {
  advanceMatchupGenerations,
  lockMatchupChanges,
  noticeMatchup,
  type Matchup,
} from "./record-correction-matchups.js";
import {
  parseRecordCorrectionSeasonDataset,
  recordCorrectionSupportKind,
  type RecordCorrectionNotice,
  type RecordCorrectionSeasonDataset,
} from "@kbo/contracts";
import type { Pool, PoolClient } from "pg";
import { assertContract } from "./record-correction-db.js";
import type { RecordCorrectionImportedSeason } from "./record-correction-types.js";
interface NoticeLocation {
  readonly season: number;
  readonly sourceRevision: number;
  readonly noticeSequence: number;
  readonly noticeHash: string;
}
export class RecordCorrectionSources {
  public constructor(
    private readonly pool: Pool,
    private readonly expectedMigrationVersion: string,
  ) {}
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

  public async currentNotice(noticeId: string): Promise<RecordCorrectionNotice | null> {
    const location = await this.noticeLocation(noticeId);
    if (location === null) return null;
    return loadNotice(this.pool, location.season, location.sourceRevision, location.noticeSequence);
  }
  public async noticeLocation(
    noticeId: string,
    reader: Pick<Pool, "query"> = this.pool,
  ): Promise<NoticeLocation | null> {
    const result = await reader.query<{
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
  const seriesControl = dataset.sourcePages.find(
    (page) => page.requestKey === `control:series:${dataset.season}`,
  );
  const recordPages = dataset.sourcePages.filter((page) => page.pageKind === "records");
  const actualSeries = new Set(recordPages.map((page) => page.seriesId));
  if (
    seriesControl?.rowCount !== actualSeries.size ||
    (dataset.expectedSeriesIds !== undefined &&
      (dataset.expectedSeriesIds.length !== actualSeries.size ||
        !dataset.expectedSeriesIds.every((id) => actualSeries.has(id))))
  ) {
    throw new Error("record correction records source가 전체 시리즈를 포함하지 않습니다.");
  }
  if (recordPages.length === 0) throw new Error("record correction records source가 없습니다.");
  const pageSeries = new Map(recordPages.map((page) => [page.requestKey, page.seriesId]));
  if (dataset.notices.some((notice) => pageSeries.get(notice.sourceRequestKey) !== notice.seriesId))
    throw new Error("record correction notice source 참조가 완전하지 않습니다.");
  for (const seriesId of actualSeries) {
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
  const next = new Map(
    dataset.notices.map((notice, index) => [notice.noticeId, { notice, index }]),
  );
  const current = await client.query<{
    notice_id: string;
    notice_hash: string;
    game_date: string;
    away_team_name: string;
    home_team_name: string;
  }>(
    `SELECT a.notice_id,n.notice_hash,to_char(n.game_date,'YYYY-MM-DD') AS game_date,n.away_team_name,n.home_team_name
     FROM record_correction.match_assessments a
     JOIN record_correction.notices n ON (n.season,n.revision,n.notice_sequence)=(a.season,a.source_revision,a.notice_sequence)
     WHERE a.season=$1 AND a.active`,
    [dataset.season],
  );
  const previous = new Map(current.rows.map((row) => [row.notice_id, row]));
  const noticeIds = [...new Set([...next.keys(), ...previous.keys()])].sort();
  const changedMatchups: Matchup[] = [];
  for (const noticeId of noticeIds) {
    const old = previous.get(noticeId);
    const notice = next.get(noticeId)?.notice;
    if (old?.notice_hash === notice?.noticeHash) continue;
    if (old !== undefined)
      changedMatchups.push(
        noticeMatchup({
          gameDate: old.game_date,
          awayTeamName: old.away_team_name,
          homeTeamName: old.home_team_name,
        }),
      );
    if (notice !== undefined) changedMatchups.push(noticeMatchup(notice));
  }
  const changedScopes = await lockMatchupChanges(client, changedMatchups);
  for (const noticeId of noticeIds) {
    const entry = next.get(noticeId);
    if (entry === undefined) {
      await client.query(
        `UPDATE record_correction.match_assessments
         SET active=FALSE,publication=publication+1,case_version=case_version+1,
             decision_sequence=0,checked_decision_sequence=NULL,checked_matchup_generation=NULL
         WHERE notice_id=$1 AND active`,
        [noticeId],
      );
      continue;
    }
    const previous = await client.query<{ active: boolean; notice_hash: string }>(
      `SELECT a.active,n.notice_hash FROM record_correction.match_assessments a
       JOIN record_correction.notices n
         ON (n.season,n.revision,n.notice_sequence)=(a.season,a.source_revision,a.notice_sequence)
       WHERE a.notice_id=$1 FOR UPDATE OF a`,
      [noticeId],
    );
    const row = previous.rows[0];
    const changed =
      row !== undefined && (!row.active || row.notice_hash !== entry.notice.noticeHash);
    await client.query(
      `INSERT INTO record_correction.match_assessments AS a
         (notice_id,season,source_revision,notice_sequence,case_version,status,
          reason_code,reason_message,assessed_at)
       VALUES ($1,$2,$3,$4,1,'manual_review','awaiting_assessment',
               '수집된 공지를 아직 평가하지 않았습니다.',$5)
       ON CONFLICT (notice_id) DO UPDATE SET
         active=TRUE,source_revision=EXCLUDED.source_revision,notice_sequence=EXCLUDED.notice_sequence,
         publication=a.publication+CASE WHEN $6 THEN 1 ELSE 0 END,
         case_version=a.case_version+CASE WHEN $6 THEN 1 ELSE 0 END,
         decision_sequence=CASE WHEN $6 THEN 0 ELSE a.decision_sequence END,
         checked_matchup_generation=CASE WHEN $6 THEN NULL ELSE a.checked_matchup_generation END,
         checked_decision_sequence=CASE WHEN $6 THEN NULL ELSE a.checked_decision_sequence END,
         status=CASE WHEN $6 THEN 'manual_review' ELSE a.status END,
         reason_code=CASE WHEN $6 THEN 'notice_source_changed' ELSE a.reason_code END,
         reason_message=CASE WHEN $6 THEN 'KBO 공지 내용이 변경되어 재검토가 필요합니다.' ELSE a.reason_message END,
         proposal_hash=CASE WHEN $6 THEN NULL ELSE a.proposal_hash END,
         applied_revision=CASE WHEN $6 THEN NULL ELSE a.applied_revision END,
         assessed_at=CASE WHEN $6 THEN EXCLUDED.assessed_at ELSE a.assessed_at END`,
      [noticeId, dataset.season, revision, entry.index, dataset.collectedAt, changed],
    );
  }
  await advanceMatchupGenerations(client, changedScopes);
}
export async function loadNotice(
  pool: Pick<Pool, "query">,
  season: number,
  revision: number,
  noticeSequence: number,
): Promise<RecordCorrectionNotice> {
  const [notice] = await loadNotices(pool, [
    { season, source_revision: revision, notice_sequence: noticeSequence },
  ]);
  if (notice === undefined) throw new Error("record correction notice source가 없습니다.");
  return notice;
}

interface NoticeParticipantRow {
  readonly participant_index: number;
  readonly raw_team_name: string | null;
  readonly raw_player_name: string;
  readonly role: RecordCorrectionNotice["participants"][number]["role"];
  readonly parenthesized: boolean;
}

interface NoticeStatRow {
  readonly stat_index: number;
  readonly participant_index: number | null;
  readonly raw_stat_name: string;
  readonly stat_code: RecordCorrectionNotice["statChanges"][number]["statCode"];
  readonly scope: RecordCorrectionNotice["statChanges"][number]["scope"];
  readonly before_value: number;
  readonly after_value: number;
  readonly support_kind: RecordCorrectionNotice["statChanges"][number]["supportKind"];
}

export async function loadNotices(
  pool: Pick<Pool, "query">,
  locations: readonly { season: number; source_revision: number; notice_sequence: number }[],
): Promise<RecordCorrectionNotice[]> {
  if (locations.length === 0) return [];
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
    readonly participants: readonly NoticeParticipantRow[];
    readonly stats: readonly NoticeStatRow[];
  }>(
    `SELECT n.*,n.game_date::text AS game_date,p.request_key,
       COALESCE(participants.rows,'[]'::json) AS participants,COALESCE(stats.rows,'[]'::json) AS stats
     FROM unnest($1::int[], $2::int[], $3::int[]) WITH ORDINALITY
       AS requested(season,revision,notice_sequence,position)
     JOIN record_correction.notices n USING (season,revision,notice_sequence)
     JOIN record_correction.source_pages p
       ON p.season=n.season AND p.revision=n.revision
      AND p.page_sequence=n.source_page_sequence
     LEFT JOIN LATERAL (
       SELECT json_agg(participant ORDER BY participant_index) AS rows
       FROM record_correction.notice_participants participant
       WHERE (participant.season,participant.revision,participant.notice_sequence)=
         (n.season,n.revision,n.notice_sequence)
     ) participants ON TRUE
     LEFT JOIN LATERAL (
       SELECT json_agg(stat ORDER BY stat_index) AS rows
       FROM record_correction.notice_stat_changes stat
       WHERE (stat.season,stat.revision,stat.notice_sequence)=(n.season,n.revision,n.notice_sequence)
     ) stats ON TRUE
     ORDER BY requested.position`,
    [
      locations.map(({ season }) => season),
      locations.map(({ source_revision }) => source_revision),
      locations.map(({ notice_sequence }) => notice_sequence),
    ],
  );
  if (result.rows.length !== locations.length)
    throw new Error("record correction notice source가 없습니다.");
  return result.rows.map((row) => ({
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
    participants: row.participants.map((participant) => ({
      participantIndex: participant.participant_index,
      rawTeamName: participant.raw_team_name,
      rawPlayerName: participant.raw_player_name,
      role: participant.role,
      parenthesized: participant.parenthesized,
    })),
    statChanges: row.stats.map((stat) => ({
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
  }));
}
