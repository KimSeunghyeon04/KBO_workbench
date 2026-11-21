import type { TrackingCandidate, TrackingResolution } from "@kbo/contracts";

type LinkedTrackingCandidate = TrackingCandidate & {
  readonly resolution: Extract<TrackingResolution, { kind: "linked" }>;
};

/** A duplicate can refer only to a directly linked representative. */
export function resolveLinkedTrackingCandidate(
  candidate: TrackingCandidate,
  candidatesById: ReadonlyMap<string, TrackingCandidate>,
): LinkedTrackingCandidate | undefined {
  const representative =
    candidate.resolution.kind === "duplicate"
      ? candidatesById.get(candidate.resolution.canonicalTrackingId)
      : candidate;
  return isLinkedTrackingCandidate(representative) ? representative : undefined;
}

function isLinkedTrackingCandidate(
  candidate: TrackingCandidate | undefined,
): candidate is LinkedTrackingCandidate {
  return candidate?.resolution.kind === "linked";
}
