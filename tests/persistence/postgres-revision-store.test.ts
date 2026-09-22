import {
  PitchQualityRepository,
  AnalysisModelSourceRepository,
  pitchQualitySourceHash,
  trainPitchQualityFromFacts,
} from "@kbo/persistence";
import { ParkEnvironmentRepository } from "@kbo/persistence";
import { trainCountRunExpectancy, trainWinProbability, trainMatchupModel } from "@kbo/game-core";
import { regulationGame } from "../helpers/regulation-game.js";
import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { applyCorrectionCommand } from "@kbo/correction";

import {
  parseRecordCorrectionSeasonDataset,
  parseRegistrySeasonDataset,
  parseStagingGameDocumentV2,
  type PitchAnalysisSample,
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
  PlayerStatisticsRepository,
  PitchLocationRepository,
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
  PlayerHeightSupplementRepository,
  StagingWorkspace,
  RecordCorrectionRepository,
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
import { pitchAnalysisFixture } from "../helpers/pitch-analysis-fixture.js";
import { competitionFixture } from "../helpers/game-competition.js";
import { BoundedReadCache } from "../../apps/server/src/bounded-read-cache.js";
import { ComputationPool } from "../../apps/server/src/computation-pool.js";
import {
  compileDocument,
  createRevisionProjectionComputation,
} from "../../apps/server/src/computation.js";

const dsn = process.env.KBO_TEST_POSTGRES_DSN;
const describeIntegration = dsn === undefined ? describe.skip : describe;

describeIntegration("PostgreSQL 16 V3 revision 및 analytics", () => {
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
    expect(first.quality).toBe(
      pitchQualitySourceHash((await new PitchQualityRepository(pool).training(2024)).manifest),
    );
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
    const before = await repo.snapshot(2024);
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
    const after = await repo.snapshot(2024, before.sourceHash);
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
      "0012_competition_game_links",
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
      "0012_competition_game_links",
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
      "0012_competition_game_links",
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
    const missing = await repo.snapshot(2024);
    expect(missing.rows?.every((r) => r.inZone === null && r.batterHeightCm === null)).toBe(true);
    expect(
      (await new BatterStrikeZoneRepository(pool).forGame(document.metadata.gameId, 1)).size,
    ).toBe(0);
    await seedBatterHeights(pool, document, 180);
    const snapshot = await repo.snapshot(2024, missing.sourceHash);
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
    const taller = await repo.snapshot(2024, snapshot.sourceHash);
    expect(taller.sourceHash).not.toBe(snapshot.sourceHash);
    expect(taller.rows?.every((r) => r.batterHeightCm === 190)).toBe(true);
  });

  it.each([2020, 2023, 2024, 2025, 2026])(
    "SQL and game-core use identical height rules for %i",
    async (season) => {
      const { resolveBatterStrikeZone } = await import("@kbo/game-core");
      for (const height of [100, 168, 180, 200, 250]) {
        const zone = resolveBatterStrikeZone(season, height);
        const result = await pool.query(
          "SELECT analytics.batter_zone_top($1,$2) AS top, analytics.batter_zone_bottom($1,$2) AS bottom",
          [season, height],
        );
        expect(result.rows).toEqual([{ top: zone?.topFeet, bottom: zone?.bottomFeet }]);
      }
    },
  );
  it.each(["project", "hash", "reproject"])(
    "projection worker failure at %s rolls back every fact",
    async (failure) => {
      const workers = new ComputationPool(1);
      const computation = createRevisionProjectionComputation(workers);
      const document = pitchAnalysisFixture(2024);
      let projects = 0;
      try {
        const failing = new GameRevisionStore(pool, "0012_competition_game_links", undefined, {
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
    store = new GameRevisionStore(pool, "0012_competition_game_links");
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE reference.competition_datasets CASCADE");
    await pool.query(
      "TRUNCATE record_correction.collection_runs,record_correction.season_current_revisions CASCADE",
    );
    await pool.query(
      "TRUNCATE registry.game_height_bundles,registry.official_player_heights,registry.collection_runs,registry.season_current_revisions,workbench.games CASCADE",
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
    const bat = await repository.batting({ season: 2024, competition: "all" });
    expect(bat.rows.find((r) => r.playerId === "a1")).toMatchObject({
      plateAppearances: 1,
      atBats: 1,
      strikeouts: 1,
      kRate: 1,
      avg: 0,
    });
    const pitcher = await repository.pitching({ season: 2024, competition: "all" });
    expect(pitcher.rows.find((r) => r.playerId === "hp1")).toMatchObject({
      battersFaced: 1,
      pitches: 4,
      outsRecorded: 1,
      knownErGames: 0,
      era: null,
      knownGamesEra: null,
    });
    const teams = await repository.batting({ season: 2024, competition: "all", group: "team" });
    expect(teams.rows.reduce((n, r) => n + r.plateAppearances, 0)).toBe(
      bat.rows.reduce((n, r) => n + r.plateAppearances, 0),
    );
    expect(teams.rows.every((r) => r.playerId === null)).toBe(true);
    const draft = await store.loadCorrectionDraft(source.metadata.gameId, 1);
    await store.importRevision(draft);
    const next = await repository.pitching({ season: 2024, competition: "all" });
    expect(next.sourceHash).not.toBe(pitcher.sourceHash);
    expect(next.rows).toEqual(pitcher.rows);
    expect((await repository.batting({ season: 2024, competition: "all", minPA: 2 })).rows).toEqual(
      [],
    );
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
      expect((await repository.analyze(2024, "hp1")).actualPitchCount).toBe(4);
      const discipline = new BatterDisciplineRepository(
        single,
        { getOrCreate: async (_key, calculate) => calculate() },
        async (...args) => {
          await check();
          return preparePitchAnalysisReference(...args);
        },
      );
      expect((await discipline.snapshot(2024)).rows).toHaveLength(4);
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

  it("uses the same competition for target, reference and calibration while dates only narrow the target", async () => {
    const source = pitchAnalysisFixture(2024);
    const second = parseStagingGameDocumentV2({
      ...pitchAnalysisFixture(2024, "hp1", -100),
      source: { ...source.source, sourceGameId: "other-game" },
      metadata: { ...source.metadata, gameId: "postseason-game", gameDate: "2024-10-01" },
    });
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
    const before = await pitch.analyze(2024, "hp1", { competition: "regular" });
    const disciplineBefore = await discipline.snapshot(2024, undefined, { competition: "regular" });
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
    ]);
    await new GameCompetitionRepository(pool).adopt(dataset);
    const after = await pitch.analyze(2024, "hp1", { competition: "regular" });
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect(after.actualPitchCount).toBe(4);
    expect(after.baseline?.candidateCount).toBe(3);
    expect((await pitch.catalog(2024, { competition: "postseason" })).pitchers[0]?.pitches).toBe(4);
    const narrow = await pitch.analyze(2024, "hp1", {
      competition: "regular",
      dateFrom: "2024-06-02",
    });
    expect(narrow.actualPitchCount).toBe(0);
    expect(narrow.baseline).toEqual(after.baseline);
    expect(narrow.calibration.profileHash).toBe(after.calibration.profileHash);
    const summary = await coverage.read(2024, {
      competition: "regular",
      dateFrom: "2024-06-01",
      dateTo: "2024-06-01",
    });
    expect(summary.total.games).toBe(1);
    expect(summary.unclassifiedGames).toBe(0);
    expect((await coverage.read(2024, { competition: "unknown" })).total.games).toBe(0);
    const disc = await discipline.snapshot(2024, disciplineBefore.sourceHash, {
      competition: "regular",
    });
    expect(disc.sourceHash).not.toBe(disciplineBefore.sourceHash);
    expect(disc.rows).toHaveLength(4);
    expect(disc.reference?.summary.candidateCount).toBe(3);
  });

  it("keeps pitch outcomes separate from official terminal PA grain and current revision", async () => {
    const source = pitchAnalysisFixture(2024);
    await store.importRevision(source);
    const query = { season: 2024, competition: "all" as const };
    const pitch = await new PitchLocationRepository(pool).analyze(query, "hp1");
    expect(pitch.total).toMatchObject({
      pitches: 4,
      swings: 3,
      whiffs: 3,
      twoStrikePitches: 2,
      terminalStrikeouts: 1,
    });
    expect(pitch.coverage).toMatchObject({ locationPitches: 0, missingLocation: 4 });
    const bat = await new BatterProfileRepository(pool).analyze(query, "a1");
    expect(bat.plateAppearances.total).toMatchObject({ pa: 1, ab: 1, strikeouts: 1 });
    expect(bat.plateAppearances.byTerminalType[0]?.key).toBe("직구");
    expect(bat.total.pitches).toBe(4);
    const draft = await store.loadCorrectionDraft(source.metadata.gameId, 1);
    await store.importRevision(
      parseStagingGameDocumentV2({ ...draft, metadata: { ...draft.metadata, stadium: "잠실" } }),
    );
    const next = await new PitchLocationRepository(pool).analyze(query, "hp1");
    expect(next.total).toEqual(pitch.total);
    expect(next.sourceHash).not.toBe(pitch.sourceHash);
    expect(
      (await new PitchLocationRepository(pool).analyze({ season: 2024 }, "hp1")).total.pitches,
    ).toBe(0);
  });

  it("preserves full sequence before pair filtering and does not skip missing tracking", async () => {
    await store.importRevision(pitchAnalysisFixture(2024));
    const result = await new PitchSequenceRepository(pool).analyze(
      { season: 2024, competition: "all" },
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
      { season: 2024, competition: "all", pitchType: "직구" },
      "hp1",
    );
    expect(filtered.pairs).toHaveLength(2);
    expect(filtered.pairs[0]?.previous.pitchType).toBe("슬라이더");
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
      const query = { season: 2024, competition: "all" as const, dateTo: "2024-06-01" };
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
      competition: "all" as const,
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
  it("aggregates workload conditions from current pitch facts with missing tracking retained and snapshot lookback", async () => {
    const original = pitchAnalysisFixture(2024),
      source = parseStagingGameDocumentV2({
        ...original,
        trackingCandidates: original.trackingCandidates.map((c) => ({ ...c, stance: "R" })),
      });
    await store.importRevision(source);
    const query = { season: 2024, competition: "all" as const, dateTo: "2024-06-01" },
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
            pitchType: "fast",
            speedKph: 140,
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
      query = { season: 2026, competition: "all" as const };
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
      query = { season: 2026, competition: "all" as const };
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
    const result = await new MatchupRepository(pool).analyze({
      season: 2024,
      competition: "all",
      pitcherId: "hp1",
      batterId: "a1",
    });
    expect(result.direct.pitches).toBe(4);
    expect(result.directPlateAppearances).toHaveLength(1);
    expect(result.similar.pitches).toBe(0);
    expect(result.excludedSimilar).toBe(4);
    expect(result.conditions).toEqual([]);
    expect(result.predictionStatus).toBe("not_validated");
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
      const missing = await initial.inspect(2024);
      expect(missing.response).toBeNull();
      const first = await initial.read(2024);
      const restarted = makeRepository();
      expect((await restarted.inspect(2024)).response).toEqual(first);
      expect(
        (
          await restarted.inspect(2024, {
            dateFrom: source.metadata.gameDate,
            dateTo: source.metadata.gameDate,
          })
        ).response?.total,
      ).toEqual(first.total);
      expect(
        (await restarted.inspect(2024, { dateFrom: "2024-12-31" })).response?.total.games,
      ).toBe(0);
      expect(calibrate).toHaveBeenCalledTimes(1);
      // Unrelated season imports do not invalidate the prepared year.
      await store.importRevision(pitchAnalysisFixture(2023));
      expect((await restarted.inspect(2024)).sourceKey).toBe(missing.sourceKey);
      await seedBatterHeights(pool, source, 185);
      const heights = await restarted.inspect(2024);
      expect(heights.response).toBeNull();
      expect(heights.sourceKey).not.toBe(missing.sourceKey);
      const withHeight = await restarted.read(2024);
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
    const before = await repository.read(2024);
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
    expect(await repository.read(2024)).toEqual(before);
    expect(calibrate).toHaveBeenCalledTimes(1);
    before.total.games = 500;
    expect((await repository.read(2024)).total.games).toBe(1);
    await seedBatterHeights(pool, source, 185);
    const withHeight = await repository.read(2024);
    expect(withHeight.total.zoneKnown).toBeGreaterThan(0);
    expect(withHeight.sourceHash).not.toBe(before.sourceHash);
    expect(calibrate).toHaveBeenCalledTimes(2);
    const draft = await store.loadCorrectionDraft(source.metadata.gameId, 1);
    await store.importRevision(
      parseStagingGameDocumentV2({ ...draft, metadata: { ...draft.metadata, stadium: "잠실" } }),
    );
    const after = await repository.read(2024);
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
      const failing = new GameRevisionStore(pool, "0012_competition_game_links", async (input) => {
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
        "0012_competition_game_links",
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
      Array.from({ length: 3 }, () => repository.analyze(2024, "hp1")),
    );
    expect(computation.sample).toHaveBeenCalledTimes(1);
    expect(computation.reference).toHaveBeenCalledTimes(1);
    const expected = await new PitchAnalysisRepository(pool).analyze(2024, "hp1");
    expect(first[0]).toEqual(expected);
    first[0]?.points.splice(0);
    expect(await repository.analyze(2024, "hp1")).toEqual(expected);
    expect(computation.sample).toHaveBeenCalledTimes(1);
    await store.importRevision(pitchAnalysisFixture(2025));
    expect(await repository.analyze(2024, "hp1")).toEqual(expected);
    expect(computation.sample).toHaveBeenCalledTimes(1);
    const draft = await store.loadCorrectionDraft("analysis-2024-hp1", 1);
    await store.importRevision(draft);
    const updated = await repository.analyze(2024, "hp1");
    expect(updated.sourceHash).not.toBe(expected.sourceHash);
    expect(updated.points.every((point) => point.revision === 2)).toBe(true);
    expect(computation.sample).toHaveBeenCalledTimes(2);
    expect(updated).toEqual(await new PitchAnalysisRepository(pool).analyze(2024, "hp1"));
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
    expect((await store.catalogPage({ authority: "database", page: 3, limit: 1 })).games).toEqual(
      [],
    );
  });

  it("타자 선구안은 같은 snapshot의 typed 코스·판단을 읽고 기준 캐시와 current revision을 공유한다", async () => {
    await store.importRevision(pitchAnalysisFixture(2024));
    await store.importRevision(pitchAnalysisFixture(2025));
    await seedBatterHeights(pool, pitchAnalysisFixture(2024));
    const repository = new BatterDisciplineRepository(pool, {
      getOrCreate: async (_key, calculate) => calculate(),
    });
    const catalog = await repository.catalog(2024);
    expect(catalog.batters).toEqual([expect.objectContaining({ batterId: "a1", pitches: 4 })]);
    const snapshot = await repository.snapshot(2024);
    const shape = await new PitchAnalysisRepository(pool).analyze(2024, "hp1");
    expect(snapshot.sourceHash).not.toBe(shape.sourceHash);
    expect(snapshot.reference?.summary).toMatchObject({
      candidateCount: shape.baseline?.candidateCount,
      sampleCount: shape.baseline?.sampleCount,
    });
    // Discipline keeps the source front plane; movement uses the middle plane.
    expect(snapshot.reference?.summary.arrivalMs).toBeCloseTo(358.4986883527349, 8);
    expect(shape.baseline?.arrivalMs).toBeCloseTo(363.9073091983306, 8);
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
    expect((await repository.snapshot(2024, snapshot.sourceHash)).rows).toBeNull();
    const draft = await store.loadCorrectionDraft("analysis-2024-hp1", 1);
    await store.importRevision(draft);
    const updated = await repository.snapshot(2024, snapshot.sourceHash);
    expect(updated.sourceHash).not.toBe(snapshot.sourceHash);
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
    const repository = new RecordCorrectionRepository(pool, "0012_competition_game_links");
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

  it("기록정정 source revision을 봉인하고 no-change와 append-only 검토 이력을 보장한다", async () => {
    const repository = new RecordCorrectionRepository(pool, "0012_competition_game_links");
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
    for (let i = 0; i < 6; i++) {
      const base = pitchAnalysisFixture(2024);
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
          trackingCandidates: base.trackingCandidates.map((t) => ({
            ...t,
            ax: i - 8,
            vy0: -140 - i,
            az: i % 2 === 0 ? -15 : -18,
          })),
        }),
      );
    }
    const repository = new PitchAnalysisRepository(pool);
    const data = await repository.analyze(2024, "hp1");
    // The third tracking now has az too, so each game contributes two valid fastballs.
    expect(data.referenceDistribution?.sampleCount).toBe(12);
    expect(data.referenceDistribution?.central90.includedCount).toBeGreaterThanOrEqual(11);
    expect(data.referenceDistribution).toEqual(
      (await repository.analyze(2024, "hp2")).referenceDistribution,
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

  it("시즌 평균 포심은 투수 선택과 독립이고 current revision만 사용한다", async () => {
    const repository = new PitchAnalysisRepository(pool);
    await store.importRevision(pitchAnalysisFixture(2024));
    await store.importRevision(pitchAnalysisFixture(2025));
    await store.importRevision(pitchAnalysisFixture(2025, "hp2", -150));
    const first = await repository.analyze(2025, "hp1");
    const second = await repository.analyze(2025, "hp2");
    const previousSeason = await repository.analyze(2024, "hp1");
    expect(first.baseline).toEqual(second.baseline);
    expect(first.baseline).toMatchObject({ candidateCount: 6, sampleCount: 2, excludedCount: 4 });
    expect(previousSeason.baseline).toMatchObject({ candidateCount: 3, sampleCount: 1 });
    expect(previousSeason.baseline?.arrivalMs).not.toBe(first.baseline?.arrivalMs);
    expect(first).toMatchObject({
      actualPitchCount: 4,
      missingTrackingCount: 1,
      invalidTrackingCount: 1,
    });
    expect(first.points).toHaveLength(2);
    expect(first.calibration).toMatchObject({
      plane: "middle",
      calibratedCount: 0,
      uncalibratedCount: 2,
    });
    expect(
      first.points.every(
        (point) => point.calibrationStatus !== "applied" && point.calibrationXcm === null,
      ),
    ).toBe(true);
    expect(first.referenceDistribution).toBeNull();
    expect(first.points.every((p) => p.swing && p.whiff && p.referenceBand === null)).toBe(true);
    expect(first.points.every((point) => !("clusterId" in point))).toBe(true);
    expect(first.points[1]?.timingDifferenceMs).toBeGreaterThan(0);
    expect((await repository.catalog(2025)).pitchers).toHaveLength(2);
    const empty = await repository.analyze(2023, "hp1");
    expect(empty.baseline).toBeNull();
    expect(empty.points).toEqual([]);
    const before = await store.revisions("analysis-2025-hp1");
    const draft = await store.loadCorrectionDraft("analysis-2025-hp1", 1);
    await store.importRevision(draft);
    const after = await repository.analyze(2025, "hp1");
    expect(after.baseline).toEqual(first.baseline);
    expect(after.sourceHash).not.toBe(first.sourceHash);
    expect(after.points.every((point) => point.revision === 2)).toBe(true);
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
      const first = await repository.analyze(2024, "hp1");
      expect(first).toEqual(await uncached.analyze(2024, "hp1"));
      expect(await repository.analyze(2024, "hp2")).toEqual(await uncached.analyze(2024, "hp2"));
      expect(calculations).toBe(1);
      expect(calibrationCalculations).toBe(1);
      await workspace.close();
      workspace = await StagingWorkspace.open(temporary.path);
      expect(await repository.analyze(2024, "hp1")).toEqual(first);
      expect(calculations).toBe(1);
      const draft = await store.loadCorrectionDraft("analysis-2024-hp2", 1);
      await store.importRevision({
        ...pitchAnalysisFixture(2024, "hp2", -155),
        revisionBase: draft.revisionBase,
      });
      const updated = await repository.analyze(2024, "hp1");
      expect(updated.sourceHash).not.toBe(first.sourceHash);
      expect(updated.baseline?.arrivalMs).not.toBe(first.baseline?.arrivalMs);
      expect(updated).toEqual(await uncached.analyze(2024, "hp1"));
      expect(calculations).toBe(2);
      expect(calibrationCalculations).toBe(2);
      await store.importRevision(pitchAnalysisFixture(2025));
      expect(await repository.analyze(2025, "hp1")).toEqual(await uncached.analyze(2025, "hp1"));
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
    await pool.query(
      "UPDATE catalog.tracking_measurement_profiles SET supports_zone=FALSE,zone_formula_version=NULL WHERE measurement_profile_id='naver_pts_v1'",
    );
    try {
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
    const repository = new RegistryRepository(pool, "0012_competition_game_links");
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
    const repository = new RegistryRepository(pool, "0012_competition_game_links");
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
