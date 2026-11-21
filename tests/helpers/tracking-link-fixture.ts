import type { StagingGameDocumentV2, TrackingCandidate } from "@kbo/contracts";

export function trackingLinkFixture(document: StagingGameDocumentV2): StagingGameDocumentV2 {
  const canonical = document.trackingCandidates[0];
  if (canonical?.resolution.kind !== "linked") throw new Error("대표 관측 fixture가 없습니다.");
  const duplicate: TrackingCandidate = {
    ...canonical,
    trackingId: "anon-tracking-duplicate",
    sequence: document.trackingCandidates.length,
    source: { ...canonical.source, rowIndex: canonical.source.rowIndex + 1 },
    // 다른 관측값은 검증 문제로 남아 대표 투구의 상세를 열 수 있어야 한다.
    crossPlateX: (canonical.crossPlateX ?? 0) + 0.25,
    resolution: { kind: "duplicate", canonicalTrackingId: canonical.trackingId },
  };
  const chain: TrackingCandidate = {
    ...duplicate,
    trackingId: "anon-tracking-chain",
    sequence: duplicate.sequence + 1,
    source: { ...canonical.source, rowIndex: canonical.source.rowIndex + 2 },
    resolution: { kind: "duplicate", canonicalTrackingId: duplicate.trackingId },
  };
  return { ...document, trackingCandidates: [...document.trackingCandidates, duplicate, chain] };
}
