import { canonicalStringify } from "@kbo/contracts";
import type {
  CorrectionEventContext,
  CorrectionFinding,
  StagingGameDocumentV2,
  TrackingCandidate,
} from "@kbo/contracts";

export interface TrackingReviewGroup {
  readonly key: string;
  readonly sourcePitchId: string;
  readonly candidates: readonly TrackingCandidate[];
  readonly metricVariantCount: number;
}

export function buildTrackingReviewGroups(
  candidates: readonly TrackingCandidate[],
): TrackingReviewGroup[] {
  const groups = new Map<string, TrackingCandidate[]>();
  for (const candidate of candidates) {
    const key = trackingContextKey(candidate);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      sourcePitchId: group[0]?.sourcePitchId ?? "없음",
      candidates: [...group].sort((left, right) => left.sequence - right.sequence),
      metricVariantCount: new Set(group.map(trackingMetricFingerprint)).size,
    }))
    .sort((left, right) => {
      const leftCandidate = left.candidates[0];
      const rightCandidate = right.candidates[0];
      if (leftCandidate === undefined || rightCandidate === undefined) return 0;
      const leftPending = Number(
        left.candidates.some((item) => item.resolution.kind === "pending"),
      );
      const rightPending = Number(
        right.candidates.some((item) => item.resolution.kind === "pending"),
      );
      return rightPending - leftPending || leftCandidate.sequence - rightCandidate.sequence;
    });
}

export function trackingCandidateForFinding(
  document: StagingGameDocumentV2,
  finding: Pick<CorrectionFinding, "recordIdentity" | "details">,
): TrackingCandidate | null {
  const identities = [
    finding.recordIdentity,
    ...finding.details
      .filter((detail) => detail.field.startsWith("source."))
      .map((detail) => detail.field.slice("source.".length)),
  ];
  for (const identity of identities) {
    if (identity === undefined) continue;
    const candidate = document.trackingCandidates.find((item) => item.trackingId === identity);
    if (candidate !== undefined) return candidate;
  }
  return null;
}

export function trackingCandidatesForFinding(
  document: StagingGameDocumentV2,
  finding: Pick<CorrectionFinding, "recordIdentity" | "details">,
): TrackingCandidate[] {
  const identities = new Set([
    finding.recordIdentity,
    ...finding.details
      .filter((detail) => detail.field.startsWith("source."))
      .map((detail) => detail.field.slice("source.".length)),
  ]);
  return document.trackingCandidates
    .filter((candidate) => identities.has(candidate.trackingId))
    .sort((left, right) => left.sequence - right.sequence);
}

export function isRepairableTrackingPlateAppearanceFinding(
  document: StagingGameDocumentV2,
  eventContexts: readonly CorrectionEventContext[],
  finding: Pick<CorrectionFinding, "code" | "recordIdentity" | "details">,
): boolean {
  if (finding.code !== "domain.tracking.plate_appearance_mismatch") return false;
  const candidate = trackingCandidateForFinding(document, finding);
  if (
    candidate?.resolution.kind !== "linked" ||
    candidate.plateAppearanceEventId === undefined ||
    document.events.some((event) => event.identity.eventId === candidate.plateAppearanceEventId)
  ) {
    return false;
  }
  const pitchEventId = candidate.resolution.pitchEventId;
  const context = eventContexts.find((item) => item.eventId === pitchEventId);
  return context?.pitch?.actual === true && context.pitch.plateAppearanceEventId !== null;
}

export function exactTrackingPeers(
  candidate: TrackingCandidate,
  candidates: readonly TrackingCandidate[],
): TrackingCandidate[] {
  const fingerprint = trackingMetricFingerprint(candidate);
  return candidates
    .filter((item) => trackingMetricFingerprint(item) === fingerprint)
    .sort((left, right) => left.sequence - right.sequence);
}

export function trackingFindingLocation(
  document: StagingGameDocumentV2,
  candidate: TrackingCandidate,
  eventContexts: readonly CorrectionEventContext[] = [],
): string {
  const contextualPitch = uniqueContextualPitch(document, candidate, eventContexts);
  const pitchEvent =
    contextualPitch === undefined
      ? undefined
      : document.events.find((event) => event.identity.eventId === contextualPitch.eventId);
  const plateAppearanceEventId =
    candidate.plateAppearanceEventId ?? contextualPitch?.pitch?.plateAppearanceEventId ?? undefined;
  const plateAppearance =
    plateAppearanceEventId === undefined || plateAppearanceEventId === null
      ? undefined
      : document.events.find((event) => event.identity.eventId === plateAppearanceEventId);
  const plateAppearanceLabel =
    plateAppearance === undefined
      ? "PA 미확인"
      : `PA 시작 ${String(plateAppearance.sequence + 1)}행`;
  const pitchLabel =
    pitchEvent === undefined
      ? undefined
      : `원장 ${String(pitchEvent.sequence + 1)}행 실제 ${contextualPitch?.pitch?.actualPitchNumber === null ? "순번 미확인" : String(contextualPitch?.pitch?.actualPitchNumber)}구`;
  const ordinal =
    candidate.sourcePitchOrdinal === null
      ? "PTS 순번 미확인"
      : `PTS 순번 ${String(candidate.sourcePitchOrdinal)}`;
  return [
    `${String(candidate.inning)}회${halfLabel(candidate.half)}`,
    pitchLabel,
    plateAppearanceLabel,
    ordinal,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

export function trackingSourceLocation(candidate: TrackingCandidate): string {
  return `${candidate.source.endpoint} · block ${String(candidate.source.blockIndex)} · row ${String(candidate.source.rowIndex)}`;
}

export function trackingCandidateElementId(trackingId: string): string {
  return `tracking-candidate-${trackingId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function trackingContextKey(candidate: TrackingCandidate): string {
  return [
    candidate.inning,
    candidate.half,
    candidate.plateAppearanceEventId ?? "no-pa",
    candidate.sourcePitchOrdinal ?? "no-ordinal",
    candidate.sourcePitchId ?? "no-id",
  ].join("|");
}

function uniqueContextualPitch(
  document: StagingGameDocumentV2,
  candidate: TrackingCandidate,
  eventContexts: readonly CorrectionEventContext[],
): CorrectionEventContext | undefined {
  const events = new Map(document.events.map((event) => [event.identity.eventId, event]));
  const matches = eventContexts.filter((context) => {
    if (context.pitch === undefined) return false;
    const event = events.get(context.eventId);
    if (
      event?.kind !== "pitch" ||
      event.inning !== candidate.inning ||
      event.half !== candidate.half
    )
      return false;
    if (
      candidate.sourcePitchId !== undefined &&
      context.pitch.sourcePitchId === candidate.sourcePitchId
    )
      return true;
    return (
      candidate.plateAppearanceEventId !== undefined &&
      context.pitch.plateAppearanceEventId === candidate.plateAppearanceEventId &&
      (candidate.pitcherId === undefined || context.pitch.pitcherId === candidate.pitcherId) &&
      (candidate.batterId === undefined || context.pitch.batterId === candidate.batterId)
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function trackingMetricFingerprint(candidate: TrackingCandidate): string {
  const fact = Object.fromEntries(
    Object.entries(candidate).filter(
      ([key]) => !["trackingId", "source", "sequence", "resolution"].includes(key),
    ),
  );
  return canonicalStringify(fact);
}

function halfLabel(half: "top" | "bottom"): string {
  return half === "top" ? "초" : "말";
}
