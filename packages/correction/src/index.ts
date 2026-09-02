export {
  applyCorrectionCommand,
  cloneStagingDocument,
  CorrectionCommandError,
  type CorrectionResult,
} from "./commands.js";
export { buildCorrectionPreview } from "./preview.js";
export {
  buildRecordCorrectionBatchProposal,
  type BuiltRecordCorrectionProposal,
  type RecordCorrectionProposalBinding,
} from "./record-correction-proposal.js";

export const CORRECTION_MODULE_VERSION = "0.5.0";
