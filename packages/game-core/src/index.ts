export { stagingDocumentHash } from "./hash.js";

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
