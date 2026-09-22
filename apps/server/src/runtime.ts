import {
  extractNaverSourceEvidence,
  KboRecordCorrectionCollector,
  KboRecordCorrectionHttpClient,
  NaverGameCollector,
  NaverHttpClient,
  NaverSourceEvidenceError,
  PlaywrightScheduleExplorer,
} from "@kbo/collection";
import { GameRevisionStore, RecordCorrectionRepository, StagingWorkspace } from "@kbo/persistence";
import type { Pool } from "pg";

import type { AppConfig } from "./config.js";
import {
  CorrectionSessionManager,
  CorrectionSourceNotFoundError,
} from "./correction-session-manager.js";
import { CollectionJobManager } from "./jobs/collection-job-manager.js";
import { CollectionOperationsService } from "./collection-operations-service.js";
import { ImportJobManager } from "./jobs/import-job-manager.js";
import { RecordCorrectionJobManager } from "./jobs/record-correction-job-manager.js";
import { RecordCorrectionService } from "./record-correction-service.js";
import { ComputationPool } from "./computation-pool.js";
import { AnalysisModelService } from "./analysis-model-service.js";
import { AnalysisModelJobManager } from "./jobs/analysis-model-job-manager.js";
import { compileDocument, createRevisionProjectionComputation } from "./computation.js";

export interface AppRuntime {
  readonly analysisModelJobs?: AnalysisModelJobManager;
  readonly workspace: StagingWorkspace;
  readonly collectionJobs: CollectionJobManager;
  readonly collectionOperations?: CollectionOperationsService;
  readonly revisionStore: Pick<
    GameRevisionStore,
    | "catalog"
    | "catalogPage"
    | "catalogSeasons"
    | "countStoredGames"
    | "storedGameIds"
    | "currentRevisionBase"
    | "loadCompiled"
    | "loadCorrectionDraft"
    | "revisions"
  >;
  readonly importJobs: Pick<
    ImportJobManager,
    | "close"
    | "create"
    | "createReadyBatch"
    | "get"
    | "list"
    | "createSelection"
    | "history"
    | "cancel"
    | "cancelBatch"
    | "reconcile"
  >;
  readonly correctionSessions: Pick<
    CorrectionSessionManager,
    | "close"
    | "command"
    | "commit"
    | "create"
    | "delete"
    | "get"
    | "loadOriginal"
    | "original"
    | "redo"
    | "sourceEvidence"
    | "undo"
  >;
  readonly recordCorrectionRepository?: RecordCorrectionRepository;
  readonly recordCorrectionService?: RecordCorrectionService;
  readonly recordCorrectionJobs?: Pick<
    RecordCorrectionJobManager,
    "cancel" | "close" | "create" | "get" | "list" | "nextScheduledAt"
  >;
  close(): Promise<void>;
}

export async function createRuntime(config: AppConfig, pool: Pool): Promise<AppRuntime> {
  const workspace = await StagingWorkspace.open(config.workspacePath);
  const client = new NaverHttpClient({
    maxAttempts: config.collection.maxAttempts,
    requestsPerSecond: config.collection.requestsPerSecond,
    timeoutMs: config.collection.timeoutMs,
  });
  const computation = new ComputationPool();
  try {
    await computation.warmup();
  } catch (error: unknown) {
    await computation.close();
    await workspace.close();
    throw error;
  }
  const revisionStore = new GameRevisionStore(
    pool,
    config.expectedMigrationVersion,
    (document) => compileDocument(computation, document),
    createRevisionProjectionComputation(computation),
    async (document) => {
      const result = await computation.run({
        kind: "player_heights",
        root: config.workspacePath,
        season: document.metadata.season,
        gameId: document.metadata.gameId,
        hash: document.source.sourceBundleHash,
      });
      if (result.kind !== "player_heights") throw new Error("Unexpected player height result");
      return result.value;
    },
  );
  const correctionSessions = new CorrectionSessionManager(
    workspace,
    undefined,
    extractNaverSourceEvidence,
    undefined,
    computation,
    async (season, gameId, hash, event) => {
      try {
        const result = await computation.run({
          kind: "source_evidence",
          root: config.workspacePath,
          season,
          gameId,
          hash,
          event,
        });
        if (result.kind !== "source_evidence") throw new Error("Unexpected source evidence result");
        return result.value;
      } catch (error: unknown) {
        if (error instanceof NaverSourceEvidenceError)
          throw new CorrectionSourceNotFoundError(error.message);
        throw error;
      }
    },
  );
  const recordCorrectionRepository = new RecordCorrectionRepository(
    pool,
    config.expectedMigrationVersion,
  );
  const recordCorrectionService = new RecordCorrectionService(
    recordCorrectionRepository,
    revisionStore,
    workspace,
    correctionSessions,
    undefined,
    computation,
  );
  const collectionJobs = new CollectionJobManager(
    new PlaywrightScheduleExplorer(),
    new NaverGameCollector(client),
    workspace,
    config.collection.maxConcurrentJobs,
    undefined,
    undefined,
    (gameId) => revisionStore.currentRevisionBase(gameId),
    async (bundle, base, findings, signal) => {
      const result = await computation.run(
        { kind: "source", bundle, base, findings: findings ?? [] },
        signal,
      );
      if (result.kind !== "source") throw new Error("Unexpected source projection result");
      return result.value;
    },
  );
  await collectionJobs.restoreInterrupted(await workspace.recoverInterruptedCollectionJobs());
  const collectionOperations = new CollectionOperationsService(
    new PlaywrightScheduleExplorer(),
    workspace,
    async (gameIds) => ({ games: [...(await revisionStore.catalog(gameIds))] }),
  );
  await collectionOperations.restore();
  const importJobs = new ImportJobManager(
    workspace,
    revisionStore,
    undefined,
    undefined,
    2,
    (gameId, revision, documentHash) =>
      recordCorrectionService.afterImport(gameId, revision, documentHash),
  );
  await importJobs.restore();
  const recordCorrectionJobs = new RecordCorrectionJobManager(
    new KboRecordCorrectionCollector(
      new KboRecordCorrectionHttpClient({
        maxAttempts: config.recordCorrection.maxAttempts,
        requestsPerSecond: config.recordCorrection.requestsPerSecond,
        timeoutMs: config.recordCorrection.timeoutMs,
      }),
    ),
    recordCorrectionRepository,
    recordCorrectionService,
    config.workspacePath,
    {
      enabled: config.recordCorrection.autoSync,
      syncIntervalMs: config.recordCorrection.syncIntervalMs,
      retryIntervalMs: config.recordCorrection.retryIntervalMs,
    },
  );
  await recordCorrectionJobs.start();
  const analysisModelJobs = new AnalysisModelJobManager(
    workspace.analysisModelJobs,
    new AnalysisModelService(pool, workspace, config.workspacePath),
    undefined,
    undefined,
    (error) =>
      process.stderr.write(
        JSON.stringify({
          level: "error",
          event: "analysis_model_refresh_failed",
          message: error instanceof Error ? error.message : "Unknown model error",
        }) + "\n",
      ),
  );
  await analysisModelJobs.start();
  return {
    workspace,
    collectionJobs,
    collectionOperations,
    revisionStore,
    importJobs,
    correctionSessions,
    recordCorrectionRepository,
    recordCorrectionService,
    recordCorrectionJobs,
    analysisModelJobs,
    async close() {
      await analysisModelJobs.close();
      await recordCorrectionJobs.close();
      correctionSessions.close();
      await importJobs.close();
      await collectionJobs.close();
      await collectionOperations.close();
      recordCorrectionService.close();
      await computation.close();
      await workspace.close();
    },
  };
}
