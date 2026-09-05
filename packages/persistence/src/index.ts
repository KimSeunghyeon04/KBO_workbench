export {
  buildRelationalProjection,
  decodeProjectionRow,
  hashProjectionTables,
  projectionCounts,
  PROJECTION_TABLE_COLUMNS,
  PROJECTION_TABLE_DESCRIPTORS,
  type ProjectionCounts,
  type ProjectionRow,
  type ProjectionScalar,
  type ProjectionTableName,
  type ProjectionTables,
  type ProjectionVersion,
  type RelationalProjection,
} from "./projection.js";
export {
  BlockingImportError,
  DatabaseContractError,
  GameAlreadyImportedError,
  GameRevisionNotFoundError,
  GameRevisionStore,
  hydrateProjectionLedger,
  PersistenceIntegrityError,
  RevisionConflictError,
  type CurrentRevisionBase,
  type ImportedRevision,
  type ImportFailurePoint,
  type ImportOptions,
  type ProjectionLedgerManifest,
  type StoredCompiledRevision,
  type StoredReplayRelayEvent,
  type StoredReplayRosterPlayer,
  type StoredReplaySource,
} from "./revision-store.js";
export {
  RegistryRepository,
  type ImportedRegistryRevision,
  type RegistryDateRange,
} from "./registry-repository.js";
export { RegistryWorkspace, type StoredRegistryPage } from "./registry-workspace.js";
export {
  RecordCorrectionWorkspace,
  type StoredRecordCorrectionPage,
} from "./record-correction-workspace.js";
export {
  RecordCorrectionRepository,
  RecordCorrectionStaleError,
  type RecordCorrectionAssessmentInput,
  type RecordCorrectionGameCandidate,
  type RecordCorrectionImportedSeason,
} from "./record-correction-repository.js";
export {
  replayCompilerHash,
  replaySemanticHash,
  stagingSourceContentHash,
  V2CurrentRevisionExporter,
  type V2ExportedCurrentGame,
} from "./v2-current-export.js";
export {
  V3TransferWorkspace,
  type V3TransferGameArtifact,
  type V3TransferGameManifest,
  type V3TransferManifest,
} from "./v3-transfer-workspace.js";
export {
  StagingWorkspace,
  StaleStagingDocumentError,
  WorkspaceMigrationRequiredError,
  WorkspacePersistenceBlockedError,
  type CurrentDocumentSnapshot,
  type ImmutableSourceBundle,
  type SupersededDocumentSnapshot,
} from "./staging-workspace.js";
export {
  migrateWorkspaceLayout,
  verifyBackupDirectory,
  type WorkspaceMigrationConflict,
  type WorkspaceMigrationOptions,
  type WorkspaceMigrationReport,
} from "./workspace-migration.js";
export { type StagingCorrectionCommit, type StoredFinding } from "@kbo/contracts";
