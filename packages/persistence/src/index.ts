export { CollectionWorkspace } from "./collection-workspace.js";
export { ImportWorkspace } from "./import-workspace.js";
export { readImmutableSourceBundle } from "./source-bundle-reader.js";
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
  type RevisionProjectionComputation,
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
export { recordCorrectionEligibleGames } from "./record-correction-matchups.js";
export {
  RecordCorrectionRepository,
  RecordCorrectionStaleError,
  matchesRecordCorrectionDoubleheader,
  type RecordCorrectionAssessmentBasis,
  type RecordCorrectionAssessmentInput,
  type RecordCorrectionGameCandidate,
  type RecordCorrectionApprovalEvidence,
  type RecordCorrectionApprovalPlan,
  type RecordCorrectionMatchupContext,
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
export { deduplicateStoredFindings, storedCompilerFindings } from "./workspace-findings.js";
export {
  PitchAnalysisRepository,
  prepareReference as preparePitchAnalysisReference,
  analyzeRows as calculatePitchAnalysisSample,
  type PitchAnalysisRow,
  type PitchAnalysisComputation,
} from "./pitch-analysis-repository.js";
export { PitchReferenceWorkspace } from "./pitch-reference-workspace.js";
export { BatterDisciplineRepository } from "./batter-discipline-repository.js";
export {
  DisciplinePreparedWorkspace,
  type DisciplineCacheScope,
} from "./discipline-prepared-workspace.js";
export { BatterStrikeZoneRepository } from "./batter-strike-zone-repository.js";
export { PlayerHeightRepository } from "./player-height-repository.js";
export { PlayerBattingProfileRepository } from "./player-batting-profile-repository.js";
export { OfficialPitcherHandRepository } from "./official-pitcher-hand-repository.js";
export { PlayerHeightSupplementRepository } from "./player-height-supplement-repository.js";
export { PitchCalibrationWorkspace } from "./pitch-calibration-workspace.js";
export {
  calculatePitchCalibration,
  preparePitchCalibrationCells,
  pitchCalibrationParkId,
} from "./pitch-calibration.js";
export { AnalysisCoverageWorkspace } from "./analysis-coverage-workspace.js";
export type { CoverageSeason } from "./analysis-coverage-summary.js";
export {
  AnalysisCoverageRepository,
  type CoverageInspection,
} from "./analysis-coverage-repository.js";
export {
  GameCompetitionRepository,
  CompetitionScheduleNoMatchesError,
} from "./game-competition-repository.js";
export { PlayerStatisticsRepository } from "./player-statistics-repository.js";
export { PlayerDirectoryRepository } from "./player-directory-repository.js";
export {
  OfficialCareerWorkspace,
  readOfficialPlayerCareers,
  readOfficialPlayerBirthYears,
} from "./official-career-workspace.js";
export { PitchLocationRepository } from "./pitch-location-repository.js";
export { BatterProfileRepository } from "./batter-profile-repository.js";
export { type PitchOutcomeCache, type PitchOutcomeSnapshot } from "./pitch-outcomes.js";
export { PitcherChangesRepository } from "./pitcher-changes-repository.js";
export { PitchSequenceRepository } from "./pitch-sequence-repository.js";
export { PitchReleaseRepository } from "./pitch-release-repository.js";
export { BaserunningAnalysisRepository } from "./baserunning-analysis-repository.js";
export { PitcherWorkloadRepository } from "./pitcher-workload-repository.js";
export { WorkloadComparisonRepository } from "./workload-comparison-repository.js";
export { MatchupRepository } from "./matchup-repository.js";
export { RunValueRepository, runTrainingHash } from "./run-value-repository.js";
export { RunExpectancyWorkspace, RunTrainingManifestSchema } from "./run-expectancy-workspace.js";
export { ParkEnvironmentRepository, parkTrainingHash } from "./park-environment-repository.js";
export {
  ParkEnvironmentWorkspace,
  ParkTrainingManifestSchema,
} from "./park-environment-workspace.js";
export { AnalysisModelSourceRepository } from "./analysis-model-source-repository.js";
export { AnalysisModelJobWorkspace } from "./analysis-model-job-workspace.js";

export {
  PitchQualityRepository,
  PitchQualityManifestSchema,
  pitchQualitySourceHash,
  type PitchQualityManifest,
} from "./pitch-quality-repository.js";
export { PitchQualityWorkspace } from "./pitch-quality-workspace.js";
export { trainPitchQualityFromFacts } from "./pitch-quality-training.js";
export { MatchupModelRepository } from "./matchup-model-repository.js";
export { MatchupModelWorkspace } from "./matchup-model-workspace.js";
export { PitchAnglesRepository } from "./pitch-angles-repository.js";
export {
  AnalysisPreparationWorkspace,
  COMPETITION_CLASSIFICATION_POLICY_VERSION,
  type CompetitionClassificationCheckpoint,
} from "./analysis-preparation-workspace.js";
