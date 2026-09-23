export { stagingDocumentHash } from "./hash.js";
export { clusterPitchPositions, PITCH_CLUSTER_PARAMETERS } from "./pitch-clustering.js";
export {
  alignPitchTrajectory,
  averagePitchTrajectory,
  comparePitchTrajectory,
  pitchApproachAngles,
  type PitchTrajectoryInput,
  type AlignedPitchTrajectory,
  type PitchTrajectoryComparison,
} from "./pitch-trajectory.js";
export { compileStagingGameDocumentV2 } from "./reducer.js";
export {
  applyPitchCall,
  findTerminalPitchForPlateResult,
  isAtBat,
  isHit,
  isWalkTransferredToPreviousPitcher,
  requiredBatterDestination,
  thirdOutCancelsEveryRun,
  type CountTransition,
} from "./rules.js";
export type {
  ActivePlateAppearance,
  BaseOccupant,
  Bases,
  BatterLine,
  CompiledPlay,
  CompiledPitchFact,
  CompiledPlayKind,
  CompiledRunnerMovement,
  CompileResult,
  Finding,
  FindingCategory,
  FindingDetail,
  FindingSeverity,
  GameState,
  PitcherLine,
  BaserunnerLine,
  PlateAppearanceSummary,
  PlateAppearanceTerminationReason,
  ReplayFrame,
  ReplayResult,
} from "./types.js";

export const GAME_CORE_VERSION = "2";
export {
  disciplinePoint,
  prepareDisciplineSeason,
  analyzeBatterDiscipline,
  DISCIPLINE_MIN_CONTROLS,
  type PreparedDisciplineSeason,
} from "./batter-discipline.js";
export {
  fitPitchReferenceDistribution,
  pitchReferenceDistance,
  classifyPitchReference,
  summarizePitchExpectation,
} from "./pitch-expectation.js";
export { resolveBatterStrikeZone, STRIKE_ZONE_HALF_WIDTH_FEET } from "./strike-zone.js";
export {
  fitPitchCalibration,
  pitchCalibrationWindowStart,
  type PitchCalibrationCell,
} from "./pitch-calibration.js";
export { summarizePitchProfile } from "./pitch-profile.js";
export { battingStatistics, pitchingStatistics } from "./player-statistics.js";
export { observedPitchLocation } from "./pitch-location.js";
export {
  hasTerminalPitch,
  matchesPitchOutcome,
  pitchOutcomeSummarizer,
  analyzePitchLocation,
} from "./pitch-outcomes.js";
export { analyzeBatterProfile } from "./batter-profile.js";
export { analyzePitcherChanges } from "./pitcher-changes.js";
export { analyzePitchSequences, pitchPositionAtPlane } from "./pitch-sequence.js";
export {
  baserunningOpportunities,
  summarizeBaserunningOpportunities,
} from "./baserunning-analysis.js";
export { analyzePitcherWorkload } from "./pitcher-workload.js";
export { comparePitcherWorkload, WORKLOAD_COMPARISON_POLICY } from "./workload-comparison.js";
export { analyzeMatchup, matchupCondition } from "./matchup.js";
export {
  baseMask,
  groupAnalysisHalves,
  completeAnalysisHalf,
  collectRunObservations,
  trainRunExpectancy,
  evaluateRunValues,
} from "./run-expectancy.js";
export { collectCountRunObservations, trainCountRunExpectancy } from "./count-run-expectancy.js";
export { countValueTransitions, evaluateCountRunValues } from "./count-run-value.js";
export { collectWinObservations } from "./win-probability-input.js";
export { winInningLimit } from "./win-probability-rules.js";
export { trainWinProbability, winPredictor, evaluateWinModel } from "./win-probability.js";
export { evaluateWinValues } from "./win-probability-value.js";
export { analyzeParkEnvironment } from "./park-environment.js";
export { trainParkEnvironment } from "./park-environment-model.js";

export { trainPitchQuality } from "./pitch-quality-training.js";
export { summarizePitchQuality } from "./pitch-quality.js";
export { trainMatchupModel } from "./matchup-training.js";
export {
  modelTrainingPeriod,
  modelValidationSeasons,
  validModelEvaluationSeasons,
} from "./model-training-period.js";
export { summarizeMatchupModel } from "./matchup-model.js";
export { analyzePitchAngles, type PitchAngleInput } from "./pitch-angles.js";
