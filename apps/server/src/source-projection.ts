import { mapNaverGame, type RawGameBundle, type SourceFinding } from "@kbo/collection";
import { canonicalStringify, type StagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import type { CurrentRevisionBase, StoredFinding } from "@kbo/persistence";

export interface SourceProjection {
  readonly document: StagingGameDocumentV2;
  readonly findings: readonly StoredFinding[];
}

export function projectNaverSourceBundle(
  bundle: RawGameBundle,
  currentBase: CurrentRevisionBase | null,
  providerFindings: readonly SourceFinding[] = [],
): SourceProjection {
  const mapped = mapNaverGame(bundle);
  const document: StagingGameDocumentV2 =
    currentBase === null
      ? mapped.document
      : {
          ...mapped.document,
          revisionBase: {
            kind: "sealed_revision",
            revision: currentBase.revision,
            documentHash: currentBase.documentHash,
          },
        };
  const replay = compileStagingGameDocumentV2(document);
  return {
    document,
    findings: deduplicateStoredFindings([
      ...providerFindings.map(storedSourceFinding),
      ...mapped.findings.map(storedSourceFinding),
      ...replay.findings.map((finding) => ({
        producer: "compiler" as const,
        lifecycle: "recomputed" as const,
        code: finding.code,
        category: finding.category,
        severity: finding.severity,
        message: finding.message,
        ...(finding.eventId === undefined ? {} : { eventId: finding.eventId }),
        ...(finding.eventSequence === undefined ? {} : { eventSequence: finding.eventSequence }),
        ...(finding.recordIdentity === undefined ? {} : { recordIdentity: finding.recordIdentity }),
        ...(finding.details.length === 0
          ? {}
          : { details: finding.details.map((detail) => ({ ...detail })) }),
      })),
    ]),
  };
}

export function storedSourceFinding(finding: SourceFinding): StoredFinding {
  const details: NonNullable<StoredFinding["details"]> = [
    ...(finding.blockIndex === undefined
      ? []
      : [{ field: "source_block_index", actual: finding.blockIndex }]),
    ...(finding.rowIndex === undefined
      ? []
      : [{ field: "source_row_index", actual: finding.rowIndex }]),
    ...(finding.sourceEventId === undefined
      ? []
      : [{ field: "source_event_id", actual: finding.sourceEventId }]),
    ...(finding.sourceText === undefined
      ? []
      : [{ field: "source_text", actual: finding.sourceText }]),
  ];
  return {
    producer: "collection",
    lifecycle: finding.lifecycle,
    code: finding.code,
    category: "source",
    severity: finding.severity,
    message: finding.message,
    ...(finding.eventId === undefined ? {} : { eventId: finding.eventId }),
    ...(finding.endpoint === null ? {} : { endpoint: finding.endpoint }),
    ...(details.length === 0 ? {} : { details }),
  };
}

export function storedCompilerFindings(
  findings: ReturnType<typeof compileStagingGameDocumentV2>["findings"],
): StoredFinding[] {
  return findings.map((finding) => ({
    producer: "compiler",
    lifecycle: "recomputed",
    code: finding.code,
    category: finding.category,
    severity: finding.severity,
    message: finding.message,
    ...(finding.eventId === undefined ? {} : { eventId: finding.eventId }),
    ...(finding.eventSequence === undefined ? {} : { eventSequence: finding.eventSequence }),
    ...(finding.recordIdentity === undefined ? {} : { recordIdentity: finding.recordIdentity }),
    ...(finding.details.length === 0
      ? {}
      : { details: finding.details.map((detail) => ({ ...detail })) }),
  }));
}

function deduplicateStoredFindings(findings: readonly StoredFinding[]): StoredFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = canonicalStringify(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
