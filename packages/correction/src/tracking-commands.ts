import type { StagingGameDocumentV2, TrackingCandidate } from "@kbo/contracts";
import { compileStagingGameDocumentV2, type ReplayResult } from "@kbo/game-core";

export function updateTrackingResolution(
  document: StagingGameDocumentV2,
  trackingId: string,
  resolution: StagingGameDocumentV2["trackingCandidates"][number]["resolution"],
): StagingGameDocumentV2 {
  if (resolution.kind === "linked") {
    const event = document.events.find(
      (candidate) => candidate.identity.eventId === resolution.pitchEventId,
    );
    if (event?.kind !== "pitch") throw new Error("tracking 연결 대상은 투구 원장 행이어야 합니다.");
  }
  requiredTrackingCandidate(document, trackingId);
  return {
    ...document,
    trackingCandidates: document.trackingCandidates.map((candidate) =>
      candidate.trackingId === trackingId ? { ...candidate, resolution } : candidate,
    ),
  };
}

export function requiredTrackingCandidate(
  document: StagingGameDocumentV2,
  trackingId: string,
): StagingGameDocumentV2["trackingCandidates"][number] {
  const candidate = document.trackingCandidates.find((item) => item.trackingId === trackingId);
  if (candidate === undefined) throw new Error(`tracking 후보를 찾을 수 없습니다: ${trackingId}`);
  return candidate;
}

export function reconcileTrackingPlateAppearanceContexts(
  document: StagingGameDocumentV2,
): StagingGameDocumentV2 {
  const replay = compileStagingGameDocumentV2(document);
  const eventIds = new Set(document.events.map((event) => event.identity.eventId));
  const candidatesById = new Map(
    document.trackingCandidates.map((candidate) => [candidate.trackingId, candidate]),
  );
  const pitchFactsById = new Map(replay.pitchFacts.map((pitch) => [pitch.pitchId, pitch]));
  let repaired = 0;
  const trackingCandidates = document.trackingCandidates.map((candidate) => {
    if (
      candidate.plateAppearanceEventId === undefined ||
      eventIds.has(candidate.plateAppearanceEventId) ||
      !canReconcileCandidate(candidate, candidatesById)
    ) {
      return candidate;
    }
    const pitchEventId = resolvedPitchEventId(candidate, candidatesById);
    const pitch = pitchEventId === null ? undefined : pitchFactsById.get(pitchEventId);
    if (!pitch?.actual || pitch.plateAppearanceEventId === null) return candidate;
    repaired += 1;
    return { ...candidate, plateAppearanceEventId: pitch.plateAppearanceEventId };
  });
  if (repaired === 0) {
    throw new Error("복구할 삭제된 tracking PA 문맥이 없습니다.");
  }
  return { ...document, trackingCandidates };
}

function canReconcileCandidate(
  candidate: TrackingCandidate,
  candidatesById: ReadonlyMap<string, TrackingCandidate>,
): boolean {
  if (candidate.resolution.kind === "linked") return true;
  if (candidate.resolution.kind !== "duplicate") return false;
  const canonical = candidatesById.get(candidate.resolution.canonicalTrackingId);
  return (
    canonical?.resolution.kind === "linked" &&
    candidate.plateAppearanceEventId === canonical.plateAppearanceEventId
  );
}

export function followStableTrackingPlateAppearanceContexts(
  beforeDocument: StagingGameDocumentV2,
  beforeReplay: ReplayResult,
  afterDocument: StagingGameDocumentV2,
  afterReplay: ReplayResult,
): StagingGameDocumentV2 {
  const beforeCandidates = new Map(
    beforeDocument.trackingCandidates.map((candidate) => [candidate.trackingId, candidate]),
  );
  const afterCandidates = new Map(
    afterDocument.trackingCandidates.map((candidate) => [candidate.trackingId, candidate]),
  );
  const beforePitches = new Map(beforeReplay.pitchFacts.map((pitch) => [pitch.pitchId, pitch]));
  const afterPitches = new Map(afterReplay.pitchFacts.map((pitch) => [pitch.pitchId, pitch]));
  let changed = false;
  const trackingCandidates = afterDocument.trackingCandidates.map((candidate) => {
    const previous = beforeCandidates.get(candidate.trackingId);
    if (previous === undefined) return candidate;
    const beforePitchId = resolvedPitchEventId(previous, beforeCandidates);
    const afterPitchId = resolvedPitchEventId(candidate, afterCandidates);
    if (beforePitchId === null || beforePitchId !== afterPitchId) return candidate;
    const beforePitch = beforePitches.get(beforePitchId);
    const afterPitch = afterPitches.get(afterPitchId);
    if (
      !beforePitch?.actual ||
      !afterPitch?.actual ||
      beforePitch.plateAppearanceEventId === null ||
      afterPitch.plateAppearanceEventId === null ||
      previous.plateAppearanceEventId !== beforePitch.plateAppearanceEventId ||
      candidate.plateAppearanceEventId !== previous.plateAppearanceEventId ||
      beforePitch.plateAppearanceEventId === afterPitch.plateAppearanceEventId
    ) {
      return candidate;
    }
    changed = true;
    return { ...candidate, plateAppearanceEventId: afterPitch.plateAppearanceEventId };
  });
  return changed ? { ...afterDocument, trackingCandidates } : afterDocument;
}

function resolvedPitchEventId(
  candidate: TrackingCandidate,
  candidatesById: ReadonlyMap<string, TrackingCandidate>,
): string | null {
  if (candidate.resolution.kind === "linked") return candidate.resolution.pitchEventId;
  if (candidate.resolution.kind !== "duplicate") return null;
  const canonical = candidatesById.get(candidate.resolution.canonicalTrackingId);
  return canonical?.resolution.kind === "linked" ? canonical.resolution.pitchEventId : null;
}

export function excludeTrackingForPitch(
  document: StagingGameDocumentV2,
  pitchEventId: string,
  note: string,
): StagingGameDocumentV2 {
  const directlyLinked = new Set(
    document.trackingCandidates.flatMap((candidate) =>
      candidate.resolution.kind === "linked" && candidate.resolution.pitchEventId === pitchEventId
        ? [candidate.trackingId]
        : [],
    ),
  );
  return {
    ...document,
    trackingCandidates: document.trackingCandidates.map((candidate) =>
      (candidate.resolution.kind === "linked" &&
        candidate.resolution.pitchEventId === pitchEventId) ||
      (candidate.resolution.kind === "duplicate" &&
        directlyLinked.has(candidate.resolution.canonicalTrackingId))
        ? {
            ...candidate,
            resolution: { kind: "excluded" as const, reason: "manual_other" as const, note },
          }
        : candidate,
    ),
  };
}
