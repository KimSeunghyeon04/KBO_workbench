import {
  PitchQualityRepository,
  AnalysisModelSourceRepository,
  pitchQualitySourceHash,
  trainPitchQualityFromFacts,
} from "@kbo/persistence";
import { parkTrainingHash, ParkEnvironmentRepository } from "@kbo/persistence";
import {
  comparePitcherWorkload,
  trainCountRunExpectancy,
  trainWinProbability,
  trainMatchupModel,
} from "@kbo/game-core";
import { regulationGame } from "../helpers/regulation-game.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdtempDisposable, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import { applyCorrectionCommand } from "@kbo/correction";
import { resolveNaverPitcherHand } from "@kbo/collection";

import {
  RecordCorrectionNoticeSchema,
  parseRecordCorrectionSeasonDataset,
  parseRegistrySeasonDataset,
  parseStagingGameDocumentV2,
  resolveAnalysisScope,
  canonicalStringify,
  type AnalysisPlay,
  type ImportJobRecord,
  type ImportTarget,
  type PitchAnalysisSample,
  type RecordCorrectionCase,
  type RecordCorrectionNotice,
} from "@kbo/contracts";
import {
  compileStagingGameDocumentV2,
  trainRunExpectancy,
  stagingDocumentHash,
  prepareDisciplineSeason,
  analyzeBatterDiscipline,
} from "@kbo/game-core";
import {
  BlockingImportError,
  GameRevisionStore,
  PitchAnalysisRepository,
  AnalysisCoverageRepository,
  GameCompetitionRepository,
  CompetitionScheduleNoMatchesError,
  PlayerStatisticsRepository,
  PlayerDirectoryRepository,
  PitchLocationRepository,
  type PitchOutcomeSnapshot,
  RunValueRepository,
  runTrainingHash,
  MatchupRepository,
  MatchupModelRepository,
  PitchAnglesRepository,
  PitcherWorkloadRepository,
  WorkloadComparisonRepository,
  BaserunningAnalysisRepository,
  PitcherChangesRepository,
  PitchSequenceRepository,
  BatterProfileRepository,
  BatterDisciplineRepository,
  BatterStrikeZoneRepository,
  PlayerHeightRepository,
  PlayerBattingProfileRepository,
  OfficialPitcherHandRepository,
  PlayerHeightSupplementRepository,
  StagingWorkspace,
  RecordCorrectionRepository,
  RecordCorrectionStaleError,
  RegistryRepository,
  RevisionConflictError,
  replaySemanticHash,
  preparePitchAnalysisReference,
  calculatePitchAnalysisSample,
  calculatePitchCalibration,
} from "@kbo/persistence";

import { seedBatterHeights, batterHeightDataset } from "../helpers/registry-height.js";
import { makeDocument, safe, scored } from "../helpers/game-document.js";
import { recordCorrectionVenueFixture } from "../helpers/record-correction-fixture.js";
import { plateTracking, plateZoneCases } from "../helpers/tracking-geometry.js";
import {
  pitchAnalysisFixture,
  releasePitchAnalysisFixture,
} from "../helpers/pitch-analysis-fixture.js";
import { disciplineEligibilityFixture } from "../helpers/discipline-eligibility-fixture.js";
import { competitionFixture } from "../helpers/game-competition.js";
import { analysisSourceHash } from "../../packages/persistence/src/analysis-scope.js";
import { AnalysisPreparationManager } from "../../apps/server/src/jobs/analysis-preparation-manager.js";
import { EXPECTED_MIGRATION_VERSION } from "../../apps/server/src/config.js";
import { BoundedReadCache } from "../../apps/server/src/bounded-read-cache.js";
import { ComputationPool } from "../../apps/server/src/computation-pool.js";
import { CorrectionSessionManager } from "../../apps/server/src/correction-session-manager.js";
import { ImportJobManager } from "../../apps/server/src/jobs/import-job-manager.js";
import { RecordCorrectionService } from "../../apps/server/src/record-correction-service.js";
import { recordCorrectionFixture } from "../helpers/record-correction-fixture.js";
import {
  compileDocument,
  createRevisionProjectionComputation,
} from "../../apps/server/src/computation.js";

const dsn = process.env.KBO_TEST_POSTGRES_DSN;
const describeIntegration = dsn === undefined ? describe.skip : describe;

describeIntegration("PostgreSQL 16 V3 revision 및 analytics", () => {
  it("reads revision history and its current pointer from the same statement snapshot", async () => {
    const first = await store.importRevision(regulationGame(2025));
    const draft = await store.loadCorrectionDraft(first.gameId, 1);
    const next = { ...draft, metadata: { ...draft.metadata, stadium: "snapshot-fixture-park" } };
    const before = await store.revisions(first.gameId);
    let published = false;
    const overlapping = new GameRevisionStore(
      {
        async query(sql: string, params: unknown[]) {
          const result = await pool.query(sql, params);
          if (!published) {
            published = true;
            await store.importRevision(next);
          }
          return result;
        },
      } as unknown as Pool,
      EXPECTED_MIGRATION_VERSION,
    );

    expect(before.currentRevision).toBe(1);
    expect(await overlapping.revisions(first.gameId)).toEqual(before);
    const after = await store.revisions(first.gameId);
    expect(after.currentRevision).toBe(2);
    expect(
      after.revisions.map(({ revision, original, current }) => ({ revision, original, current })),
    ).toEqual([
      { revision: 1, original: true, current: false },
      { revision: 2, original: false, current: true },
    ]);
  });

  it("keeps the SQL calendar date through import, replay, correction and catalog in Asia/Seoul", async () => {
    const timezone = process.env.TZ;
    process.env.TZ = "Asia/Seoul";
    try {
      const date = await pool.query<{ game_date: Date }>("SELECT DATE '2026-08-20' AS game_date");
      expect(date.rows[0]?.game_date.toISOString()).toBe("2026-08-19T15:00:00.000Z");
      const document = parseStagingGameDocumentV2(makeDocument([]));
      expect(document.metadata.gameDate).toBe("2026-08-20");
      const { gameId, documentHash } = await store.importRevision(document);

      expect(documentHash).toBe(stagingDocumentHash(document));
      expect((await store.loadCompiled(gameId, 1)).source.gameDate).toBe("2026-08-20");
      expect((await store.loadCorrectionDraft(gameId, 1)).metadata.gameDate).toBe("2026-08-20");
      expect(await store.catalog([gameId])).toMatchObject([{ gameId, gameDate: "2026-08-20" }]);
      expect((await store.catalogPage({ authority: "database" })).games).toMatchObject([
        { gameId, gameDate: "2026-08-20" },
      ]);
    } finally {
      if (timezone === undefined) delete process.env.TZ;
      else process.env.TZ = timezone;
    }
  });

  it("keeps historical source/cache periods independent of later season imports", async () => {
    const sources = new AnalysisModelSourceRepository(pool);
    const earlier = await sources.read(2022),
      later = await sources.read(2023);
    const game = regulationGame(2024);
    await store.importRevision(game);
    await new GameCompetitionRepository(pool).adopt(
      competitionFixture(2024, [
        {
          sourceGameId: game.source.sourceGameId,
          gameDate: game.metadata.gameDate,
          competition: "regular",
        },
      ]),
    );
    await seedBatterHeights(pool, game, 180);
    expect(await sources.read(2022)).toEqual(earlier);
    const changed = await sources.read(2023);
    expect(changed.re24).not.toBe(later.re24);
    expect(changed.quality).not.toBe(later.quality);
    expect(changed.quality).toBe(
      pitchQualitySourceHash((await new PitchQualityRepository(pool).training(2023)).manifest),
    );
    expect(await sources.read(2022)).toEqual(earlier);
  });
  it("reuses exact model manifests and invalidates height datasets, frozen choices, revisions and classifications", async () => {
    const game = regulationGame(2025);
    await store.importRevision(game);
    const competition = new GameCompetitionRepository(pool);
    const entry = {
      sourceGameId: game.source.sourceGameId,
      gameDate: game.metadata.gameDate,
      competition: "regular" as const,
    };
    await competition.adopt(competitionFixture(2025, [entry]));
    const sources = new AnalysisModelSourceRepository(pool);
    const first = await sources.read(2024);
    const run = runTrainingHash((await new RunValueRepository(pool).training(2024)).manifest);
    const park = parkTrainingHash(
      (await new ParkEnvironmentRepository(pool).training(2024)).manifest,
    );
    const quality = pitchQualitySourceHash(
      (await new PitchQualityRepository(pool).training(2024)).manifest,
    );
    expect(first).toEqual({ re24: run, count: run, win: run, park, quality, matchup: quality });
    expect(await sources.read(2024)).toEqual(first);
    await seedBatterHeights(pool, game, 180);
    const height = await sources.read(2024);
    expect(height.quality).not.toBe(first.quality);
    expect(height.re24).toBe(first.re24);
    expect(await sources.read(2024)).toEqual(height);
    expect(height.quality).toBe(
      pitchQualitySourceHash((await new PitchQualityRepository(pool).training(2024)).manifest),
    );
    await new PlayerHeightSupplementRepository(pool).resolveSeason(2025);
    const choices = await sources.read(2024);
    expect(choices.quality).toBe(
      pitchQualitySourceHash((await new PitchQualityRepository(pool).training(2024)).manifest),
    );
    const draft = await store.loadCorrectionDraft(game.metadata.gameId, 1);
    await store.importRevision({ ...draft, metadata: { ...draft.metadata, stadium: "잠실" } });
    const revised = await sources.read(2024);
    expect(revised.quality).not.toBe(choices.quality);
    await competition.adopt(competitionFixture(2025, [{ ...entry, competition: "preseason" }]));
    const changed = await sources.read(2024);
    expect(changed.quality).not.toBe(revised.quality);
    expect(changed.quality).toBe(
      pitchQualitySourceHash((await new PitchQualityRepository(pool).training(2024)).manifest),
    );
  });

  it("preserves an empty regular model source on the first nonregular adoption", async () => {
    const game = regulationGame(2025);
    await store.importRevision(game);
    const scope = resolveAnalysisScope({ season: 2025, competition: "regular" });
    const sources = new AnalysisModelSourceRepository(pool);
    const before = await sources.read(2024);
    const emptyScopeHash = (dataset: readonly { hash: string }[]) =>
      createHash("sha256")
        .update(canonicalStringify({ version: 1, scope, sources: [], dataset }))
        .digest("hex");
    expect(await analysisSourceHash(pool, scope)).toBe(emptyScopeHash([]));
    const adopted = await new GameCompetitionRepository(pool).adopt(
      competitionFixture(2025, [
        {
          sourceGameId: game.source.sourceGameId,
          gameDate: game.metadata.gameDate,
          competition: "allstar",
        },
      ]),
    );
    expect(await sources.read(2024)).toEqual(before);
    expect(await analysisSourceHash(pool, scope)).toBe(
      emptyScopeHash([{ hash: adopted.datasetHash }]),
    );
    expect((await new RunValueRepository(pool).training(2024)).observations).toEqual([]);
  });
  it("freezes same-season evidence, hashes the supplementation, and never refreshes a chosen height", async () => {
    const source = pitchAnalysisFixture(2024);
    const target = parseStagingGameDocumentV2({
      ...source,
      metadata: { ...source.metadata, gameId: "missing-height" },
    });
    await store.importRevision(source);
    const imported = await store.importRevision(target);
    await seedBatterHeights(pool, source, 185);
    await new PlayerHeightRepository(pool).importDataset({
      ...batterHeightDataset(target),
      observations: [],
    });
    const repo = new BatterDisciplineRepository(pool, {
      getOrCreate: async (_key, calculate) => calculate(),
    });
    const before = await repo.snapshot(2024, undefined, { competition: "unknown" });
    const supplement = new PlayerHeightSupplementRepository(pool);
    expect(await supplement.resolveSeason(2024, true)).toContainEqual({
      sourceKind: "same_season",
      players: 1,
    });
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(target.metadata.gameId, 1)).size,
    ).toBe(0);
    expect(await supplement.resolveSeason(2024)).toContainEqual({
      sourceKind: "same_season",
      players: 1,
    });
    const after = await repo.snapshot(2024, before.sourceHash, { competition: "unknown" });
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(target.metadata.gameId, 1)).get("e2")
        ?.batterHeightCm,
    ).toBe(185);
    const later = parseStagingGameDocumentV2({
      ...source,
      metadata: { ...source.metadata, gameId: "later-different-height" },
    });
    await store.importRevision(later);
    await seedBatterHeights(pool, later, 190);
    await supplement.resolveSeason(2024);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(target.metadata.gameId, 1)).get("e2")
        ?.batterHeightCm,
    ).toBe(185);
    expect((await store.loadCompiled(target.metadata.gameId, 1)).projectionHash).toBe(
      imported.projectionHash,
    );
    await expect(
      pool.query("UPDATE registry.game_player_height_choices SET height_cm=190"),
    ).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM registry.game_player_height_choices")).rejects.toThrow(
      /immutable/,
    );
    expect(await supplement.resolveSeason(2024)).toEqual([]);
  });

  it("requires same-season player IDs and rejects local conflicts before consulting official profiles", async () => {
    const supplement = new PlayerHeightSupplementRepository(pool);
    const source = pitchAnalysisFixture(2023);
    await store.importRevision(source);
    await seedBatterHeights(pool, source, 185);
    const target = pitchAnalysisFixture(2024);
    await store.importRevision(target);
    await new PlayerHeightRepository(pool).importDataset({
      ...batterHeightDataset(target),
      observations: [],
    });
    expect(await supplement.resolveSeason(2024)).toEqual([]);
    const outcomes = new PitchLocationRepository(
      pool,
      new BoundedReadCache<PitchOutcomeSnapshot>(1024 * 1024, 8, 60_000),
    );
    const query = { season: 2024, competition: "unknown" as const };
    const withoutChoice = await outcomes.analyze(query, "hp1");
    const official = {
      season: 2024,
      playerId: "a1",
      playerName: "a1",
      birthDate: "1991-03-26",
      heightCm: 183,
      reportedValue: 72,
      reportedUnit: "inch",
      sourceUrl: "https://example.test/player/1",
      sourcePlayerId: "official-1",
      checkedOn: "2026-09-16",
    };
    expect(await supplement.importOfficialProfiles([official])).toBe(1);
    expect(await supplement.importOfficialProfiles([official])).toBe(0);
    await expect(
      supplement.importOfficialProfiles([{ ...official, heightCm: 180, reportedValue: 71 }]),
    ).rejects.toThrow(/근거/);
    await expect(
      pool.query("UPDATE registry.official_player_heights SET source_url='https://changed.test'"),
    ).rejects.toThrow(/immutable/);
    expect(await supplement.resolveSeason(2024)).toEqual([
      { sourceKind: "official_profile", players: 1 },
    ]);
    const withChoice = await outcomes.analyze(query, "hp1");
    expect(withChoice.sourceHash).not.toBe(withoutChoice.sourceHash);
    expect(withChoice).toEqual(await new PitchLocationRepository(pool).analyze(query, "hp1"));
    const conflict = parseStagingGameDocumentV2({
      ...target,
      metadata: { ...target.metadata, gameId: "conflicting-height" },
    });
    await store.importRevision(conflict);
    const dataset = batterHeightDataset(conflict, 180);
    const sample = dataset.observations[0];
    if (sample === undefined) throw new Error("fixture");
    await new PlayerHeightRepository(pool).importDataset({
      ...dataset,
      observations: [...dataset.observations, { ...sample, heightCm: 190, rawHeight: "190.0" }],
    });
    expect(await supplement.resolveSeason(2024)).toEqual([]);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(conflict.metadata.gameId, 1)).size,
    ).toBe(0);
    const another = parseStagingGameDocumentV2({
      ...target,
      metadata: { ...target.metadata, gameId: "season-conflict" },
    });
    await store.importRevision(another);
    await new PlayerHeightRepository(pool).importDataset({
      ...batterHeightDataset(another),
      observations: [],
    });
    expect(await supplement.resolveSeason(2024)).toEqual([]);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(another.metadata.gameId, 1)).size,
    ).toBe(0);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(target.metadata.gameId, 1)).get("e2")
        ?.batterHeightCm,
    ).toBe(183);
  });

  it("new imports freeze known same-season heights in the game transaction", async () => {
    const source = pitchAnalysisFixture(2024);
    await store.importRevision(source);
    await seedBatterHeights(pool, source, 180);
    const target = parseStagingGameDocumentV2({
      ...source,
      metadata: { ...source.metadata, gameId: "new-missing" },
    });
    const importer = new GameRevisionStore(
      pool,
      EXPECTED_MIGRATION_VERSION,
      undefined,
      undefined,
      async () => ({ ...batterHeightDataset(target), observations: [] }),
    );
    await expect(importer.importRevision(target, { failurePoint: "before_seal" })).rejects.toThrow(
      /injected/,
    );
    expect(
      (await pool.query("SELECT * FROM registry.game_height_bundles WHERE game_id='new-missing'"))
        .rows,
    ).toEqual([]);
    await importer.importRevision(target);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(target.metadata.gameId, 1)).get("e2")
        ?.batterHeightCm,
    ).toBe(180);
    expect(
      (
        await pool.query(
          "SELECT source_kind FROM registry.game_player_height_choices WHERE game_id='new-missing'",
        )
      ).rows,
    ).toEqual([{ source_kind: "same_season" }]);
  });
  it("height evidence imports atomically with the game, is immutable, and stays bound to its source", async () => {
    const document = pitchAnalysisFixture(2024);
    const dataset = batterHeightDataset(document, 180);
    const importer = new GameRevisionStore(
      pool,
      EXPECTED_MIGRATION_VERSION,
      undefined,
      undefined,
      async () => dataset,
    );
    await expect(
      importer.importRevision(document, { failurePoint: "after_facts" }),
    ).rejects.toThrow(/injected/);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM registry.game_height_bundles")).rows,
    ).toEqual([{ n: 0 }]);
    const imported = await importer.importRevision(document);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(document.metadata.gameId, 1)).get("e2")
        ?.batterHeightCm,
    ).toBe(180);
    const repository = new PlayerHeightRepository(pool);
    expect(await repository.importDataset(dataset)).toBe(false);
    expect(await repository.pendingSources()).toEqual([]);
    await expect(repository.importDataset(batterHeightDataset(document, 190))).rejects.toThrow(
      /다릅니다/,
    );
    await expect(
      pool.query("UPDATE registry.game_player_height_observations SET height_cm=190"),
    ).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM registry.game_height_bundles")).rejects.toThrow(
      /immutable/,
    );
    await expect(
      pool.query(
        `INSERT INTO registry.game_player_height_observations
      (game_id,source_bundle_hash,observation_sequence,player_id,height_cm,endpoint,source_path)
      VALUES ($1,$2,999,'a1',190,'lineup','height')`,
        [dataset.gameId, dataset.sourceBundleHash],
      ),
    ).rejects.toThrow(/immutable/);
    expect((await store.loadCompiled(document.metadata.gameId, 1)).projectionHash).toBe(
      imported.projectionHash,
    );
    const other = parseStagingGameDocumentV2({
      ...document,
      metadata: { ...document.metadata, gameId: "different-game" },
    });
    await store.importRevision(other);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(other.metadata.gameId, 1)).size,
    ).toBe(0);
    await seedBatterHeights(pool, other, 190);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(other.metadata.gameId, 1)).get("e2")
        ?.batterHeightCm,
    ).toBe(190);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(document.metadata.gameId, 1)).get("e2")
        ?.batterHeightCm,
    ).toBe(180);
  });

  it("conflicting source heights produce no zone and wrong-source input cannot import", async () => {
    const document = pitchAnalysisFixture(2024);
    const dataset = batterHeightDataset(document, 180);
    const sample = dataset.observations[0];
    if (sample === undefined) throw new Error("fixture");
    const wrong = new GameRevisionStore(
      pool,
      EXPECTED_MIGRATION_VERSION,
      undefined,
      undefined,
      async () => ({ ...dataset, gameId: "wrong" }),
    );
    await expect(wrong.importRevision(document)).rejects.toThrow(/출처/);
    await store.importRevision(document);
    await new PlayerHeightRepository(pool).importDataset({
      ...dataset,
      observations: [
        ...dataset.observations,
        { ...sample, heightCm: 190, rawHeight: "190.0", endpoint: "relay_summary" },
      ],
    });
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(document.metadata.gameId, 1)).size,
    ).toBe(0);
    expect(
      (await pool.query("SELECT DISTINCT in_zone,batter_height_cm FROM analytics.current_pitches"))
        .rows,
    ).toEqual([{ in_zone: null, batter_height_cm: null }]);
  });

  it("provider zones cannot affect import, height-based analytics, replay, or missing-height fallback", async () => {
    const base = pitchAnalysisFixture(2024);
    const document = parseStagingGameDocumentV2({
      ...base,
      trackingCandidates: base.trackingCandidates.map((t) => ({
        ...t,
        topSz: 0.375,
        bottomSz: 1.5,
      })),
    });
    const imported = await store.importRevision(document);
    const repo = new BatterDisciplineRepository(pool, {
      getOrCreate: async (_key, calculate) => calculate(),
    });
    const missing = await repo.snapshot(2024, undefined, { competition: "unknown" });
    expect(missing.rows?.every((r) => r.inZone === null && r.batterHeightCm === null)).toBe(true);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(document.metadata.gameId, 1)).size,
    ).toBe(0);
    await seedBatterHeights(pool, document, 180);
    const snapshot = await repo.snapshot(2024, missing.sourceHash, { competition: "unknown" });
    expect(snapshot.rows?.every((r) => r.batterHeightCm === 180)).toBe(true);
    expect(snapshot.sourceHash).not.toBe(missing.sourceHash);
    const zones = await new BatterStrikeZoneRepository(pool).forGame(document.metadata.gameId, 1);
    expect(zones.get("e2")).toMatchObject({ ruleYear: 2024, batterHeightCm: 180 });
    const before = (
      await pool.query(
        "SELECT pitch_id,in_zone,chase,top_sz,bottom_sz FROM analytics.current_pitches ORDER BY pitch_sequence",
      )
    ).rows;
    expect(before.every((r) => r.top_sz === null && r.bottom_sz === null)).toBe(true);
    const draft = await store.loadCorrectionDraft(document.metadata.gameId, 1);
    await store.importRevision({
      ...draft,
      trackingCandidates: draft.trackingCandidates.map((t) => ({
        ...t,
        topSz: -100,
        bottomSz: 100,
      })),
    });
    expect(
      (
        await pool.query(
          "SELECT pitch_id,in_zone,chase,top_sz,bottom_sz FROM analytics.current_pitches ORDER BY pitch_sequence",
        )
      ).rows,
    ).toEqual(before);
    expect((await store.loadCompiled(document.metadata.gameId, 1)).projectionHash).toBe(
      imported.projectionHash,
    );
    expect(await new BatterStrikeZoneRepository(pool).forGame(document.metadata.gameId, 2)).toEqual(
      zones,
    );
    const nextDraft = await store.loadCorrectionDraft(document.metadata.gameId, 2);
    const nextDocument = parseStagingGameDocumentV2({
      ...nextDraft,
      source: { ...nextDraft.source, sourceBundleHash: "e".repeat(64) },
    });
    await store.importRevision(nextDocument);
    await seedBatterHeights(pool, nextDocument, 190);
    const taller = await repo.snapshot(2024, snapshot.sourceHash, { competition: "unknown" });
    expect(taller.sourceHash).not.toBe(snapshot.sourceHash);
    expect(taller.rows?.every((r) => r.batterHeightCm === 190)).toBe(true);
  });

  it.each([1981, 1982, 2020, 2023, 2024, 2025, 2026, 2027, 2200, 9999, 10000])(
    "SQL and game-core use identical height rules for %i",
    async (season) => {
      const { resolveBatterStrikeZone } = await import("@kbo/game-core");
      for (const height of [null, 99, 100, 168, 180, 200, 250, 251]) {
        const zone = resolveBatterStrikeZone(season, height);
        const result = await pool.query(
          "SELECT analytics.batter_zone_top($1,$2) AS top, analytics.batter_zone_bottom($1,$2) AS bottom",
          [season, height],
        );
        expect(result.rows).toEqual([
          { top: zone?.topFeet ?? null, bottom: zone?.bottomFeet ?? null },
        ]);
      }
    },
  );

  it("uses the latest defined zone for a 2027 game in SQL, discipline and replay inputs", async () => {
    const base = pitchAnalysisFixture(2027);
    const document = parseStagingGameDocumentV2({
      ...base,
      trackingCandidates: base.trackingCandidates.map((row, index) =>
        index === 0 ? { ...row, z0: 5 } : row,
      ),
    });
    const { gameId } = await store.importRevision(document);
    const outcomeCache = new BoundedReadCache<PitchOutcomeSnapshot>(1024 * 1024, 8, 60_000);
    const location = new PitchLocationRepository(pool, outcomeCache);
    const query = { season: 2027, competition: "unknown" as const };
    const beforeHeight = await location.analyze(query, "hp1");
    await seedBatterHeights(pool, document, 180);
    const afterHeight = await location.analyze(query, "hp1");
    expect(afterHeight.sourceHash).not.toBe(beforeHeight.sourceHash);
    expect(afterHeight).toEqual(await new PitchLocationRepository(pool).analyze(query, "hp1"));
    const result = await pool.query(
      "SELECT in_zone FROM analytics.current_pitches WHERE game_id=$1 AND pitch_id='e2'",
      [gameId],
    );
    expect(result.rows).toEqual([{ in_zone: true }]);
    const zones = await new BatterStrikeZoneRepository(pool).forGame(gameId, 1);
    expect(zones.get("e2")).toMatchObject({
      ruleYear: 2025,
      batterHeightCm: 180,
      topFeet: (180 * 0.5575) / 30.48,
      bottomFeet: (180 * 0.2704) / 30.48,
    });

    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-zone-fallback-"));
    const workspace = await StagingWorkspace.open(directory.path);
    try {
      const snapshot = await new BatterDisciplineRepository(
        pool,
        workspace.pitchReferences,
      ).snapshot(2027, undefined, { competition: "unknown" });
      expect(snapshot.rows?.find((row) => row.pitchId === "e2")).toMatchObject({
        season: 2027,
        batterHeightCm: 180,
        inZone: true,
      });
    } finally {
      await workspace.close();
    }
  });

  it.each(["project", "hash", "reproject"])(
    "projection worker failure at %s rolls back every fact",
    async (failure) => {
      const workers = new ComputationPool(1);
      const computation = createRevisionProjectionComputation(workers);
      const document = pitchAnalysisFixture(2024);
      let projects = 0;
      try {
        const failing = new GameRevisionStore(pool, EXPECTED_MIGRATION_VERSION, undefined, {
          async project(...args) {
            projects += 1;
            if (
              (failure === "project" && projects === 1) ||
              (failure === "reproject" && projects === 2)
            )
              throw new Error("projection worker failed");
            return computation.project(...args);
          },
          async hash(...args) {
            if (failure === "hash") throw new Error("projection worker failed");
            return computation.hash(...args);
          },
        });
        await expect(failing.importRevision(document)).rejects.toThrow("projection worker failed");
        expect(
          (
            await pool.query("SELECT game_id FROM workbench.games WHERE game_id=$1", [
              document.metadata.gameId,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await pool.query("SELECT game_id FROM workbench.game_revisions WHERE game_id=$1", [
              document.metadata.gameId,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await pool.query("SELECT game_id FROM baseball.pitch_facts WHERE game_id=$1", [
              document.metadata.gameId,
            ])
          ).rowCount,
        ).toBe(0);
      } finally {
        await workers.close();
      }
    },
  );
  let pool: Pool;
  let store: GameRevisionStore;

  beforeAll(() => {
    pool = new Pool({ connectionString: dsn });
    store = new GameRevisionStore(pool, EXPECTED_MIGRATION_VERSION);
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE reference.competition_datasets,record_correction.matchup_generations CASCADE",
    );
    await pool.query(
      "TRUNCATE record_correction.collection_runs,record_correction.season_current_revisions CASCADE",
    );
    await pool.query(
      "TRUNCATE registry.game_batting_profile_bundles,registry.game_height_bundles,registry.official_player_heights,registry.collection_runs,registry.season_current_revisions,workbench.games CASCADE",
    );
    await pool.query(
      "TRUNCATE catalog.seasons,catalog.teams,catalog.players,catalog.venues CASCADE",
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("aggregates statistics at player-game grain with distinct PA/BF, team totals and missing ER", async () => {
    const source = pitchAnalysisFixture(2024);
    await store.importRevision(source);
    const repository = new PlayerStatisticsRepository(pool);
    expect((await repository.batting({ season: 2024 })).total).toBe(0);
    const bat = await repository.batting({ season: 2024, competition: "unknown" });
    expect(bat.rows.find((r) => r.playerId === "a1")).toMatchObject({
      plateAppearances: 1,
      atBats: 1,
      strikeouts: 1,
      kRate: 1,
      avg: 0,
    });
    const pitcher = await repository.pitching({ season: 2024, competition: "unknown" });
    expect(pitcher.rows.find((r) => r.playerId === "hp1")).toMatchObject({
      battersFaced: 1,
      pitches: 4,
      outsRecorded: 1,
      knownErGames: 0,
      era: null,
      knownGamesEra: null,
    });
    const selectedBat = await repository.batting({
      season: 2024,
      competition: "unknown",
      playerId: "a1",
    });
    expect(selectedBat.rows).toEqual(bat.rows.filter((r) => r.playerId === "a1"));
    expect(selectedBat.query.playerId).toBe("a1");
    const selectedPitcher = await repository.pitching({
      season: 2024,
      competition: "unknown",
      playerId: "hp1",
    });
    expect(selectedPitcher.rows).toEqual(pitcher.rows.filter((r) => r.playerId === "hp1"));
    expect(selectedPitcher.query.playerId).toBe("hp1");
    for (const kind of ["batting", "pitching"] as const) {
      expect(
        await repository[kind]({
          season: 2024,
          competition: "unknown",
          playerId: "missing-player",
        }),
      ).toMatchObject({ rows: [], total: 0 });
      await expect(
        repository[kind]({
          season: 2024,
          competition: "unknown",
          group: "team",
          playerId: "a1",
        }),
      ).rejects.toThrow("팀 합계 조회");
    }
    const teams = await repository.batting({ season: 2024, competition: "unknown", group: "team" });
    expect(teams.rows.reduce((n, r) => n + r.plateAppearances, 0)).toBe(
      bat.rows.reduce((n, r) => n + r.plateAppearances, 0),
    );
    expect(teams.rows.every((r) => r.playerId === null)).toBe(true);
    const draft = await store.loadCorrectionDraft(source.metadata.gameId, 1);
    await store.importRevision(draft);
    const next = await repository.pitching({ season: 2024, competition: "unknown" });
    expect(next.sourceHash).not.toBe(pitcher.sourceHash);
    expect(next.rows).toEqual(pitcher.rows);
    expect(
      (await repository.batting({ season: 2024, competition: "unknown", minPA: 2 })).rows,
    ).toEqual([]);
  });

  it("combines traded players' game facts into one row per season with the original denominators", async () => {
    const original = pitchAnalysisFixture(2025);
    await store.importRevision(pitchAnalysisFixture(2024));
    await store.importRevision({
      ...original,
      officialRecords: {
        batters: [],
        pitchers: [
          {
            playerId: "hp1",
            side: "home",
            battersFaced: 1,
            outsRecorded: 1,
            hits: 0,
            runs: 0,
            earnedRuns: 0,
            walks: 0,
            hitByPitch: 0,
            strikeouts: 1,
          },
        ],
      },
    });
    const homeRun = parseStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "in_play" } },
        {
          kind: "plate_result",
          payload: { result: "home_run", batterId: "a1", pitcherId: "hp1", creditedRbi: 1 },
        },
      ]),
    );
    for (const { game, day } of [
      { game: homeRun, day: "01" },
      { game: original, day: "02" },
    ]) {
      const gameId = `annual-statistics-2025-${day}`;
      await store.importRevision({
        ...game,
        source: { ...game.source, sourceGameId: gameId },
        metadata: { ...game.metadata, gameId, season: 2025, gameDate: "2025-07-01" },
        teams: {
          away: { teamId: "NEW_AWAY", name: "새 원정" },
          home: { teamId: "NEW_HOME", name: "새 홈" },
        },
        rosters: {
          away: { ...game.rosters.away, teamId: "NEW_AWAY" },
          home: { ...game.rosters.home, teamId: "NEW_HOME" },
        },
      });
    }

    const repository = new PlayerStatisticsRepository(pool);
    const competition = "unknown" as const;
    const batting = await repository.playerSeasons({ player: "naver:a1", competition });
    expect(batting.pitching).toEqual([]);
    expect(batting.batting.map(({ season }) => season)).toEqual([2025, 2024]);
    expect(batting.batting[0]).toMatchObject({
      teams: ["원정", "새 원정"],
      games: 3,
      plateAppearances: 3,
      atBats: 3,
      hits: 1,
      homeRuns: 1,
      avg: 1 / 3,
      obp: 1 / 3,
      slg: 4 / 3,
    });
    expect(batting.batting[0]?.ops).toBeCloseTo(5 / 3);
    expect(batting.batting[1]).toMatchObject({ teams: ["원정"], games: 1, hits: 0 });

    const pitching = await repository.playerSeasons({ player: "naver:hp1", competition });
    expect(pitching.pitching.map(({ season }) => season)).toEqual([2025, 2024]);
    expect(pitching.pitching[0]).toMatchObject({
      teams: ["홈", "새 홈"],
      games: 3,
      battersFaced: 3,
      outsRecorded: 2,
      runs: 1,
      knownErGames: 1,
      knownErOuts: 1,
      era: null,
      knownGamesEra: 0,
    });
    expect(await repository.playerSeasons({ player: "naver:a1" })).toMatchObject({
      batting: [],
      pitching: [],
    });
    const july = await repository.playerSeasons({
      player: "a1",
      sourceRole: "batter",
      competition,
      season: 2025,
      dateFrom: "2025-07-01",
    });
    expect(july.pitching).toEqual([]);
    expect(july.batting).toHaveLength(1);
    expect(july.batting[0]).toMatchObject({
      season: 2025,
      teams: ["새 원정"],
      games: 2,
      atBats: 2,
      hits: 1,
      avg: 0.5,
    });
    const gameScope = { season: 2025, competition, dateFrom: "2025-07-01" };
    const battingLog = await repository.playerGames({
      ...gameScope,
      player: "naver:a1",
      role: "batter",
    });
    expect(battingLog.role).toBe("batter");
    expect(battingLog.rows).toMatchObject([
      {
        gameId: "annual-statistics-2025-02",
        revision: 1,
        gameDate: "2025-07-01",
        teams: ["새 원정"],
        opponents: ["새 홈"],
        side: "away",
        plateAppearances: 1,
        atBats: 1,
        hits: 0,
        homeRuns: 0,
      },
      {
        gameId: "annual-statistics-2025-01",
        revision: 1,
        gameDate: "2025-07-01",
        plateAppearances: 1,
        atBats: 1,
        hits: 1,
        homeRuns: 1,
      },
    ]);
    const pitchingLog = await repository.playerGames({
      season: 2025,
      competition,
      player: "hp1",
      role: "pitcher",
      source: "naver",
    });
    expect(pitchingLog.role).toBe("pitcher");
    expect(pitchingLog.rows).toMatchObject([
      { gameId: "annual-statistics-2025-02", side: "home", outsRecorded: 1, earnedRuns: null },
      { gameId: "annual-statistics-2025-01", side: "home", outsRecorded: 0, earnedRuns: null },
      { gameId: original.metadata.gameId, side: "home", outsRecorded: 1, earnedRuns: 0 },
    ]);
    const venue = await repository.playerSplits(
      {
        season: 2025,
        competition,
        player: "naver:hp1",
        role: "pitcher",
        split: "venue",
        countFor: "home",
      },
      resolveNaverPitcherHand,
    );
    expect(venue.rows).toMatchObject([
      { bucket: "home", plateAppearances: 3, hits: 1, homeRuns: 1, strikeouts: 2, avg: 1 / 3 },
      { bucket: "away", plateAppearances: 0, avg: null },
    ]);
    expect(venue.byCount).toMatchObject([
      { count: { balls: 0, strikes: 0 }, plateAppearances: 1, hits: 1 },
      { count: { balls: 1, strikes: 2 }, plateAppearances: 2, strikeouts: 2 },
    ]);
    const league = await repository.playerLeague({
      season: 2025,
      competition,
      player: "naver:hp1",
      role: "pitcher",
    });
    expect(league).toMatchObject({
      player: { battersFaced: 3, outsRecorded: 2, knownErOuts: 1, era: null, knownGamesEra: 0 },
      league: { battersFaced: 3, outsRecorded: 2, knownErOuts: 1, era: null, knownGamesEra: 0 },
    });
    const hands = await repository.playerSplits(
      {
        season: 2025,
        competition,
        player: "naver:a1",
        role: "batter",
        split: "hand",
      },
      resolveNaverPitcherHand,
    );
    expect(hands.rows).toMatchObject([
      { bucket: "L", plateAppearances: 0 },
      { bucket: "R", plateAppearances: 0 },
      { bucket: "unknown", plateAppearances: 3, atBats: 3, hits: 1 },
    ]);
  });

  it("uses the bases before the result and weights the league line by recorded opportunities", async () => {
    const start = (batterId: string) => ({
      kind: "batter_start",
      payload: { batterId, pitcherId: "hp1" },
    });
    const document = parseStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        start("a1"),
        { kind: "plate_result", payload: { result: "single", batterId: "a1", pitcherId: "hp1" } },
        start("a2"),
        { kind: "pitch", payload: { call: "ball" } },
        {
          kind: "runner_play",
          payload: { reason: "stolen_base", movements: [safe("a1", 1, 2, 0)] },
        },
        { kind: "pitch", payload: { call: "in_play" } },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "single",
            batterId: "a2",
            pitcherId: "hp1",
            movements: [scored("a1", 2, 0)],
          },
        },
        start("a3"),
        {
          kind: "plate_appearance_result",
          payload: {
            result: "intentional_walk",
            batterId: "a3",
            pitcherId: "hp1",
            movements: [safe("a2", 1, 2, 0)],
          },
        },
        start("a4"),
        {
          kind: "plate_result",
          payload: { result: "field_out", batterId: "a4", pitcherId: "hp1" },
        },
        start("a5"),
        { kind: "pitch", payload: { call: "ball" } },
      ]),
    );
    const other = parseStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        start("a1"),
        {
          kind: "plate_result",
          payload: { result: "field_out", batterId: "a1", pitcherId: "hp1" },
        },
      ]),
    );
    await store.importRevision(document);
    await store.importRevision({
      ...other,
      metadata: { ...other.metadata, gameId: "another-game" },
    });
    const repository = new PlayerStatisticsRepository(pool);
    const scope = { season: 2026, competition: "unknown" } as const;
    const splits = await repository.playerSplits(
      { ...scope, player: "naver:hp1", role: "pitcher", split: "risp", countFor: "risp" },
      resolveNaverPitcherHand,
    );
    expect(splits.rows).toMatchObject([
      { bucket: "risp", plateAppearances: 2, atBats: 2, hits: 1, avg: 0.5 },
      { bucket: "no-risp", plateAppearances: 3, atBats: 2, hits: 1, intentionalWalks: 1 },
      { bucket: "unknown", plateAppearances: 0 },
    ]);
    expect(splits.byCount).toMatchObject([
      { count: { balls: 1, strikes: 0 }, plateAppearances: 1, atBats: 1, hits: 1 },
      { count: null, plateAppearances: 1, atBats: 1, hits: 0 },
    ]);
    const a3 = await repository.playerLeague({ ...scope, player: "naver:a3", role: "batter" });
    expect(a3).toMatchObject({
      player: { plateAppearances: 1, atBats: 0, avg: null, obp: 1 },
      league: { plateAppearances: 5, atBats: 4, hits: 2, walks: 1, avg: 0.5, obp: 0.6, ops: 1.1 },
    });
    const a2 = await repository.playerSplits(
      { ...scope, player: "naver:a2", role: "batter", split: "risp" },
      resolveNaverPitcherHand,
    );
    expect(a2.rows).toMatchObject([
      { bucket: "risp", plateAppearances: 1, hits: 1 },
      { bucket: "no-risp", plateAppearances: 0 },
      { bucket: "unknown", plateAppearances: 0 },
    ]);
  });

  it("builds one career per player, keeps return stints, and counts only official PA and actual pitches", async () => {
    for (const season of [2024, 2025]) {
      const game = pitchAnalysisFixture(season);
      await store.importRevision({
        ...game,
        rosters: {
          away: {
            ...game.rosters.away,
            players: game.rosters.away.players.map((player) =>
              player.playerId === "a1"
                ? { ...player, name: "동명 선수", positions: ["유격수"] }
                : player,
            ),
          },
          home: {
            ...game.rosters.home,
            players: game.rosters.home.players.map((player) =>
              player.playerId === "hp1" ? { ...player, name: "동명 선수" } : player,
            ),
          },
        },
      });
    }
    const partial = parseStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "a1" } },
        { kind: "pitch", payload: { call: "called_strike" } },
      ]),
    );
    await store.importRevision({
      ...partial,
      metadata: { ...partial.metadata, season: 2024, gameDate: "2024-08-01" },
      rosters: {
        away: {
          ...partial.rosters.away,
          players: partial.rosters.away.players.filter((player) => player.playerId !== "a1"),
        },
        home: {
          ...partial.rosters.home,
          players: partial.rosters.home.players.map((player) =>
            player.playerId === "hp1" ? { ...player, playerId: "a1", name: "동명 선수" } : player,
          ),
        },
      },
    });

    const allstar = pitchAnalysisFixture(2025);
    await store.importRevision({
      ...allstar,
      source: { ...allstar.source, sourceGameId: "analysis-directory-allstar" },
      metadata: {
        ...allstar.metadata,
        gameId: "analysis-directory-allstar",
        gameDate: "2025-07-12",
      },
      teams: {
        away: { ...allstar.teams.away, name: "나눔" },
        home: { ...allstar.teams.home, name: "드림" },
      },
      rosters: {
        away: {
          ...allstar.rosters.away,
          players: allstar.rosters.away.players.map((player) =>
            player.playerId === "a1"
              ? { ...player, name: "동명 선수", positions: ["유격수"] }
              : player,
          ),
        },
        home: {
          ...allstar.rosters.home,
          players: allstar.rosters.home.players.map((player) =>
            player.playerId === "hp1" ? { ...player, name: "동명 선수" } : player,
          ),
        },
      },
    });
    await new GameCompetitionRepository(pool).adopt(
      competitionFixture(2025, [
        {
          sourceGameId: "analysis-directory-allstar",
          gameDate: "2025-07-12",
          competition: "allstar",
        },
      ]),
    );

    const directory = await new PlayerDirectoryRepository(pool).list();
    expect(directory.map((player) => player.sourceIds)).toEqual([["a1"], ["hp1"]]);
    expect(directory).toEqual([
      {
        identity: "naver:a1",
        sourceIds: ["a1"],
        name: "동명 선수",
        primaryPosition: "유격수",
        teams: ["원정", "홈", "원정"],
        seasons: [
          { season: 2025, battingPlayerId: "a1", pitchingPlayerId: null },
          { season: 2024, battingPlayerId: "a1", pitchingPlayerId: "a1" },
        ],
      },
      {
        identity: "naver:hp1",
        sourceIds: ["hp1"],
        name: "동명 선수",
        primaryPosition: "투수",
        teams: ["홈"],
        seasons: [
          { season: 2025, battingPlayerId: null, pitchingPlayerId: "hp1" },
          { season: 2024, battingPlayerId: null, pitchingPlayerId: "hp1" },
        ],
      },
    ]);
  });

  it("filters the selected player's game facts before aggregation without changing PA/BF denominators", async () => {
    await store.importRevision(pitchAnalysisFixture(2024));
    const otherPitcher = pitchAnalysisFixture(2024, "hp2");
    await store.importRevision({
      ...otherPitcher,
      metadata: { ...otherPitcher.metadata, gameDate: "2024-07-01" },
    });
    await store.importRevision(pitchAnalysisFixture(2025));
    const repository = new PlayerStatisticsRepository(pool);
    const query = { season: 2024, competition: "unknown" as const };
    const selectedBat = await repository.batting({ ...query, playerId: "a1" });
    expect(selectedBat.rows).toHaveLength(1);
    expect(selectedBat.rows[0]).toMatchObject({
      games: 2,
      plateAppearances: 2,
      atBats: 2,
      strikeouts: 2,
      kRate: 1,
    });
    const selectedPitcher = await repository.pitching({ ...query, playerId: "hp1" });
    expect(selectedPitcher.rows).toHaveLength(1);
    expect(selectedPitcher.rows[0]).toMatchObject({
      playerId: "hp1",
      games: 1,
      battersFaced: 1,
      pitches: 4,
      strikeouts: 1,
      kRate: 1,
    });
    expect(
      (await repository.pitching(query)).rows.reduce((total, row) => total + row.battersFaced, 0),
    ).toBe(2);
    const june = await repository.batting({
      ...query,
      playerId: "a1",
      dateFrom: "2024-06-01",
      dateTo: "2024-06-30",
    });
    expect(june.rows[0]).toMatchObject({ games: 1, plateAppearances: 1, atBats: 1 });
    expect(june.sourceHash).not.toBe(selectedBat.sourceHash);
  });

  it("releases the read snapshot before calibration, reference and sample CPU work", async () => {
    await store.importRevision(pitchAnalysisFixture(2024));
    const single = new Pool({ connectionString: dsn, max: 1, connectionTimeoutMillis: 1000 });
    const check = async () => {
      await single.query("SELECT 1");
    };
    try {
      const repository = new PitchAnalysisRepository(single, undefined, {
        calibration: async (...args) => {
          await check();
          return calculatePitchCalibration(...args);
        },
        reference: async (...args) => {
          await check();
          return preparePitchAnalysisReference(...args);
        },
        sample: async (...args) => {
          await check();
          return calculatePitchAnalysisSample(...args);
        },
      });
      expect(
        (await repository.analyze(2024, "hp1", { competition: "unknown" })).actualPitchCount,
      ).toBe(4);
      const discipline = new BatterDisciplineRepository(
        single,
        { getOrCreate: async (_key, calculate) => calculate() },
        async (...args) => {
          await check();
          return preparePitchAnalysisReference(...args);
        },
      );
      expect(
        (await discipline.snapshot(2024, undefined, { competition: "unknown" })).rows,
      ).toHaveLength(4);
    } finally {
      await single.end();
    }
  });

  it("adopts complete competition evidence atomically without changing sealed game facts", async () => {
    const source = pitchAnalysisFixture(2024);
    await store.importRevision(source);
    const repo = new GameCompetitionRepository(pool);
    const dataset = competitionFixture(2024, [
      {
        sourceGameId: source.source.sourceGameId,
        gameDate: source.metadata.gameDate,
        competition: "regular",
      },
    ]);
    const current = async () =>
      (await pool.query("SELECT competition FROM analytics.current_analysis_games")).rows;
    expect(await current()).toEqual([{ competition: "unknown" }]);
    expect(await repo.adopt(dataset, true)).toMatchObject({
      matched: 1,
      unclassified: 0,
      dryRun: true,
    });
    expect(await current()).toEqual([{ competition: "unknown" }]);
    const adopted = await repo.adopt(dataset);
    expect(await current()).toEqual([{ competition: "regular" }]);
    expect(await repo.adopt(dataset)).toMatchObject({
      changed: false,
      datasetHash: adopted.datasetHash,
    });
    await expect(
      pool.query("UPDATE reference.game_competitions SET competition='preseason'"),
    ).rejects.toThrow("immutable");
    await expect(repo.adopt({ ...dataset, pages: dataset.pages.slice(1) })).rejects.toThrow();
    await expect(
      repo.adopt({
        ...dataset,
        entries: dataset.entries.map((r) => ({ ...r, gameDate: "2024-06-02" })),
      }),
    ).rejects.toThrow();
    expect(await current()).toEqual([{ competition: "regular" }]);
    const next = competitionFixture(2024, [
      {
        sourceGameId: source.source.sourceGameId,
        gameDate: source.metadata.gameDate,
        competition: "preseason",
      },
    ]);
    const changed = await repo.adopt(next);
    expect(changed.datasetHash).not.toBe(adopted.datasetHash);
    expect(await current()).toEqual([{ competition: "preseason" }]);
    const loaded = await store.loadCompiled(source.metadata.gameId, 1);
    expect(loaded.documentHash).toBe(stagingDocumentHash(source));
  });

  it("reuses season summaries and detects newly sealed revisions and external schedule adoption", async () => {
    const repository = new GameCompetitionRepository(pool);
    expect(await repository.seasons()).toEqual([]);
    const source = pitchAnalysisFixture(2024);
    await store.importRevision(source);
    const [initial] = await repository.seasons();
    expect(initial).toMatchObject({ season: 2024, competitionHash: null, unclassified: 1 });
    const query = vi.spyOn(pool, "query");
    try {
      expect(await repository.seasons()).toEqual([initial]);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]?.[0]).toContain("FROM workbench.games");
      expect(query.mock.calls[0]?.[0]).not.toContain("analytics.current_analysis_games");
    } finally {
      query.mockRestore();
    }

    const statistics = new PlayerStatisticsRepository(pool);
    const pitch = new PitchAnalysisRepository(pool);
    const empty = { season: 2024, dateTo: "2024-05-31" };
    const emptyBefore = (await statistics.battingWithManifest(empty)).sourceHash;
    expect(await statistics.readSourceHash(empty)).toBe(emptyBefore);
    const adopt = await new GameCompetitionRepository(pool).adopt(
      competitionFixture(2024, [
        {
          sourceGameId: source.source.sourceGameId,
          gameDate: source.metadata.gameDate,
          competition: "regular",
        },
      ]),
    );
    const [classified] = await repository.seasons();
    expect(classified).toMatchObject({
      season: 2024,
      competitionHash: adopt.datasetHash,
      unclassified: 0,
    });
    expect(classified?.sourceHash).toBe(initial?.sourceHash);
    const batting = await statistics.battingWithManifest(empty);
    expect(batting.response.rows).toEqual([]);
    expect(batting.sourceHash).not.toBe(emptyBefore);
    expect(await statistics.readSourceHash(empty)).toBe(batting.sourceHash);
    const scoped = { season: 2024, competition: "regular", dateFrom: "2024-06-01" } as const;
    const pitching = await statistics.pitchingWithManifest(scoped);
    expect(pitching.response.rows).toMatchObject([{ battersFaced: 1 }]);
    expect(await statistics.readSourceHash(scoped)).toBe(pitching.sourceHash);

    const pitchBefore = await pitch.analyze(2024, "hp1", { dateTo: empty.dateTo });
    expect(pitchBefore.actualPitchCount).toBe(0);
    expect(await pitch.readSourceHash(empty)).toBe(pitchBefore.sourceHash);
    const draft = await store.loadCorrectionDraft(source.metadata.gameId, 1);
    await store.importRevision({
      ...pitchAnalysisFixture(2024, "hp1", -150),
      revisionBase: draft.revisionBase,
    });
    const [updated] = await repository.seasons();
    expect(updated?.sourceHash).not.toBe(classified?.sourceHash);
    expect(updated?.competitionHash).toBe(adopt.datasetHash);
    const pitchAfter = await pitch.analyze(2024, "hp1", { dateTo: empty.dateTo });
    expect(await pitch.readSourceHash(empty)).toBe(pitchAfter.sourceHash);
    expect(pitchAfter.sourceHash).not.toBe(pitchBefore.sourceHash);
    expect(pitchAfter.actualPitchCount).toBe(0);
  });

  it("rejects omission of a late exact match and accepts a complete reclassification", async () => {
    const first = pitchAnalysisFixture(2026);
    const makeGame = (gameId: string, sourceGameId: string, gameDate: string) =>
      parseStagingGameDocumentV2({
        ...first,
        source: { ...first.source, sourceGameId },
        metadata: { ...first.metadata, gameId, gameDate },
      });
    const late = makeGame("late-exact-game", "20260602LGKT0", "2026-06-02");
    const unknown = makeGame("unclassified-game", "20260603LGKT0", "2026-06-03");
    const entry = (game: typeof first) => ({
      sourceGameId: game.source.sourceGameId,
      gameDate: game.metadata.gameDate,
      competition: "regular" as const,
    });
    const firstEntry = entry(first);
    const lateEntry = entry(late);
    const dataset = competitionFixture(2026, [firstEntry, lateEntry]);
    const repository = new GameCompetitionRepository(pool);
    await store.importRevision(first);
    const adopted = await repository.adopt(dataset);
    expect(adopted.matched).toBe(1);
    await store.importRevision(late);
    await store.importRevision(unknown);
    const current = async () =>
      (
        await pool.query(
          `SELECT game_id AS "gameId",competition FROM analytics.current_analysis_games
         WHERE season=2026 ORDER BY game_date`,
        )
      ).rows;
    const expected = [
      { gameId: first.metadata.gameId, competition: "regular" },
      { gameId: late.metadata.gameId, competition: "regular" },
      { gameId: unknown.metadata.gameId, competition: "unknown" },
    ];
    expect(await current()).toEqual(expected);
    const models = new AnalysisModelSourceRepository(pool);
    const previousModels = await models.read(2025);

    const incomplete = competitionFixture(2026, [firstEntry]);
    for (const dryRun of [true, false]) {
      await expect(repository.adopt(incomplete, dryRun)).rejects.toThrow(
        "기존에 분류한 경기의 공식 일정이 누락",
      );
    }
    expect(await repository.current(2026)).toEqual(dataset);
    expect(await repository.seasons()).toMatchObject([
      { season: 2026, competitionHash: adopted.datasetHash, unclassified: 1 },
    ]);
    expect(await current()).toEqual(expected);
    expect(await models.read(2025)).toEqual(previousModels);

    const complete = competitionFixture(2026, [
      firstEntry,
      { ...lateEntry, competition: "postseason" },
    ]);
    expect(await repository.adopt(complete)).toMatchObject({
      changed: true,
      matched: 2,
      unclassified: 1,
    });
    expect(await current()).toEqual([
      expected[0],
      { gameId: late.metadata.gameId, competition: "postseason" },
      expected[2],
    ]);
    expect((await models.read(2025)).re24).not.toBe(previousModels.re24);
  });

  it("classifies a later import from sealed schedule evidence without changing manually corrected game facts", async () => {
    const original = pitchAnalysisFixture(2026);
    const source = parseStagingGameDocumentV2({
      ...original,
      events: original.events.map((event, index) =>
        index === 0 ? { ...event, relayText: "수동으로 보정한 중계 문구" } : event,
      ),
    });
    const repository = new GameCompetitionRepository(pool);
    const dataset = competitionFixture(2026, [
      {
        sourceGameId: source.source.sourceGameId,
        gameDate: source.metadata.gameDate,
        competition: "regular",
      },
    ]);
    const adopted = await repository.adopt(dataset);
    expect(await repository.current(2026)).toEqual(dataset);
    await store.importRevision(source);
    expect(
      (await pool.query("SELECT competition FROM analytics.current_analysis_games")).rows,
    ).toEqual([{ competition: "regular" }]);
    expect(
      (await pool.query("SELECT dataset_hash FROM reference.current_competition_datasets")).rows,
    ).toEqual([{ dataset_hash: adopted.datasetHash }]);
    expect((await repository.seasons())[0]).toMatchObject({
      season: 2026,
      unclassified: 0,
      competitionHash: adopted.datasetHash,
    });
    expect((await store.loadCompiled(source.metadata.gameId, 1)).documentHash).toBe(
      stagingDocumentHash(source),
    );
    const season2026 = await new AnalysisModelSourceRepository(pool).read(2025);
    expect(season2026.re24).toMatch(/^[a-f0-9]{64}$/);
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-analysis-import-"));
    const workspace = await StagingWorkspace.open(directory.path);
    const refresh = vi.fn(async () => {});
    const collect = vi.fn(async () => dataset);
    const manager = new AnalysisPreparationManager(
      repository,
      workspace.analysisPreparation,
      collect,
      { afterImport: refresh },
      () => false,
    );
    try {
      await workspace.saveCorrectionDraft(source);
      const before = await workspace.readCurrentDocumentSnapshot(source.metadata.gameId);
      await manager.check();
      expect(collect).toHaveBeenCalledTimes(1);
      expect(collect).toHaveBeenCalledWith(2026, expect.any(AbortSignal), [
        {
          gameId: source.metadata.gameId,
          sourceGameId: source.source.sourceGameId,
          gameDate: source.metadata.gameDate,
        },
      ]);
      const [after] = await repository.seasons();
      expect(after?.competitionHash).not.toBe(adopted.datasetHash);
      expect(await workspace.analysisPreparation.readClassification(2026)).toMatchObject({
        competitionHash: after?.competitionHash,
        error: null,
      });
      await manager.check();
      expect(collect).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith(2026);
      expect(await workspace.analysisPreparation.read(2026)).toMatchObject({
        state: "ready",
        unclassified: 0,
      });
      expect(await workspace.readCurrentDocumentSnapshot(source.metadata.gameId)).toEqual(before);
      expect((await store.loadCompiled(source.metadata.gameId, 1)).documentHash).toBe(
        stagingDocumentHash(source),
      );
    } finally {
      await manager.close();
      await workspace.close();
    }
  });

  it.each(["empty", "unrelated"] as const)(
    "collects a fresh official schedule when the first imported game matches no entry in a saved %s schedule",
    async (savedEntries) => {
      const repository = new GameCompetitionRepository(pool);
      const stale = competitionFixture(
        2026,
        savedEntries === "empty"
          ? []
          : [{ sourceGameId: "20260531LGKT0", gameDate: "2026-05-31", competition: "regular" }],
      );
      const old = await repository.adopt(stale);
      const fixture = pitchAnalysisFixture(2026);
      const document = parseStagingGameDocumentV2({
        ...fixture,
        source: { ...fixture.source, sourceGameId: "20260601LGKT02026" },
      });
      const imported = await store.importRevision(document);
      await expect(repository.adopt(stale)).rejects.toBeInstanceOf(
        CompetitionScheduleNoMatchesError,
      );
      expect(await repository.seasons()).toMatchObject([
        { season: 2026, competitionHash: old.datasetHash, unclassified: 1 },
      ]);

      const fresh = competitionFixture(2026, [
        { sourceGameId: "20260601LGKT0", gameDate: "2026-06-01", competition: "regular" },
      ]);
      const collect = vi.fn(async () => fresh);
      const afterImport = vi.fn(async () => {
        expect(await repository.seasons()).toMatchObject([{ season: 2026, unclassified: 0 }]);
      });
      await using directory = await mkdtempDisposable(
        path.join(tmpdir(), "kbo-preparation-stale-"),
      );
      const workspace = await StagingWorkspace.open(directory.path);
      const manager = new AnalysisPreparationManager(
        repository,
        workspace.analysisPreparation,
        collect,
        { afterImport },
        () => false,
      );
      try {
        await manager.check();
        await manager.check();
        expect(collect).toHaveBeenCalledExactlyOnceWith(2026, expect.any(AbortSignal), [
          {
            gameId: imported.gameId,
            gameDate: document.metadata.gameDate,
            sourceGameId: document.source.sourceGameId,
          },
        ]);
        expect(afterImport).toHaveBeenCalledExactlyOnceWith(2026);
        expect(await workspace.analysisPreparation.read(2026)).toMatchObject({
          state: "ready",
          unclassified: 0,
        });
        expect((await store.loadCompiled(imported.gameId, 1)).documentHash).toBe(
          imported.documentHash,
        );
      } finally {
        await manager.close();
        await workspace.close();
      }
    },
  );

  it("preserves both provider IDs and seals only a unique dated competition link", async () => {
    const source = pitchAnalysisFixture(2024);
    await store.importRevision(source);
    const repository = new GameCompetitionRepository(pool);
    const dataset = competitionFixture(2024, [
      { sourceGameId: "20240601AABB0", gameDate: source.metadata.gameDate, competition: "regular" },
    ]);
    const link = {
      sourceGameId: "20240601AABB0",
      matchedSourceGameId: source.source.sourceGameId,
      gameDate: source.metadata.gameDate,
    };
    await expect(
      repository.adopt(dataset, false, [{ ...link, gameDate: "2024-06-02" }]),
    ).rejects.toThrow();
    await expect(
      repository.adopt(dataset, false, [{ ...link, matchedSourceGameId: "missing" }]),
    ).rejects.toThrow();
    expect(await repository.adopt(dataset, true, [link])).toMatchObject({
      matched: 1,
      dryRun: true,
    });
    expect(
      (await pool.query("SELECT competition FROM analytics.current_analysis_games")).rows,
    ).toEqual([{ competition: "unknown" }]);
    const adopted = await repository.adopt(dataset, false, [link]);
    expect(await repository.adopt(dataset, false, [link])).toMatchObject({
      changed: false,
      datasetHash: adopted.datasetHash,
    });
    expect(
      (await pool.query("SELECT competition FROM analytics.current_analysis_games")).rows,
    ).toEqual([{ competition: "regular" }]);
    expect(
      (
        await pool.query(
          "SELECT source_game_id,matched_source_game_id FROM reference.competition_game_links",
        )
      ).rows,
    ).toEqual([
      { source_game_id: link.sourceGameId, matched_source_game_id: link.matchedSourceGameId },
    ]);
    await expect(
      pool.query("UPDATE reference.competition_game_links SET matched_source_game_id='changed'"),
    ).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM reference.competition_game_links")).rejects.toThrow(
      /immutable/,
    );
    expect((await store.loadCompiled(source.metadata.gameId, 1)).documentHash).toBe(
      stagingDocumentHash(source),
    );
  });

  it("counts selected actual pitches and chooses roster names in both catalogs", async () => {
    const first = pitchAnalysisFixture(2024, "hp1");
    const second = pitchAnalysisFixture(2024, "hp2");
    await store.importRevision(first);
    await store.importRevision(second);
    await store.importRevision({
      ...first,
      metadata: { ...first.metadata, gameId: "catalog-july", gameDate: "2024-07-01" },
      rosters: {
        away: {
          ...first.rosters.away,
          players: first.rosters.away.players.map((player) =>
            player.playerId === "a1" ? { ...player, name: "a0 batter" } : player,
          ),
        },
        home: {
          ...first.rosters.home,
          players: first.rosters.home.players.map((player) =>
            player.playerId === "hp1" ? { ...player, name: "hp0 pitcher" } : player,
          ),
        },
      },
    });
    const pitchers = new PitchAnalysisRepository(pool);
    const batters = new BatterDisciplineRepository(pool, { getOrCreate: (_key, load) => load() });
    const season = { competition: "unknown" as const };
    const june = { ...season, dateTo: "2024-06-30" };
    expect((await pitchers.catalog(2024, june)).pitchers).toEqual([
      { pitcherId: "hp1", name: "hp1", pitches: 4 },
      { pitcherId: "hp2", name: "hp2", pitches: 4 },
    ]);
    expect((await batters.catalog(2024, june)).batters).toEqual([
      { batterId: "a1", name: "a1", pitches: 8 },
    ]);
    expect((await pitchers.catalog(2024, season)).pitchers).toEqual([
      { pitcherId: "hp1", name: "hp0 pitcher", pitches: 8 },
      { pitcherId: "hp2", name: "hp2", pitches: 4 },
    ]);
    expect((await batters.catalog(2024, season)).batters).toEqual([
      { batterId: "a1", name: "a0 batter", pitches: 12 },
    ]);
  });

  it("uses the same competition for target, reference and calibration while dates only narrow the target", async () => {
    const source = pitchAnalysisFixture(2024);
    const second = parseStagingGameDocumentV2({
      ...pitchAnalysisFixture(2024, "hp1", -100),
      source: { ...source.source, sourceGameId: "other-game" },
      metadata: { ...source.metadata, gameId: "postseason-game", gameDate: "2024-10-01" },
    });
    const allstar = parseStagingGameDocumentV2({
      ...pitchAnalysisFixture(2024, "hp1", 20),
      source: { ...source.source, sourceGameId: "20240706WEEA0" },
      metadata: { ...source.metadata, gameId: "allstar-game", gameDate: "2024-07-06" },
    });
    await store.importRevision(allstar);
    await store.importRevision(source);
    await store.importRevision(second);
    const coverage = new AnalysisCoverageRepository(pool);
    const referenceCache = { getOrCreate: vi.fn(async (_key, calculate) => calculate()) };
    const pitch = new PitchAnalysisRepository(
      pool,
      referenceCache,
      undefined,
      new BoundedReadCache(1024 * 1024, 10, 10000),
    );
    const discipline = new BatterDisciplineRepository(pool, referenceCache);
    const location = new PitchLocationRepository(
      pool,
      new BoundedReadCache<PitchOutcomeSnapshot>(1024 * 1024, 8, 60_000),
    );
    const regular = { season: 2024, competition: "regular" as const };
    expect((await location.analyze(regular, "hp1")).total.pitches).toBe(0);
    const before = await pitch.analyze(2024, "hp1", { competition: "regular" });
    const disciplineBefore = await discipline.snapshot(2024, undefined, { competition: "regular" });
    expect(await discipline.readSourceHash({ season: 2024, competition: "regular" })).toBe(
      disciplineBefore.sourceHash,
    );
    expect(before.actualPitchCount).toBe(0);
    const dataset = competitionFixture(2024, [
      {
        sourceGameId: source.source.sourceGameId,
        gameDate: source.metadata.gameDate,
        competition: "regular",
      },
      {
        sourceGameId: second.source.sourceGameId,
        gameDate: second.metadata.gameDate,
        competition: "postseason",
      },
      {
        sourceGameId: allstar.source.sourceGameId,
        gameDate: allstar.metadata.gameDate,
        competition: "allstar",
      },
    ]);
    const competitions = new GameCompetitionRepository(pool);
    await competitions.adopt(dataset);
    expect(await competitions.current(2024)).toEqual(dataset);
    const dbGames = await pool.query(
      "SELECT game_id, competition FROM analytics.current_analysis_games ORDER BY game_id",
    );
    expect(dbGames.rows).toEqual([
      { game_id: "allstar-game", competition: "allstar" },
      { game_id: source.metadata.gameId, competition: "regular" },
      { game_id: "postseason-game", competition: "postseason" },
    ]);
    expect((await coverage.read(2024, { competition: "allstar" })).total.games).toBe(1);
    expect((await pitch.catalog(2024)).pitchers[0]?.pitches).toBe(4);
    const quality = new PitchQualityRepository(pool);
    expect((await quality.read(regular, "hp1", null, null)).rows).toEqual([]);
    const allstarSample = await pitch.analyze(2024, "hp1", { competition: "allstar" });
    expect(allstarSample.actualPitchCount).toBe(4);
    const allstarDiscipline = await discipline.snapshot(2024, undefined, {
      competition: "allstar",
    });
    expect(allstarDiscipline.rows?.map((row) => row.gameId)).toEqual(Array(4).fill("allstar-game"));
    expect((await location.analyze(regular, "hp1")).total.pitches).toBe(4);
    const { manifest } = await new RunValueRepository(pool).training(2024);
    expect(manifest.games.map((game) => game.gameId)).toEqual([source.metadata.gameId]);
    const after = await pitch.analyze(2024, "hp1", { competition: "regular" });
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect(after.actualPitchCount).toBe(4);
    expect(after.baseline).toBeNull();
    expect(after.missingReleaseCount).toBe(2);
    expect((await pitch.catalog(2024, { competition: "postseason" })).pitchers[0]?.pitches).toBe(4);
    const narrow = await pitch.analyze(2024, "hp1", {
      competition: "regular",
      dateFrom: "2024-06-02",
    });
    expect(narrow.actualPitchCount).toBe(0);
    expect(narrow.baseline).toEqual(after.baseline);
    expect(narrow.calibration.profileHash).toBe(after.calibration.profileHash);
    expect(
      (await location.analyze({ ...regular, dateFrom: "2024-06-02" }, "hp1")).total.pitches,
    ).toBe(0);
    const summary = await coverage.read(2024, {
      competition: "regular",
      dateFrom: "2024-06-01",
      dateTo: "2024-06-01",
    });
    expect(summary.total.games).toBe(1);
    expect(summary.unclassifiedGames).toBe(0);
    expect((await coverage.read(2024, { competition: "unknown" })).total.games).toBe(0);
    const disc = await discipline.snapshot(2024, undefined, {
      competition: "regular",
      dateFrom: "2024-06-02",
    });
    expect(disc.sourceHash).not.toBe(disciplineBefore.sourceHash);
    expect(disc.rows).toHaveLength(4);
    expect(disc.reference?.summary.candidateCount).toBe(3);
    expect(await discipline.readSourceHash({ season: 2024, competition: "regular" })).toBe(
      disc.sourceHash,
    );
    await seedBatterHeights(pool, source, 185);
    const nextDiscipline = await discipline.snapshot(2024, disc.sourceHash, {
      competition: "regular",
    });
    expect(nextDiscipline.sourceHash).not.toBe(disc.sourceHash);
    expect(await discipline.readSourceHash({ season: 2024, competition: "regular" })).toBe(
      nextDiscipline.sourceHash,
    );
  });

  it("classifies untracked pitches and terminal PA from same-game profiles without changing sealed facts or geometry", async () => {
    const source = parseStagingGameDocumentV2({
      ...pitchAnalysisFixture(2024),
      trackingCandidates: [],
    });
    await store.importRevision(source);
    const query = { season: 2024, competition: "unknown" as const };
    const outcomeCache = new BoundedReadCache<PitchOutcomeSnapshot>(1024 * 1024, 8, 60_000);
    const location = new PitchLocationRepository(pool, outcomeCache);
    const batters = new BatterProfileRepository(pool, outcomeCache);
    const left = { ...query, stance: "L" as const };
    expect((await batters.analyze(left, "a1")).total.pitches).toBe(0);
    const before = await location.analyze(query, "hp1");
    const manifests = (await pool.query("SELECT * FROM workbench.game_revisions")).rows;
    const facts = (await pool.query("SELECT * FROM baseball.pitch_facts ORDER BY pitch_sequence"))
      .rows;
    const repository = new PlayerBattingProfileRepository(pool);
    const dataset = {
      gameId: source.metadata.gameId,
      season: 2024,
      sourceBundleHash: source.source.sourceBundleHash,
      observations: [
        {
          playerId: "a1",
          battingSide: "L",
          rawValue: "좌타",
          endpoint: "lineup",
          sourcePath: "fullLineUp[0].batsThrows",
        },
        {
          playerId: "a2",
          battingSide: "R",
          rawValue: "우타",
          endpoint: "lineup",
          sourcePath: "fullLineUp[1].batsThrows",
        },
      ],
    };
    expect(await repository.pendingSources(2024)).toHaveLength(1);
    expect(await repository.importDataset(dataset)).toBe(true);
    expect(await repository.importDataset(dataset)).toBe(false);
    expect(await repository.pendingSources(2024)).toHaveLength(0);
    const after = await location.analyze(query, "hp1");
    expect(after.total).toEqual(before.total);
    expect(after.coverage).toEqual(before.coverage);
    expect(after.coverage.locationPitches).toBe(0);
    expect(after.arsenal.every((group) => group.stance === "L")).toBe(true);
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect((await location.analyze({ ...query, stance: "L" }, "hp1")).total.pitches).toBe(4);
    expect(
      (await location.compare({ ...query, stance: "L", compareSeason: 2024 }, "hp1")).first.total
        .pitches,
    ).toBe(4);
    const batter = await batters.analyze(left, "a1");
    expect(batter.total.pitches).toBe(4);
    expect(batter.plateAppearances.rows[0]?.stance).toBe("L");
    const discipline = new BatterDisciplineRepository(pool, {
      getOrCreate: (_key, load) => load(),
    });
    const observed = await discipline.snapshot(2024, undefined, { competition: "unknown" });
    expect(observed.rows?.map(({ stance }) => stance)).toEqual([null, null, null, null]);
    expect((await pool.query("SELECT * FROM workbench.game_revisions")).rows).toEqual(manifests);
    expect(
      (await pool.query("SELECT * FROM baseball.pitch_facts ORDER BY pitch_sequence")).rows,
    ).toEqual(facts);
    await expect(repository.importDataset({ ...dataset, observations: [] })).rejects.toThrow(
      "추출 결과",
    );
    await expect(
      pool.query("UPDATE registry.game_player_batting_profile_observations SET batting_side='R'"),
    ).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM registry.game_batting_profile_bundles")).rejects.toThrow(
      "immutable",
    );

    const draft = await store.loadCorrectionDraft(source.metadata.gameId, 1);
    const revised = parseStagingGameDocumentV2({
      ...draft,
      source: { ...draft.source, sourceBundleHash: "e".repeat(64) },
    });
    await store.importRevision(revised);
    await repository.importDataset({
      ...dataset,
      sourceBundleHash: revised.source.sourceBundleHash,
      observations: [
        {
          playerId: "a1",
          battingSide: "R",
          rawValue: "우타",
          endpoint: "lineup",
          sourcePath: "fullLineUp[0].batsThrows",
        },
      ],
    });
    expect((await batters.analyze(left, "a1")).total.pitches).toBe(0);
    const current = await batters.analyze({ ...query, stance: "R" }, "a1");
    expect(current.total.pitches).toBe(4);
    expect(current.plateAppearances.rows).toMatchObject([{ revision: 2, stance: "R" }]);
  });

  it.each([
    { sides: ["L"], expected: "L" },
    { sides: ["S"], expected: "S" },
    { sides: ["L", "R"], expected: null },
    { sides: ["L", "S"], expected: null },
    { sides: [null], expected: null },
  ])(
    "preserves observed direction with profile $sides and leaves unresolved profiles separate",
    async ({ sides, expected }) => {
      const base = pitchAnalysisFixture(2024);
      const source = parseStagingGameDocumentV2({
        ...base,
        trackingCandidates: base.trackingCandidates.map((row, i) =>
          i === 0 ? { ...row, stance: "R" } : row,
        ),
      });
      await store.importRevision(source);
      const repository = new PlayerBattingProfileRepository(pool);
      const dataset = {
        gameId: source.metadata.gameId,
        season: 2024,
        sourceBundleHash: source.source.sourceBundleHash,
        observations: sides.map((battingSide, i) => ({
          playerId: "a1",
          battingSide,
          rawValue: `declaration-${i}`,
          endpoint: "lineup",
          sourcePath: `row[${i}]`,
        })),
      };
      // An unrelated source bundle cannot classify this game's pitches.
      await repository.importDataset({ ...dataset, sourceBundleHash: "e".repeat(64) });
      const query = { season: 2024, competition: "unknown" as const };
      const location = new PitchLocationRepository(pool);
      const unrelated = await location.analyze(query, "hp1");
      expect(
        unrelated.arsenal.filter((g) => g.stance === null).reduce((n, g) => n + g.pitches, 0),
      ).toBe(3);
      await repository.importDataset(dataset);
      const result = await location.analyze(query, "hp1");
      expect(
        result.arsenal.filter((g) => g.stance === "R").reduce((n, g) => n + g.pitches, 0),
      ).toBe(1);
      expect(
        result.arsenal.filter((g) => g.stance === expected).reduce((n, g) => n + g.pitches, 0),
      ).toBe(3);
      expect(result.total.pitches).toBe(4);
    },
  );

  it("rolls profile extraction back with failed imports and rejects mismatched source provenance", async () => {
    const source = pitchAnalysisFixture(2024);
    const dataset = {
      gameId: source.metadata.gameId,
      season: 2024,
      sourceBundleHash: source.source.sourceBundleHash,
      observations: [],
    };
    const withProfiles = new GameRevisionStore(
      pool,
      EXPECTED_MIGRATION_VERSION,
      undefined,
      undefined,
      undefined,
      async () => dataset,
    );
    await expect(
      withProfiles.importRevision(source, { failurePoint: "after_facts" }),
    ).rejects.toThrow("injected");
    expect(
      (await pool.query("SELECT game_id FROM registry.game_batting_profile_bundles")).rowCount,
    ).toBe(0);
    const wrongSource = new GameRevisionStore(
      pool,
      EXPECTED_MIGRATION_VERSION,
      undefined,
      undefined,
      undefined,
      async () => ({ ...dataset, sourceBundleHash: "f".repeat(64) }),
    );
    await expect(wrongSource.importRevision(source)).rejects.toThrow("출처");
    await withProfiles.importRevision(source);
    expect(
      (await pool.query("SELECT sealed FROM registry.game_batting_profile_bundles")).rows,
    ).toEqual([{ sealed: true }]);
  });

  it("links a legacy ball to a sealed HBP without crossing another pitch event", async () => {
    const fullCount = ["ball", "called_strike", "ball", "called_strike", "ball"];
    const scenarios = [
      {
        game: "legacy",
        call: "ball",
        result: "hit_by_pitch",
        before: fullCount,
        intervening: [
          { kind: "review", payload: { decision: "upheld", reviewedEventId: "e7" } },
          { kind: "administrative", payload: { code: "announcement" } },
        ],
      },
      { game: "walk", call: "ball", result: "walk", before: fullCount, intervening: [] },
      {
        game: "canonical",
        call: "hit_by_pitch",
        result: "hit_by_pitch",
        before: fullCount,
        intervening: [],
      },
      {
        game: "no-pitch",
        call: "hit_by_pitch",
        result: "hit_by_pitch",
        before: fullCount,
        intervening: [{ kind: "pitch", payload: { call: "no_pitch" } }],
      },
      {
        game: "automatic",
        call: "ball",
        result: "hit_by_pitch",
        before: [],
        intervening: [{ kind: "pitch", payload: { call: "automatic_strike" } }],
      },
    ];
    for (const scenario of scenarios) {
      const original = parseStagingGameDocumentV2(
        makeDocument([
          { kind: "half_inning_start", payload: {} },
          { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
          ...[...scenario.before, scenario.call].map((call) => ({
            kind: "pitch",
            payload: { call },
          })),
          ...scenario.intervening,
          {
            kind: "plate_result",
            payload: { result: scenario.result, batterId: "a1", pitcherId: "hp1" },
          },
        ]),
      );
      const gameId = `hbp-flow-${scenario.game}`;
      await store.importRevision(
        parseStagingGameDocumentV2({
          ...original,
          metadata: { ...original.metadata, gameId },
          source: { ...original.source, sourceGameId: gameId },
        }),
      );
    }
    const location = new PitchLocationRepository(pool);
    const query = { season: 2026, competition: "unknown" as const };
    const select = (
      groups: Awaited<ReturnType<PitchLocationRepository["countFlow"]>>["groups"],
      balls: number,
      strikes: number,
    ) =>
      groups.find(
        (group) => group.stance === "all" && group.balls === balls && group.strikes === strikes,
      );
    const flow = await location.countFlow(query, "hp1");
    expect(flow.scopePitches).toBe(25);
    const full = select(flow.groups, 3, 2);
    expect(full?.types).toHaveLength(1);
    expect(full?.types[0]?.pitchType).toBeNull();
    expect(full?.transitions.filter((step) => step.pitches > 0)).toEqual([
      { outcome: "walk", pitches: 1, rate: 0.25 },
      { outcome: "hitByPitch", pitches: 2, rate: 0.5 },
      { outcome: "unresolved", pitches: 1, rate: 0.25 },
    ]);
    expect(select(flow.groups, 0, 0)?.transitions.filter((step) => step.pitches > 0)).toEqual([
      { outcome: "ball", pitches: 5, rate: 1 },
    ]);
    const discipline = await location.countFlow({ ...query, cohort: "discipline" }, "hp1");
    expect(discipline.excludedSituations).toBe(2);
    expect(select(discipline.groups, 3, 2)?.transitions.filter((step) => step.pitches > 0)).toEqual(
      [
        { outcome: "walk", pitches: 1, rate: 0.5 },
        { outcome: "hitByPitch", pitches: 1, rate: 0.5 },
      ],
    );
  });

  it("keeps pitch outcomes separate from official terminal PA grain and current revision", async () => {
    const source = pitchAnalysisFixture(2024);
    await store.importRevision(source);
    const query = { season: 2024, competition: "unknown" as const };
    const samples = new BoundedReadCache<PitchOutcomeSnapshot>(1024 * 1024, 8, 60_000);
    const location = new PitchLocationRepository(pool, samples);
    const pitch = await location.analyze(query, "hp1");
    expect(pitch.total).toMatchObject({
      pitches: 4,
      swings: 3,
      whiffs: 3,
      twoStrikePitches: 2,
      terminalStrikeouts: 1,
    });
    expect(pitch.coverage).toMatchObject({ locationPitches: 0, missingLocation: 4 });
    expect(pitch.arsenal.reduce((sum, group) => sum + group.pitches, 0)).toBe(4);
    const flow = await location.countFlow(query, "hp1");
    expect(
      flow.groups
        .filter((group) => group.stance === "all")
        .map((group) => [
          group.balls,
          group.strikes,
          group.transitions.filter((step) => step.pitches > 0),
        ]),
    ).toEqual([
      [0, 0, [{ outcome: "strike", pitches: 1, rate: 1 }]],
      [0, 1, [{ outcome: "strike", pitches: 1, rate: 1 }]],
      [0, 2, [{ outcome: "ball", pitches: 1, rate: 1 }]],
      [1, 2, [{ outcome: "strikeout", pitches: 1, rate: 1 }]],
    ]);
    const detailed = await location.countFlow({ ...query, include: "terminal-details" }, "hp1");
    expect(
      detailed.groups.find(
        (group) => group.stance === "all" && group.balls === 1 && group.strikes === 2,
      )?.terminalDetails,
    ).toEqual([{ outcome: "swingingStrikeout", pitches: 1, rate: 1 }]);
    const comparison = await location.compare(
      {
        ...query,
        compareSeason: 2024,
        compareDateFrom: "2024-06-02",
      },
      "hp1",
    );
    expect(comparison.first.total).toEqual(pitch.total);
    expect(comparison.first.sourceHash).toBe(pitch.sourceHash);
    expect(comparison.second.total.pitches).toBe(0);
    expect(comparison.differences.every((cell) => cell.usageRate === null)).toBe(true);
    const same = await location.compare({ ...query, compareSeason: 2024 }, "hp1");
    expect(same.first).toEqual(same.second);
    await expect(
      location.compare(
        {
          ...query,
          compareSeason: 2024,
          compareDateFrom: "2024-02-30",
        },
        "hp1",
      ),
    ).rejects.toThrow("유효한 날짜");
    const batters = new BatterProfileRepository(pool, samples);
    const bat = await batters.analyze(query, "a1");
    expect(bat.plateAppearances.total).toMatchObject({ pa: 1, ab: 1, strikeouts: 1 });
    expect(bat.plateAppearances.byTerminalType[0]?.key).toBe("직구");
    expect(bat.total.pitches).toBe(4);
    const nextPeriod = { ...query, dateFrom: "2024-06-02" };
    const batPair = await batters.compare(query, nextPeriod, "a1");
    expect(batPair.first).toEqual(bat);
    expect(batPair.second.total.pitches).toBe(0);
    expect(batPair.second).toEqual(await batters.analyze(nextPeriod, "a1"));
    const draft = await store.loadCorrectionDraft(source.metadata.gameId, 1);
    await store.importRevision(
      parseStagingGameDocumentV2({ ...draft, metadata: { ...draft.metadata, stadium: "잠실" } }),
    );
    const next = await location.analyze(query, "hp1");
    expect(next.total).toEqual(pitch.total);
    expect(next.sourceHash).not.toBe(pitch.sourceHash);
    expect((await location.analyze({ season: 2024 }, "hp1")).total.pitches).toBe(0);

    const otherPitcher = pitchAnalysisFixture(2024, "hp2");
    const firstPitch = otherPitcher.events[2];
    if (firstPitch?.kind !== "pitch") throw new Error("Expected a physical pitch");
    const { pitchType, ...withoutType } = firstPitch.payload;
    expect(pitchType).toBe("직구");
    await store.importRevision(
      parseStagingGameDocumentV2({
        ...otherPitcher,
        events: otherPitcher.events.map((event) =>
          event === firstPitch
            ? { ...firstPitch, payload: { ...withoutType, call: "called_strike" } }
            : event,
        ),
      }),
    );
    const received = await batters.countFlow({ ...query, include: "terminal-details" }, "a1");
    expect(received.scopePitches).toBe(8);
    expect(received.groups.every((group) => group.stance === "all")).toBe(true);
    const first = received.groups.find((group) => group.balls === 0 && group.strikes === 0);
    expect(first).toMatchObject({ pitches: 2, swings: 1, swingRate: 0.5 });
    expect(first?.types.find((type) => type.pitchType === null)).toMatchObject({
      pitches: 1,
      swings: 0,
      swingRate: 0,
    });
    const unknown = await batters.analyze({ ...query, balls: 0, strikes: 0, pitchType: "" }, "a1");
    expect(unknown.total).toMatchObject({ pitches: 1, swings: 0, swingRate: 0 });
    expect(received.groups.find((group) => group.balls === 1 && group.strikes === 2)).toMatchObject(
      {
        pitches: 2,
        swings: 2,
        terminalDetails: [{ outcome: "swingingStrikeout", pitches: 2, rate: 1 }],
      },
    );
    const conflict = parseStagingGameDocumentV2({
      ...source,
      metadata: { ...source.metadata, gameId: "analysis-2024-conflict" },
    });
    await store.importRevision(conflict);
    const withHands = new BatterProfileRepository(pool, samples, resolveNaverPitcherHand);
    const splitQuery = { ...query, split: "pitcher-hand", include: "terminal-details" } as const;
    const rightQuery = { ...query, pitcherHand: "R", balls: 0, strikes: 0, pitchType: "" } as const;
    expect((await withHands.countFlow(splitQuery, "a1")).byPitcherHand).toEqual({
      left: [],
      right: [],
      unknownPitches: 12,
    });
    const beforeProfiles = await withHands.analyze(rightQuery, "a1");
    expect(beforeProfiles.total.pitches).toBe(0);
    const profiles = new PlayerBattingProfileRepository(pool);
    for (const [game, pitcherId, labels] of [
      [source, "hp1", ["좌투우타", "우타"]],
      [otherPitcher, "hp2", ["우언좌타"]],
      [conflict, "hp1", ["좌투우타", "우투우타"]],
    ] as const) {
      await profiles.importDataset({
        gameId: game.metadata.gameId,
        season: game.metadata.season,
        sourceBundleHash: game.source.sourceBundleHash,
        observations: labels.map((rawValue, index) => ({
          playerId: pitcherId,
          rawValue,
          battingSide: null,
          endpoint: "lineup",
          sourcePath: `profile[${index}]`,
        })),
      });
    }
    const split = await withHands.countFlow(splitQuery, "a1");
    const pitchCount = (groups: typeof split.groups | undefined) =>
      groups?.reduce((total, group) => total + group.pitches, 0);
    expect([
      pitchCount(split.groups),
      pitchCount(split.byPitcherHand?.left),
      pitchCount(split.byPitcherHand?.right),
      split.byPitcherHand?.unknownPitches,
    ]).toEqual([12, 4, 4, 4]);
    const right = await withHands.analyze(rightQuery, "a1");
    expect(right.total).toMatchObject({ pitches: 1, swings: 0, swingRate: 0 });
    expect(right.coverage.scopePitches).toBe(12);
    expect(right.sourceHash).not.toBe(beforeProfiles.sourceHash);
    expect(right.plateAppearances.total.pa).toBe(1);
    expect((await withHands.analyze({ ...query, pitcherHand: "L" }, "a1")).total.pitches).toBe(4);
  });

  it("registers reviewed official pitcher hands only for the confirmed game source", async () => {
    const pitcherId = "10001";
    const pitcherName = "공식 근거 투수";
    const fixture = pitchAnalysisFixture(2024, pitcherId);
    const source = parseStagingGameDocumentV2({
      ...fixture,
      rosters: {
        ...fixture.rosters,
        home: {
          ...fixture.rosters.home,
          players: fixture.rosters.home.players.map((player) =>
            player.playerId === "hp1"
              ? { ...player, playerId: pitcherId, name: pitcherName }
              : player,
          ),
        },
      },
    });
    const gameId = source.metadata.gameId;
    const sourceBundleHash = source.source.sourceBundleHash;
    const otherGameId = "analysis-2024-official-hand-conflict";
    await store.importRevision(source);
    await store.importRevision(
      parseStagingGameDocumentV2({
        ...source,
        metadata: { ...source.metadata, gameId: otherGameId },
      }),
    );
    const profile = {
      gameId,
      sourceBundleHash,
      pitcherId,
      pitcherName,
      reportedHand: "좌투좌타",
      sourceUrl:
        "https://www.koreabaseball.com/Record/Player/PitcherDetail/Total.aspx?playerId=10001",
      checkedOn: "2026-11-22",
    };
    const repository = new OfficialPitcherHandRepository(pool, resolveNaverPitcherHand);
    const batter = new BatterProfileRepository(
      pool,
      new BoundedReadCache<PitchOutcomeSnapshot>(1024 * 1024, 8, 60_000),
      resolveNaverPitcherHand,
    );
    const query = { season: 2024, competition: "unknown" } as const;
    const leftQuery = { ...query, pitcherHand: "L" } as const;
    const before = await batter.analyze(leftQuery, "a1");
    expect(before.total.pitches).toBe(0);
    await expect(
      repository.importProfile({ ...profile, sourceBundleHash: "a".repeat(64) }),
    ).rejects.toThrow("일치하는 투구가 없습니다");
    await expect(
      repository.importProfile({ ...profile, pitcherName: "다른 선수" }),
    ).rejects.toThrow("일치하는 투구가 없습니다");
    await expect(
      repository.importProfile({
        ...profile,
        sourceUrl: profile.sourceUrl.replace("10001", "10002"),
      }),
    ).rejects.toThrow("선수 ID와 대상 투수 ID가 다릅니다");
    await expect(repository.importProfile(profile, true)).resolves.toEqual({
      pitcherHand: "L",
      pitches: 4,
      added: false,
    });
    expect(await batter.analyze(leftQuery, "a1")).toEqual(before);
    await expect(repository.importProfile(profile)).resolves.toEqual({
      pitcherHand: "L",
      pitches: 4,
      added: true,
    });
    expect((await repository.importProfile(profile)).added).toBe(false);
    await expect(
      repository.importProfile({ ...profile, reportedHand: "우투좌타" }),
    ).rejects.toThrow("이미 등록한 공식 투구 손의 근거가 다릅니다");

    const after = await batter.analyze(leftQuery, "a1");
    expect(after.total.pitches).toBe(4);
    expect(after.sourceHash).not.toBe(before.sourceHash);

    const raw = new PlayerBattingProfileRepository(pool);
    const importRaw = (id: string, labels: string[]) =>
      raw.importDataset({
        gameId: id,
        season: 2024,
        sourceBundleHash,
        observations: labels.map((rawValue, index) => ({
          playerId: pitcherId,
          rawValue,
          battingSide: null,
          endpoint: "lineup",
          sourcePath: `profile[${index}]`,
        })),
      });
    await importRaw(gameId, ["우타"]);
    await importRaw(otherGameId, ["좌투우타", "우투우타"]);
    await repository.importProfile({ ...profile, gameId: otherGameId });
    const flow = await batter.countFlow({ ...query, split: "pitcher-hand" }, "a1");
    expect(flow.scopePitches).toBe(8);
    expect(flow.byPitcherHand?.left.map(({ pitches }) => pitches)).toEqual([1, 1, 1, 1]);
    expect(flow.byPitcherHand?.right).toEqual([]);
    expect(flow.byPitcherHand?.unknownPitches).toBe(4);
    const splits = await new PlayerStatisticsRepository(pool).playerSplits(
      {
        season: 2024,
        competition: "unknown",
        player: "naver:a1",
        role: "batter",
        split: "hand",
      },
      resolveNaverPitcherHand,
    );
    expect(splits.rows.map(({ bucket, plateAppearances }) => [bucket, plateAppearances])).toEqual([
      ["L", 1],
      ["R", 0],
      ["unknown", 1],
    ]);
  });

  it("preserves full sequence before pair filtering and does not skip missing tracking", async () => {
    await store.importRevision(pitchAnalysisFixture(2024));
    const result = await new PitchSequenceRepository(pool).analyze(
      { season: 2024, competition: "unknown" },
      "hp1",
    );
    expect(result.coverage).toMatchObject({
      targetPitches: 4,
      noPrevious: 1,
      eligiblePairs: 3,
      geometryPairs: 1,
    });
    expect(result.pairs.map((p) => [p.previous.pitchId, p.current.pitchId])).toEqual([
      ["e2", "e3"],
      ["e3", "e4"],
      ["e4", "e5"],
    ]);
    const filtered = await new PitchSequenceRepository(pool).analyze(
      { season: 2024, competition: "unknown", pitchType: "직구" },
      "hp1",
    );
    expect(filtered.pairs).toHaveLength(2);
    expect(filtered.pairs[0]?.previous.pitchType).toBe("슬라이더");
  });

  it("keeps the automatic pitch as a boundary in the sequence input", async () => {
    await store.importRevision(
      parseStagingGameDocumentV2(
        makeDocument([
          { kind: "half_inning_start", payload: {} },
          { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
          { kind: "pitch", payload: { call: "called_strike" } },
          { kind: "pitch", payload: { call: "automatic_ball" } },
          { kind: "pitch", payload: { call: "ball" } },
          { kind: "pitch", payload: { call: "in_play" } },
          {
            kind: "plate_result",
            payload: { result: "field_out", batterId: "a1", pitcherId: "hp1" },
          },
        ]),
      ),
    );
    const result = await new PitchSequenceRepository(pool).analyze(
      { season: 2026, competition: "unknown" },
      "hp1",
    );
    expect(result.coverage).toMatchObject({
      targetPitches: 3,
      noPrevious: 1,
      nonActualBoundary: 1,
      eligiblePairs: 1,
    });
    expect(
      result.pairs.map(({ previous, current }) => [previous.pitchId, current.pitchId]),
    ).toEqual([["e4", "e5"]]);
    const options = { competition: "unknown" as const };
    expect((await new PitchAnalysisRepository(pool).catalog(2026, options)).pitchers).toEqual([
      { pitcherId: "hp1", name: "hp1", pitches: 3 },
    ]);
    const batters = new BatterDisciplineRepository(pool, { getOrCreate: (_key, load) => load() });
    expect((await batters.catalog(2026, options)).batters).toEqual([
      { batterId: "a1", name: "a1", pitches: 3 },
    ]);
  });

  it("builds change baselines only through the cutoff, releasing DB before computation", async () => {
    const base = pitchAnalysisFixture(2024);
    const final = parseStagingGameDocumentV2({
      ...base,
      metadata: { ...base.metadata, status: "final" },
      events: [
        ...base.events,
        {
          kind: "administrative",
          sequence: base.events.length,
          identity: {
            kind: "source",
            eventId: "end",
            endpoint: "fixture",
            blockIndex: 0,
            eventIndex: 99,
          },
          inning: 1,
          half: "top",
          relayText: "종료",
          payload: { code: "called_game" },
        },
      ],
    });
    await store.importRevision(final);
    const single = new Pool({ connectionString: dsn, max: 1, connectionTimeoutMillis: 2000 });
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-changes-cache-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const calibration = vi.fn(async (...args: Parameters<typeof calculatePitchCalibration>) => {
      await single.query("SELECT 1");
      return calculatePitchCalibration(...args);
    });
    const reference = vi.fn(async (...args: Parameters<typeof preparePitchAnalysisReference>) => {
      await single.query("SELECT 1");
      return preparePitchAnalysisReference(...args);
    });
    const repository = new PitcherChangesRepository(single, {
      calibrations: workspace.pitchCalibrations,
      references: workspace.pitchReferences,
      computation: {
        calibration,
        reference,
        sample: async (...args) => {
          await single.query("SELECT 1");
          return calculatePitchAnalysisSample(...args);
        },
      },
    });
    try {
      const query = { season: 2024, competition: "unknown" as const, dateTo: "2024-06-01" };
      const before = await repository.analyze(query, "hp1");
      expect(before.games).toHaveLength(1);
      expect(before.baselineLastDate).toBe("2024-06-01");
      expect(await repository.analyze(query, "hp1")).toEqual(before);
      expect(calibration).toHaveBeenCalledTimes(1);
      expect(reference).toHaveBeenCalledTimes(1);
      const later = parseStagingGameDocumentV2({
        ...final,
        metadata: { ...final.metadata, gameId: "future-change", gameDate: "2024-07-01" },
      });
      await store.importRevision(later);
      expect(await repository.analyze(query, "hp1")).toEqual(before);
    } finally {
      await workspace.close();
      await single.end();
    }
  });

  it("reads workload lookback and PA encounters from actual facts without future leakage", async () => {
    const base = pitchAnalysisFixture(2024);
    await store.importRevision(base);
    const prior = parseStagingGameDocumentV2({
      ...base,
      metadata: { ...base.metadata, gameId: "workload-prior", gameDate: "2024-05-31" },
    });
    await store.importRevision(prior);
    const query = {
      season: 2024,
      competition: "unknown" as const,
      dateFrom: "2024-06-01",
      dateTo: "2024-06-01",
    };
    const repository = new PitcherWorkloadRepository(pool),
      before = await repository.analyze(query, "hp1");
    expect(before.appearances).toHaveLength(1);
    expect(before.appearances[0]).toMatchObject({
      pitches: 4,
      previous3DaysPitches: 4,
      role: "starter",
      observedRestDays: 0,
    });
    expect(before.appearances[0]?.encounters).toHaveLength(1);
    expect(before.appearances[0]?.buckets.reduce((n, b) => n + b.pitches, 0)).toBe(4);
    await store.importRevision(
      parseStagingGameDocumentV2({
        ...base,
        metadata: { ...base.metadata, gameId: "workload-future", gameDate: "2024-06-02" },
      }),
    );
    expect(await repository.analyze(query, "hp1")).toEqual(before);
  });

  it("limits workload targets and comparisons while using cross-competition calendar history", async () => {
    const fixture = pitchAnalysisFixture(2024);
    const base = {
      ...fixture,
      trackingCandidates: fixture.trackingCandidates.map((row) => ({ ...row, stance: "R" })),
    };
    const entries = [
      { sourceGameId: "d8", gameDate: "2024-05-31", competition: "preseason" },
      { sourceGameId: "d7", gameDate: "2024-06-01", competition: "postseason" },
      { sourceGameId: "d3", gameDate: "2024-06-05", competition: "regular" },
      { sourceGameId: "d1", gameDate: "2024-06-07", competition: null },
      { sourceGameId: "target", gameDate: "2024-06-08", competition: "allstar" },
      { sourceGameId: "same-day", gameDate: "2024-06-08", competition: "postseason" },
      { sourceGameId: "future", gameDate: "2024-06-09", competition: "regular" },
    ] as const;
    for (const { sourceGameId, gameDate } of entries) {
      await store.importRevision(
        parseStagingGameDocumentV2({
          ...base,
          source: { ...base.source, sourceGameId },
          metadata: { ...base.metadata, gameId: sourceGameId, gameDate },
        }),
      );
    }
    await new GameCompetitionRepository(pool).adopt(
      competitionFixture(
        2024,
        entries.filter((row) => row.competition !== null),
      ),
    );
    const query = {
      season: 2024,
      competition: "allstar" as const,
      dateFrom: "2024-06-08",
      dateTo: "2024-06-08",
    };
    const workload = new PitcherWorkloadRepository(pool);
    const comparison = new WorkloadComparisonRepository(pool);
    const timeline = await workload.analyze(query, "hp1");
    expect(timeline.lookbackCompetition).toBe("all");
    expect(timeline.appearances).toMatchObject([
      {
        gameId: "target",
        pitches: 4,
        previousObservedDate: "2024-06-07",
        observedRestDays: 0,
        previous3DaysPitches: 8,
        previous7DaysPitches: 12,
        observedConsecutiveDays: 2,
        sameDayAppearances: 2,
        sameDayEarlierPitches: null,
        sameDayOrder: "unknown",
      },
    ]);
    const input = await comparison.read(query, "hp1");
    expect(input.history.map((row) => row.gameId)).toEqual([
      "d8",
      "d7",
      "d3",
      "d1",
      "same-day",
      "target",
    ]);
    expect(input.cells.map((cell) => cell.gameId)).toEqual(Array(4).fill("target"));
    const model = comparePitcherWorkload(
      input.query,
      input.scope,
      input.pitcherId,
      input.sourceHash,
      input.history,
      input.cells,
    );
    expect(model.lookbackCompetition).toBe("all");
    expect(model.actualPitches).toBe(4);
    expect(model.excludedConditionPitches).toBe(1);
    expect(model.dimensions.find((row) => row.dimension === "rest")?.excludedWorkloadPitches).toBe(
      3,
    );

    const draft = await store.loadCorrectionDraft("d3", 1);
    await store.importRevision({ ...draft, metadata: { ...draft.metadata, stadium: "잠실" } });
    const updated = await workload.analyze(query, "hp1");
    expect(updated.appearances).toEqual(timeline.appearances);
    expect(updated.sourceHash).not.toBe(timeline.sourceHash);
    expect((await comparison.read(query, "hp1")).sourceHash).not.toBe(input.sourceHash);
  });
  it("aggregates workload conditions from current pitch facts with missing tracking retained and snapshot lookback", async () => {
    const original = pitchAnalysisFixture(2024),
      source = parseStagingGameDocumentV2({
        ...original,
        trackingCandidates: original.trackingCandidates.map((c) => ({ ...c, stance: "R" })),
      });
    await store.importRevision(source);
    const query = { season: 2024, competition: "unknown" as const, dateTo: "2024-06-01" },
      repository = new WorkloadComparisonRepository(pool),
      before = await repository.read(query, "hp1");
    expect(before.cells.reduce((n, c) => n + c.pitches, 0)).toBe(4);
    expect(before.cells.reduce((n, c) => n + c.swings, 0)).toBe(3);
    expect(before.cells.reduce((n, c) => n + c.speedSum, 0)).toBe(580);
    expect(before.cells.filter((c) => c.stance === null).reduce((n, c) => n + c.pitches, 0)).toBe(
      1,
    );
    expect(before.cells.every((c) => c.meeting === 1 && c.pitchBucket === 0)).toBe(true);
    expect(before.cells.every((c) => c.observedRole === "first_pitcher")).toBe(true);
    expect(before.cells.map((c) => [c.balls, c.strikes]).sort()).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 2],
    ]);
    await store.importRevision(
      parseStagingGameDocumentV2({
        ...source,
        metadata: { ...source.metadata, gameId: "comparison-future", gameDate: "2024-06-02" },
      }),
    );
    expect(await repository.read(query, "hp1")).toEqual(before);
    const draft = await store.loadCorrectionDraft(source.metadata.gameId, 1);
    await store.importRevision(
      parseStagingGameDocumentV2({
        ...draft,
        events: draft.events.map((e) =>
          e.kind === "pitch" ? { ...e, payload: { ...e.payload, speedKph: 140 } } : e,
        ),
      }),
    );
    const current = await repository.read(query, "hp1");
    expect(current.cells.every((c) => c.revision === 2)).toBe(true);
    expect(current.cells.reduce((n, c) => n + c.pitches, 0)).toBe(4);
    expect(current.cells.reduce((n, c) => n + c.speedSum, 0)).toBe(560);
    expect(current.sourceHash).not.toBe(before.sourceHash);
    expect((await repository.read({ season: 2024, competition: "regular" }, "hp1")).cells).toEqual(
      [],
    );
  });
  it("counts pitch buckets before tracking eligibility and separates later observed pitchers from official roles", async () => {
    const source = parseStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "automatic_ball" } },
        ...Array.from({ length: 26 }, (_, i) => ({
          kind: "pitch",
          payload: {
            call: i < 2 || i === 25 ? "swinging_strike" : "foul",
            ...(i === 25 ? {} : { pitchType: "fast", speedKph: 140 }),
          },
        })),
        {
          kind: "plate_result",
          payload: { result: "strikeout", batterId: "a1", pitcherId: "hp1" },
        },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "pitch", payload: { call: "in_play", pitchType: "fast", speedKph: 140 } },
        {
          kind: "plate_result",
          payload: { result: "field_out", batterId: "a1", pitcherId: "hp1" },
        },
        {
          kind: "substitution",
          payload: {
            side: "home",
            role: "pitcher",
            outgoingPlayerId: "hp1",
            incomingPlayerId: "hp2",
          },
        },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp2" } },
        { kind: "pitch", payload: { call: "ball", pitchType: "fast", speedKph: 140 } },
      ]),
    );
    await store.importRevision(source);
    const repository = new WorkloadComparisonRepository(pool),
      query = { season: 2026, competition: "unknown" as const };
    const first = await repository.read(query, "hp1"),
      later = await repository.read(query, "hp2");
    expect(first.cells.filter((c) => c.pitchBucket === 0).reduce((n, c) => n + c.pitches, 0)).toBe(
      25,
    );
    expect(first.cells.filter((c) => c.pitchBucket === 1).reduce((n, c) => n + c.pitches, 0)).toBe(
      2,
    );
    expect(first.cells.every((c) => c.stance === null)).toBe(true);
    expect(first.cells.some((c) => c.meeting === 2)).toBe(true);
    const appearance = (await new PitcherWorkloadRepository(pool).analyze(query, "hp1"))
      .appearances[0];
    expect(
      appearance?.encounters.map(({ batterId, meetingNumber, pitches }) => [
        batterId,
        meetingNumber,
        pitches,
      ]),
    ).toEqual([
      ["a1", 1, 26],
      ["a1", 2, 1],
    ]);
    expect(
      appearance?.buckets.map(
        ({ bucket, pitchType, stance, pitches, speedCount, meanSpeedKph }) => [
          bucket,
          pitchType,
          stance,
          pitches,
          speedCount,
          meanSpeedKph,
        ],
      ),
    ).toEqual([
      ["1–25", "fast", null, 25, 25, 140],
      ["26–50", "fast", null, 1, 1, 140],
      ["26–50", null, null, 1, 0, null],
    ]);
    expect(later.cells).toHaveLength(1);
    expect(later.cells[0]).toMatchObject({
      pitchBucket: 0,
      meeting: 1,
      observedRole: "later_pitcher",
      pitches: 1,
    });
  });
  it("reads baserunner totals without joins multiplying them and retains atomic single opportunities", async () => {
    const document = parseStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "plate_result", payload: { result: "single", batterId: "a1", pitcherId: "hp1" } },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "single",
            batterId: "a2",
            pitcherId: "hp1",
            movements: [safe("a2", 0, 1, 0), safe("a1", 1, 2, 1), safe("a1", 2, 3, 2)],
          },
        },
      ]),
    );
    await store.importRevision(document);
    const repository = new BaserunningAnalysisRepository(pool),
      query = { season: 2026, competition: "unknown" as const };
    const before = await repository.read(query, "a1");
    expect(before.opportunitySummary).toMatchObject({ candidates: 1, eligible: 1, extraBase: 1 });
    expect(before.players.filter((r) => r.playerId === "a1")).toHaveLength(1);
    expect(before.teams[0]?.games).toBe(1);
    const draft = await store.loadCorrectionDraft(document.metadata.gameId, 1);
    await store.importRevision(
      parseStagingGameDocumentV2({ ...draft, metadata: { ...draft.metadata, stadium: "잠실" } }),
    );
    const next = await repository.read(query, "a1");
    expect(next.opportunitySummary).toEqual(before.opportunitySummary);
    expect(next.opportunities[0]?.revision).toBe(2);
  });

  it("reads direct PA and league matchup conditions in one snapshot without inferred handedness", async () => {
    await store.importRevision(pitchAnalysisFixture(2024));
    const repository = new MatchupRepository(pool);
    const query = {
      season: 2024,
      competition: "unknown",
      pitcherId: "hp1",
      batterId: "a1",
    } as const;
    const result = await repository.analyze(query);
    expect(result.direct.pitches).toBe(4);
    expect(result.directPlateAppearances).toHaveLength(1);
    expect(result.similar.pitches).toBe(0);
    expect(result.excludedSimilar).toBe(4);
    expect(result.conditions).toEqual([]);
    expect(result.predictionStatus).toBe("not_validated");
    const direct = await repository.direct(query);
    expect(direct.direct).toEqual(result.direct);
    expect(direct.directPlateAppearances).toEqual(result.directPlateAppearances);
    expect(direct.batting).toEqual({
      plateAppearances: 1,
      atBats: 1,
      hits: 0,
      homeRuns: 0,
      walks: 0,
      strikeouts: 1,
      avg: 0,
      ops: 0,
    });
    expect(await repository.direct({ ...query, pitcherId: "other" })).toMatchObject({
      batting: { plateAppearances: 0, avg: null },
      direct: { pitches: 0 },
      directPlateAppearances: [],
    });
  });

  it("lists direct matchup candidates by official PA or actual pitches with season team metadata", async () => {
    await store.importRevision(pitchAnalysisFixture(2024));
    const walk = parseStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "intentional_walk", batterId: "a2", pitcherId: "hp1" },
        },
      ]),
    );
    await store.importRevision(
      parseStagingGameDocumentV2({
        ...walk,
        metadata: {
          ...walk.metadata,
          gameId: "matchup-no-pitch",
          season: 2024,
          gameDate: "2024-06-02",
        },
      }),
    );
    const repository = new MatchupRepository(pool);
    const scope = { season: 2024, competition: "unknown" } as const;
    const pitcher = await repository.opponents({ ...scope, role: "pitcher", playerId: "hp1" });
    expect(pitcher.players.slice(0, 2)).toEqual([
      { id: "a1", name: "a1", teams: ["원정"], pitches: 4, plateAppearances: 1 },
      { id: "a2", name: "a2", teams: ["원정"], pitches: 0, plateAppearances: 1 },
    ]);
    const batter = await repository.opponents({ ...scope, role: "batter", playerId: "a1" });
    expect(batter.players[0]).toEqual({
      id: "hp1",
      name: "hp1",
      teams: ["홈"],
      pitches: 4,
      plateAppearances: 1,
    });
    const onFirstDay = await repository.opponents({
      ...scope,
      role: "pitcher",
      playerId: "hp1",
      dateTo: "2024-06-01",
    });
    expect(onFirstDay.players.find(({ id }) => id === "a2")).toEqual({
      id: "a2",
      name: "a2",
      teams: ["원정"],
      pitches: 0,
      plateAppearances: 0,
    });
  });

  it("uses the same tracked-first batting side for matchup batter, pitcher, and league samples", async () => {
    const profiles = new PlayerBattingProfileRepository(pool);
    const games = [
      { id: "matchup-target-tracked", pitcherId: "hp1", batterId: "a1", tracked: true },
      { id: "matchup-target-profile", pitcherId: "hp1", batterId: "a1", tracked: false },
      { id: "matchup-target-unknown", pitcherId: "hp1", batterId: "a1", tracked: false },
      { id: "matchup-league-tracked", pitcherId: "hp2", batterId: "other", tracked: true },
      { id: "matchup-league-profile", pitcherId: "hp2", batterId: "other", tracked: false },
    ];
    for (const { id, pitcherId, batterId, tracked } of games) {
      const base = pitchAnalysisFixture(2024, pitcherId);
      const document = parseStagingGameDocumentV2({
        ...base,
        metadata: { ...base.metadata, gameId: id },
        rosters: {
          ...base.rosters,
          away: {
            ...base.rosters.away,
            players: base.rosters.away.players.map((player) =>
              player.playerId === "a1" ? { ...player, playerId: batterId } : player,
            ),
          },
        },
        events: base.events.map((event) =>
          event.kind === "batter_start" || event.kind === "plate_result"
            ? { ...event, payload: { ...event.payload, batterId } }
            : event,
        ),
        trackingCandidates: tracked
          ? base.trackingCandidates.slice(0, 1).map((row) => ({ ...row, stance: "R" }))
          : [],
      });
      await store.importRevision(document);
      if (id === "matchup-target-unknown") continue;
      await profiles.importDataset({
        gameId: id,
        season: document.metadata.season,
        sourceBundleHash: document.source.sourceBundleHash,
        observations: [
          {
            playerId: batterId,
            battingSide: "L",
            rawValue: "좌타",
            endpoint: "lineup",
            sourcePath: "fullLineUp[0].batsThrows",
          },
        ],
      });
    }
    const result = await new MatchupRepository(pool).analyze({
      season: 2024,
      competition: "unknown",
      pitcherId: "hp1",
      batterId: "a1",
    });
    const firstPitch = { pitchType: "직구", balls: 0, strikes: 0, speedBand: 29 };
    expect(
      result.conditions.filter(
        (row) => row.balls === firstPitch.balls && row.strikes === firstPitch.strikes,
      ),
    ).toMatchObject([
      { ...firstPitch, stance: "L", batterPitches: 1, targetPitcherPitches: 1, leaguePitches: 1 },
      { ...firstPitch, stance: "R", batterPitches: 1, targetPitcherPitches: 1, leaguePitches: 1 },
    ]);
    expect(result.direct.rows.filter((row) => row.balls === 0 && row.strikes === 0)).toMatchObject([
      { gameId: "matchup-target-profile", stance: "L" },
      { gameId: "matchup-target-tracked", stance: "R" },
      { gameId: "matchup-target-unknown", stance: null },
    ]);
  });

  it("shares sealed replay plays across models while rechecking current competition", async () => {
    const competition = new GameCompetitionRepository(pool);
    for (const year of [2024, 2025]) {
      const game = regulationGame(year);
      await store.importRevision(game);
      await competition.adopt(
        competitionFixture(year, [
          {
            sourceGameId: game.source.sourceGameId,
            gameDate: game.metadata.gameDate,
            competition: "regular",
          },
        ]),
      );
    }
    const game = regulationGame(2025);
    const cache = new BoundedReadCache<readonly AnalysisPlay[]>(1024 * 1024, 4, 60_000);
    const load = vi.spyOn(cache, "load");
    const repository = new RunValueRepository(pool, cache);
    const { observations, manifest } = await repository.training(2024);
    const model = trainRunExpectancy(observations, runTrainingHash(manifest));

    expect(await repository.game(game.metadata.gameId, 1, model, "a".repeat(64), 2024)).toBeNull();
    const [run, count, win] = await Promise.all([
      repository.game(game.metadata.gameId, 1, model, "a".repeat(64), 2025),
      repository.countGame(game.metadata.gameId, 1, null, null, 2025),
      repository.winGame(game.metadata.gameId, 1, null, null, 2025),
    ]);
    expect(run?.status).toBe("ready");
    expect(count?.documentHash).toBe(run?.documentHash);
    expect(win?.documentHash).toBe(run?.documentHash);
    expect(load).toHaveBeenCalledTimes(1);

    await competition.adopt(
      competitionFixture(2025, [
        {
          sourceGameId: game.source.sourceGameId,
          gameDate: game.metadata.gameDate,
          competition: "allstar",
        },
      ]),
    );
    expect((await repository.game(game.metadata.gameId, 1, model, "a".repeat(64)))?.status).toBe(
      "model_unavailable",
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("trains RE24 on completed regular halves and preserves exact revision reads with stale-model detection", async () => {
    for (const year of [2024, 2025]) {
      const game = regulationGame(year);
      await store.importRevision(game);
      await new GameCompetitionRepository(pool).adopt(
        competitionFixture(year, [
          {
            sourceGameId: game.source.sourceGameId,
            gameDate: game.metadata.gameDate,
            competition: "regular",
          },
        ]),
      );
    }
    const repo = new RunValueRepository(pool),
      training = await repo.training(2024),
      model = trainRunExpectancy(training.observations, runTrainingHash(training.manifest));
    expect(training.observations.filter((r) => r.season === 2024)).toHaveLength(49);
    const result = await repo.game("regulation-2025", 1, model, "a".repeat(64));
    expect(result?.status).toBe("ready");
    expect(result?.halves).toHaveLength(18);
    expect(result?.halves.every((h) => h.conserved === true)).toBe(true);
    const countModel = trainCountRunExpectancy(
      training.countObservations,
      training.observations,
      runTrainingHash(training.manifest),
    );
    expect(training.countObservations.filter((r) => r.season === 2024)).toHaveLength(49);
    const countResult = await repo.countGame("regulation-2025", 1, countModel, "a".repeat(64));
    expect(countResult?.transitions.filter((t) => t.terminalLinked)).toHaveLength(55);
    expect(countResult?.halves.every((h) => h.conserved === true)).toBe(true);
    const winModel = trainWinProbability(
      training.winObservations,
      runTrainingHash(training.manifest),
    );
    expect(training.winObservations.every((r) => r.limit === 11 && r.inning <= 11)).toBe(true);
    const win = await repo.winGame("regulation-2025", 1, winModel, "a".repeat(64));
    expect(win?.terminalValue).toBe(0);
    expect(win?.model?.evaluation?.unsupported).toBeGreaterThan(0);
    expect(await repo.game("regulation-2025", 1, model, "a".repeat(64), 2023)).toBeNull();
    const qualityRepository = new PitchQualityRepository(pool),
      qualityTraining = await qualityRepository.training(2024);
    expect(qualityTraining.rows.filter((r) => r.season === 2025)).toHaveLength(55);
    const qualityModel = trainPitchQualityFromFacts(
      qualityTraining.rows,
      pitchQualitySourceHash(qualityTraining.manifest),
      2024,
    );
    const pitcherId = qualityTraining.rows.find((r) => r.season === 2025)?.pitcherId;
    if (pitcherId === undefined) throw new Error("Missing quality pitcher");
    const quality = await qualityRepository.read(
      { season: 2025 },
      pitcherId,
      qualityModel,
      "q".repeat(64),
    );
    expect(quality.model?.sourceHash).toBe(qualityModel.sourceHash);
    expect(quality.rows).toEqual(
      qualityTraining.rows.filter((row) => row.season === 2025 && row.pitcherId === pitcherId),
    );
    const matchupInput = await new MatchupModelRepository(pool).read(
      { season: 2025, pitcherId, batterId: "h1" },
      null,
      null,
    );
    expect(matchupInput.pitcherRows).toEqual(quality.rows);
    expect(matchupInput.batterRows).toEqual(
      qualityTraining.rows.filter((row) => row.season === 2025 && row.batterId === "h1"),
    );
    expect(
      (await qualityRepository.read({ season: 2025 }, "no-observed-pitches", null, null)).rows,
    ).toEqual([]);
    expect(quality.rows.length).toBeGreaterThan(0);
    expect(quality.rows.every((r) => r.pitcherId === pitcherId && r.revision === 1)).toBe(true);
    const pitchIds = quality.rows.map(({ pitchId }) => pitchId);
    expect(pitchIds).toEqual([...pitchIds].sort());
    expect(quality.rows).toEqual(
      qualityTraining.rows.filter((r) => r.season === 2025 && r.pitcherId === pitcherId),
    );
    const matchupModel = trainMatchupModel(
        qualityTraining.rows,
        qualityModel,
        "b".repeat(64),
        qualityModel.sourceHash,
      ),
      batterId = qualityTraining.rows.find((r) => r.season === 2025)?.batterId;
    if (batterId === undefined) throw new Error("Missing matchup batter");
    const matchupQuery = { season: 2025, pitcherId, batterId },
      matchupRepository = new MatchupModelRepository(pool),
      modeled = await matchupRepository.read(matchupQuery, matchupModel, "b".repeat(64));
    expect(modeled.model).toEqual(matchupModel);
    const parsedQuery = { ...matchupQuery };
    Object.setPrototypeOf(parsedQuery, {});
    expect(await matchupRepository.read(parsedQuery, matchupModel, "b".repeat(64))).toEqual(
      modeled,
    );
    expect(modeled.pitcherRows).toEqual(quality.rows);
    expect(modeled.batterRows).toEqual(
      qualityTraining.rows.filter((r) => r.season === 2025 && r.batterId === batterId),
    );
    const angleInput = await new PitchAnglesRepository(pool).read({ season: 2025 }, pitcherId);
    expect(angleInput.rows.length).toBe(quality.rows.length);
    expect(angleInput.rows.every((r) => r.revision === 1 && r.pitcherId === pitcherId)).toBe(true);
    expect(
      (
        await qualityRepository.read(
          { season: 2025, dateFrom: "2025-01-01", dateTo: "2025-01-31" },
          pitcherId,
          null,
          null,
        )
      ).rows,
    ).toEqual([]);
    const environment = await new ParkEnvironmentRepository(pool).read({ season: 2025 });
    expect(environment.games).toBe(1);
    expect(environment.parks[0]?.total).toMatchObject({
      games: 1,
      pa: 55,
      homeRuns: 1,
      runs: 1,
      completeHalves: 16,
      completeRuns: 1,
      excludedHalves: 2,
    });
    expect(environment.parks[0]?.home.homeRuns).toBe(0);
    expect(environment.parks[0]?.away.homeRuns).toBe(1);
    const regular = regulationGame(2025);
    const specials = [
      { sourceGameId: "league-allstar", gameDate: "2025-07-05", competition: "allstar" },
      {
        sourceGameId: "league-tiebreak",
        gameDate: regular.metadata.gameDate,
        competition: "postseason",
      },
    ] as const;
    for (const { sourceGameId, gameDate } of specials) {
      await store.importRevision(
        parseStagingGameDocumentV2({
          ...regular,
          source: { ...regular.source, sourceGameId },
          metadata: { ...regular.metadata, gameId: sourceGameId, gameDate },
        }),
      );
    }
    const sources = new AnalysisModelSourceRepository(pool);
    const before = await sources.read(2024);
    const competition = new GameCompetitionRepository(pool);
    const { datasetHash } = await competition.adopt(
      competitionFixture(2025, [
        {
          sourceGameId: regular.source.sourceGameId,
          gameDate: regular.metadata.gameDate,
          competition: "regular",
        },
        ...specials,
      ]),
    );
    expect(await sources.read(2024)).toEqual(before);
    expect(await repo.training(2024)).toEqual(training);
    expect(await repo.game("regulation-2025", 1, model, "a".repeat(64))).toEqual(result);
    expect(
      (await qualityRepository.read({ season: 2025 }, pitcherId, qualityModel, "q".repeat(64)))
        .model?.sourceHash,
    ).toBe(qualityModel.sourceHash);
    expect(
      (
        await pool.query(
          "SELECT game_id,competition,competition_dataset_hash FROM analytics.current_analysis_games WHERE season=2025 ORDER BY game_id",
        )
      ).rows,
    ).toEqual([
      { game_id: "league-allstar", competition: "allstar", competition_dataset_hash: datasetHash },
      {
        game_id: "league-tiebreak",
        competition: "postseason",
        competition_dataset_hash: datasetHash,
      },
      { game_id: "regulation-2025", competition: "regular", competition_dataset_hash: datasetHash },
    ]);
    const draft = await store.loadCorrectionDraft("regulation-2025", 1);
    await store.importRevision(
      parseStagingGameDocumentV2({ ...draft, metadata: { ...draft.metadata, stadium: "잠실" } }),
    );
    const revised = await matchupRepository.read(matchupQuery, matchupModel, "b".repeat(64));
    expect(revised.model).toBeNull();
    expect(revised.sourceHash).not.toBe(modeled.sourceHash);
    expect(revised.pitcherRows.every((r) => r.revision === 2)).toBe(true);
    const changedAngles = await new PitchAnglesRepository(pool).read({ season: 2025 }, pitcherId);
    expect(changedAngles.sourceHash).not.toBe(angleInput.sourceHash);
    expect(changedAngles.rows.every((r) => r.revision === 2)).toBe(true);
    expect(
      (await qualityRepository.read({ season: 2025 }, pitcherId, qualityModel, "q".repeat(64)))
        .model,
    ).toBeNull();
    const old = await repo.game("regulation-2025", 1, model, "a".repeat(64));
    expect(old?.revision).toBe(1);
    expect(old?.status).toBe("model_unavailable");
    expect(old?.documentHash).toBe(result?.documentHash);
    expect(await repo.game("unknown", 1, null, null)).toBeNull();
  });

  it("coverage reuses persisted season summaries across periods/restarts and invalidates exact inputs", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-coverage-db-"));
    const workspace = await StagingWorkspace.open(temp.path);
    const source = pitchAnalysisFixture(2024);
    const calibrate = vi.fn(async (...args: Parameters<typeof calculatePitchCalibration>) =>
      calculatePitchCalibration(...args),
    );
    const makeRepository = () =>
      new AnalysisCoverageRepository(
        pool,
        workspace.pitchCalibrations,
        calibrate,
        new BoundedReadCache(1024 * 1024, 8, 300000),
        workspace.analysisCoverage,
      );
    try {
      await store.importRevision(source);
      const initial = makeRepository();
      const missing = await initial.inspect(2024, { competition: "unknown" });
      expect(missing.response).toBeNull();
      const first = await initial.read(2024, { competition: "unknown" });
      const restarted = makeRepository();
      expect((await restarted.inspect(2024, { competition: "unknown" })).response).toEqual(first);
      expect(
        (
          await restarted.inspect(2024, {
            competition: "unknown",
            dateFrom: source.metadata.gameDate,
            dateTo: source.metadata.gameDate,
          })
        ).response?.total,
      ).toEqual(first.total);
      expect(
        (await restarted.inspect(2024, { competition: "unknown", dateFrom: "2024-12-31" })).response
          ?.total.games,
      ).toBe(0);
      expect(calibrate).toHaveBeenCalledTimes(1);
      // Unrelated season imports do not invalidate the prepared year.
      await store.importRevision(pitchAnalysisFixture(2023));
      expect((await restarted.inspect(2024, { competition: "unknown" })).sourceKey).toBe(
        missing.sourceKey,
      );
      await seedBatterHeights(pool, source, 185);
      const heights = await restarted.inspect(2024, { competition: "unknown" });
      expect(heights.response).toBeNull();
      expect(heights.sourceKey).not.toBe(missing.sourceKey);
      const withHeight = await restarted.read(2024, { competition: "unknown" });
      expect(withHeight.total.zoneKnown).toBeGreaterThan(0);
      expect(calibrate).toHaveBeenCalledTimes(1); // Same trajectory source: calibration file reused.
      await new GameCompetitionRepository(pool).adopt(
        competitionFixture(2024, [
          {
            sourceGameId: source.source.sourceGameId,
            gameDate: source.metadata.gameDate,
            competition: "regular",
          },
        ]),
      );
      const classified = await restarted.inspect(2024);
      expect(classified.sourceKey).not.toBe(heights.sourceKey);
      expect(classified.response).toBeNull();
      await restarted.read(2024);
      const draft = await store.loadCorrectionDraft(source.metadata.gameId, 1);
      await store.importRevision(
        parseStagingGameDocumentV2({ ...draft, metadata: { ...draft.metadata, stadium: "잠실" } }),
      );
      const revised = await restarted.inspect(2024);
      expect(revised.sourceKey).not.toBe(classified.sourceKey);
      expect(revised.response).toBeNull();
      expect((await restarted.read(2024)).stadiums.map((s) => s.stadium)).toEqual(["잠실"]);
    } finally {
      await workspace.close();
    }
  });

  it("coverage preserves pitch/PA grain and reads only the current sealed revision", async () => {
    const source = pitchAnalysisFixture(2024);
    await store.importRevision(source);
    const calibrate = vi.fn(async (...args: Parameters<typeof calculatePitchCalibration>) =>
      calculatePitchCalibration(...args),
    );
    const repository = new AnalysisCoverageRepository(
      pool,
      undefined,
      calibrate,
      new BoundedReadCache(1024 * 1024, 8, 300000),
    );
    const before = await repository.read(2024, { competition: "unknown" });
    expect(before.total).toMatchObject({
      games: 1,
      actualPitches: 4,
      completedPlateAppearances: 1,
      linkedTracking: 3,
      missingTracking: 1,
      invalidTrajectory: 1,
      validTrajectory: 2,
      zoneKnown: 0,
    });
    expect(await repository.read(2024, { competition: "unknown" })).toEqual(before);
    expect(calibrate).toHaveBeenCalledTimes(1);
    before.total.games = 500;
    expect((await repository.read(2024, { competition: "unknown" })).total.games).toBe(1);
    await seedBatterHeights(pool, source, 185);
    const withHeight = await repository.read(2024, { competition: "unknown" });
    expect(withHeight.total.zoneKnown).toBeGreaterThan(0);
    expect(withHeight.sourceHash).not.toBe(before.sourceHash);
    expect(calibrate).toHaveBeenCalledTimes(2);
    const draft = await store.loadCorrectionDraft(source.metadata.gameId, 1);
    await store.importRevision(
      parseStagingGameDocumentV2({ ...draft, metadata: { ...draft.metadata, stadium: "잠실" } }),
    );
    const after = await repository.read(2024, { competition: "unknown" });
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect(after.total).toMatchObject({
      games: 1,
      actualPitches: 4,
      completedPlateAppearances: 1,
      validTrajectory: 2,
      insufficientCalibration: 2,
      unsupportedPark: 0,
    });
    expect(after.stadiums.map((row) => row.stadium)).toEqual(["잠실"]);
    expect(calibrate).toHaveBeenCalledTimes(3);
    const empty = await repository.read(2023);
    expect(empty.total.actualPitches).toBe(0);
    expect(empty.firstGameDate).toBeNull();
  });

  it("포스 병살에서 승계한 책임 투수와 후속 득점은 DB 적재·재생·재열기에도 유지된다", async () => {
    const document = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile(
          "tests/fixtures/correction/force-double-play-responsibility.anonymized.json",
          "utf8",
        ),
      ) as unknown,
    );
    const imported = await store.importRevision(document);
    const loaded = await store.loadCompiled(document.metadata.gameId, imported.revision);
    expect(loaded.replay.pitcherLines.find((line) => line.playerId === "a1")?.runs).toBe(3);
    expect(loaded.replay.pitcherLines.find((line) => line.playerId === "a51")?.runs).toBe(1);
    expect(
      loaded.replay.plays
        .flatMap((play) => play.movements)
        .find((movement) => movement.runnerId === "h3" && movement.outcome === "scored")
        ?.responsiblePitcherId,
    ).toBe("a1");
    const draft = await store.loadCorrectionDraft(document.metadata.gameId, imported.revision);
    expect(draft.events).toEqual(document.events);
    expect(compileStagingGameDocumentV2(draft).pitcherLines).toEqual(loaded.replay.pitcherLines);
  });

  it("보정된 관측값과 문구는 기존 typed DB 컬럼에 봉인되고 재열기에도 유지된다", async () => {
    const source = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile("tests/fixtures/correction/in-play-observation.anonymized.json", "utf8"),
      ) as unknown,
    );
    const pitch = source.events[3];
    if (pitch === undefined) throw new Error("missing anonymous pitch");
    const corrected = applyCorrectionCommand(source, {
      commandId: "correct-observation-and-text",
      kind: "correction_batch",
      commands: [
        {
          commandId: "correct-observation",
          kind: "update_observed_state",
          eventId: "e3",
          observedStateAfter: { ...pitch.observedStateAfter, balls: 0 },
        },
        {
          commandId: "correct-text",
          kind: "replace_event",
          eventId: "e3",
          event: { ...pitch, relayText: "2구 타격 · 수동 확인 문구" },
        },
      ],
    }).document;
    const imported = await store.importRevision(corrected);
    const draft = await store.loadCorrectionDraft(corrected.metadata.gameId, imported.revision);
    expect(draft.events).toEqual(corrected.events);
    expect(draft.events[3]?.relayText).toBe("2구 타격 · 수동 확인 문구");
    const loaded = await store.loadCompiled(corrected.metadata.gameId, imported.revision);
    expect(loaded.replay.plays.flatMap((play) => play.relayTexts)).toContain(
      "2구 타격 · 수동 확인 문구",
    );
    expect(compileStagingGameDocumentV2(draft).pitcherLines).toEqual(
      compileStagingGameDocumentV2(source).pitcherLines,
    );
    const cleared = applyCorrectionCommand(draft, {
      commandId: "clear-observation",
      kind: "update_observed_state",
      eventId: "e3",
      observedStateAfter: {},
    }).document;
    const next = await store.importRevision(cleared);
    expect(
      (await store.loadCorrectionDraft(cleared.metadata.gameId, next.revision)).events,
    ).toEqual(cleared.events);
    expect(source.events[3]?.observedStateAfter?.balls).toBe(1);
  });

  it("worker 재compile 실패는 import 전체를 rollback하고 같은 compiler로 재시도한다", async () => {
    const workers = new ComputationPool(1);
    let calls = 0;
    const document = pitchAnalysisFixture(2024);
    try {
      const failing = new GameRevisionStore(pool, EXPECTED_MIGRATION_VERSION, async (input) => {
        calls += 1;
        if (calls === 2) throw new Error("worker unavailable during verification");
        return compileDocument(workers, input);
      });
      await expect(failing.importRevision(document)).rejects.toThrow("worker unavailable");
      expect(calls).toBe(2);
      expect(
        (
          await pool.query("SELECT game_id FROM workbench.games WHERE game_id=$1", [
            document.metadata.gameId,
          ])
        ).rowCount,
      ).toBe(0);
      const workerStore = new GameRevisionStore(
        pool,
        EXPECTED_MIGRATION_VERSION,
        (input) => compileDocument(workers, input),
        createRevisionProjectionComputation(workers),
      );
      const imported = await workerStore.importRevision(document);
      expect(imported.documentHash).toBe(stagingDocumentHash(document));
      expect(await workerStore.storedGameIds()).toEqual([document.metadata.gameId]);
      expect(await workerStore.catalog([document.metadata.gameId])).toEqual(
        await workerStore.catalog(),
      );
      expect(await workerStore.catalog(["unknown"])).toEqual([]);
      expect(await workerStore.catalog([])).toEqual([]);
      expect((await workerStore.revisions(document.metadata.gameId)).revisions[0]?.sealed).toBe(
        true,
      );
    } finally {
      await workers.close();
    }
  });

  it("투구 표본 계산은 같은 DB snapshot에서 공유하고 새 revision과 시즌을 구분한다", async () => {
    await store.importRevision(pitchAnalysisFixture(2024));
    const cache = new BoundedReadCache<PitchAnalysisSample>(1024 * 1024, 4, 60_000);
    const computation = {
      calibration: vi.fn(async (...args: Parameters<typeof calculatePitchCalibration>) =>
        calculatePitchCalibration(...args),
      ),
      reference: vi.fn(async (...args: Parameters<typeof preparePitchAnalysisReference>) =>
        preparePitchAnalysisReference(...args),
      ),
      sample: vi.fn(async (...args: Parameters<typeof calculatePitchAnalysisSample>) =>
        calculatePitchAnalysisSample(...args),
      ),
    };
    const repository = new PitchAnalysisRepository(pool, undefined, computation, cache);
    const first = await Promise.all(
      Array.from({ length: 3 }, () => repository.analyze(2024, "hp1", { competition: "unknown" })),
    );
    expect(computation.sample).toHaveBeenCalledTimes(1);
    expect(computation.reference).toHaveBeenCalledTimes(1);
    const expected = await new PitchAnalysisRepository(pool).analyze(2024, "hp1", {
      competition: "unknown",
    });
    expect(first[0]).toEqual(expected);
    first[0]?.points.splice(0);
    expect(await repository.analyze(2024, "hp1", { competition: "unknown" })).toEqual(expected);
    expect(computation.sample).toHaveBeenCalledTimes(1);
    await store.importRevision(pitchAnalysisFixture(2025));
    expect(await repository.analyze(2024, "hp1", { competition: "unknown" })).toEqual(expected);
    expect(computation.sample).toHaveBeenCalledTimes(1);
    const draft = await store.loadCorrectionDraft("analysis-2024-hp1", 1);
    await store.importRevision(draft);
    const updated = await repository.analyze(2024, "hp1", { competition: "unknown" });
    expect(updated.sourceHash).not.toBe(expected.sourceHash);
    expect(updated.points).toHaveLength(0);
    expect(updated.missingReleaseCount).toBe(2);
    expect(computation.sample).toHaveBeenCalledTimes(2);
    expect(updated).toEqual(
      await new PitchAnalysisRepository(pool).analyze(2024, "hp1", { competition: "unknown" }),
    );
  });

  it("DB 목록은 SQL에서 페이지·시즌·문자열을 제한하고 전체 시즌을 반환한다", async () => {
    await store.importRevision(pitchAnalysisFixture(2024));
    await store.importRevision(pitchAnalysisFixture(2025));
    const first = await store.catalogPage({ authority: "database", page: 1, limit: 1 });
    const second = await store.catalogPage({ authority: "database", page: 2, limit: 1 });
    expect(first).toMatchObject({ total: 2, seasons: [2025, 2024], page: 1, limit: 1 });
    expect(first.games[0]?.season).toBe(2025);
    expect(second.games[0]?.season).toBe(2024);
    expect((await store.catalogPage({ authority: "database", season: 2024 })).total).toBe(1);
    expect(
      (await store.catalogPage({ authority: "database", search: "%' OR TRUE --" })).total,
    ).toBe(0);
    const game = first.games[0];
    if (game === undefined) throw new Error("missing catalog fixture");
    expect(
      (await store.catalogPage({ authority: "database", search: game.gameId.toUpperCase() })).total,
    ).toBe(1);
    expect(await store.catalogPage({ authority: "database", page: 3, limit: 1 })).toMatchObject({
      games: [],
      total: 2,
    });
  });

  it("preserves the DB page and inventory tie orders with the same current revision metadata", async () => {
    const first = pitchAnalysisFixture(2024);
    const second = pitchAnalysisFixture(2024, "hp2");
    await store.importRevision(second);
    await store.importRevision(first);
    const draft = await store.loadCorrectionDraft(first.metadata.gameId, 1);
    await store.importRevision(
      parseStagingGameDocumentV2({ ...draft, metadata: { ...draft.metadata, stadium: "잠실" } }),
    );
    const ids = [first.metadata.gameId, second.metadata.gameId];
    const page = await store.catalogPage({ authority: "database", season: 2024 });
    const inventory = await store.catalog(ids);
    expect(
      page.games.map(({ gameId, currentRevision, revisionCount }) => [
        gameId,
        currentRevision,
        revisionCount,
      ]),
    ).toEqual([
      [ids[0], 2, 2],
      [ids[1], 1, 1],
    ]);
    expect(inventory.map(({ gameId }) => gameId)).toEqual([ids[1], ids[0]]);
    expect(page.games).toEqual([...inventory].reverse());
    expect(await store.catalog([])).toEqual([]);
    expect(await store.storedGameCounts([])).toEqual({ stored: 2, alreadyStored: 0 });
    const onlyFirst = first.metadata.gameId;
    expect(await store.storedGameCounts([onlyFirst, onlyFirst, "missing"])).toEqual({
      stored: 2,
      alreadyStored: 1,
    });
  });

  it("타자 선구안은 공통 표본 제외 대상을 실제 투구 합계에 보존하고 적격 분모에서 뺀다", async () => {
    const tracked = pitchAnalysisFixture(2024);
    const situations = disciplineEligibilityFixture();
    await store.importRevision(tracked);
    await store.importRevision(situations);
    await seedBatterHeights(pool, tracked);
    const repository = new BatterDisciplineRepository(pool, {
      getOrCreate: async (_key, calculate) => calculate(),
    });
    const snapshot = await repository.snapshot(2024, undefined, { competition: "unknown" });
    expect(
      snapshot.rows?.map(({ gameId, pitchId, eligible }) => [gameId, pitchId, eligible]),
    ).toEqual([
      ["analysis-2024-hp1", "e2", true],
      ["analysis-2024-hp1", "e3", true],
      ["analysis-2024-hp1", "e4", true],
      ["analysis-2024-hp1", "e5", true],
      ["discipline-eligibility", "e2", false],
      ["discipline-eligibility", "e3", true],
      ["discipline-eligibility", "e6", false],
      ["discipline-eligibility", "e7", false],
      ["discipline-eligibility", "e10", false],
      ["discipline-eligibility", "e13", false],
      ["discipline-eligibility", "e18", true],
    ]);

    const prepared = prepareDisciplineSeason(snapshot);
    const coverages = ["a1", "a2", "a3", "a4", "a5"].map((batterId) => {
      const { coverage } = analyzeBatterDiscipline(prepared, batterId, { season: 2024 });
      return [coverage.actualPitches, coverage.excludedSituations, coverage.locationPitches];
    });
    expect(coverages).toEqual([
      [6, 1, 2],
      [2, 2, 0],
      [1, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ]);
  });

  it("타자 선구안은 같은 snapshot의 typed 코스·판단을 읽고 기준 캐시와 current revision을 공유한다", async () => {
    await store.importRevision(pitchAnalysisFixture(2024));
    await store.importRevision(pitchAnalysisFixture(2025));
    await seedBatterHeights(pool, pitchAnalysisFixture(2024));
    const repository = new BatterDisciplineRepository(pool, {
      getOrCreate: async (_key, calculate) => calculate(),
    });
    const catalog = await repository.catalog(2024, { competition: "unknown" });
    expect(catalog.batters).toEqual([expect.objectContaining({ batterId: "a1", pitches: 4 })]);
    const snapshot = await repository.snapshot(2024, undefined, { competition: "unknown" });
    const shape = await new PitchAnalysisRepository(pool).analyze(2024, "hp1", {
      competition: "unknown",
    });
    expect(snapshot.sourceHash).not.toBe(shape.sourceHash);
    expect(snapshot.reference?.summary).toMatchObject({ candidateCount: 3, sampleCount: 1 });
    // The discipline baseline can use a sample below the release estimator's threshold.
    expect(snapshot.reference?.summary.arrivalMs).toBeCloseTo(358.4986883527349, 8);
    expect(shape.baseline).toBeNull();
    expect(snapshot.rows).toHaveLength(4);
    const result = analyzeBatterDiscipline(prepareDisciplineSeason(snapshot), "a1", {
      season: 2024,
    });
    expect(result.coverage).toMatchObject({
      actualPitches: 4,
      locationPitches: 2,
      comparisonPitches: 2,
      missingLocation: 2,
    });
    expect(result.points.every((p) => p.swing && p.whiff)).toBe(true);
    const courseSql = await pool.query(`
      SELECT count(*)::integer AS pitches,
        count(*) FILTER (WHERE NOT in_zone)::integer AS "outsidePitches",
        count(*) FILTER (WHERE NOT in_zone AND swing)::integer AS "outsideSwings",
        count(*) FILTER (WHERE NOT in_zone AND swing)::float8 /
          NULLIF(count(*) FILTER (WHERE NOT in_zone), 0) AS "chaseRate"
      FROM analytics.current_pitches
      WHERE actual AND season=2024 AND batter_id='a1' AND in_zone IS NOT NULL`);
    expect(result.courseComparison.conventional.batter).toMatchObject(courseSql.rows[0]);
    expect(result.courseComparison.common.batter.pitches).toBe(result.coverage.comparisonPitches);
    expect(
      result.courseComparison.paired.every(
        (g) => g.matchedPitches === 0 && g.courseLeagueSwingRate === null,
      ),
    ).toBe(true);
    expect(result.summary.reduce((n, g) => n + g.matchedPitches, 0)).toBe(0);
    expect(
      (await repository.snapshot(2024, snapshot.sourceHash, { competition: "unknown" })).rows,
    ).toBeNull();
    const first = { season: 2025, competition: "unknown" } as const;
    const second = { season: 2024, competition: "unknown" } as const;
    const firstSourceHash = await repository.readSourceHash(first);
    const acquired = vi.fn();
    pool.on("acquire", acquired);
    try {
      expect(await repository.readPeriodSourceHashes(first, second)).toEqual([
        firstSourceHash,
        snapshot.sourceHash,
      ]);
      expect(acquired).toHaveBeenCalledOnce();
    } finally {
      pool.off("acquire", acquired);
    }
    const early = { ...second, dateTo: "2024-05-31" };
    const late = { ...second, dateFrom: "2024-06-01" };
    expect(await repository.readPeriodSourceHashes(early, late)).toEqual([
      snapshot.sourceHash,
      snapshot.sourceHash,
    ]);
    const regular = { season: 2024, competition: "regular" } as const;
    const regularHash = await repository.readSourceHash(regular);
    expect(regularHash).not.toBe(snapshot.sourceHash);
    expect(await repository.readPeriodSourceHashes(regular, second)).toEqual([
      regularHash,
      snapshot.sourceHash,
    ]);
    const draft = await store.loadCorrectionDraft("analysis-2024-hp1", 1);
    await store.importRevision(draft);
    const updated = await repository.snapshot(2024, snapshot.sourceHash, {
      competition: "unknown",
    });
    expect(updated.sourceHash).not.toBe(snapshot.sourceHash);
    expect(await repository.readPeriodSourceHashes(first, second)).toEqual([
      firstSourceHash,
      updated.sourceHash,
    ]);
    expect(updated.rows).toHaveLength(4);
    expect(updated.rows?.every((p) => p.revision === 2)).toBe(true);
  });

  it("시즌 회귀 원장은 typed fact로 재생하고 새 revision 뒤에도 기존 봉인과 hash를 보존한다", async () => {
    for (const fixture of [
      "extra-inning-called-game",
      "fielder-choice-multistep",
      "terminal-bunt-count",
    ]) {
      const original = parseStagingGameDocumentV2(
        JSON.parse(
          await readFile(`tests/fixtures/correction/${fixture}.anonymized.json`, "utf8"),
        ) as unknown,
      );
      const document = parseStagingGameDocumentV2({
        ...original,
        metadata: { ...original.metadata, gameId: fixture },
      });
      const first = await store.importRevision(document);
      const before = await store.loadCompiled(first.gameId, 1);
      const manifest = await store.revisions(first.gameId);
      if (fixture === "extra-inning-called-game") {
        expect(before.replay.plateAppearances.at(-1)?.terminationReason).toBe("called_game");
        expect(before.replay.pitchFacts).toHaveLength(1);
      }
      if (fixture === "fielder-choice-multistep") {
        expect(before.replay.pitcherLines.find((line) => line.playerId === "hp1")?.runs).toBe(1);
        expect(before.replay.pitcherLines.find((line) => line.playerId === "hp2")?.runs).toBe(2);
      }
      const draft = await store.loadCorrectionDraft(first.gameId, 1);
      await expect(store.importRevision(draft, { failurePoint: "after_facts" })).rejects.toThrow(
        "injected",
      );
      expect(await store.revisions(first.gameId)).toEqual(manifest);
      const next = await store.importRevision(draft);
      expect(next.revision).toBe(2);
      const after = await store.loadCompiled(first.gameId, 1);
      expect(after.documentHash).toBe(before.documentHash);
      expect(after.projectionHash).toBe(before.projectionHash);
      expect(replaySemanticHash(after.replay)).toBe(replaySemanticHash(before.replay));
      expect(
        (await store.revisions(first.gameId)).revisions.every((revision) => revision.sealed),
      ).toBe(true);
    }
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

  it("기록정정 경기는 구장 표기·미제공과 무관하게 날짜·원정/홈 팀으로 찾고 DH 후보를 보존한다", async () => {
    const { document, notice } = await recordCorrectionVenueFixture();
    const repository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
    const first = await store.importRevision(document);
    expect(await repository.gameCandidates(notice)).toEqual([
      expect.objectContaining({ gameId: first.gameId, revision: 1, stadium: "대전(신)" }),
    ]);
    for (const mismatched of [
      { ...notice, gameDate: "2025-06-04" },
      { ...notice, gameDate: "2024-06-03" },
      { ...notice, awayTeamName: notice.homeTeamName, homeTeamName: notice.awayTeamName },
    ]) {
      expect(await repository.gameCandidates(mismatched)).toEqual([]);
    }
    const draft = await store.loadCorrectionDraft(first.gameId, 1);
    const metadata = { ...draft.metadata };
    delete metadata.stadium;
    await store.importRevision({ ...draft, metadata });
    expect(await repository.gameCandidates(notice)).toEqual([
      expect.objectContaining({ gameId: first.gameId, revision: 2, stadium: null }),
    ]);
    await store.importRevision({
      ...document,
      metadata: { ...document.metadata, gameId: "anon-game-dh2" },
      source: { ...document.source, sourceGameId: "anon_DH2" },
    });
    expect(await repository.gameCandidates(notice)).toHaveLength(2);
    expect((await store.revisions(first.gameId)).revisions).toHaveLength(2);
  });

  it.each(["first-game-first", "second-game-first"] as const)(
    "reconciles doubleheader imports and preserves valid decisions with %s follow-up",
    async (order) => {
      const { document, notice } = await recordCorrectionVenueFixture();
      const specified = {
        ...notice,
        noticeId: "2025:0:707",
        noticeHash: "b".repeat(64),
        recordNumber: 707,
        sourceRowIndex: notice.sourceRowIndex + 1,
        doubleheaderNumber: 1,
      };
      const manual = {
        ...notice,
        noticeId: "2025:0:708",
        noticeHash: "c".repeat(64),
        recordNumber: 708,
        sourceRowIndex: notice.sourceRowIndex + 2,
      };
      const unrelated = {
        ...notice,
        noticeId: "2025:0:709",
        noticeHash: "d".repeat(64),
        recordNumber: 709,
        sourceRowIndex: notice.sourceRowIndex + 3,
        awayTeamName: "다른 원정팀",
      };
      const repository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
      await seedVenueCorrectionNotice(repository, notice, specified, manual, unrelated);
      const unrelatedBefore = await repository.case(unrelated.noticeId);
      expect(unrelatedBefore).toMatchObject({ reasonCode: "awaiting_assessment" });
      const first = await store.importRevision({
        ...document,
        source: { ...document.source, sourceGameId: "anon_20250603_DH1" },
      });
      await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-doubleheader-followup-"));
      const workspace = await StagingWorkspace.open(root.path);
      const sessions = new CorrectionSessionManager(workspace);
      const service = new RecordCorrectionService(repository, store, workspace, sessions);
      try {
        const automatic = await service.assessNotice(notice);
        const explicit = await service.assessNotice(specified);
        const manualBase = await service.assessNotice(manual);
        expect([automatic.gameId, explicit.gameId, manualBase.gameId]).toEqual([
          first.gameId,
          first.gameId,
          first.gameId,
        ]);
        const manualCandidate = manualBase.candidates[0];
        if (manualCandidate === undefined) throw new Error("수동으로 고를 후보가 없습니다.");
        await repository.reviewAction(manual.noticeId, {
          caseVersion: manualBase.caseVersion,
          action: "select_candidate",
          candidateId: manualCandidate.candidateId,
          reason: null,
        });
        const chosen = await service.assessNotice(manual);
        for (const item of [await service.assessNotice(specified), chosen]) {
          await repository.markProposalApplied({
            noticeId: item.noticeId,
            caseVersion: item.caseVersion,
            sessionId: `fixture-${item.noticeId}`,
            proposalHash: "a".repeat(64),
            documentHash: "f".repeat(64),
          });
        }
        const approvedIds = [specified.noticeId, manual.noticeId];
        const approvedCases = await Promise.all(approvedIds.map((id) => repository.case(id)));
        const approvedHistory = async () =>
          (
            await pool.query(
              `SELECT notice_id,action_kind,case_version,document_hash FROM record_correction.review_actions
           WHERE notice_id=ANY($1::text[]) ORDER BY notice_id,action_sequence`,
              [approvedIds],
            )
          ).rows;
        const approvalActions = await approvedHistory();
        expect(approvalActions).toEqual([
          {
            notice_id: specified.noticeId,
            action_kind: "proposal_applied",
            case_version: explicit.caseVersion,
            document_hash: "f".repeat(64),
          },
          {
            notice_id: manual.noticeId,
            action_kind: "select_candidate",
            case_version: manualBase.caseVersion,
            document_hash: null,
          },
          {
            notice_id: manual.noticeId,
            action_kind: "proposal_applied",
            case_version: chosen.caseVersion,
            document_hash: "f".repeat(64),
          },
        ]);

        const second = await store.importRevision({
          ...document,
          metadata: { ...document.metadata, gameId: "anon-venue-game-dh2" },
          source: { ...document.source, sourceGameId: "anon_20250603_DH2" },
        });
        const initialOrder = order === "first-game-first" ? [first, second] : [second, first];
        let reviewed: RecordCorrectionCase | null | undefined;
        for (const imported of [...initialOrder, ...[...initialOrder].reverse()]) {
          await service.afterImport(imported.gameId, imported.revision);
          const current = await repository.case(notice.noticeId);
          expect(current).toMatchObject({
            status: "manual_review",
            reasonCode: "ambiguous_game_identity",
            gameId: null,
            caseVersion: automatic.caseVersion + 1,
          });
          expect(current?.candidates.map((candidate) => candidate.gameId)).toEqual([
            first.gameId,
            second.gameId,
          ]);
          reviewed ??= current;
          expect(current).toEqual(reviewed);
          const approvedNow = await Promise.all(approvedIds.map((id) => repository.case(id)));
          for (const [index, previous] of approvedCases.entries()) {
            expect(approvedNow[index]).toMatchObject({
              gameId: previous?.gameId,
              gameRevision: previous?.gameRevision,
              eventId: previous?.eventId,
              reasonCode: previous?.reasonCode,
              proposalHash: previous?.proposalHash,
            });
          }
          expect(await approvedHistory()).toEqual(approvalActions);
          await expect(repository.case(unrelated.noticeId)).resolves.toEqual(unrelatedBefore);
        }

        if (order === "first-game-first") {
          const draft = await store.loadCorrectionDraft(first.gameId, first.revision);
          const moved = await store.importRevision({
            ...draft,
            metadata: { ...draft.metadata, gameDate: "2025-06-04" },
          });
          await service.afterImport(moved.gameId, moved.revision);
          await expect(repository.case(notice.noticeId)).resolves.toMatchObject({
            gameId: second.gameId,
            gameRevision: second.revision,
          });
          await expect(repository.case(specified.noticeId)).resolves.toMatchObject({
            gameId: null,
          });
          const invalidated = await repository.case(manual.noticeId);
          expect(invalidated).toMatchObject({
            status: "manual_review",
            reasonCode: "manual_candidate_stale",
            gameId: null,
          });
          expect(invalidated?.candidates.map((candidate) => candidate.gameId)).toEqual([
            second.gameId,
          ]);
          await service.afterImport(second.gameId, second.revision);
          await service.afterImport(moved.gameId, moved.revision);
          await expect(repository.case(manual.noticeId)).resolves.toEqual(invalidated);
          expect(await approvedHistory()).toEqual(approvalActions);
        }
      } finally {
        service.close();
        sessions.close();
        await workspace.close();
      }
    },
    20000,
  );

  it("locks the current game through assessment save and rejects a late older assessment", async () => {
    const { document, notice } = await recordCorrectionVenueFixture();
    const repository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
    const earlierRepository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
    const first = await store.importRevision(document);
    await seedVenueCorrectionNotice(repository, notice);

    await using workspaceRoot = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-assessment-race-"),
    );
    const workspace = await StagingWorkspace.open(workspaceRoot.path);
    const sessions = new CorrectionSessionManager(workspace);
    const earlierService = new RecordCorrectionService(
      earlierRepository,
      store,
      workspace,
      sessions,
    );
    const currentService = new RecordCorrectionService(repository, store, workspace, sessions);
    const ready = Promise.withResolvers<number | null>();
    const resume = Promise.withResolvers<undefined>();
    vi.spyOn(earlierRepository, "assess").mockImplementation(async (input) => {
      ready.resolve(input.gameRevision);
      await resume.promise;
      return repository.assess(input);
    });

    const earlier = earlierService.assessNotice(notice);
    try {
      await expect(Promise.race([ready.promise, earlier])).resolves.toBe(1);
      const draft = await store.loadCorrectionDraft(first.gameId, first.revision);
      const sealed = await store.importRevision({
        ...draft,
        events: draft.events.map((event) =>
          event.identity.eventId === "e10" ? { ...event, relayText: "비식별 수정" } : event,
        ),
      });
      expect(sealed.revision).toBe(2);

      const caseLock = await pool.connect();
      const current = await (async () => {
        try {
          await caseLock.query("BEGIN");
          await caseLock.query(
            "SELECT 1 FROM record_correction.match_assessments WHERE notice_id=$1 FOR UPDATE",
            [notice.noticeId],
          );
          const backend = await caseLock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const saving = currentService.assessNotice(notice);
          try {
            await Promise.race([
              vi.waitFor(
                async () => {
                  const result = await pool.query<{ waiting: boolean }>(
                    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                   WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting`,
                    [backend.rows[0]?.pid],
                  );
                  expect(result.rows[0]?.waiting).toBe(true);
                },
                { timeout: 3000 },
              ),
              saving.then(() => {
                throw new Error("저장이 공지 행 잠금을 기다리지 않았습니다.");
              }),
            ]);
            await expect(
              pool
                .query("SELECT 1 FROM workbench.games WHERE game_id=$1 FOR NO KEY UPDATE NOWAIT", [
                  first.gameId,
                ])
                .then(({ rowCount }) => rowCount),
            ).rejects.toMatchObject({ code: "55P03" });
          } finally {
            await caseLock.query("ROLLBACK");
            await saving.catch(() => undefined);
          }
          return saving;
        } finally {
          caseLock.release();
        }
      })();
      expect(current.gameRevision).toBe(2);

      resume.resolve(undefined);
      await expect(earlier).rejects.toBeInstanceOf(RevisionConflictError);
      await expect(repository.case(notice.noticeId)).resolves.toEqual(current);
    } finally {
      resume.resolve(undefined);
      await earlier.catch(() => undefined);
      earlierService.close();
      currentService.close();
      await workspace.close();
    }
  });

  it.each([false, true])(
    "rejects an empty candidate set after first import (already reassessed: %s)",
    async (reassessFirst) => {
      const { document, notice } = await recordCorrectionVenueFixture();
      const repository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
      const earlierRepository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
      await seedVenueCorrectionNotice(repository, notice);

      await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-first-matchup-"));
      const workspace = await StagingWorkspace.open(root.path);
      const sessions = new CorrectionSessionManager(workspace);
      const earlier = new RecordCorrectionService(earlierRepository, store, workspace, sessions);
      const service = new RecordCorrectionService(repository, store, workspace, sessions);
      const ready = Promise.withResolvers<string>();
      const resume = Promise.withResolvers<undefined>();
      vi.spyOn(earlierRepository, "assess").mockImplementation(async (input) => {
        ready.resolve(input.status);
        await resume.promise;
        return repository.assess(input);
      });
      const pending = earlier.assessNotice(notice);
      try {
        await expect(Promise.race([ready.promise, pending])).resolves.toBe("unmatched");
        const sealed = await store.importRevision(document);
        expect(sealed.revision).toBe(1);
        if (reassessFirst) {
          await service.afterImport(sealed.gameId, sealed.revision);
          await expect(repository.case(notice.noticeId)).resolves.toMatchObject({
            gameId: sealed.gameId,
            gameRevision: 1,
          });
        }
        const before = await repository.case(notice.noticeId);
        resume.resolve(undefined);
        await expect(pending).rejects.toBeInstanceOf(
          reassessFirst ? RecordCorrectionStaleError : RevisionConflictError,
        );
        await expect(repository.case(notice.noticeId)).resolves.toEqual(before);

        if (!reassessFirst) await service.afterImport(sealed.gameId, sealed.revision);
        await expect(repository.case(notice.noticeId)).resolves.toMatchObject({
          gameId: sealed.gameId,
          gameRevision: 1,
        });
      } finally {
        resume.resolve(undefined);
        await pending.catch(() => undefined);
        earlier.close();
        service.close();
        sessions.close();
        await workspace.close();
      }
    },
  );

  it("lets other same-day matchups publish while the assessed matchup waits to save", async () => {
    const { document, notice } = await recordCorrectionVenueFixture();
    const repository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
    await seedVenueCorrectionNotice(repository, notice);
    // Commit shared catalogue rows for this season before opening the competing imports.
    await store.importRevision({
      ...document,
      metadata: { ...document.metadata, gameId: "anon-earlier-date", gameDate: "2025-06-02" },
      source: { ...document.source, sourceGameId: "anon-earlier-date" },
    });
    await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-matchup-lock-"));
    const workspace = await StagingWorkspace.open(root.path);
    const sessions = new CorrectionSessionManager(workspace);
    const service = new RecordCorrectionService(repository, store, workspace, sessions);
    const gate = await pool.connect();
    const otherPool = new Pool({ connectionString: dsn, options: "-c lock_timeout=1500" });
    const otherStore = new GameRevisionStore(otherPool, EXPECTED_MIGRATION_VERSION);
    let pending: Promise<RecordCorrectionCase> | undefined;
    let importing: ReturnType<GameRevisionStore["importRevision"]> | undefined;
    try {
      await gate.query("BEGIN");
      await gate.query(
        "SELECT 1 FROM record_correction.match_assessments WHERE notice_id=$1 FOR UPDATE",
        [notice.noticeId],
      );
      const backend = await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const gatePid = backend.rows[0]?.pid;
      if (gatePid === undefined) throw new Error("공지 행 잠금 연결이 없습니다.");
      pending = service.assessNotice(notice);
      const assessingPid = await Promise.race([
        blockedBackend(pool, gatePid, null),
        pending.then(() => {
          throw new Error("평가가 공지 행 잠금을 기다리지 않았습니다.");
        }),
      ]);
      importing = store.importRevision(document);
      await Promise.race([
        blockedBackend(pool, assessingPid, "advisory"),
        importing.then(() => {
          throw new Error("같은 대진의 적재가 평가 저장을 기다리지 않았습니다.");
        }),
      ]);

      for (const side of ["away", "home"] as const) {
        const otherId = `anon-other-${side}`;
        await expect(
          otherStore.importRevision({
            ...document,
            metadata: { ...document.metadata, gameId: otherId },
            source: { ...document.source, sourceGameId: otherId },
            teams: { ...document.teams, [side]: { teamId: otherId, name: `비식별 ${side}` } },
            rosters: {
              ...document.rosters,
              [side]: { ...document.rosters[side], teamId: otherId },
            },
          }),
        ).resolves.toMatchObject({ gameId: otherId, revision: 1 });
      }

      await expect(store.currentRevisionBase(document.metadata.gameId)).resolves.toBeNull();
      await gate.query("COMMIT");
      await expect(pending).resolves.toMatchObject({ status: "unmatched", gameId: null });
      const sealed = await importing;
      await service.afterImport(sealed.gameId, sealed.revision);
      await expect(repository.case(notice.noticeId)).resolves.toMatchObject({
        gameId: sealed.gameId,
        gameRevision: 1,
      });
    } finally {
      await gate.query("ROLLBACK");
      gate.release();
      await Promise.allSettled([pending, importing]);
      await otherPool.end();
      service.close();
      sessions.close();
      await workspace.close();
    }
  }, 20000);

  it.each(["corrected-first", "sibling-first"] as const)(
    "converges for the same sealed evidence when %s and keeps a valid manual target",
    async (order) => {
      const { document, notice } = await recordCorrectionLifecycleFixture();
      const manual = {
        ...notice,
        noticeId: "2025:0:712",
        recordNumber: 712,
        noticeHash: "7".repeat(64),
        sourceRowIndex: 1,
      };
      const explicit = {
        ...notice,
        noticeId: "2025:0:713",
        recordNumber: 713,
        noticeHash: "8".repeat(64),
        sourceRowIndex: 2,
        doubleheaderNumber: 1,
      };
      const repository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
      await seedVenueCorrectionNotice(repository, notice, manual, explicit);
      const first = await store.importRevision({
        ...document,
        source: { ...document.source, sourceGameId: "anon_20250603_DH1" },
      });
      await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-correction-converge-"));
      const workspace = await StagingWorkspace.open(root.path);
      const sessions = new CorrectionSessionManager(workspace);
      const service = new RecordCorrectionService(repository, store, workspace, sessions);
      try {
        await service.assessSeason(2025);
        const previous = await repository.case(manual.noticeId);
        const candidate = previous?.candidates[0];
        if (!previous || !candidate) throw new Error("manual candidate fixture");
        await repository.reviewAction(manual.noticeId, {
          caseVersion: previous.caseVersion,
          action: "select_candidate",
          candidateId: candidate.candidateId,
          reason: null,
        });
        const pending = await repository.case(manual.noticeId);
        expect(pending?.assessmentPending).toBe(true);
        if (pending === null) throw new Error("missing fixture case");
        await expect(service.createDraft(manual.noticeId, pending.caseVersion)).rejects.toThrow(
          "최신 경기와 플레이 후보",
        );
        await service.assessSeason(2025);
        const draft = await openCurrentRecordCorrectionDraft(service, manual.noticeId);
        const proposal = await service.proposal(draft.sessionId, manual.noticeId);
        if (proposal.batch === null)
          throw new Error(proposal.reasons.join(" ") || "fixture correction unavailable");
        const current = sessions.get(draft.sessionId).draftDocument;
        const independentlyCorrected = applyCorrectionCommand(current, proposal.batch).document;
        const publishCorrection = async () => {
          const sealed = await store.importRevision(independentlyCorrected);
          await service.afterImport(sealed.gameId, sealed.revision);
          return sealed;
        };
        const publishSibling = async () => {
          const sibling = await store.importRevision({
            ...document,
            metadata: { ...document.metadata, gameId: "anon-venue-game-dh2" },
            source: { ...document.source, sourceGameId: "anon_20250603_DH2" },
          });
          await service.afterImport(sibling.gameId, sibling.revision);
          return sibling;
        };
        let sibling;
        let sealed;
        if (order === "corrected-first") {
          sealed = await publishCorrection();
          expect((await repository.case(notice.noticeId))?.status).toBe("resolved");
          sibling = await publishSibling();
        } else {
          sibling = await publishSibling();
          sealed = await publishCorrection();
        }
        const currentCases = async () =>
          Promise.all([notice, manual, explicit].map((item) => repository.case(item.noticeId)));
        const final = await currentCases();
        expect(final[0]).toMatchObject({
          status: "manual_review",
          gameId: null,
          appliedRevision: null,
        });
        expect(final[0]?.candidates.map(({ gameId }) => gameId)).toEqual([
          first.gameId,
          sibling.gameId,
        ]);
        for (const item of final.slice(1)) {
          expect(item).toMatchObject({
            status: "resolved",
            gameId: first.gameId,
            gameRevision: 2,
            eventId: "e10",
            appliedRevision: 2,
          });
        }
        const replay = await store.loadCompiled(first.gameId, sealed.revision);
        expect(
          replay.replay.plateAppearances.find((appearance) => appearance.endEventId === "e10")
            ?.result,
        ).toBe("reached_on_error");
        await service.afterImport(sibling.gameId, sibling.revision);
        await service.afterImport(sealed.gameId, sealed.revision);
        expect(await currentCases()).toEqual(final);
      } finally {
        await service.close();
        sessions.close();
        await workspace.close();
      }
    },
    20000,
  );

  it("keeps pending import notices and scoped evidence in their respective orders", async () => {
    await withRecordCorrectionWorkspace(async (repository, _workspace, _sessions, service) => {
      const { document, notice } = await recordCorrectionLifecycleFixture();
      const laterRecord = {
        ...notice,
        noticeId: "2025:0:901",
        recordNumber: 901,
        noticeHash: "9".repeat(64),
        sourceRowIndex: notice.sourceRowIndex + 1,
        statChanges: [
          {
            statIndex: 0,
            participantIndex: 0,
            rawStatName: "2루타",
            statCode: "doubles",
            scope: "batter",
            beforeValue: 2,
            afterValue: 1,
            supportKind: "direct",
          },
          {
            statIndex: 1,
            participantIndex: 0,
            rawStatName: "3루타",
            statCode: "triples",
            scope: "batter",
            beforeValue: 0,
            afterValue: 1,
            supportKind: "direct",
          },
        ],
      } satisfies RecordCorrectionNotice;
      await seedVenueCorrectionNotice(repository, laterRecord, notice);
      const first = await store.importRevision(document);
      const initial = await service.assessNotice(notice);
      const candidate = initial.candidates[0];
      if (candidate === undefined) throw new Error("missing manual candidate fixture");
      await repository.reviewAction(notice.noticeId, {
        caseVersion: initial.caseVersion,
        action: "select_candidate",
        candidateId: candidate.candidateId,
        reason: null,
      });
      const noticeIds = await repository.listNoticeIdsForImport(first.gameId, first.revision);
      const context = await repository.matchupContext(notice);
      const basis = await repository.assessmentBasis(notice);
      expect(noticeIds).toEqual([laterRecord.noticeId, notice.noticeId]);
      expect(context.notices).toEqual([
        { notice, selection: candidate },
        { notice: laterRecord, selection: null },
      ]);
      expect(basis.selection).toEqual(candidate);
      expect(basis.peers).toEqual(context.notices);
    });
  });

  it("retries the stale post-publication assessment against a concurrent selection", async () => {
    const { document, notice } = await recordCorrectionLifecycleFixture();
    const repository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
    await seedVenueCorrectionNotice(repository, notice);
    const first = await store.importRevision({
      ...document,
      source: { ...document.source, sourceGameId: "anon_20250603_DH1" },
    });
    await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-record-decision-race-"));
    const workspace = await StagingWorkspace.open(root.path);
    const sessions = new CorrectionSessionManager(workspace);
    const service = new RecordCorrectionService(repository, store, workspace, sessions);
    try {
      const initial = await service.assessNotice(notice);
      const candidate = initial.candidates[0];
      if (!candidate) throw new Error("manual candidate fixture");
      const sibling = await store.importRevision({
        ...document,
        metadata: { ...document.metadata, gameId: "anon-venue-game-dh2" },
        source: { ...document.source, sourceGameId: "anon_20250603_DH2" },
      });
      const assess = repository.assess.bind(repository);
      const spy = vi.spyOn(repository, "assess").mockImplementationOnce(async (input) => {
        expect(input.gameId).toBeNull();
        await repository.reviewAction(notice.noticeId, {
          caseVersion: initial.caseVersion,
          action: "select_candidate",
          candidateId: candidate.candidateId,
          reason: null,
        });
        return assess(input);
      });
      await service.afterImport(sibling.gameId, sibling.revision);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(await repository.pendingNoticeIds("", 10)).toEqual([]);
      expect(await repository.case(notice.noticeId)).toMatchObject({
        gameId: first.gameId,
        eventId: "e10",
        status: "action_required",
      });
    } finally {
      await service.close();
      sessions.close();
      await workspace.close();
    }
  }, 20000);

  async function withRecordCorrectionWorkspace(
    check: (
      repository: RecordCorrectionRepository,
      workspace: StagingWorkspace,
      sessions: CorrectionSessionManager,
      service: RecordCorrectionService,
      root: string,
    ) => Promise<void>,
  ) {
    await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-record-proof-"));
    const workspace = await StagingWorkspace.open(root.path);
    const repository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
    const sessions = new CorrectionSessionManager(workspace);
    const service = new RecordCorrectionService(repository, store, workspace, sessions);
    try {
      await check(repository, workspace, sessions, service, root.path);
    } finally {
      await service.close();
      sessions.close();
      await workspace.close();
    }
  }

  it("opens the new sealed revision when another import completes during draft preparation", async () => {
    await withRecordCorrectionWorkspace(async (repo, workspace, sessions, service) => {
      const { document, notice } = await recordCorrectionLifecycleFixture();
      const first = await store.importRevision(document);
      await seedVenueCorrectionNotice(repo, notice);
      await service.assessNotice(notice);
      const loadedOld = Promise.withResolvers<undefined>();
      const resumeOpen = Promise.withResolvers<undefined>();
      const prepare = workspace.prepareCorrectionDraft.bind(workspace);
      vi.spyOn(workspace, "prepareCorrectionDraft").mockImplementationOnce(async (input) => {
        expect(input.revisionBase).toMatchObject({ kind: "sealed_revision", revision: 1 });
        const publish = await prepare(input);
        loadedOld.resolve(undefined);
        await resumeOpen.promise;
        return publish;
      });
      const opening = openCurrentRecordCorrectionDraft(service, notice.noticeId);
      const jobs = new ImportJobManager(
        workspace,
        store,
        undefined,
        undefined,
        2,
        (gameId, revision) => service.afterImport(gameId, revision),
        service.verifyPublication.bind(service),
      );
      try {
        await loadedOld.promise;
        const ordinary = await store.loadCorrectionDraft(first.gameId, 1);
        await workspace.withGameOperation(first.gameId, () =>
          workspace.saveCorrectionDraft(ordinary),
        );
        const editing = await sessions.create({ gameId: first.gameId, authority: "staging" });
        const event = editing.draftDocument.events.find((row) => row.identity.eventId === "e10");
        if (event === undefined) throw new Error("fixture game event missing");
        const edited = await sessions.command(
          editing.sessionId,
          editing.sessionVersion,
          {
            commandId: "audit-independent-edit",
            kind: "replace_event",
            eventId: "e10",
            event: { ...event, relayText: "비식별 수동 문구" },
          },
          true,
        );
        await sessions.commit(editing.sessionId, {
          expectedSessionVersion: edited.session.sessionVersion,
          allowBlockingStaging: false,
        });
        const queued = await jobs.create({
          gameId: first.gameId,
          idempotencyKey: "audit-newer-seal",
        });
        expect(await jobs.waitForTerminal(queued.jobId)).toMatchObject({
          status: "succeeded",
          revision: 2,
          followUpPending: false,
        });
        expect(await workspace.readImportTarget(first.gameId)).toBeNull();
        resumeOpen.resolve(undefined);
        const opened = await opening;
        expect(sessions.get(opened.sessionId).draftDocument.revisionBase).toMatchObject({
          revision: 2,
        });
        expect(await workspace.readImportTarget(first.gameId)).toMatchObject({ revision: 3 });
        expect(await store.currentRevisionBase(first.gameId)).toMatchObject({ revision: 2 });
        const retry = await openCurrentRecordCorrectionDraft(service, notice.noticeId);
        expect(sessions.get(retry.sessionId).draftDocument.revisionBase).toMatchObject({
          revision: 2,
        });
        expect(await service.proposal(retry.sessionId, notice.noticeId)).toMatchObject({
          eligible: true,
        });
      } finally {
        resumeOpen.resolve(undefined);
        await opening.catch(() => undefined);
        await jobs.close();
      }
    });
  }, 30000);

  it.each([1, 3])(
    "renews a reproducible two-notice draft with revised earned runs %s",
    async (earnedRuns) => {
      await withRecordCorrectionWorkspace(async (repo, workspace, sessions, service) => {
        const raw: unknown = JSON.parse(
          await readFile(
            "tests/fixtures/correction/record-correction-multiple-pitchers.anonymized.json",
            "utf8",
          ),
        );
        if (raw === null || typeof raw !== "object" || !("document" in raw) || !("notice" in raw))
          throw new Error("invalid fixture");
        const document = parseStagingGameDocumentV2(raw.document);
        const notice = Value.Decode(RecordCorrectionNoticeSchema, raw.notice);
        const players = ["away-player-24", "away-player-26"];
        const first = await store.importRevision({
          ...document,
          events: document.events.map((event) =>
            event.kind === "plate_result" &&
            event.identity.eventId === "anon-multiple-pitchers:relay_007:6:2"
              ? { ...event, payload: { ...event.payload, result: "reached_on_error" } }
              : event,
          ),
          officialRecords: {
            ...document.officialRecords,
            pitchers: document.officialRecords.pitchers.map((line) =>
              players.includes(line.playerId) ? { ...line, earnedRuns: 3 } : line,
            ),
          },
        });
        await store.importRevision(await store.loadCorrectionDraft(first.gameId, 1), {
          fromIndependentSealedDraft: true,
        });
        const a = {
          ...notice,
          noticeHash: "a".repeat(64),
          contentText:
            "비식별홈\n홈선수4(안타 3→2, 루타수 3→2)\n비식별원정\n원정선수24(피안타 3→2, 자책점 3→0)",
          statChanges: notice.statChanges.filter(
            (stat) => stat.statCode !== "earned_runs" || stat.participantIndex === 1,
          ),
        };
        const b = {
          ...notice,
          noticeId: "2025:0:978",
          recordNumber: 978,
          sourceRowIndex: notice.sourceRowIndex + 1,
          noticeHash: "b".repeat(64),
          contentText:
            "비식별홈\n홈선수4(안타 3→2, 루타수 3→2)\n비식별원정\n원정선수24(피안타 3→2)\n원정선수26(자책점 3→2)",
          statChanges: notice.statChanges.filter(
            (stat) => stat.statCode !== "earned_runs" || stat.participantIndex === 2,
          ),
        };
        await seedVenueCorrectionNotice(repo, a, b);
        await service.assessSeason(2025);
        await applyAndSaveNotice(service, sessions, a.noticeId);
        const bundled = await applyAndSaveNotice(service, sessions, b.noticeId);
        const oldTarget = await workspace.readImportTarget(first.gameId);
        expect(oldTarget?.recordCorrection?.approvals).toHaveLength(2);
        const from = earnedRuns === 3 ? 0 : 3;
        const a2 = {
          ...a,
          noticeHash: "c".repeat(64),
          contentText: a.contentText.replace("자책점 3→0", `자책점 ${from}→${earnedRuns}`),
          statChanges: a.statChanges.map((stat) =>
            stat.statCode === "earned_runs"
              ? { ...stat, beforeValue: from, afterValue: earnedRuns }
              : stat,
          ),
        };
        await publishVenueNotices(repo, "audit-edited-approval", "c", [a2, b]);
        await service.assessSeason(2025);
        const toApprove = earnedRuns === 3 ? b.noticeId : a2.noticeId;
        const session = await openCurrentRecordCorrectionDraft(service, toApprove);
        const pitcher = bundled.session.draftDocument.officialRecords.pitchers.find(
          (row) => row.playerId === players[0],
        );
        if (pitcher === undefined) throw new Error("missing fixture pitcher");
        const adjusted = await sessions.command(
          session.sessionId,
          session.sessionVersion,
          {
            commandId: "audit-revised-er",
            kind: "update_official_record",
            recordType: "pitcher",
            playerId: pitcher.playerId,
            record: { ...pitcher, earnedRuns },
          },
          true,
        );
        await sessions.commit(session.sessionId, {
          expectedSessionVersion: adjusted.session.sessionVersion,
          allowBlockingStaging: false,
        });
        const staged = await workspace.readImportTarget(first.gameId);
        expect(staged?.recordCorrection?.approvals).toEqual(oldTarget?.recordCorrection?.approvals);
        const oldReferences = oldTarget?.recordCorrection?.approvals;
        expect(await repo.approvalEvidence(oldReferences ?? [])).toMatchObject([
          { noticeId: b.noticeId, documentHash: oldTarget?.documentHash },
        ]);

        await using cleanRoot = await mkdtempDisposable(
          path.join(tmpdir(), "kbo-audit-proven-base-"),
        );
        const cleanWorkspace = await StagingWorkspace.open(cleanRoot.path);
        const cleanSessions = new CorrectionSessionManager(cleanWorkspace);
        const cleanService = new RecordCorrectionService(
          repo,
          store,
          cleanWorkspace,
          cleanSessions,
        );
        try {
          if (earnedRuns !== 3) await applyAndSaveNotice(cleanService, cleanSessions, a2.noticeId);
          const recreated = await applyAndSaveNotice(cleanService, cleanSessions, b.noticeId);
          expect(recreated.session.draftDocumentHash).toBe(adjusted.session.draftDocumentHash);
          const control = await cleanWorkspace.readImportTarget(first.gameId);
          if (!control) throw new Error("missing control artifact");
          expect(
            typeof (await cleanService.verifyPublication(recreated.session.draftDocument, control)),
          ).toBe("number");
        } finally {
          await cleanService.close();
          cleanSessions.close();
          await cleanWorkspace.close();
        }

        const reopen = await openCurrentRecordCorrectionDraft(service, toApprove);
        const proposal = await service.proposal(reopen.sessionId, toApprove);
        expect(proposal).toMatchObject({ eligible: true, batch: null });
        const renewed = await service.applyProposal(
          reopen.sessionId,
          toApprove,
          reopen.sessionVersion,
          proposal.proposalHash,
        );
        const prior = sessions.approvalReferences(reopen.sessionId);
        expect(prior.map(({ noticeId }) => noticeId)).toEqual(
          earnedRuns === 3 ? [b.noticeId] : [a2.noticeId, b.noticeId],
        );
        const undone = await sessions.undo(reopen.sessionId, renewed.session.sessionVersion);
        expect(sessions.approvalReferences(reopen.sessionId)).toEqual(oldReferences);
        const redone = await sessions.redo(reopen.sessionId, undone.session.sessionVersion);
        expect(sessions.approvalReferences(reopen.sessionId)).toEqual(prior);
        await sessions.commit(reopen.sessionId, {
          expectedSessionVersion: redone.session.sessionVersion,
          allowBlockingStaging: false,
        });
        const proved = await workspace.readImportTarget(first.gameId);
        expect(proved?.documentHash).toBe(staged?.documentHash);
        expect(proved?.recordCorrection?.approvals).toEqual(prior);
        const jobs = verifiedImportJobs(workspace, store, service);
        try {
          const job = await jobs.create({ gameId: first.gameId, idempotencyKey: "renewed-bundle" });
          expect(await jobs.waitForTerminal(job.jobId)).toMatchObject({
            status: "succeeded",
            revision: 3,
          });
        } finally {
          await jobs.close();
        }
      });
    },
    30000,
  );

  it("automatically confirms a sealed import after a one-time ownership read failure", async () => {
    await withRecordCorrectionWorkspace(async (_repo, workspace, _sessions, service) => {
      const { document } = await recordCorrectionLifecycleFixture();
      const first = await store.importRevision(document);
      const base = await store.loadCorrectionDraft(first.gameId, first.revision);
      await workspace.saveCorrectionDraft(base);
      const target = await workspace.readImportTarget(first.gameId);
      if (!target) throw new Error("fixture target missing");
      const ownershipRead = vi
        .fn(store.importPublication.bind(store))
        .mockRejectedValueOnce(new Error("transient read failure"));
      const finished = vi.fn(async () => undefined);
      const jobs = new ImportJobManager(
        workspace,
        {
          async importRevision(
            ...args: Parameters<GameRevisionStore["importRevision"]>
          ): Promise<never> {
            await store.importRevision(...args);
            throw new Error("lost COMMIT reply");
          },
          importPublication: ownershipRead,
        },
        undefined,
        undefined,
        2,
        finished,
        service.verifyPublication.bind(service),
      );
      try {
        const queued = await jobs.create({
          gameId: first.gameId,
          idempotencyKey: "audit-lost-commit-reply",
        });
        const uncertain = await jobs.waitForTerminal(queued.jobId);
        expect(uncertain).toMatchObject({
          status: "running",
          revision: null,
          errorCategory: "persistence",
        });
        expect(uncertain.publicationCheckPending).toBe(true);
        expect(await store.importPublication(queued.jobId, target)).toMatchObject({ revision: 2 });
        expect(await store.currentRevisionBase(first.gameId)).toMatchObject({ revision: 2 });
        for (let i = 0; i < 5; i += 1) expect(jobs.get(queued.jobId)).toEqual(uncertain);
        expect(ownershipRead).toHaveBeenCalledTimes(1);
        expect(finished).not.toHaveBeenCalled();
        expect(await workspace.readImportTarget(first.gameId)).toEqual(target);
        await vi.waitFor(
          () =>
            expect(jobs.get(queued.jobId)).toMatchObject({
              status: "succeeded",
              revision: 2,
              followUpPending: false,
            }),
          { timeout: 6000 },
        );
        expect(ownershipRead).toHaveBeenCalledTimes(2);
        expect(await workspace.readImportTarget(first.gameId)).toBeNull();
      } finally {
        await jobs.close();
      }
    });
  }, 30000);

  it("coalesces concurrent receipt checks before persisting one success", async () => {
    await withRecordCorrectionWorkspace(async (_repo, workspace, _sessions, service) => {
      const { document } = await recordCorrectionLifecycleFixture();
      const first = await store.importRevision(document);
      await workspace.saveCorrectionDraft(await store.loadCorrectionDraft(first.gameId, 1));
      const firstRead = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      let reads = 0;
      const jobs = new ImportJobManager(
        workspace,
        {
          async importRevision(
            ...args: Parameters<GameRevisionStore["importRevision"]>
          ): Promise<never> {
            await store.importRevision(...args);
            throw new Error("lost commit reply test");
          },
          async importPublication(jobId, target) {
            reads += 1;
            if (reads === 1) {
              firstRead.resolve(undefined);
              await release.promise;
              throw new Error("slow failing lookup");
            }
            return store.importPublication(jobId, target);
          },
        },
        undefined,
        undefined,
        2,
        undefined,
        service.verifyPublication.bind(service),
      );
      try {
        const queued = await jobs.create({
          gameId: first.gameId,
          idempotencyKey: "audit-two-recovery-writers",
        });
        await firstRead.promise;
        const intervening = jobs.reconcile(queued.jobId);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(reads).toBe(1);
        release.resolve(undefined);
        expect(await intervening).toMatchObject({
          status: "running",
          publicationCheckPending: true,
        });
        const [result, duplicate] = await Promise.all([
          jobs.reconcile(queued.jobId),
          jobs.reconcile(queued.jobId),
        ]);
        expect(result).toMatchObject({ status: "succeeded", revision: 2 });
        expect(duplicate).toEqual(result);
        expect(await jobs.waitForTerminal(queued.jobId)).toMatchObject({ followUpPending: false });
        expect(reads).toBe(2);
        expect(await workspace.readImportTarget(first.gameId)).toBeNull();
        expect(
          (await workspace.imports.jobs()).find(({ job }) => job.jobId === queued.jobId),
        ).toMatchObject({
          job: { status: "succeeded", revision: 2 },
        });
      } finally {
        release.resolve(undefined);
        await jobs.close();
      }
    });
  }, 30000);

  it("keeps already queued imports behind an unconfirmed job for the same game", async () => {
    await withRecordCorrectionWorkspace(async (_repo, workspace) => {
      const { document } = await recordCorrectionLifecycleFixture();
      const sibling = parseStagingGameDocumentV2(makeDocument([]));
      await workspace.saveReady(document, []);
      await workspace.saveReady(sibling, []);
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      let receiptsAvailable = false;
      const readReceipt = vi.fn(async (id: string, target: ImportTarget) => {
        if (!receiptsAvailable) throw new Error("temporary receipt lookup failure");
        return store.importPublication(id, target);
      });
      const importRevision = vi.fn(
        async (input: unknown, options?: Parameters<GameRevisionStore["importRevision"]>[1]) => {
          const draft = parseStagingGameDocumentV2(input);
          if (draft.metadata.gameId === document.metadata.gameId) {
            entered.resolve(undefined);
            await release.promise;
            await store.importRevision(draft, options);
            throw new Error("lost COMMIT reply");
          }
          return store.importRevision(draft, options);
        },
      );
      const jobs = new ImportJobManager(workspace, {
        importRevision,
        importPublication: readReceipt,
      });
      try {
        const first = await jobs.create({
          gameId: document.metadata.gameId,
          idempotencyKey: "pending-first",
        });
        await entered.promise;
        expect(await jobs.reconcile(first.jobId)).toMatchObject({ status: "running" });
        expect(readReceipt).not.toHaveBeenCalled();
        const queued = await jobs.create({
          gameId: document.metadata.gameId,
          idempotencyKey: "pending-second",
        });
        release.resolve(undefined);
        expect(await jobs.waitForTerminal(first.jobId)).toMatchObject({
          publicationCheckPending: true,
        });
        expect(jobs.get(queued.jobId).status).toBe("queued");
        expect(jobs.hasImportActivity()).toBe(false);
        await expect(
          jobs.create({ gameId: document.metadata.gameId, idempotencyKey: "pending-third" }),
        ).rejects.toThrow(/선행 적재/);
        const other = await jobs.create({
          gameId: sibling.metadata.gameId,
          idempotencyKey: "pending-other-game",
        });
        expect(await jobs.waitForTerminal(other.jobId)).toMatchObject({
          status: "succeeded",
          revision: 1,
        });
        expect(importRevision).toHaveBeenCalledTimes(2);
        expect(jobs.get(queued.jobId).status).toBe("queued");
        receiptsAvailable = true;
        expect(await jobs.reconcile(first.jobId)).toMatchObject({
          status: "succeeded",
          revision: 1,
        });
        expect(await jobs.waitForTerminal(queued.jobId)).toMatchObject({
          status: "cancelled",
          revision: null,
        });
        expect(importRevision).toHaveBeenCalledTimes(2);
      } finally {
        release.resolve(undefined);
        await jobs.close();
      }
    });
  }, 30000);

  it("holds the matching game row through draft publication while allowing another game", async () => {
    const { document } = await recordCorrectionLifecycleFixture();
    const first = await store.importRevision(document);
    const original = await store.currentRevisionBase(first.gameId);
    if (original === null) throw new Error("missing base fixture");
    const revised = await store.loadCorrectionDraft(first.gameId, 1);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const publishing = store.withCurrentRevisionBase(first.gameId, original, async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    const importing = store.importRevision(revised, { fromIndependentSealedDraft: true });
    try {
      await vi.waitFor(
        async () => {
          const blocked = await pool.query(`SELECT pid FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND query='SELECT current_revision FROM workbench.games WHERE game_id=$1 FOR UPDATE'`);
          expect(blocked.rows.length).toBeGreaterThan(0);
        },
        { timeout: 5000 },
      );
      expect(await store.currentRevisionBase(first.gameId)).toEqual(original);
      const sibling = await store.importRevision(parseStagingGameDocumentV2(makeDocument([])));
      expect(sibling.gameId).not.toBe(first.gameId);
      release.resolve(undefined);
      await publishing;
      expect(await importing).toMatchObject({ revision: 2 });
      const stale = vi.fn(async () => {});
      await expect(
        store.withCurrentRevisionBase(first.gameId, original, stale),
      ).rejects.toBeInstanceOf(RevisionConflictError);
      expect(stale).not.toHaveBeenCalled();
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([publishing, importing]);
    }
  }, 30000);

  it("rejects draft publication if the PostgreSQL guard connection is terminated during file I/O", async () => {
    const { document } = await recordCorrectionLifecycleFixture();
    const first = await store.importRevision(document);
    const original = await store.currentRevisionBase(first.gameId);
    if (original === null) throw new Error("missing base fixture");
    const guardPool = new Pool({
      connectionString: dsn,
      application_name: "draft-file-guard-test",
    });
    const guardedStore = new GameRevisionStore(guardPool, EXPECTED_MIGRATION_VERSION);
    const opened = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const publishing = guardedStore.withCurrentRevisionBase(first.gameId, original, async () => {
      opened.resolve(undefined);
      await release.promise;
      return "prepared file result";
    });
    const observed = publishing.catch((error: unknown) => error);
    try {
      await opened.promise;
      const activity = await pool.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'",
        ["draft-file-guard-test"],
      );
      const pid = activity.rows[0]?.pid;
      if (pid === undefined) throw new Error("guard backend not found");
      const terminated = await pool.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend($1, 5000) AS terminated",
        [pid],
      );
      expect(terminated.rows[0]?.terminated).toBe(true);
      const ordinary = await store.loadCorrectionDraft(first.gameId, 1);
      expect(
        await store.importRevision(ordinary, { fromIndependentSealedDraft: true }),
      ).toMatchObject({ revision: 2 });
      release.resolve(undefined);
      expect(await observed).toMatchObject({ code: "57P01" });
      expect(guardPool.totalCount).toBe(0);
    } finally {
      release.resolve(undefined);
      await observed;
      await guardPool.end();
    }
  }, 30000);

  it.each(["effect_removed", "effect_retained", "selected_before_approval"] as const)(
    "revalidates saved automatic approvals after a second doubleheader game: %s",
    async (mode) => {
      await withRecordCorrectionWorkspace(async (repo, workspace, sessions, service) => {
        const { document, notice } = await recordCorrectionFixture("multiple-pitchers");
        const pitchers = ["away-player-24", "away-player-26"];
        const earnedRuns = (draft: typeof document) =>
          pitchers.map(
            (id) => draft.officialRecords.pitchers.find((line) => line.playerId === id)?.earnedRuns,
          );
        const fixture = parseStagingGameDocumentV2({
          ...document,
          source: { ...document.source, sourceGameId: "anon-multiple-DH1" },
          events: document.events.map((event) =>
            event.kind === "plate_result" &&
            event.identity.eventId === "anon-multiple-pitchers:relay_007:6:2"
              ? { ...event, payload: { ...event.payload, result: "reached_on_error" } }
              : event,
          ),
          officialRecords: {
            ...document.officialRecords,
            pitchers: document.officialRecords.pitchers.map((line) =>
              pitchers.includes(line.playerId) ? { ...line, earnedRuns: 3 } : line,
            ),
          },
        });
        const first = await store.importRevision(fixture);
        const a = {
          ...notice,
          noticeHash: "a".repeat(64),
          doubleheaderNumber: 1,
          contentText:
            "비식별홈\n홈선수4(안타 3→2, 루타수 3→2)\n비식별원정\n원정선수24(피안타 3→2, 자책점 3→0)",
          statChanges: notice.statChanges.filter(
            (stat) => stat.statCode !== "earned_runs" || stat.participantIndex === 1,
          ),
        };
        const b = {
          ...notice,
          noticeId: "2025:0:978",
          recordNumber: 978,
          sourceRowIndex: notice.sourceRowIndex + 1,
          noticeHash: "b".repeat(64),
          doubleheaderNumber: null,
          contentText:
            "비식별홈\n홈선수4(안타 3→2, 루타수 3→2)\n비식별원정\n원정선수24(피안타 3→2)\n원정선수26(자책점 3→2)",
          statChanges: notice.statChanges.filter(
            (stat) => stat.statCode !== "earned_runs" || stat.participantIndex === 2,
          ),
        };
        await seedVenueCorrectionNotice(repo, a, b);
        await service.assessSeason(2025);
        if (mode === "selected_before_approval") {
          const assessment = await repo.case(b.noticeId);
          const candidate = assessment?.candidates[0];
          if (assessment === null || candidate === undefined) throw new Error("fixture candidate");
          await repo.reviewAction(b.noticeId, {
            caseVersion: assessment.caseVersion,
            action: "select_candidate",
            candidateId: candidate.candidateId,
            reason: null,
          });
          await service.assessSeason(2025);
        }
        await applyAndSaveNotice(service, sessions, a.noticeId);
        const bundle = await applyAndSaveNotice(service, sessions, b.noticeId);
        expect(earnedRuns(bundle.session.draftDocument)).toEqual([0, 2]);
        const prior = await workspace.readImportTarget(first.gameId);
        const approvals = prior?.recordCorrection?.approvals;
        expect(approvals?.map(({ noticeId }) => noticeId)).toEqual([a.noticeId, b.noticeId]);

        const second = await store.importRevision({
          ...fixture,
          source: { ...fixture.source, sourceGameId: "anon-multiple-DH2" },
          metadata: { ...fixture.metadata, gameId: "anon-multiple-game-dh2" },
        });
        await service.afterImport(second.gameId, second.revision);
        if (mode !== "selected_before_approval") {
          expect(await repo.case(b.noticeId)).toMatchObject({
            status: "manual_review",
            reasonCode: "ambiguous_game_identity",
          });
          await expect(
            store.importRevision(bundle.session.draftDocument, {
              recordCorrectionApprovals: approvals ?? [],
              verifiedMatchupGeneration: (await repo.matchupContext(a)).generation,
            }),
          ).rejects.toBeInstanceOf(RevisionConflictError);
        }

        let editing = await openCurrentRecordCorrectionDraft(service, a.noticeId);
        if (mode === "effect_removed") {
          const pitcher = bundle.session.draftDocument.officialRecords.pitchers.find(
            (line) => line.playerId === "away-player-26",
          );
          if (pitcher === undefined) throw new Error("fixture pitcher");
          const corrected = await sessions.command(
            editing.sessionId,
            editing.sessionVersion,
            {
              commandId: "restore-expired-earnings",
              kind: "update_official_record",
              recordType: "pitcher",
              playerId: pitcher.playerId,
              record: { ...pitcher, earnedRuns: 3 },
            },
            true,
          );
          await sessions.commit(editing.sessionId, {
            expectedSessionVersion: corrected.session.sessionVersion,
            allowBlockingStaging: false,
          });
          editing = await openCurrentRecordCorrectionDraft(service, a.noticeId);
        }
        const proposal = await service.proposal(editing.sessionId, a.noticeId);
        expect(proposal.eligible, proposal.reasons.join(" ")).toBe(mode !== "effect_retained");
        if (mode === "effect_retained") {
          expect(
            (await workspace.readImportTarget(first.gameId))?.recordCorrection?.approvals,
          ).toEqual(approvals);
          expect(await store.currentRevisionBase(first.gameId)).toMatchObject({ revision: 1 });
          return;
        }
        const approved = await service.applyProposal(
          editing.sessionId,
          a.noticeId,
          editing.sessionVersion,
          proposal.proposalHash,
        );
        expect(
          sessions.approvalReferences(editing.sessionId).map(({ noticeId }) => noticeId),
        ).toEqual(mode === "effect_removed" ? [a.noticeId] : [a.noticeId, b.noticeId]);
        await sessions.commit(editing.sessionId, {
          expectedSessionVersion: approved.session.sessionVersion,
          allowBlockingStaging: false,
        });
        const jobs = verifiedImportJobs(workspace, store, service);
        try {
          const job = await jobs.create({
            gameId: first.gameId,
            idempotencyKey: "after-second-game",
          });
          expect(await jobs.waitForTerminal(job.jobId)).toMatchObject({
            status: "succeeded",
            revision: 2,
          });
          expect(earnedRuns(await store.loadCorrectionDraft(first.gameId, 2))).toEqual(
            mode === "effect_removed" ? [0, 3] : [0, 2],
          );
        } finally {
          await jobs.close();
        }
      });
    },
    30000,
  );

  it("checks the whole corrected ledger when a revised notice still has unapplied changes", async () => {
    await withRecordCorrectionWorkspace(async (repo, workspace, sessions, service) => {
      const fixture: unknown = JSON.parse(
        await readFile(
          "tests/fixtures/correction/record-correction-multiple-pitchers.anonymized.json",
          "utf8",
        ),
      );
      if (
        fixture === null ||
        typeof fixture !== "object" ||
        !("document" in fixture) ||
        !("notice" in fixture)
      )
        throw new Error("fixture");
      const document = parseStagingGameDocumentV2(fixture.document);
      const notice = Value.Decode(RecordCorrectionNoticeSchema, fixture.notice);
      const players = ["away-player-24", "away-player-26"];
      const earnedRuns = (draft: typeof document) =>
        players.map(
          (id) => draft.officialRecords.pitchers.find((line) => line.playerId === id)?.earnedRuns,
        );
      const first = await store.importRevision({
        ...document,
        events: document.events.map((event) =>
          event.kind === "plate_result" &&
          event.identity.eventId === "anon-multiple-pitchers:relay_007:6:2"
            ? { ...event, payload: { ...event.payload, result: "reached_on_error" } }
            : event,
        ),
        officialRecords: {
          ...document.officialRecords,
          pitchers: document.officialRecords.pitchers.map((line) =>
            players.includes(line.playerId) ? { ...line, earnedRuns: 3 } : line,
          ),
        },
      });
      const a = {
        ...notice,
        noticeHash: "a".repeat(64),
        contentText:
          "비식별홈\n홈선수4(안타 3→2, 루타수 3→2)\n비식별원정\n원정선수24(피안타 3→2, 자책점 3→0)",
        statChanges: notice.statChanges.filter(
          (stat) => stat.statCode !== "earned_runs" || stat.participantIndex === 1,
        ),
      };
      const b = {
        ...notice,
        noticeHash: "b".repeat(64),
        contentText:
          "비식별홈\n홈선수4(안타 3→2, 루타수 3→2)\n비식별원정\n원정선수24(피안타 3→2)\n원정선수26(자책점 3→2)",
        statChanges: notice.statChanges.filter(
          (stat) => stat.statCode !== "earned_runs" || stat.participantIndex === 2,
        ),
      };
      await seedVenueCorrectionNotice(repo, a);
      await service.assessSeason(2025);
      const old = await applyAndSaveNotice(service, sessions, a.noticeId);
      expect(earnedRuns(old.session.draftDocument)).toEqual([0, 3]);
      const saved = await workspace.readImportTarget(first.gameId);
      await publishVenueNotices(repo, "revised-earnings", "b", [b]);
      await service.assessSeason(2025);
      const reopened = await openCurrentRecordCorrectionDraft(service, b.noticeId);
      const proposal = await service.proposal(reopened.sessionId, b.noticeId);
      expect(proposal.eligible).toBe(false);
      expect(proposal.batch).not.toBeNull();
      await expect(
        service.applyProposal(
          reopened.sessionId,
          b.noticeId,
          reopened.sessionVersion,
          proposal.proposalHash,
        ),
      ).rejects.toThrow();
      expect(await workspace.readImportTarget(first.gameId)).toEqual(saved);
      expect(earnedRuns(await store.loadCorrectionDraft(first.gameId, 1))).toEqual([3, 3]);

      await workspace.saveCorrectionDraft(await store.loadCorrectionDraft(first.gameId, 1));
      const corrected = await applyAndSaveNotice(service, sessions, b.noticeId);
      expect(earnedRuns(corrected.session.draftDocument)).toEqual([3, 2]);
      const jobs = verifiedImportJobs(workspace, store, service);
      try {
        const job = await jobs.create({ gameId: first.gameId, idempotencyKey: "proved-revision" });
        expect(await jobs.waitForTerminal(job.jobId)).toMatchObject({
          status: "succeeded",
          revision: 2,
        });
        expect(earnedRuns(await store.loadCorrectionDraft(first.gameId, 2))).toEqual([3, 2]);
      } finally {
        await jobs.close();
      }
    });
  }, 30000);

  it("imports using the exact saved approval after a later unsaved approval is discarded", async () => {
    await withRecordCorrectionWorkspace(async (repo, workspace, sessions, service) => {
      const { document, notice } = await recordCorrectionLifecycleFixture();
      const first = await store.importRevision(document);
      await seedVenueCorrectionNotice(repo, notice);
      await service.assessSeason(2025);
      const initial = await applyAndSaveNotice(service, sessions, notice.noticeId);
      const saved = await workspace.readImportTarget(first.gameId);
      const temporary = await applyAndSaveNotice(service, sessions, notice.noticeId, false);
      expect(temporary.proposal.batch).toBeNull();
      expect(temporary.session.draftDocumentHash).toBe(initial.session.draftDocumentHash);
      expect(sessions.approvalReferences(temporary.session.sessionId)).not.toEqual(
        saved?.recordCorrection?.approvals,
      );
      await sessions.delete(temporary.session.sessionId, temporary.session.sessionVersion);
      expect(await workspace.readImportTarget(first.gameId)).toEqual(saved);
      expect((await service.case(notice.noticeId))?.draftProgress?.state).toBe("ready_to_import");
      const jobs = verifiedImportJobs(workspace, store, service);
      try {
        const job = await jobs.create({ gameId: first.gameId, idempotencyKey: "use-saved" });
        expect(await jobs.waitForTerminal(job.jobId)).toMatchObject({
          status: "succeeded",
          revision: 2,
        });
      } finally {
        await jobs.close();
      }
    });
  }, 30000);

  it("protects opposing active notices and rechecks a saved approval after reopening the conflict", async () => {
    await withRecordCorrectionWorkspace(async (repo, workspace, sessions, service) => {
      const { document, notice: a } = await recordCorrectionLifecycleFixture();
      const first = await store.importRevision(document);
      const b = {
        ...a,
        noticeId: "2025:0:707",
        noticeHash: "b".repeat(64),
        sourceRowIndex: a.sourceRowIndex + 1,
        recordNumber: 707,
        decisionBefore: "error" as const,
        decisionAfter: "hit" as const,
        beforeRecordText: "실책",
        afterRecordText: "안타",
        contentText: "비식별홈\n홈선수4(루타수 0→1)",
        statChanges: [
          {
            statIndex: 0,
            participantIndex: 0,
            statCode: "total_bases" as const,
            scope: "batter" as const,
            rawStatName: "루타수",
            beforeValue: 0,
            afterValue: 1,
            supportKind: "derived" as const,
          },
        ],
      };
      await seedVenueCorrectionNotice(repo, a, b);
      for (const input of [a, b, b, a]) {
        const item = await service.assessNotice(input);
        expect(item).toMatchObject({
          status: "manual_review",
          reasonCode: "conflicting_active_notices",
        });
        const draft = await openCurrentRecordCorrectionDraft(service, input.noticeId);
        expect(await service.proposal(draft.sessionId, input.noticeId)).toMatchObject({
          eligible: false,
        });
      }
      const opposed = await repo.case(b.noticeId);
      if (opposed === null) throw new Error("peer notice fixture");
      const dismissed = await repo.reviewAction(b.noticeId, {
        caseVersion: opposed.caseVersion,
        action: "dismiss",
        reason: "공식 공지 충돌 확인",
        candidateId: null,
      });
      await service.assessSeason(2025);
      await applyAndSaveNotice(service, sessions, a.noticeId);
      await repo.reviewAction(b.noticeId, {
        caseVersion: dismissed.caseVersion,
        action: "reopen",
        reason: null,
        candidateId: null,
      });
      const jobs = verifiedImportJobs(workspace, store, service);
      try {
        const job = await jobs.create({
          gameId: first.gameId,
          idempotencyKey: "reopened-conflict",
        });
        expect(await jobs.waitForTerminal(job.jobId)).toMatchObject({
          status: "failed",
          errorCategory: "domain",
        });
        expect(await store.currentRevisionBase(first.gameId)).toMatchObject({ revision: 1 });
        expect(await workspace.readImportTarget(first.gameId)).not.toBeNull();
      } finally {
        await jobs.close();
      }
    });
  }, 30000);

  it("recovers only the exact import owner and keeps a restored artifact with the same document hash", async () => {
    await withRecordCorrectionWorkspace(async (repo, workspace, sessions, service, root) => {
      const { document, notice } = await recordCorrectionLifecycleFixture();
      const first = await store.importRevision(document);
      await seedVenueCorrectionNotice(repo, notice);
      await service.assessSeason(2025);
      const opened = await openCurrentRecordCorrectionDraft(service, notice.noticeId);
      const proposal = await service.proposal(opened.sessionId, notice.noticeId);
      if (proposal.batch === null) throw new Error("correction batch fixture");
      const manual = await sessions.command(
        opened.sessionId,
        opened.sessionVersion,
        proposal.batch,
        true,
      );
      await sessions.commit(opened.sessionId, {
        expectedSessionVersion: manual.session.sessionVersion,
        allowBlockingStaging: false,
      });
      const independent = await workspace.readImportTarget(first.gameId);
      await workspace.saveCorrectionDraft(await store.loadCorrectionDraft(first.gameId, 1));
      const archived = (await readdir(path.join(root, "superseded", first.gameId))).find((file) =>
        file.endsWith(`-${independent?.artifact?.contentHash}.document.json`),
      );
      if (archived === undefined) throw new Error("independent artifact fixture");
      const approved = await applyAndSaveNotice(service, sessions, notice.noticeId);
      const old = await workspace.readImportTarget(first.gameId);
      if (!old?.recordCorrection) throw new Error("bound artifact fixture");
      expect(old.documentHash).toBe(independent?.documentHash);
      expect(old.artifact).not.toEqual(independent?.artifact);
      for (const id of ["owner", "duplicate"])
        await workspace.imports.saveJob(runningImport(id, old));
      const targetApproval = old.recordCorrection.approvals;
      const publish = (jobId: string) =>
        store.importRevision(approved.session.draftDocument, {
          publication: { jobId, target: old },
          recordCorrectionApprovals: targetApproval,
          fromIndependentSealedDraft: true,
        });
      const [owner, duplicate] = await Promise.allSettled([publish("owner"), publish("duplicate")]);
      const [won, rejected] =
        owner?.status === "fulfilled" ? [owner, duplicate] : [duplicate, owner];
      expect(won).toMatchObject({ status: "fulfilled", value: { revision: 2 } });
      expect(rejected).toMatchObject({ status: "rejected" });
      const sealedJob = owner?.status === "fulfilled" ? "owner" : "duplicate";
      const duplicateJob = sealedJob === "owner" ? "duplicate" : "owner";
      expect(await publish(sealedJob)).toMatchObject({
        revision: 2,
        documentHash: old.documentHash,
      });
      const restored = await sessions.create({
        gameId: first.gameId,
        authority: "superseded",
        snapshotId: archived,
      });
      await sessions.commit(restored.sessionId, {
        expectedSessionVersion: restored.sessionVersion,
        allowBlockingStaging: false,
      });
      const newer = await workspace.readImportTarget(first.gameId);
      expect(newer?.documentHash).toBe(old.documentHash);
      expect(newer?.artifact).not.toEqual(old.artifact);
      const jobs = verifiedImportJobs(workspace, store, service);
      try {
        await jobs.restore();
        expect(await jobs.create(runningImport(sealedJob, old).request)).toMatchObject({
          status: "succeeded",
          revision: 2,
          followUpPending: false,
        });
        expect(await jobs.create(runningImport(duplicateJob, old).request)).toMatchObject({
          status: "cancelled",
          revision: null,
        });
        expect(await workspace.readImportTarget(first.gameId)).toEqual(newer);
        expect(await store.importPublication(duplicateJob, old)).toBeNull();
      } finally {
        await jobs.close();
      }
    });
  }, 30000);

  it("recovers a lost commit response even when the first ownership lookup also fails", async () => {
    await withRecordCorrectionWorkspace(async (_repo, workspace, _sessions, service) => {
      const { document } = await recordCorrectionLifecycleFixture();
      await workspace.saveReady(document, []);
      const target = await workspace.readImportTarget(document.metadata.gameId);
      if (target === null) throw new Error("staged fixture");
      const importer = {
        async importRevision(
          ...args: Parameters<GameRevisionStore["importRevision"]>
        ): Promise<never> {
          await store.importRevision(...args);
          throw new Error("simulated lost COMMIT response");
        },
        importPublication: vi.fn().mockRejectedValue(new Error("simulated connection failure")),
      };
      const request = runningImport("commit-response-lost", target).request;
      const jobs = new ImportJobManager(
        workspace,
        importer,
        undefined,
        () => "commit-response-lost",
      );
      let jobId: string;
      try {
        ({ jobId } = await jobs.create(request));
        await vi.waitFor(async () => {
          expect(
            (await workspace.imports.jobs()).find(({ job }) => job.jobId === jobId),
          ).toMatchObject({
            publicationPending: true,
            job: { status: "running", revision: null, errorCategory: "persistence" },
          });
        });
      } finally {
        await jobs.close();
      }
      expect(await store.currentRevisionBase(target.gameId)).toMatchObject({ revision: 1 });
      expect(await workspace.readImportTarget(target.gameId)).toEqual(target);
      const recovered = verifiedImportJobs(workspace, store, service);
      try {
        await recovered.restore();
        expect(await recovered.create(request)).toMatchObject({
          status: "succeeded",
          revision: 1,
          followUpPending: false,
        });
        expect(await store.importPublication(jobId, target)).toMatchObject({
          revision: 1,
          documentHash: target.documentHash,
        });
        expect(await workspace.readImportTarget(target.gameId)).toBeNull();
      } finally {
        await recovered.close();
      }
    });
  }, 30000);

  it("keeps a new saved artifact after an archive failure and workspace restart", async () => {
    await withRecordCorrectionWorkspace(async (_repo, workspace, _sessions, _service, root) => {
      const { document } = await recordCorrectionLifecycleFixture();
      await workspace.saveReady(document, []);
      const { gameId } = document.metadata;
      const blockedArchive = path.join(root, "superseded", gameId);
      const jobs = new ImportJobManager(workspace, {
        importPublication: store.importPublication.bind(store),
        async importRevision(...args: Parameters<GameRevisionStore["importRevision"]>) {
          const result = await store.importRevision(...args);
          await writeFile(blockedArchive, "test-only archive failure after COMMIT");
          return result;
        },
      });
      const request = { gameId, idempotencyKey: "archive-failure" };
      try {
        const job = await jobs.create(request);
        const result = await jobs.waitForTerminal(job.jobId);
        expect(result, result.error ?? undefined).toMatchObject({
          status: "succeeded",
          revision: 1,
          followUpPending: true,
        });
      } finally {
        await jobs.close();
      }
      expect(await workspace.readImportTarget(gameId)).toBeNull();
      await unlink(blockedArchive);
      await workspace.saveCorrectionDraft(await store.loadCorrectionDraft(gameId, 1));
      const next = await workspace.readImportTarget(gameId);
      expect(next).toMatchObject({ revision: 2 });
      await workspace.close();
      const resumed = await StagingWorkspace.open(root);
      try {
        const restarted = new ImportJobManager(resumed, store);
        try {
          await restarted.restore();
          expect(await restarted.create(request)).toMatchObject({
            status: "succeeded",
            revision: 1,
            followUpPending: false,
          });
          expect(await resumed.readImportTarget(gameId)).toEqual(next);
          expect(await store.currentRevisionBase(gameId)).toMatchObject({ revision: 1 });
        } finally {
          await restarted.close();
        }
      } finally {
        await resumed.close();
      }
    });
  }, 30000);

  it.each(["valid", "ambiguous", "withdrawn", "edited", "reapproved"] as const)(
    "rechecks %s approval after archived workspace restoration and a restarted importer",
    async (mode) => {
      const { document, notice } = await recordCorrectionLifecycleFixture();
      const repository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
      await seedVenueCorrectionNotice(repository, notice);
      const first = await store.importRevision({
        ...document,
        source: { ...document.source, sourceGameId: "anon_20250603_DH1" },
      });
      await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-approval-restore-"));
      let workspace = await StagingWorkspace.open(root.path);
      let sessions = new CorrectionSessionManager(workspace);
      let service = new RecordCorrectionService(repository, store, workspace, sessions);
      let jobs: ImportJobManager | undefined;
      try {
        const assessed = await service.assessNotice(notice);
        if (mode === "valid") {
          const candidate = assessed.candidates[0];
          if (!candidate) throw new Error("manual candidate fixture");
          await repository.reviewAction(notice.noticeId, {
            caseVersion: assessed.caseVersion,
            action: "select_candidate",
            candidateId: candidate.candidateId,
            reason: null,
          });
          await service.assessSeason(2025);
        }
        const draft = await openCurrentRecordCorrectionDraft(service, notice.noticeId);
        const proposal = await service.proposal(draft.sessionId, notice.noticeId);
        const applied = await service.applyProposal(
          draft.sessionId,
          notice.noticeId,
          draft.sessionVersion,
          proposal.proposalHash,
        );
        await sessions.commit(draft.sessionId, {
          expectedSessionVersion: applied.session.sessionVersion,
          allowBlockingStaging: false,
        });
        const savedHash = applied.session.draftDocumentHash;
        const [approved] = await workspace.readImportTargets([first.gameId]);
        expect(approved?.recordCorrection?.approvals).toHaveLength(1);
        const base = await store.loadCorrectionDraft(first.gameId, 1);
        await workspace.saveCorrectionDraft(base);
        const snapshots = await readdir(path.join(root.path, "superseded", first.gameId));
        const archived = snapshots.find((name) =>
          name.endsWith(`-${approved?.artifact?.contentHash}.document.json`),
        );
        if (archived === undefined) throw new Error("approved snapshot fixture");
        await service.close();
        sessions.close();
        await workspace.close();

        const revisedSource = {
          ...notice,
          noticeId: "2025:0:714",
          recordNumber: 714,
          noticeHash: "9".repeat(64),
          sourceRowIndex: 1,
        };
        await publishVenueNotices(
          repository,
          "record-refresh",
          "e",
          mode === "withdrawn" ? [revisedSource] : [notice, revisedSource],
        );
        if (mode === "withdrawn") {
          expect(await repository.case(notice.noticeId)).toBeNull();
          await publishVenueNotices(repository, "record-return", "f", [notice, revisedSource]);
        }
        if (mode === "ambiguous" || mode === "valid" || mode === "reapproved") {
          await store.importRevision({
            ...document,
            metadata: { ...document.metadata, gameId: "anon-venue-game-dh2" },
            source: { ...document.source, sourceGameId: "anon_20250603_DH2" },
          });
        }
        workspace = await StagingWorkspace.open(root.path);
        sessions = new CorrectionSessionManager(workspace);
        service = new RecordCorrectionService(repository, store, workspace, sessions);
        const restoring = await sessions.create({
          gameId: first.gameId,
          authority: "superseded",
          snapshotId: archived,
        });
        await sessions.commit(restoring.sessionId, {
          expectedSessionVersion: restoring.sessionVersion,
          allowBlockingStaging: false,
        });
        if (mode === "edited") {
          const restored = await workspace.readCurrentDocumentSnapshot(first.gameId);
          if (!restored) throw new Error("restored snapshot fixture");
          await workspace.commitCorrection({
            baseAuthority: restored.authority,
            targetAuthority: "staging",
            baseDocumentHash: savedHash,
            document: {
              ...restored.document,
              events: restored.document.events.map((event) =>
                event.identity.eventId === "e10"
                  ? { ...event, relayText: "비식별 후속 편집" }
                  : event,
              ),
            },
            findingEnvelope: { schemaVersion: 2, findings: [] },
          });
        }
        const [restored] = await workspace.readImportTargets([first.gameId]);
        expect(restored?.recordCorrection?.approvals).toEqual(
          approved?.recordCorrection?.approvals,
        );
        if (!restored) throw new Error("restored target fixture");
        await service.assessSeason(2025);
        if (mode === "reapproved") {
          const ambiguous = await repository.case(notice.noticeId);
          const candidate = ambiguous?.candidates.find(({ gameId }) => gameId === first.gameId);
          if (!ambiguous || !candidate) throw new Error("doubleheader fixture");
          await repository.reviewAction(notice.noticeId, {
            caseVersion: ambiguous.caseVersion,
            action: "select_candidate",
            candidateId: candidate.candidateId,
            reason: null,
          });
          await service.assessSeason(2025);
          const reopened = await openCurrentRecordCorrectionDraft(service, notice.noticeId);
          const renewed = await service.proposal(reopened.sessionId, notice.noticeId);
          expect(renewed).toMatchObject({ eligible: true, batch: null });
          const applied = await service.applyProposal(
            reopened.sessionId,
            notice.noticeId,
            reopened.sessionVersion,
            renewed.proposalHash,
          );
          expect(applied.session.draftDocumentHash).toBe(savedHash);
          await sessions.commit(reopened.sessionId, {
            expectedSessionVersion: applied.session.sessionVersion,
            allowBlockingStaging: false,
          });
          const [reapproved] = await workspace.readImportTargets([first.gameId]);
          expect(reapproved?.recordCorrection?.approvals).not.toEqual(
            approved?.recordCorrection?.approvals,
          );
        }
        const request = {
          gameId: first.gameId,
          expectedDocumentHash: restored.documentHash,
          idempotencyKey: "restore-approval",
        };
        let result;
        if (mode === "valid") {
          await service.close();
          sessions.close();
          await workspace.close();
          await exitAfterSealing(root.path, request.gameId, request.expectedDocumentHash);
          // The last durable file job is still running. The DB revision was committed by the dead process.
          expect(await store.currentRevisionBase(first.gameId)).toMatchObject({
            revision: 2,
            documentHash: savedHash,
          });
          workspace = await StagingWorkspace.open(root.path);
          sessions = new CorrectionSessionManager(workspace);
          service = new RecordCorrectionService(repository, store, workspace, sessions);
          jobs = verifiedImportJobs(workspace, store, service);
          await jobs.restore();
          result = await jobs.create(request);
        } else {
          jobs = verifiedImportJobs(workspace, store, service);
          await jobs.restore();
          const job = await jobs.create(request);
          result = await jobs.waitForTerminal(job.jobId);
        }
        if (mode === "valid" || mode === "reapproved") {
          expect(result).toMatchObject({
            status: "succeeded",
            revision: 2,
            documentHash: savedHash,
          });
          expect(await repository.pendingNoticeIds("", 10)).toContain(notice.noticeId);
          // No import-completion callback was registered. A new service drains DB work on startup.
          await jobs.close();
          await service.close();
          sessions.close();
          await workspace.close();
          workspace = await StagingWorkspace.open(root.path);
          sessions = new CorrectionSessionManager(workspace);
          const restarted = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
          service = new RecordCorrectionService(restarted, store, workspace, sessions);
          const errors: unknown[] = [];
          service.startPendingReconciliation((error) => errors.push(error));
          await vi.waitFor(
            async () => {
              expect(await restarted.case(notice.noticeId)).toMatchObject({
                status: "resolved",
                appliedRevision: 2,
                eventId: "e10",
              });
              expect(await restarted.pendingNoticeIds("", 10)).toEqual([]);
            },
            { timeout: 5000 },
          );
          expect(errors).toEqual([]);
        } else {
          expect(result).toMatchObject({
            status: "failed",
            errorCategory: "domain",
            error: expect.stringContaining("KBO 기록정정 승인을 확인할 수 없습니다"),
          });
          expect(await store.currentRevisionBase(first.gameId)).toMatchObject({
            revision: 1,
            documentHash: first.documentHash,
          });
          expect(await workspace.readImportTargets([first.gameId])).toEqual([restored]);
          if (mode === "ambiguous") {
            if (proposal.batch === null) throw new Error("manual correction fixture");
            await workspace.saveCorrectionDraft(await store.loadCorrectionDraft(first.gameId, 1));
            const manual = await sessions.create({ gameId: first.gameId, authority: "staging" });
            const changed = await sessions.command(
              manual.sessionId,
              manual.sessionVersion,
              proposal.batch,
              true,
            );
            expect(changed.session.draftDocumentHash).toBe(savedHash);
            await sessions.commit(manual.sessionId, {
              expectedSessionVersion: changed.session.sessionVersion,
              allowBlockingStaging: false,
            });
            const independent = await jobs.create({
              ...request,
              idempotencyKey: "independent-manual-correction",
            });
            expect(await jobs.waitForTerminal(independent.jobId)).toMatchObject({
              status: "succeeded",
              revision: 2,
              documentHash: savedHash,
            });
            await service.reconcilePending((error) => {
              throw error;
            });
            expect(await repository.case(notice.noticeId)).toMatchObject({
              status: "manual_review",
              gameId: null,
            });
          }
        }
      } finally {
        await jobs?.close();
        await service.close();
        sessions.close();
        await workspace.close();
      }
    },
    60000,
  );

  it("기록정정 source revision을 봉인하고 no-change와 append-only 검토 이력을 보장한다", async () => {
    const repository = new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION);
    const importedGame = await store.importRevision(await recordCorrectionGolden());
    const dataset = recordCorrectionSeasonFixture();
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
    const basis = await repository.assessmentBasis(recordCorrectionNotice());
    const initialAssessment = {
      noticeId: "2024:0:1",
      noticeHash: recordCorrectionNotice().noticeHash,
      matchup: recordCorrectionNotice(),
      caseVersion: basis.caseVersion,
      basis,
      gameBases: [importedGame],
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
    } as const;
    for (const base of [
      { ...importedGame, documentHash: "0".repeat(64) },
      { ...importedGame, gameId: "missing-anon-game" },
    ]) {
      await expect(
        repository.assess({
          ...initialAssessment,
          gameBases: [base],
          gameId: base.gameId,
          documentHash: base.documentHash,
        }),
      ).rejects.toBeInstanceOf(RevisionConflictError);
    }
    expect(await repository.seasonHasPendingAssessments(2024)).toBe(true);
    const assessed = await repository.assess(initialAssessment);
    expect(await repository.seasonHasPendingAssessments(2024)).toBe(false);
    expect(assessed.status).toBe("already_applied");

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
    await expect(repository.assess(initialAssessment)).rejects.toBeInstanceOf(
      RecordCorrectionStaleError,
    );
    await expect(repository.case(item.noticeId)).resolves.toEqual(reopened);
    const actionCount = await pool.query<{ readonly count: string }>(
      "SELECT COUNT(*)::text count FROM record_correction.review_actions WHERE notice_id=$1",
      [item.noticeId],
    );
    expect(actionCount.rows[0]?.count).toBe("1");
    await expect(
      pool.query(
        "UPDATE record_correction.notices SET content_text='변조' WHERE season=2024 AND revision=2",
      ),
    ).rejects.toThrow(/immutable/);
    const currentBasis = await repository.assessmentBasis({
      ...item.notice,
      noticeHash: "f".repeat(64),
    });
    await repository.assess({
      noticeId: item.noticeId,
      noticeHash: "f".repeat(64),
      matchup: recordCorrectionNotice(),
      caseVersion: currentBasis.caseVersion,
      basis: currentBasis,
      gameBases: null,
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

  it("미래 원장 행을 가리키는 타석 검토는 DB에 봉인하지 않는다", async () => {
    const document = await golden();
    const blocked = parseStagingGameDocumentV2({
      ...document,
      events: document.events.map((event) =>
        event.identity.eventId === "e7"
          ? { ...event, kind: "review", payload: { decision: "upheld", reviewedEventId: "e8" } }
          : event,
      ),
    });

    await expect(store.importRevision(blocked)).rejects.toBeInstanceOf(BlockingImportError);
    expect(await store.countStoredGames()).toBe(0);
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

  it.each(plateZoneCases)("SQL/replay plate geometry: $label", async ({ overrides, inZone }) => {
    const t = plateTracking(overrides);
    const result = await pool.query<{ in_zone: boolean | null }>(
      "SELECT analytics.tracking_in_zone($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS in_zone",
      [
        t.crossPlateX,
        t.crossPlateY,
        t.y0,
        t.z0,
        t.vy0,
        t.vz0,
        t.ay,
        t.az,
        t.strikeZone?.bottomFeet ?? null,
        t.strikeZone?.topFeet ?? null,
      ],
    );
    expect(result.rows).toEqual([{ in_zone: inZone }]);
  });

  it("포심 분포와 결과를 같은 snapshot에서 읽고 실제 스윙 판정을 보존한다", async () => {
    for (let i = 0; i < 3; i++) {
      const base = releasePitchAnalysisFixture(2024, i);
      await store.importRevision(
        parseStagingGameDocumentV2({
          ...base,
          metadata: { ...base.metadata, gameId: `expectation-${i}` },
          events: base.events.map((e) =>
            e.kind === "pitch" && e.identity.eventId === "e2"
              ? {
                  ...e,
                  payload: {
                    ...e.payload,
                    call: i === 0 ? "called_strike" : i === 1 ? "foul" : "swinging_strike",
                  },
                }
              : e,
          ),
        }),
      );
    }
    const repository = new PitchAnalysisRepository(pool);
    const data = await repository.analyze(2024, "hp1", { competition: "unknown" });
    expect(data.referenceDistribution?.sampleCount).toBe(144);
    expect(data.referenceDistribution?.central90.includedCount).toBeGreaterThanOrEqual(130);
    expect(data.referenceDistribution).toEqual(
      (await repository.analyze(2024, "hp2", { competition: "unknown" })).referenceDistribution,
    );
    expect(
      data.points.find((p) => p.gameId === "expectation-0" && p.pitchId === "e2"),
    ).toMatchObject({ swing: false, whiff: false });
    expect(
      data.points.find((p) => p.gameId === "expectation-1" && p.pitchId === "e2"),
    ).toMatchObject({ swing: true, whiff: false });
    expect(
      data.points.find((p) => p.gameId === "expectation-2" && p.pitchId === "e2"),
    ).toMatchObject({ swing: true, whiff: true });
    expect(data.points.every((p) => p.referenceBand !== null)).toBe(true);
  });

  it("uses the finalized season release clock for a date-filtered shape and sequence", async () => {
    for (let i = 0; i < 3; i++) await store.importRevision(releasePitchAnalysisFixture(2024, i));
    const openGame = releasePitchAnalysisFixture(2024, 3);
    await store.importRevision(
      parseStagingGameDocumentV2({
        ...openGame,
        metadata: { ...openGame.metadata, status: "suspended" },
      }),
    );
    const scope = { competition: "unknown", dateFrom: "2024-06-01", dateTo: "2024-06-01" } as const;
    const shape = await new PitchAnalysisRepository(pool).analyze(2024, "hp1", scope);
    expect(shape.actualPitchCount).toBe(96);
    expect(shape.points).toHaveLength(96);
    expect(
      shape.releaseGroups?.map((group) => [group.pitchType, group.pitches, group.games]),
    ).toEqual([
      ["슬라이더", 144, 3],
      ["직구", 144, 3],
    ]);
    const t = (55 - 17 / 24) / 100;
    expect(shape.baseline?.sampleCount).toBe(144);
    expect(shape.baseline?.arrivalMs).toBeCloseTo(t * 1000, 8);
    expect(shape.points.find((pitch) => pitch.pitchType === "슬라이더")).toMatchObject({
      arrivalMs: expect.closeTo((t - 0.01) * 1000, 7),
      timingDifferenceMs: expect.closeTo(-10, 7),
      xCm: expect.closeTo((16 * t ** 2 * 30.48) / 2, 7),
    });
    const repository = new PitchSequenceRepository(pool);
    const result = await repository.analyze({ season: 2024, ...scope }, "hp1");
    expect(result.releaseGroups).toEqual(shape.releaseGroups);
    expect(result.pairs[0]?.planeTimeDifferenceMs).toBeCloseTo(-10, 8);
    expect(result.pairs[1]?.planeTimeDifferenceMs).toBeCloseTo(10, 8);
    const later = releasePitchAnalysisFixture(2024, 2);
    const draft = await store.loadCorrectionDraft(later.metadata.gameId, 1);
    await store.importRevision(draft);
    const updated = await repository.analyze({ season: 2024, ...scope }, "hp1");
    expect(updated.sourceHash).not.toBe(result.sourceHash);
    expect(updated.pairs).toEqual(result.pairs);
    const updatedShape = await new PitchAnalysisRepository(pool).analyze(2024, "hp1", scope);
    expect(updatedShape.sourceHash).not.toBe(shape.sourceHash);
    expect(updatedShape.points).toEqual(shape.points);
  }, 15_000);

  it("릴리스를 추정할 수 없는 시즌은 기준 포심 없이 표본 제외 사유를 제공한다", async () => {
    const repository = new PitchAnalysisRepository(pool);
    await store.importRevision(pitchAnalysisFixture(2024));
    await store.importRevision(pitchAnalysisFixture(2025));
    await store.importRevision(pitchAnalysisFixture(2025, "hp2", -150));
    const first = await repository.analyze(2025, "hp1", { competition: "unknown" });
    const second = await repository.analyze(2025, "hp2", { competition: "unknown" });
    const previousSeason = await repository.analyze(2024, "hp1", { competition: "unknown" });
    expect(first.baseline).toEqual(second.baseline);
    expect(first.baseline).toBeNull();
    expect(previousSeason.baseline).toBeNull();
    expect(first).toMatchObject({
      actualPitchCount: 4,
      missingTrackingCount: 1,
      invalidTrackingCount: 1,
      missingReleaseCount: 2,
    });
    expect(first.points).toHaveLength(0);
    expect(first.calibration).toMatchObject({
      plane: "middle",
      calibratedCount: 0,
      uncalibratedCount: 0,
    });
    expect(first.referenceDistribution).toBeNull();
    expect((await repository.catalog(2025, { competition: "unknown" })).pitchers).toHaveLength(2);
    const empty = await repository.analyze(2023, "hp1");
    expect(empty.baseline).toBeNull();
    expect(empty.points).toEqual([]);
    const before = await store.revisions("analysis-2025-hp1");
    const draft = await store.loadCorrectionDraft("analysis-2025-hp1", 1);
    await store.importRevision(draft);
    const after = await repository.analyze(2025, "hp1", { competition: "unknown" });
    expect(after.baseline).toEqual(first.baseline);
    expect(after.sourceHash).not.toBe(first.sourceHash);
    expect(after.points).toHaveLength(0);
    expect(
      (await store.revisions("analysis-2025-hp1")).revisions.find(
        (revision) => revision.revision === 1,
      ),
    ).toMatchObject({ documentHash: before.revisions[0]?.documentHash });
  });

  it("저장된 시즌 기준은 재시작 뒤 재사용하고 현재 revision이 바뀌면 재계산한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-reference-db-"));
    let workspace = await StagingWorkspace.open(temporary.path);
    let calculations = 0;
    let calibrationCalculations = 0;
    const uncached = new PitchAnalysisRepository(pool);
    const repository = new PitchAnalysisRepository(
      pool,
      {
        getOrCreate: (key, calculate) =>
          workspace.pitchReferences.getOrCreate(key, async () => {
            calculations++;
            return calculate();
          }),
      },
      undefined,
      undefined,
      {
        getOrCreate: (key, calculate) =>
          workspace.pitchCalibrations.getOrCreate(key, async (previous) => {
            calibrationCalculations++;
            return calculate(previous);
          }),
      },
    );
    try {
      await store.importRevision(pitchAnalysisFixture(2024));
      await store.importRevision(pitchAnalysisFixture(2024, "hp2", -150));
      const first = await repository.analyze(2024, "hp1", { competition: "unknown" });
      expect(first).toEqual(await uncached.analyze(2024, "hp1", { competition: "unknown" }));
      expect(await repository.analyze(2024, "hp2", { competition: "unknown" })).toEqual(
        await uncached.analyze(2024, "hp2", { competition: "unknown" }),
      );
      expect(calculations).toBe(1);
      expect(calibrationCalculations).toBe(1);
      await workspace.close();
      workspace = await StagingWorkspace.open(temporary.path);
      expect(await repository.analyze(2024, "hp1", { competition: "unknown" })).toEqual(first);
      expect(calculations).toBe(1);
      const draft = await store.loadCorrectionDraft("analysis-2024-hp2", 1);
      await store.importRevision({
        ...pitchAnalysisFixture(2024, "hp2", -155),
        revisionBase: draft.revisionBase,
      });
      const updated = await repository.analyze(2024, "hp1", { competition: "unknown" });
      expect(updated.sourceHash).not.toBe(first.sourceHash);
      expect(updated.baseline).toBeNull();
      expect(updated).toEqual(await uncached.analyze(2024, "hp1", { competition: "unknown" }));
      expect(calculations).toBe(2);
      expect(calibrationCalculations).toBe(2);
      await store.importRevision(pitchAnalysisFixture(2025));
      expect(await repository.analyze(2025, "hp1", { competition: "unknown" })).toEqual(
        await uncached.analyze(2025, "hp1", { competition: "unknown" }),
      );
      expect(calculations).toBe(3);
      expect(calibrationCalculations).toBe(3);
    } finally {
      await workspace.close();
    }
  });

  it("병렬 집계가 활성화돼도 궤적 함수의 예외 처리와 충돌하지 않는다", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `CREATE TABLE workbench.zone_parallel_test_samples AS
         SELECT CASE WHEN n % 2=0 THEN 5.78675 ELSE 6.28675 END::DOUBLE PRECISION AS z0
         FROM generate_series(1,10000) AS n`,
      );
      await client.query("ANALYZE workbench.zone_parallel_test_samples");
      await client.query("SET LOCAL max_parallel_workers_per_gather=2");
      await client.query("SET LOCAL min_parallel_table_scan_size=0");
      await client.query("SET LOCAL parallel_setup_cost=0");
      await client.query("SET LOCAL parallel_tuple_cost=0");
      await client.query("SET LOCAL debug_parallel_query=on");
      const result = await client.query(
        `SELECT count(*) FILTER (WHERE analytics.tracking_in_zone(
           0.016251,0.7083,50,z0,-129.265,-4.59198,23.8626,-16.4274,1.504,3.067
         ))::text AS inside FROM workbench.zone_parallel_test_samples`,
      );
      expect(result.rows).toEqual([{ inside: "5000" }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("존 밖 스윙과 지켜본 공을 구분하고 높이 미제공 투구를 chase 분모에서 제외한다", async () => {
    const fixture = await golden();
    const template = fixture.trackingCandidates[0];
    if (template === undefined) throw new Error("tracking fixture 필요");
    const base = parseStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        ...["swinging_strike", "swinging_strike", "ball", "swinging_strike"].map((call, index) => ({
          kind: "pitch",
          payload: { call, sourcePitchId: `p${index}` },
        })),
        {
          kind: "plate_result",
          payload: { result: "strikeout", batterId: "a1", pitcherId: "hp1" },
        },
      ]),
    );
    const t = plateTracking();
    const document = parseStagingGameDocumentV2({
      ...base,
      trackingCandidates: [0, 1, 2, 3].map((index) => ({
        ...template,
        trackingId: `t${index}`,
        sourcePitchId: `p${index}`,
        sourcePitchOrdinal: index + 1,
        sequence: index,
        source: { ...template.source, rowIndex: index },
        crossPlateX: t.crossPlateX,
        crossPlateY: t.crossPlateY,
        y0: t.y0,
        ...(index === 3 ? {} : { z0: index === 0 ? t.z0 : 6.28675 }),
        vy0: t.vy0,
        vz0: t.vz0,
        ay: t.ay,
        az: t.az,
        bottomSz: 1.5,
        topSz: 0.375,
        resolution: { kind: "linked", pitchEventId: `e${index + 2}` },
      })),
    });
    await store.importRevision(document);
    await seedBatterHeights(pool, document);
    expect(
      (
        await pool.query(
          "SELECT in_zone,chase FROM analytics.current_pitches ORDER BY pitch_sequence",
        )
      ).rows,
    ).toEqual([
      { in_zone: true, chase: false },
      { in_zone: false, chase: true },
      { in_zone: false, chase: null },
      { in_zone: null, chase: null },
    ]);
    expect(
      (
        await pool.query(
          "SELECT zone_opportunities::text,chase_opportunities::text,chases::text,chase_rate FROM analytics.current_player_season_pitching WHERE player_id='hp1'",
        )
      ).rows,
    ).toEqual([
      { zone_opportunities: "3", chase_opportunities: "2", chases: "1", chase_rate: 0.5 },
    ]);
    const outcomes = new PitchLocationRepository(
      pool,
      new BoundedReadCache<PitchOutcomeSnapshot>(1024 * 1024, 8, 60_000),
    );
    const scope = { season: document.metadata.season, competition: "unknown" as const };
    const beforePolicy = await outcomes.analyze(scope, "hp1");
    await pool.query(
      "UPDATE catalog.tracking_measurement_profiles SET supports_zone=FALSE,zone_formula_version=NULL WHERE measurement_profile_id='naver_pts_v1'",
    );
    try {
      const afterPolicy = await outcomes.analyze(scope, "hp1");
      expect(afterPolicy.sourceHash).not.toBe(beforePolicy.sourceHash);
      expect(afterPolicy).toEqual(await new PitchLocationRepository(pool).analyze(scope, "hp1"));
      expect(
        (await pool.query("SELECT DISTINCT in_zone,chase FROM analytics.current_pitches")).rows,
      ).toEqual([{ in_zone: null, chase: null }]);
    } finally {
      await pool.query(
        "UPDATE catalog.tracking_measurement_profiles SET supports_zone=TRUE,zone_formula_version=4 WHERE measurement_profile_id='naver_pts_v1'",
      );
    }
  });

  it("같은 plate y의 궤적 높이로 zone을 분류하고 미제공은 분모에서 제외한다", async () => {
    const fixture = await golden();
    const t = plateTracking();
    const document = parseStagingGameDocumentV2({
      ...fixture,
      trackingCandidates: fixture.trackingCandidates.map((candidate, index) => ({
        ...candidate,
        ...(index === 0 ? { sourcePitchOrdinal: null } : {}),
        crossPlateX: t.crossPlateX,
        crossPlateY: t.crossPlateY,
        y0: t.y0,
        z0: index === 0 ? t.z0 : 6.28675,
        vy0: t.vy0,
        vz0: t.vz0,
        ay: t.ay,
        az: t.az,
        bottomSz: 1.5,
        topSz: 0.375,
      })),
    });
    await store.importRevision(document);
    await seedBatterHeights(pool, document);
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
    const rates = await pool.query(
      `SELECT zone_opportunities::text,pitches_in_zone::text,chase_opportunities::text,
              chases::text,zone_rate,chase_rate
       FROM analytics.current_player_season_pitching WHERE player_id='hp1'`,
    );
    expect(rates.rows).toEqual([
      {
        zone_opportunities: "2",
        pitches_in_zone: "1",
        chase_opportunities: "1",
        chases: "0",
        zone_rate: 0.5,
        chase_rate: 0,
      },
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
    const repository = new RegistryRepository(pool, EXPECTED_MIGRATION_VERSION);
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
    const repository = new RegistryRepository(pool, EXPECTED_MIGRATION_VERSION);
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
        analytics_contract_version: 4,
        projection_version: 4,
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

function recordCorrectionSeasonFixture() {
  return parseRecordCorrectionSeasonDataset({
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
}

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

function verifiedImportJobs(
  workspace: StagingWorkspace,
  store: GameRevisionStore,
  service: RecordCorrectionService,
) {
  return new ImportJobManager(
    workspace,
    store,
    undefined,
    undefined,
    2,
    undefined,
    service.verifyPublication.bind(service),
  );
}

function runningImport(jobId: string, target: ImportTarget): ImportJobRecord {
  const at = "2026-11-22T00:00:00.000Z";
  return {
    publicationPending: true,
    sourceSeason: target.season,
    target,
    request: {
      gameId: target.gameId,
      idempotencyKey: "recover-" + jobId,
      expectedDocumentHash: target.documentHash,
    },
    job: {
      jobId,
      kind: "import",
      status: "running",
      gameId: target.gameId,
      createdAt: at,
      startedAt: at,
      finishedAt: null,
      revision: null,
      documentHash: null,
      projectionHash: null,
      error: null,
      errorCategory: null,
    },
  };
}

async function openCurrentRecordCorrectionDraft(
  service: RecordCorrectionService,
  noticeId: string,
) {
  const current = await service.case(noticeId);
  if (current === null) throw new Error("missing fixture case");
  return service.createDraft(noticeId, current.caseVersion);
}

async function applyAndSaveNotice(
  service: RecordCorrectionService,
  sessions: CorrectionSessionManager,
  noticeId: string,
  save = true,
) {
  const opened = await openCurrentRecordCorrectionDraft(service, noticeId);
  const proposal = await service.proposal(opened.sessionId, noticeId);
  expect(proposal.eligible, proposal.reasons.join(" ")).toBe(true);
  const applied = await service.applyProposal(
    opened.sessionId,
    noticeId,
    opened.sessionVersion,
    proposal.proposalHash,
  );
  if (save)
    await sessions.commit(opened.sessionId, {
      expectedSessionVersion: applied.session.sessionVersion,
      allowBlockingStaging: false,
    });
  return { proposal, session: applied.session };
}

async function exitAfterSealing(root: string, gameId: string, documentHash: string): Promise<void> {
  const child = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { Pool } from "pg";
      import { GameRevisionStore, RecordCorrectionRepository, StagingWorkspace } from "./packages/persistence/dist/index.js";
      import { EXPECTED_MIGRATION_VERSION } from "./apps/server/dist/config.js";
      import { ImportJobManager } from "./apps/server/dist/jobs/import-job-manager.js";
      import { CorrectionSessionManager } from "./apps/server/dist/correction-session-manager.js";
      import { RecordCorrectionService } from "./apps/server/dist/record-correction-service.js";
      const [root, gameId, expectedDocumentHash] = process.argv.slice(1);
      const pool = new Pool({ connectionString: process.env.KBO_TEST_POSTGRES_DSN });
      const store = new GameRevisionStore(pool, EXPECTED_MIGRATION_VERSION);
      const workspace = await StagingWorkspace.open(root);
      const service = new RecordCorrectionService(
        new RecordCorrectionRepository(pool, EXPECTED_MIGRATION_VERSION),
        store, workspace, new CorrectionSessionManager(workspace),
      );
      const job = new ImportJobManager(workspace, {
        importPublication: store.importPublication.bind(store),
        async importRevision(document, options) {
          const sealed = await store.importRevision(document, options);
          process.stdout.write(String(sealed.revision), () => process.exit(0));
          await new Promise(() => {});
        },
      }, undefined, undefined, 2, undefined, service.verifyPublication.bind(service));
      const created = await job.create({ gameId, expectedDocumentHash, idempotencyKey: "restore-approval" });
      const result = await job.waitForTerminal(created.jobId);
      throw new Error(result.error ?? "worker did not exit immediately after seal");
    `,
      root,
      gameId,
      documentHash,
    ],
    { timeout: 30000 },
  );
  expect(child.stdout).toBe("2");
}

async function recordCorrectionLifecycleFixture() {
  const { document, notice } = await recordCorrectionVenueFixture();
  return {
    document: parseStagingGameDocumentV2({
      ...document,
      events: document.events.map((event) =>
        event.identity.eventId === "e10" && event.kind === "plate_result"
          ? { ...event, payload: { ...event.payload, result: "single" } }
          : event,
      ),
    }),
    notice: {
      ...notice,
      decisionBefore: "hit" as const,
      decisionAfter: "error" as const,
      beforeRecordText: "안타",
      afterRecordText: "실책",
    },
  };
}

async function seedVenueCorrectionNotice(
  repository: RecordCorrectionRepository,
  ...notices: RecordCorrectionNotice[]
): Promise<void> {
  await publishVenueNotices(repository, "assessment-race", "d", notices);
}

async function publishVenueNotices(
  repository: RecordCorrectionRepository,
  runId: string,
  hash: string,
  notices: readonly RecordCorrectionNotice[],
): Promise<void> {
  const dataset = recordCorrectionSeasonFixture();
  const season = parseRecordCorrectionSeasonDataset({
    ...dataset,
    season: 2025,
    sourcePages: dataset.sourcePages.map((page) => ({
      ...page,
      requestKey: page.requestKey.replaceAll("2024", "2025"),
      ...(page.pageKind === "records"
        ? { rowCount: notices.length, totalCount: notices.length }
        : {}),
    })),
    notices,
  });
  await repository.createJob(runId, "manual", runId, [2025], season.collectedAt);
  await repository.importSeason(runId, season, hash.repeat(64));
}

async function blockedBackend(
  pool: Pool,
  blocker: number,
  waitEvent: string | null,
): Promise<number> {
  return vi.waitFor(
    async () => {
      const result = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
       WHERE $1=ANY(pg_blocking_pids(pid)) AND ($2::text IS NULL OR wait_event=$2)`,
        [blocker, waitEvent],
      );
      const pid = result.rows[0]?.pid;
      if (pid === undefined) throw new Error("잠금을 기다리는 PostgreSQL 연결이 없습니다.");
      return pid;
    },
    { timeout: 3000 },
  );
}

async function recordCorrectionGolden() {
  const document = await golden();
  const notice = recordCorrectionNotice();
  return parseStagingGameDocumentV2({
    ...document,
    metadata: { ...document.metadata, season: 2024, gameDate: notice.gameDate },
    teams: {
      away: { ...document.teams.away, name: notice.awayTeamName },
      home: { ...document.teams.home, name: notice.homeTeamName },
    },
  });
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
