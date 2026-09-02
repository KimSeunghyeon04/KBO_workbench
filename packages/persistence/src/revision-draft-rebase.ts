import { parseStagingGameDocumentV2, type StagingGameDocumentV2 } from "@kbo/contracts";

export function rebaseSealedCorrectionDraft(
  stored: StagingGameDocumentV2,
  revision: number,
  documentHash: string,
): StagingGameDocumentV2 {
  return parseStagingGameDocumentV2({
    ...stored,
    revisionBase: {
      kind: "sealed_revision",
      revision,
      documentHash,
    },
  });
}
