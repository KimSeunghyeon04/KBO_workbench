import {
  extractNaverSourceEvidence,
  KboRecordCorrectionCollector,
  KboRecordCorrectionHttpClient,
  NaverGameCollector,
  NaverHttpClient,
  PlaywrightScheduleExplorer,
} from "@kbo/collection";
import { GameRevisionStore, RecordCorrectionRepository, StagingWorkspace } from "@kbo/persistence";
import type { Pool } from "pg";

import type { AppConfig } from "./config.js";
import { CorrectionSessionManager } from "./correction-session-manager.js";
import { CollectionJobManager } from "./jobs/collection-job-manager.js";
import { ImportJobManager } from "./jobs/import-job-manager.js";
import { RecordCorrectionJobManager } from "./jobs/record-correction-job-manager.js";
import { RecordCorrectionService } from "./record-correction-service.js";

export interface AppRuntime {
  readonly workspace: StagingWorkspace;
  readonly collectionJobs: CollectionJobManager;
  readonly revisionStore: Pick<
    GameRevisionStore,
    | "catalog"
    | "countStoredGames"
    | "currentRevisionBase"
    | "loadCompiled"
    | "loadCorrectionDraft"
    | "revisions"
  >;
  readonly importJobs: Pick<
    ImportJobManager,
    "close" | "create" | "createReadyBatch" | "get" | "list"
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
  const revisionStore = new GameRevisionStore(pool, config.expectedMigrationVersion);
  const correctionSessions = new CorrectionSessionManager(
    workspace,
    undefined,
    extractNaverSourceEvidence,
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
  );
  const collectionJobs = new CollectionJobManager(
    new PlaywrightScheduleExplorer(),
    new NaverGameCollector(client),
    workspace,
    config.collection.maxConcurrentJobs,
    undefined,
    undefined,
    (gameId) => revisionStore.currentRevisionBase(gameId),
  );
  collectionJobs.restoreInterrupted(await workspace.recoverInterruptedCollectionJobs());
  const importJobs = new ImportJobManager(
    workspace,
    revisionStore,
    undefined,
    undefined,
    2,
    (gameId, revision, documentHash) =>
      recordCorrectionService.afterImport(gameId, revision, documentHash),
  );
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
  return {
    workspace,
    collectionJobs,
    revisionStore,
    importJobs,
    correctionSessions,
    recordCorrectionRepository,
    recordCorrectionService,
    recordCorrectionJobs,
    async close() {
      await recordCorrectionJobs.close();
      correctionSessions.close();
      await importJobs.close();
      await collectionJobs.close();
      await workspace.close();
    },
  };
}
