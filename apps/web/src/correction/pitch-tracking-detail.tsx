import { useMemo, useState } from "react";
import type {
  CorrectionCommand,
  CorrectionEventContext,
  StagingGameDocumentV2,
  TrackingCandidate,
} from "@kbo/contracts";

import { newCommandId } from "./event-editor-registry";
import { pitchCallLabel } from "./event-presentation";
import { trackingFindingLocation, trackingSourceLocation } from "./tracking-review";

interface PitchTrackingDetailProps {
  readonly document: StagingGameDocumentV2;
  readonly eventContexts: readonly CorrectionEventContext[];
  readonly pitchEventId: string | null;
  readonly exceptionTrackingId: string | null;
  readonly pending: boolean;
  readonly onApply: (command: CorrectionCommand) => void;
}

interface PitchChoice {
  readonly eventId: string;
  readonly inning: number;
  readonly half: "top" | "bottom";
  readonly sourcePitchId: string | null;
  readonly label: string;
}

export function PitchTrackingDetail({
  document,
  eventContexts,
  pitchEventId,
  exceptionTrackingId,
  pending,
  onApply,
}: PitchTrackingDetailProps): React.JSX.Element | null {
  const pitches = useMemo(
    () => buildPitchChoices(document, eventContexts),
    [document, eventContexts],
  );
  const candidates = relatedCandidates(document, pitchEventId, exceptionTrackingId);
  const [selectedPitchByTrackingId, setSelectedPitchByTrackingId] = useState<
    Readonly<Record<string, string>>
  >({});
  if (candidates.length === 0) return null;
  const needsReview = candidates.some((candidate) => candidate.resolution.kind === "pending");

  return (
    <section className="pitch-tracking-detail" aria-label="선택한 투구 tracking">
      <div className="panel-title-row">
        <h3>{pitchEventId === null ? "원천 tracking 예외" : "연결된 tracking"}</h3>
        <span>
          {String(candidates.length)}개 관측 · {needsReview ? "교정 필요" : "자동 정리됨"}
        </span>
      </div>
      {candidates.map((candidate) => {
        const choices = matchingPitchChoices(candidate, pitches);
        const selectedPitchId =
          pitchEventId ??
          selectedPitchByTrackingId[candidate.trackingId] ??
          choices[0]?.eventId ??
          "";
        return (
          <article className="inline-tracking-candidate" key={candidate.trackingId}>
            <header>
              <div>
                <strong>{trackingFindingLocation(document, candidate, eventContexts)}</strong>
                <small>{trackingSourceLocation(candidate)}</small>
              </div>
              <span className={`item-state tracking-${candidate.resolution.kind}`}>
                {resolutionLabel(candidate)}
              </span>
            </header>
            <TrackingMetricSummary candidate={candidate} />
            {needsReview ? (
              <div className="inline-tracking-actions">
                {candidate.resolution.kind === "pending" && pitchEventId === null ? (
                  <label>
                    <span>연결할 실제 투구</span>
                    <select
                      aria-label={`${candidate.trackingId} 연결 투구`}
                      value={selectedPitchId}
                      disabled={pending}
                      onChange={(event) =>
                        setSelectedPitchByTrackingId((current) => ({
                          ...current,
                          [candidate.trackingId]: event.target.value,
                        }))
                      }
                    >
                      {choices.length === 0 ? <option value="">연결 후보 없음</option> : null}
                      {choices.map((pitch) => (
                        <option key={pitch.eventId} value={pitch.eventId}>
                          {pitch.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {candidate.resolution.kind === "pending" ? (
                  <button
                    type="button"
                    disabled={pending || selectedPitchId === ""}
                    onClick={() =>
                      onApply({
                        commandId: newCommandId(),
                        kind: "link_tracking_candidate",
                        trackingId: candidate.trackingId,
                        pitchEventId: selectedPitchId,
                      })
                    }
                  >
                    이 관측값을 투구에 연결
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending}
                    onClick={() =>
                      onApply({
                        commandId: newCommandId(),
                        kind: "unlink_tracking_candidate",
                        trackingId: candidate.trackingId,
                      })
                    }
                  >
                    연결 해제
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={pending}
                  onClick={() =>
                    onApply({
                      commandId: newCommandId(),
                      kind: "exclude_tracking_candidate",
                      trackingId: candidate.trackingId,
                      reason: "provider_conflict",
                    })
                  }
                >
                  공급자 충돌로 제외
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}

function relatedCandidates(
  document: StagingGameDocumentV2,
  pitchEventId: string | null,
  exceptionTrackingId: string | null,
): TrackingCandidate[] {
  if (pitchEventId === null) {
    const exception = document.trackingCandidates.find(
      (candidate) => candidate.trackingId === exceptionTrackingId,
    );
    return exception === undefined ? [] : [exception];
  }
  const event = document.events.find((item) => item.identity.eventId === pitchEventId);
  if (event?.kind !== "pitch") return [];
  const linkedIds = new Set(
    document.trackingCandidates.flatMap((candidate) =>
      candidate.resolution.kind === "linked" && candidate.resolution.pitchEventId === pitchEventId
        ? [candidate.trackingId]
        : [],
    ),
  );
  return document.trackingCandidates.filter((candidate) => {
    if (
      candidate.resolution.kind === "linked" &&
      candidate.resolution.pitchEventId === pitchEventId
    ) {
      return true;
    }
    if (
      candidate.resolution.kind === "duplicate" &&
      linkedIds.has(candidate.resolution.canonicalTrackingId)
    ) {
      return true;
    }
    return (
      candidate.resolution.kind === "pending" &&
      candidate.sourcePitchId !== undefined &&
      candidate.sourcePitchId === event.payload.sourcePitchId &&
      event.identity.kind === "source" &&
      candidate.source.endpoint === event.identity.endpoint &&
      candidate.source.blockIndex === event.identity.blockIndex
    );
  });
}

function buildPitchChoices(
  document: StagingGameDocumentV2,
  eventContexts: readonly CorrectionEventContext[],
): PitchChoice[] {
  const contextByEvent = new Map(eventContexts.map((context) => [context.eventId, context]));
  return document.events.flatMap((event) => {
    if (event.kind !== "pitch") return [];
    const pitch = contextByEvent.get(event.identity.eventId)?.pitch;
    return [
      {
        eventId: event.identity.eventId,
        inning: event.inning,
        half: event.half,
        sourcePitchId: pitch?.sourcePitchId ?? event.payload.sourcePitchId ?? null,
        label: [
          `원장 ${String(event.sequence + 1)}행`,
          `${String(event.inning)}회${event.half === "top" ? "초" : "말"}`,
          pitch?.actualPitchNumber === null || pitch?.actualPitchNumber === undefined
            ? "실제 순번 미확인"
            : `실제 ${String(pitch.actualPitchNumber)}구`,
          pitchCallLabel(pitch?.call ?? event.payload.call),
          `source ID ${pitch?.sourcePitchId ?? event.payload.sourcePitchId ?? "없음"}`,
        ].join(" · "),
      },
    ];
  });
}

function matchingPitchChoices(
  candidate: TrackingCandidate,
  pitches: readonly PitchChoice[],
): PitchChoice[] {
  const contextual = pitches.filter(
    (pitch) => pitch.inning === candidate.inning && pitch.half === candidate.half,
  );
  const sourceIdMatches = contextual.filter(
    (pitch) =>
      candidate.sourcePitchId !== undefined && pitch.sourcePitchId === candidate.sourcePitchId,
  );
  return sourceIdMatches.length > 0 ? sourceIdMatches : contextual;
}

function TrackingMetricSummary({
  candidate,
}: {
  readonly candidate: TrackingCandidate;
}): React.JSX.Element {
  const metrics = [
    ["sourcePitchId", candidate.sourcePitchId],
    [
      "PTS 순번",
      candidate.sourcePitchOrdinal === null ? "없음" : String(candidate.sourcePitchOrdinal),
    ],
    ["stance", candidate.stance],
    ["x0/y0/z0", joinNumbers(candidate.x0, candidate.y0, candidate.z0)],
    ["vx0/vy0/vz0", joinNumbers(candidate.vx0, candidate.vy0, candidate.vz0)],
    ["ax/ay/az", joinNumbers(candidate.ax, candidate.ay, candidate.az)],
    ["plate x/y", joinNumbers(candidate.crossPlateX, candidate.crossPlateY)],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
  return (
    <dl className="tracking-review-metrics">
      {metrics.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function joinNumbers(...values: Array<number | undefined>): string | undefined {
  return values.every((value) => value === undefined)
    ? undefined
    : values.map((value) => (value === undefined ? "–" : String(value))).join(" / ");
}

function resolutionLabel(candidate: TrackingCandidate): string {
  switch (candidate.resolution.kind) {
    case "pending":
      return "미해결";
    case "linked":
      return "투구에 연결";
    case "duplicate":
      return "동일 관측 중복";
    case "excluded":
      return `제외 · ${candidate.resolution.reason}`;
  }
}
