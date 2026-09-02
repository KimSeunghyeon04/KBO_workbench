import { createHash } from "node:crypto";

import { canonicalStringify, type StagingGameDocumentV2 } from "@kbo/contracts";

export function stagingDocumentHash(document: StagingGameDocumentV2): string {
  return createHash("sha256").update(canonicalStringify(document), "utf8").digest("hex");
}
