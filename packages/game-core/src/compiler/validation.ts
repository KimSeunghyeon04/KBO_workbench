import type { StagingGameDocumentV2, StagingRelayEvent, TrackingCandidate } from "@kbo/contracts";
import { canonicalStringify } from "@kbo/contracts";

import type { CompiledPitchFact, FindingDetail } from "../types.js";
import type { CompileContext } from "./model.js";

export function validateTracking(
  document: StagingGameDocumentV2,
  pitchFacts: readonly CompiledPitchFact[],
  context: CompileContext,
): void {
  const events = new Map(document.events.map((event) => [event.identity.eventId, event]));
  const pitchFactsByEvent = new Map(pitchFacts.map((pitch) => [pitch.pitchId, pitch]));
  const candidates = new Map(
    document.trackingCandidates.map((candidate) => [candidate.trackingId, candidate]),
  );
  const linkedByPitch = new Map<string, TrackingCandidate[]>();

  addReusedSourcePitchIdWarnings(document, context);

  for (const group of conflictingTrackingGroups(document.trackingCandidates)) {
    for (const candidate of group.filter((item) => item.resolution.kind === "pending")) {
      trackingFinding(
        document,
        context,
        candidate,
        "source.tracking.conflicting_candidates",
        "같은 원천 문맥에 서로 다른 tracking 후보가 있어 사용자가 확정해야 합니다.",
        group.map((item) => ({
          field: `source.${item.trackingId}`,
          actual: `${item.source.endpoint}:${String(item.source.blockIndex)}:${String(item.source.rowIndex)}`,
        })),
      );
    }
  }

  for (const candidate of document.trackingCandidates) {
    if (candidate.resolution.kind === "pending") {
      if (!hasFinding(context, "source.tracking.conflicting_candidates", candidate.trackingId)) {
        trackingFinding(
          document,
          context,
          candidate,
          "source.tracking.pending",
          "tracking 후보의 투구 연결 또는 제외 판단이 필요합니다.",
        );
      }
      continue;
    }
    if (candidate.resolution.kind === "excluded") continue;
    if (candidate.resolution.kind === "duplicate") {
      const canonical = candidates.get(candidate.resolution.canonicalTrackingId);
      if (
        canonical === undefined ||
        canonical.resolution.kind !== "linked" ||
        trackingFingerprint(canonical) !== trackingFingerprint(candidate)
      ) {
        trackingFinding(
          document,
          context,
          candidate,
          "source.tracking.invalid_duplicate_resolution",
          "중복 tracking은 동일한 값의 linked 대표 후보를 가리켜야 합니다.",
        );
      }
      continue;
    }

    const pitchEventId = candidate.resolution.pitchEventId;
    const event = events.get(pitchEventId);
    if (event?.kind !== "pitch") {
      trackingFinding(
        document,
        context,
        candidate,
        "source.tracking.link_not_pitch",
        "tracking 후보가 투구가 아닌 원장 행에 연결되었습니다.",
        [],
        pitchEventId,
      );
      continue;
    }
    const linked = linkedByPitch.get(pitchEventId) ?? [];
    linked.push(candidate);
    linkedByPitch.set(pitchEventId, linked);
    if (
      candidate.sourcePitchId !== undefined &&
      event.payload.sourcePitchId !== undefined &&
      event.payload.sourcePitchId !== candidate.sourcePitchId
    ) {
      trackingFinding(
        document,
        context,
        candidate,
        "source.tracking.pitch_id_mismatch",
        "tracking 후보와 투구의 원천 ID가 다릅니다.",
        [
          {
            field: "sourcePitchId",
            expected: event.payload.sourcePitchId,
            actual: candidate.sourcePitchId,
          },
        ],
        pitchEventId,
      );
    }
    const pitchFact = pitchFactsByEvent.get(pitchEventId);
    if (pitchFact === undefined || !pitchFact.actual) {
      trackingFinding(
        document,
        context,
        candidate,
        "domain.tracking.non_actual_pitch_link",
        "tracking 후보는 compiler가 확인한 실제 투구에만 연결할 수 있습니다.",
        [
          {
            field: "actualPitchNumber",
            expected: "actual pitch",
            actual: pitchFact?.actualPitchNumber ?? null,
          },
        ],
        pitchEventId,
      );
    }
    if (
      pitchFact !== undefined &&
      candidate.plateAppearanceEventId !== undefined &&
      candidate.plateAppearanceEventId !== pitchFact.plateAppearanceEventId
    ) {
      trackingFinding(
        document,
        context,
        candidate,
        "domain.tracking.plate_appearance_mismatch",
        "tracking 후보의 PA 문맥이 compiler가 계산한 실제 투구의 PA와 다릅니다.",
        [
          {
            field: "plateAppearanceEventId",
            expected: pitchFact.plateAppearanceEventId,
            actual: candidate.plateAppearanceEventId,
          },
        ],
        pitchEventId,
      );
    }
    if (pitchFact !== undefined) {
      const playerDetails: FindingDetail[] = [];
      if (
        candidate.pitcherId !== undefined &&
        pitchFact.pitcherId !== null &&
        candidate.pitcherId !== pitchFact.pitcherId
      ) {
        playerDetails.push({
          field: "pitcherId",
          expected: pitchFact.pitcherId,
          actual: candidate.pitcherId,
        });
      }
      if (
        candidate.batterId !== undefined &&
        pitchFact.batterId !== null &&
        candidate.batterId !== pitchFact.batterId
      ) {
        playerDetails.push({
          field: "batterId",
          expected: pitchFact.batterId,
          actual: candidate.batterId,
        });
      }
      if (playerDetails.length > 0) {
        trackingFinding(
          document,
          context,
          candidate,
          "source.tracking.player_context_mismatch",
          "tracking 후보의 선수 문맥이 연결된 실제 투구와 다릅니다.",
          playerDetails,
          pitchEventId,
        );
      }
      if (
        candidate.sourcePitchOrdinal !== null &&
        pitchFact.actualPitchNumber !== null &&
        candidate.sourcePitchOrdinal !== pitchFact.actualPitchNumber
      ) {
        context.findings.push({
          code: "source.tracking.ordinal_differs_from_actual_pitch",
          category: "source",
          severity: "warning",
          message:
            "PTS 투구 순번이 compiler의 실제 투구 순번과 다릅니다. 분석에는 compiler 순번을 사용합니다.",
          gameId: document.metadata.gameId,
          eventId: pitchEventId,
          eventSequence: event.sequence,
          recordIdentity: candidate.trackingId,
          details: [
            {
              field: "sourcePitchOrdinal",
              expected: pitchFact.actualPitchNumber,
              actual: candidate.sourcePitchOrdinal,
            },
          ],
        });
      }
    }
    if (candidate.inning !== event.inning || candidate.half !== event.half) {
      trackingFinding(
        document,
        context,
        candidate,
        "source.tracking.game_context_mismatch",
        "tracking 후보의 이닝 문맥이 연결 투구와 다릅니다.",
        [
          { field: "inning", expected: event.inning, actual: candidate.inning },
          { field: "half", expected: event.half, actual: candidate.half },
        ],
        pitchEventId,
      );
    }
    if (
      candidate.topSz !== undefined &&
      candidate.bottomSz !== undefined &&
      candidate.bottomSz >= candidate.topSz
    ) {
      trackingFinding(
        document,
        context,
        candidate,
        "source.tracking.invalid_strike_zone",
        "tracking의 스트라이크 존 하단은 상단보다 낮아야 합니다.",
        [
          { field: "bottomSz", actual: candidate.bottomSz },
          { field: "topSz", actual: candidate.topSz },
        ],
        pitchEventId,
      );
    }
  }

  for (const [pitchEventId, linked] of linkedByPitch) {
    if (linked.length <= 1) continue;
    for (const candidate of linked) {
      trackingFinding(
        document,
        context,
        candidate,
        "domain.tracking.multiple_canonical",
        "하나의 실제 투구에는 canonical tracking을 하나만 연결할 수 있습니다.",
        [{ field: "linkedCount", expected: 1, actual: linked.length }],
        pitchEventId,
      );
    }
  }

  if (document.trackingCandidates.length > 0) {
    for (const event of document.events) {
      if (
        event.kind !== "pitch" ||
        !isActualPitchCall(event.payload.call) ||
        linkedByPitch.has(event.identity.eventId)
      ) {
        continue;
      }
      context.findings.push({
        code: "source.tracking.missing_for_pitch",
        category: "source",
        severity: "warning",
        message: "실제 투구에 연결된 tracking 관측값이 없습니다.",
        gameId: document.metadata.gameId,
        eventId: event.identity.eventId,
        eventSequence: event.sequence,
        details: [],
      });
    }
  }
}

function conflictingTrackingGroups(
  candidates: readonly TrackingCandidate[],
): readonly TrackingCandidate[][] {
  const groups = new Map<string, TrackingCandidate[]>();
  for (const candidate of candidates) {
    if (
      candidate.resolution.kind !== "pending" ||
      (candidate.sourcePitchId === undefined && candidate.sourcePitchOrdinal === null)
    ) {
      continue;
    }
    const key = canonicalStringify({
      endpoint: candidate.source.endpoint,
      blockIndex: candidate.source.blockIndex,
      inning: candidate.inning,
      half: candidate.half,
      plateAppearanceEventId: candidate.plateAppearanceEventId ?? null,
      sourcePitchId: candidate.sourcePitchId ?? null,
      sourcePitchOrdinal: candidate.sourcePitchOrdinal,
      pitcherId: candidate.pitcherId ?? null,
      batterId: candidate.batterId ?? null,
    });
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return [...groups.values()].filter(
    (group) => group.length > 1 && new Set(group.map(trackingFingerprint)).size > 1,
  );
}

function addReusedSourcePitchIdWarnings(
  document: StagingGameDocumentV2,
  context: CompileContext,
): void {
  const eventsBySourcePitchId = new Map<string, StagingRelayEvent[]>();
  for (const event of document.events) {
    if (event.kind !== "pitch" || event.payload.sourcePitchId === undefined) continue;
    const group = eventsBySourcePitchId.get(event.payload.sourcePitchId) ?? [];
    group.push(event);
    eventsBySourcePitchId.set(event.payload.sourcePitchId, group);
  }
  for (const [sourcePitchId, events] of eventsBySourcePitchId) {
    if (events.length < 2) continue;
    const details = events.map((event, index) => ({
      field: `sourceLocation.${String(index + 1)}`,
      actual:
        event.identity.kind === "source"
          ? `${event.identity.endpoint}:${String(event.identity.blockIndex)}:${String(event.identity.eventIndex)}`
          : event.identity.eventId,
    }));
    for (const event of events) {
      context.findings.push({
        code: "source.pitch_id.reused_within_game",
        category: "source",
        severity: "warning",
        message: `같은 sourcePitchId(${sourcePitchId})가 경기 안의 여러 투구 행에 사용되었습니다.`,
        gameId: document.metadata.gameId,
        eventId: event.identity.eventId,
        eventSequence: event.sequence,
        details,
      });
    }
  }
}

function trackingFingerprint(candidate: TrackingCandidate): string {
  const fact = Object.fromEntries(
    Object.entries(candidate).filter(
      ([key]) => !["trackingId", "source", "sequence", "resolution"].includes(key),
    ),
  );
  return canonicalStringify(fact);
}

function isActualPitchCall(call: string): boolean {
  return call !== "automatic_ball" && call !== "automatic_strike" && call !== "no_pitch";
}

function hasFinding(context: CompileContext, code: string, trackingId: string): boolean {
  return context.findings.some(
    (finding) => finding.code === code && finding.recordIdentity === trackingId,
  );
}

function trackingFinding(
  document: StagingGameDocumentV2,
  context: CompileContext,
  candidate: TrackingCandidate,
  code: string,
  message: string,
  details: readonly FindingDetail[] = [],
  eventId?: string,
): void {
  context.findings.push({
    code,
    category: code.startsWith("domain.") ? "domain" : "source",
    severity: "blocking",
    message,
    gameId: document.metadata.gameId,
    ...(eventId === undefined ? {} : { eventId }),
    recordIdentity: candidate.trackingId,
    details,
  });
}

export {
  compareFinalObservedScore,
  compareIndependentPlayObservedState,
  compareObservedState,
  comparePlatePlayObservedState,
} from "./observed-state-validation.js";
export { compareOfficialRecords } from "./official-record-validation.js";
