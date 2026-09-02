import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  parseRecordCorrectionSeasonDataset,
  parseRegistrySeasonDataset,
  parseStagingGameDocumentV2,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import {
  BlockingImportError,
  GameRevisionStore,
  RecordCorrectionRepository,
  RegistryRepository,
  RevisionConflictError,
  replaySemanticHash,
} from "@kbo/persistence";

import { makeDocument, safe, scored } from "../helpers/game-document.js";

const dsn = process.env.KBO_TEST_POSTGRES_DSN;
const describeIntegration = dsn === undefined ? describe.skip : describe;

describeIntegration("PostgreSQL 16 V3 revision 및 analytics", () => {
  let pool: Pool;
  let store: GameRevisionStore;

  beforeAll(() => {
    pool = new Pool({ connectionString: dsn });
    store = new GameRevisionStore(pool, "0003_record_correction_scope_classification");
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE record_correction.collection_runs,record_correction.season_current_revisions CASCADE",
    );
    await pool.query(
      "TRUNCATE registry.collection_runs,registry.season_current_revisions,workbench.games CASCADE",
    );
    await pool.query(
      "TRUNCATE catalog.seasons,catalog.teams,catalog.players,catalog.venues CASCADE",
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("strict 원장을 revision 1로 원자 적재하고 typed 원장·compiled fact를 재검증한다", async () => {
    const document = await golden();
    const imported = await store.importRevision(document);
    expect(imported).toMatchObject({
      gameId: document.metadata.gameId,
      revision: 1,
      documentHash: stagingDocumentHash(document),
    });
    expect(imported.projectionHash).toMatch(/^[0-9a-f]{64}$/);

    const stored = await store.loadCompiled(document.metadata.gameId);
    expect(replaySemanticHash(stored.replay)).toBe(
      replaySemanticHash(compileStagingGameDocumentV2(document)),
    );
    expect(stored.replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(stored.source.relayEvents).toHaveLength(document.events.length);
    expect(stored.source).not.toHaveProperty("events");
    expect(await store.countStoredGames()).toBe(1);
    expect(await store.catalog()).toEqual([
      expect.objectContaining({
        gameId: document.metadata.gameId,
        authority: "database",
        gameDate: document.metadata.gameDate,
        currentRevision: 1,
        revisionCount: 1,
        teams: {
          away: document.teams.away,
          home: document.teams.home,
        },
      }),
    ]);
    expect((await store.revisions(document.metadata.gameId)).revisions).toEqual([
      expect.objectContaining({ revision: 1, sealed: true, current: true }),
    ]);
  });

  it("기록정정 source revision을 봉인하고 no-change와 append-only 검토 이력을 보장한다", async () => {
    const repository = new RecordCorrectionRepository(
      pool,
      "0003_record_correction_scope_classification",
    );
    const importedGame = await store.importRevision(await golden());
    const dataset = parseRecordCorrectionSeasonDataset({
      season: 2024,
      collectedAt: "2026-08-31T00:00:03.000Z",
      sourcePages: [
        recordCorrectionPage("landing", "landing:2024", "a", null, null, 0),
        recordCorrectionPage("control", "control:years:2024", "b", null, null, 1),
        recordCorrectionPage("control", "control:series:2024", "c", null, null, 1),
        recordCorrectionPage("records", "records:2024:0:1", "d", 0, 1, 1),
      ],
      notices: [recordCorrectionNotice()],
    });
    await repository.createJob(
      "record-run-1",
      "manual",
      "record-idempotency-1",
      [2024],
      dataset.collectedAt,
    );
    const first = await repository.importSeason("record-run-1", dataset, "d".repeat(64));
    expect(first).toMatchObject({ revision: 1, noChange: false, noticeCount: 1 });
    const sealed = await pool.query<{ readonly sealed: boolean }>(
      "SELECT sealed FROM record_correction.season_revisions WHERE season=2024 AND revision=1",
    );
    expect(sealed.rows[0]?.sealed).toBe(true);
    expect((await repository.currentNotice("2024:0:1"))?.gameDate).toBe("2024-09-15");
    expect(await repository.seasonHasPendingAssessments(2024)).toBe(true);
    const assessed = await repository.assess({
      noticeId: "2024:0:1",
      status: "already_applied",
      gameId: importedGame.gameId,
      gameRevision: importedGame.revision,
      documentHash: importedGame.documentHash,
      eventId: null,
      batterPlayerId: null,
      pitcherPlayerId: null,
      reasonCode: "integration_assessed",
      reasonMessage: "비식별 fixture 평가 완료",
      proposalHash: null,
      candidates: [],
      assessedAt: "2026-08-31T00:00:04.000Z",
    });
    expect(await repository.seasonHasPendingAssessments(2024)).toBe(false);
    await expect(
      repository.markResolvedAfterReassessment({
        noticeId: assessed.noticeId,
        caseVersion: assessed.caseVersion,
        gameId: importedGame.gameId,
        revision: importedGame.revision,
        documentHash: "0".repeat(64),
      }),
    ).resolves.toBe(false);
    await expect(
      repository.markResolvedAfterReassessment({
        noticeId: assessed.noticeId,
        caseVersion: assessed.caseVersion,
        gameId: importedGame.gameId,
        revision: importedGame.revision,
        documentHash: importedGame.documentHash,
      }),
    ).resolves.toBe(true);
    await expect(repository.case(assessed.noticeId)).resolves.toMatchObject({
      status: "resolved",
      appliedRevision: importedGame.revision,
      reasonCode: "manual_import_satisfies_kbo_after_state",
    });

    await repository.createJob(
      "record-run-2",
      "manual",
      "record-idempotency-2",
      [2024],
      dataset.collectedAt,
    );
    const second = await repository.importSeason("record-run-2", dataset, "d".repeat(64));
    expect(second).toMatchObject({ revision: 1, noChange: true });
    const revisions = await pool.query<{ readonly count: string }>(
      "SELECT COUNT(*)::text count FROM record_correction.season_revisions WHERE season=2024",
    );
    expect(revisions.rows[0]?.count).toBe("1");

    const item = await repository.case("2024:0:1");
    if (item === null) throw new Error("record correction case fixture가 없습니다.");
    const dismissed = await repository.reviewAction(item.noticeId, {
      caseVersion: item.caseVersion,
      action: "dismiss",
      candidateId: null,
      reason: "비식별 fixture 검토 완료",
    });
    expect(dismissed.status).toBe("dismissed");
    await expect(
      pool.query("UPDATE record_correction.review_actions SET reason='변조' WHERE notice_id=$1", [
        item.noticeId,
      ]),
    ).rejects.toThrow(/append-only/);

    const revisedDataset = parseRecordCorrectionSeasonDataset({
      ...dataset,
      collectedAt: "2026-09-01T00:00:03.000Z",
      sourcePages: dataset.sourcePages.map((page) =>
        page.requestKey === "records:2024:0:1" ? { ...page, contentHash: "e".repeat(64) } : page,
      ),
      notices: dataset.notices.map((notice) => ({
        ...notice,
        noticeHash: "f".repeat(64),
        contentText: `${notice.contentText} 변경`,
      })),
    });
    await repository.createJob(
      "record-run-3",
      "manual",
      "record-idempotency-3",
      [2024],
      revisedDataset.collectedAt,
    );
    await expect(
      repository.importSeason("record-run-3", revisedDataset, "e".repeat(64)),
    ).resolves.toMatchObject({ revision: 2, noChange: false });
    const reopened = await repository.case(item.noticeId);
    expect(reopened).toMatchObject({ status: "manual_review", sourceRevision: 2 });
    const actionCount = await pool.query<{ readonly count: string }>(
      "SELECT COUNT(*)::text count FROM record_correction.review_actions WHERE notice_id=$1",
      [item.noticeId],
    );
    expect(actionCount.rows[0]?.count).toBe("2");
    await expect(
      pool.query(
        "UPDATE record_correction.notices SET content_text='변조' WHERE season=2024 AND revision=2",
      ),
    ).rejects.toThrow(/immutable/);
    await repository.assess({
      noticeId: item.noticeId,
      status: "out_of_scope",
      gameId: null,
      gameRevision: null,
      documentHash: null,
      eventId: null,
      batterPlayerId: null,
      pitcherPlayerId: null,
      reasonCode: "evidence_only_notice",
      reasonMessage: "비식별 지원 범위 밖 fixture",
      proposalHash: null,
      candidates: [],
      assessedAt: "2026-09-01T00:00:04.000Z",
    });
    await expect(repository.summary(null)).resolves.toMatchObject({
      counts: { outOfScope: 1, manualReview: 0 },
      alertCount: 0,
    });

    await repository.createJob(
      "record-run-resume",
      "manual",
      "record-idempotency-resume",
      [2025],
      revisedDataset.collectedAt,
    );
    await repository.setJobRunning("record-run-resume", revisedDataset.collectedAt);
    await repository.markSeasonRunning("record-run-resume", 2025);
    await expect(repository.resumableJobs()).resolves.toContainEqual({
      jobId: "record-run-resume",
      seasons: [2025],
      hasChanges: false,
    });
  });

  it("비식별 warning detail을 DB 왕복한 뒤에도 projection hash와 scalar를 보존한다", async () => {
    const document = warningDetailDocument();
    const replay = compileStagingGameDocumentV2(document);
    expect(replay.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "official_rbi_not_verifiable", severity: "warning" }),
      ]),
    );
    expect(replay.findings.some((finding) => finding.severity === "blocking")).toBe(false);

    const imported = await store.importRevision(document);
    const stored = await store.loadCompiled(document.metadata.gameId);
    expect(stored.projectionHash).toBe(imported.projectionHash);
    expect(stored.replay.findings).toEqual(replay.findings);

    const details = await pool.query<{
      expected_type: string;
      expected_number: number | null;
      expected_text: string | null;
      actual_type: string;
      actual_number: number | null;
      actual_text: string | null;
    }>(
      `SELECT expected_type,expected_text,expected_number,actual_type,actual_text,actual_number
       FROM workbench.validation_issue_details WHERE game_id=$1 ORDER BY issue_index,detail_index`,
      [document.metadata.gameId],
    );
    expect(details.rows).toEqual([
      {
        expected_type: "number",
        expected_text: null,
        expected_number: 1,
        actual_type: "number",
        actual_text: null,
        actual_number: 0,
      },
    ]);
  });

  it("타석 결과 원장 행과 연결 주자 행을 한 play 및 movement fact로 적재한다", async () => {
    const document = await golden();
    await store.importRevision(document);
    const bridge = await pool.query<{ play_sequence: number; event_id: string }>(
      `SELECT play_sequence,event_id FROM baseball.play_events
       WHERE game_id=$1 AND event_id IN ('e10','e11') ORDER BY relay_order`,
      [document.metadata.gameId],
    );
    expect(bridge.rows.map((row) => row.event_id)).toEqual(["e10", "e11"]);
    expect(new Set(bridge.rows.map((row) => row.play_sequence)).size).toBe(1);
    const movement = await pool.query<{ runner_id: string; derived: boolean }>(
      `SELECT runner_id,derived FROM baseball.runner_movement_facts
       WHERE game_id=$1 AND play_sequence=$2 ORDER BY movement_sequence`,
      [document.metadata.gameId, bridge.rows[0]?.play_sequence],
    );
    expect(movement.rows).toEqual([
      { runner_id: "a1", derived: false },
      { runner_id: "a2", derived: true },
    ]);
  });

  it("current view는 완료 PA와 partial PA 분석 대상을 분리한다", async () => {
    const document = await golden();
    await store.importRevision(document);
    const completed = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text count FROM analytics.current_plate_appearances WHERE game_id=$1 AND completed",
      [document.metadata.gameId],
    );
    const partial = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text count FROM analytics.current_plate_appearances WHERE game_id=$1 AND NOT completed",
      [document.metadata.gameId],
    );
    expect(Number(completed.rows[0]?.count)).toBe(4);
    expect(Number(partial.rows[0]?.count)).toBe(0);
  });

  it("차단 finding과 failure injection은 경기·revision·fact 전체를 rollback한다", async () => {
    const document = await golden();
    const blocked = parseStagingGameDocumentV2({
      ...document,
      events: document.events.map((event) =>
        event.identity.eventId === "e7"
          ? { ...event, kind: "unresolved", payload: { sourceType: "unknown" } }
          : event,
      ),
    });
    await expect(store.importRevision(blocked)).rejects.toBeInstanceOf(BlockingImportError);
    expect(await store.countStoredGames()).toBe(0);

    await expect(store.importRevision(document, { failurePoint: "after_facts" })).rejects.toThrow(
      "injected import failure",
    );
    expect(await store.countStoredGames()).toBe(0);
    expect(
      Number(
        (
          await pool.query<{ count: string }>(
            "SELECT COUNT(*)::text count FROM workbench.game_revisions",
          )
        ).rows[0]?.count,
      ),
    ).toBe(0);
  });

  it("revision 1→2 전환, 과거 불변성, stale base 거부와 all/current view를 보장한다", async () => {
    const document = await golden();
    const first = await store.importRevision(document);
    const draft = await store.loadCorrectionDraft(document.metadata.gameId, 1);
    const revised = parseStagingGameDocumentV2({
      ...draft,
      events: draft.events.map((event) =>
        event.identity.eventId === "e20" ? { ...event, relayText: "우천 중단 정정" } : event,
      ),
    });
    const second = await store.importRevision(revised);
    expect(second.revision).toBe(2);
    expect((await store.revisions(document.metadata.gameId)).revisions).toEqual([
      expect.objectContaining({ revision: 1, current: false, sealed: true }),
      expect.objectContaining({ revision: 2, current: true, sealed: true }),
    ]);
    expect((await store.loadCompiled(document.metadata.gameId, 1)).documentHash).toBe(
      first.documentHash,
    );
    expect((await store.loadCompiled(document.metadata.gameId)).documentHash).toBe(
      second.documentHash,
    );
    const current = await pool.query<{ revision: number }>(
      "SELECT DISTINCT revision FROM analytics.current_pitches WHERE game_id=$1",
      [document.metadata.gameId],
    );
    expect(current.rows).toEqual([{ revision: 2 }]);
    const all = await pool.query<{ revision: number }>(
      "SELECT DISTINCT revision FROM analytics.all_revision_pitches WHERE game_id=$1 ORDER BY revision",
      [document.metadata.gameId],
    );
    expect(all.rows).toEqual([{ revision: 1 }, { revision: 2 }]);
    await expect(store.importRevision(revised)).rejects.toBeInstanceOf(RevisionConflictError);
    await expect(
      pool.query(
        "UPDATE workbench.relay_event_facts SET relay_text='변조' WHERE game_id=$1 AND revision=1 AND event_sequence=0",
        [document.metadata.gameId],
      ),
    ).rejects.toThrow(/seal|sealed|immutable/i);
    await expect(
      pool.query(
        "UPDATE workbench.game_revisions SET document_hash=$3 WHERE game_id=$1 AND revision=$2",
        [document.metadata.gameId, 1, "f".repeat(64)],
      ),
    ).rejects.toThrow(/seal|sealed|immutable/i);
  });

  it("wide tracking, zone 및 NULL denominator 분석 view를 제공한다", async () => {
    const fixture = await golden();
    const document = parseStagingGameDocumentV2({
      ...fixture,
      trackingCandidates: fixture.trackingCandidates.map((candidate, index) =>
        index === 0 ? { ...candidate, sourcePitchOrdinal: null } : candidate,
      ),
    });
    await store.importRevision(document);
    const tracking = await pool.query<{
      pitch_id: string;
      tracking_id: string | null;
      source_pitch_ordinal: number | null;
      in_zone: boolean | null;
    }>(
      `SELECT pitch_id,tracking_id,source_pitch_ordinal,in_zone FROM analytics.current_pitches
       WHERE game_id=$1 AND tracking_id IS NOT NULL ORDER BY pitch_sequence`,
      [document.metadata.gameId],
    );
    expect(tracking.rows).toEqual([
      { pitch_id: "e2", tracking_id: "t1", source_pitch_ordinal: null, in_zone: true },
      { pitch_id: "e3", tracking_id: "t2", source_pitch_ordinal: 2, in_zone: false },
    ]);
    const zeroAtBat = await pool.query<{ avg: number | null; avg_denominator: string }>(
      `SELECT avg,avg_denominator::text FROM analytics.current_player_season_batting
       WHERE season=2026 AND at_bats=0 LIMIT 1`,
    );
    expect(zeroAtBat.rows[0]).toEqual({ avg: null, avg_denominator: "0" });
    const trackingStorage = await pool.query<{
      observation_count: string;
      link_count: string;
      duplicate_measurement_columns: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM workbench.tracking_observations WHERE game_id=$1) observation_count,
         (SELECT COUNT(*)::text FROM baseball.pitch_tracking_links WHERE game_id=$1) link_count,
         (SELECT COUNT(*)::text FROM information_schema.columns
           WHERE table_schema='baseball' AND table_name='pitch_tracking_links'
             AND column_name IN ('x0','cross_plate_x','top_sz')) duplicate_measurement_columns`,
      [document.metadata.gameId],
    );
    expect(trackingStorage.rows).toEqual([
      { observation_count: "2", link_count: "2", duplicate_measurement_columns: "0" },
    ]);
  });

  it("registry는 공식 KBO identity, snapshot 공백, 비소속 event와 모호성을 보존한다", async () => {
    const document = await golden();
    await store.importRevision(document);
    const repository = new RegistryRepository(pool, "0003_record_correction_scope_classification");
    expect(await repository.seasonDateRange(2026)).toEqual({
      dateFrom: document.metadata.gameDate,
      dateTo: document.metadata.gameDate,
    });
    const sourcePages = [
      sourcePage("register:2026-06-01:AWAY", "register", 0),
      sourcePage("register:2026-06-03:AWAY", "register", 1),
      sourcePage("trade:2026:06:1", "trade", 2),
    ];
    const players = [
      registryPlayer("a1", "원정1", "내야수"),
      registryPlayer("same-1", "동명이", "투수"),
      registryPlayer("same-2", "동명이", "투수"),
    ];
    const dataset = parseRegistrySeasonDataset({
      season: 2026,
      dateFrom: "2026-06-01",
      dateTo: "2026-06-03",
      sourcePages,
      registrationSnapshots: [
        registrationSnapshot("2026-06-01", players),
        registrationSnapshot(
          "2026-06-03",
          players.map((player) =>
            player.playerId === "a1" ? { ...player, playerName: "원정일" } : player,
          ),
        ),
      ],
      statusEvents: [
        statusEvent(
          0,
          "2026-06-01",
          "소속선수 추가 등록",
          "affiliation_add",
          "start",
          "원정1",
          "내야수",
        ),
        statusEvent(1, "2026-06-02", "개명", "name_change", "none", "원정1", "내야수"),
        statusEvent(2, "2026-06-02", "등번호 변경", "number_change", "none", "원정1", "내야수"),
        statusEvent(
          3,
          "2026-06-03",
          "자유계약선수",
          "free_agent_release",
          "end",
          "원정1",
          "내야수",
        ),
        statusEvent(4, "2026-06-03", "트레이드", "trade", "transfer", "동명이", "투수"),
      ],
    });

    const imported = await repository.importSeason(
      "registry-run-sanitized",
      dataset,
      "b".repeat(64),
    );
    expect(imported).toMatchObject({ season: 2026, revision: 1 });
    const naverIdentity = await pool.query<{ player_id: string; resolution_kind: string }>(
      "SELECT player_id,resolution_kind FROM catalog.player_identities WHERE identity_key='naver:a1'",
    );
    expect(naverIdentity.rows).toEqual([
      { player_id: "kbo:a1", resolution_kind: "exact_external_and_name" },
    ]);
    const observedNames = await pool.query<{ display_name: string; observed_on: string }>(
      `SELECT display_name,observed_on::text FROM catalog.player_name_observations
       WHERE identity_key='kbo:a1' ORDER BY observed_on,display_name`,
    );
    expect(observedNames.rows).toEqual([
      { display_name: "원정1", observed_on: "2026-06-01" },
      { display_name: "원정일", observed_on: "2026-06-03" },
    ]);
    const registrationStints = await pool.query<{
      valid_from: string;
      valid_to: string;
      left_censored: boolean;
      right_censored: boolean;
    }>(
      `SELECT valid_from::text,valid_to::text,left_censored,right_censored
       FROM registry.player_team_stints
       WHERE stint_kind='first_team_registration' AND player_identity_key='kbo:a1'
       ORDER BY valid_from`,
    );
    expect(registrationStints.rows).toEqual([
      {
        valid_from: "2026-06-01",
        valid_to: "2026-06-02",
        left_censored: true,
        right_censored: false,
      },
      {
        valid_from: "2026-06-03",
        valid_to: "2026-06-04",
        left_censored: false,
        right_censored: true,
      },
    ]);
    const affiliation = await pool.query<{
      valid_from: string;
      valid_to: string;
      start_status_event_sequence: number;
      end_status_event_sequence: number;
    }>(
      `SELECT valid_from::text,valid_to::text,start_status_event_sequence,end_status_event_sequence
       FROM registry.player_team_stints
       WHERE stint_kind='organization_affiliation' AND player_identity_key='kbo:a1'`,
    );
    expect(affiliation.rows).toEqual([
      {
        valid_from: "2026-06-01",
        valid_to: "2026-06-03",
        start_status_event_sequence: 0,
        end_status_event_sequence: 3,
      },
    ]);
    const ambiguity = await pool.query<{ code: string; candidate_count: number }>(
      "SELECT code,candidate_count FROM registry.identity_resolution_issues ORDER BY issue_sequence",
    );
    expect(ambiguity.rows).toContainEqual({
      code: "registry.player_ambiguous",
      candidate_count: 2,
    });
  });

  it("구조적으로 완전한 개막 전 빈 등록 snapshot을 season revision으로 seal한다", async () => {
    const repository = new RegistryRepository(pool, "0003_record_correction_scope_classification");
    const dataset = parseRegistrySeasonDataset({
      season: 2024,
      dateFrom: "2024-03-09",
      dateTo: "2024-03-09",
      sourcePages: [sourcePage("register:2024-03-09:AWAY", "register", 0)],
      registrationSnapshots: [registrationSnapshot("2024-03-09", [])],
      statusEvents: [],
    });

    await expect(
      repository.importSeason("registry-run-empty", dataset, "c".repeat(64)),
    ).resolves.toMatchObject({ season: 2024, revision: 1 });
    const snapshot = await pool.query<{ complete: boolean; player_count: string }>(
      `SELECT s.complete,COUNT(p.player_identity_key)::text player_count
       FROM registry.registration_snapshots s
       LEFT JOIN registry.registration_snapshot_players p
         ON p.season=s.season AND p.revision=s.revision
        AND p.snapshot_date=s.snapshot_date AND p.team_identity_key=s.team_identity_key
       WHERE s.season=2024 AND s.revision=1 GROUP BY s.complete`,
    );
    expect(snapshot.rows).toEqual([{ complete: true, player_count: "0" }]);
  });

  it("V3 contract와 read-only analyst 권한을 제공한다", async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='analytics' AND table_name LIKE '%correction%'`,
    );
    expect(tables.rows).toEqual([]);
    const contract = await pool.query(
      "SELECT analytics_contract_version,projection_version,registry_contract_version,record_correction_contract_version FROM workbench.contract_metadata",
    );
    expect(contract.rows).toEqual([
      {
        analytics_contract_version: 3,
        projection_version: 3,
        registry_contract_version: 1,
        record_correction_contract_version: 2,
      },
    ]);
    const forbiddenTypes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text count FROM information_schema.columns
       WHERE table_schema IN ('catalog','registry','record_correction','workbench','baseball')
         AND data_type IN ('json','jsonb','ARRAY')`,
    );
    expect(forbiddenTypes.rows).toEqual([{ count: "0" }]);
    const analyst = await pool.query<{
      setting: string;
      workbench_usage: boolean;
      record_correction_usage: boolean;
      analytics_usage: boolean;
    }>(
      `SELECT COALESCE((SELECT setting FROM pg_db_role_setting s
        JOIN pg_roles r ON r.oid=s.setrole
        CROSS JOIN LATERAL unnest(s.setconfig) setting
        WHERE r.rolname='kbo_analyst_test' AND setting='default_transaction_read_only=on'), '') setting,
        has_schema_privilege('kbo_analyst_test','workbench','USAGE') workbench_usage,
        has_schema_privilege('kbo_analyst_test','record_correction','USAGE') record_correction_usage,
        has_schema_privilege('kbo_analyst_test','analytics','USAGE') analytics_usage`,
    );
    expect(analyst.rows).toEqual([
      {
        setting: "default_transaction_read_only=on",
        workbench_usage: false,
        record_correction_usage: false,
        analytics_usage: true,
      },
    ]);
  });
});

function recordCorrectionPage(
  pageKind: "landing" | "control" | "records",
  requestKey: string,
  hashCharacter: string,
  seriesId: number | null,
  pageNumber: number | null,
  rowCount: number,
) {
  return {
    pageKind,
    requestKey,
    seriesId,
    pageNumber,
    artifactKey: `record-corrections/source/${requestKey}.gz`,
    contentHash: hashCharacter.repeat(64),
    collectedAt: "2026-08-31T00:00:00.000Z",
    rowCount,
    totalCount: rowCount,
  };
}

function recordCorrectionNotice() {
  return {
    noticeId: "2024:0:1",
    noticeHash: "e".repeat(64),
    sourceRequestKey: "records:2024:0:1",
    sourceRowIndex: 0,
    seriesId: 0,
    seriesName: "정규시즌",
    recordNumber: 1,
    gameDate: "2024-09-15",
    weekdayText: "일",
    awayTeamName: "비식별원정",
    homeTeamName: "비식별홈",
    doubleheaderNumber: null,
    venueName: "비식별구장",
    inning: 3,
    half: "top",
    battingOrder: 7,
    decisionBefore: "fielder_choice",
    decisionAfter: "error",
    beforeRecordText: "야수 선택",
    afterRecordText: "실책",
    contentText: "비식별 fixture",
    correctionDateText: "09.16",
    participants: [
      {
        participantIndex: 0,
        rawTeamName: null,
        rawPlayerName: "가상타자",
        role: "batter",
        parenthesized: false,
      },
      {
        participantIndex: 1,
        rawTeamName: null,
        rawPlayerName: "가상투수",
        role: "pitcher",
        parenthesized: true,
      },
    ],
    statChanges: [
      {
        statIndex: 0,
        participantIndex: 0,
        rawStatName: "안타",
        statCode: "hits",
        scope: "batter",
        beforeValue: 1,
        afterValue: 0,
        supportKind: "direct",
      },
    ],
  };
}

async function golden() {
  return parseStagingGameDocumentV2(
    JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
  );
}

function warningDetailDocument() {
  const base = parseStagingGameDocumentV2(
    JSON.parse(
      JSON.stringify(
        makeDocument([
          { kind: "half_inning_start", payload: {} },
          { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
          {
            kind: "plate_result",
            payload: { result: "single", batterId: "a1", pitcherId: "hp1" },
          },
          { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
          {
            kind: "plate_appearance_result",
            payload: {
              result: "single",
              batterId: "a2",
              pitcherId: "hp1",
              movements: [safe("a2", 0, 1, 0), safe("a1", 1, 3, 1)],
            },
          },
          { kind: "batter_start", payload: { batterId: "a3", pitcherId: "hp1" } },
          {
            kind: "plate_appearance_result",
            payload: {
              result: "reached_on_error",
              batterId: "a3",
              pitcherId: "hp1",
              movements: [safe("a3", 0, 1, 0), safe("a2", 1, 2, 1), scored("a1", 3, 2)],
            },
          },
        ]),
      ),
    ) as unknown,
  );
  return parseStagingGameDocumentV2({
    ...base,
    metadata: { ...base.metadata, gameId: "sanitized-warning-game" },
    source: { ...base.source, sourceGameId: "sanitized-warning-source" },
    officialRecords: {
      batters: [
        {
          playerId: "a3",
          side: "away",
          atBats: 1,
          runs: 0,
          hits: 0,
          homeRuns: 0,
          runsBattedIn: 1,
          walks: 0,
          strikeouts: 0,
        },
      ],
      pitchers: [],
    },
  });
}

function sourcePage(requestKey: string, pageKind: "register" | "trade", sequence: number) {
  return {
    pageKind,
    requestKey,
    artifactKey: `registry/source/${String(sequence)}.gz`,
    contentHash: String(sequence + 1)
      .repeat(64)
      .slice(0, 64),
    collectedAt: `2026-06-0${String(Math.min(sequence + 1, 3))}T00:00:00.000Z`,
  };
}

function registryPlayer(playerId: string, playerName: string, positionText: string) {
  return {
    teamCode: "AWAY",
    teamName: "원정",
    playerId,
    playerName,
    rosterCategory: positionText,
    uniformNumber: "1",
    positionText,
    throwsBats: "우투우타",
    birthDate: "2000-01-01",
    heightCm: 180,
    weightKg: 80,
  };
}

function registrationSnapshot(snapshotDate: string, players: ReturnType<typeof registryPlayer>[]) {
  return {
    snapshotDate,
    teamCode: "AWAY",
    teamName: "원정",
    sourceRequestKey: `register:${snapshotDate}:AWAY`,
    complete: true,
    players,
  };
}

function statusEvent(
  sourceRowIndex: number,
  effectiveDate: string,
  rawCategory: string,
  eventKind: string,
  affiliationEffect: string,
  rawPlayerName: string,
  rawPosition: string,
) {
  return {
    effectiveDate,
    rawCategory,
    eventKind,
    affiliationEffect,
    teamName: "원정",
    rawPlayerName,
    rawPosition,
    rawNote: null,
    sourceRequestKey: "trade:2026:06:1",
    sourceRowIndex,
  };
}
