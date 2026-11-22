export {
  applyCorrectionCommand,
  cloneStagingDocument,
  CorrectionCommandError,
  type CorrectionResult,
} from "./commands.js";
export { buildCorrectionPreview } from "./preview.js";
export {
  buildRecordCorrectionBatchProposal,
  createRecordCorrectionProposalBuilder,
  createRecordCorrectionFactsReader,
  type RecordCorrectionAfterFact,
  type BuiltRecordCorrectionProposal,
  type RecordCorrectionProposalBinding,
} from "./record-correction-proposal.js";
