import {
  canonicalStringify,
  type CorrectionPreview,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { stagingDocumentHash, type ReplayResult } from "@kbo/game-core";

export function buildCorrectionPreview(
  beforeDocument: StagingGameDocumentV2,
  before: ReplayResult,
  afterDocument: StagingGameDocumentV2,
  after: ReplayResult,
): CorrectionPreview {
  const beforeCodes = before.findings.map((finding) => finding.code);
  const afterCodes = after.findings.map((finding) => finding.code);
  const blockingKeys = (replay: ReplayResult) =>
    replay.findings
      .filter((finding) => finding.severity === "blocking")
      .map((finding) => {
        const stable = Object.fromEntries(
          Object.entries(finding).filter(([key]) => key !== "eventSequence"),
        );
        return canonicalStringify(stable);
      });
  const beforeBlocking = blockingKeys(before);
  const afterBlocking = blockingKeys(after);
  return {
    beforeDocumentHash: stagingDocumentHash(beforeDocument),
    afterDocumentHash: stagingDocumentHash(afterDocument),
    beforeBlockingCount: count(before, "blocking"),
    afterBlockingCount: count(after, "blocking"),
    resolvedBlockingCount: difference(beforeBlocking, afterBlocking).length,
    newBlockingCount: difference(afterBlocking, beforeBlocking).length,
    beforeWarningCount: count(before, "warning"),
    afterWarningCount: count(after, "warning"),
    eventCountDelta: afterDocument.events.length - beforeDocument.events.length,
    trackingResolutionChanges: trackingResolutionChanges(beforeDocument, afterDocument),
    addedFindingCodes: difference(afterCodes, beforeCodes),
    removedFindingCodes: difference(beforeCodes, afterCodes),
  };
}

function trackingResolutionChanges(
  before: StagingGameDocumentV2,
  after: StagingGameDocumentV2,
): number {
  const beforeById = new Map(
    before.trackingCandidates.map((candidate) => [
      candidate.trackingId,
      canonicalStringify(candidate.resolution),
    ]),
  );
  return after.trackingCandidates.filter(
    (candidate) =>
      beforeById.get(candidate.trackingId) !== canonicalStringify(candidate.resolution),
  ).length;
}

function count(replay: ReplayResult, severity: "blocking" | "warning"): number {
  return replay.findings.filter((finding) => finding.severity === severity).length;
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const remaining = [...right];
  return left.filter((item) => {
    const index = remaining.indexOf(item);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}
