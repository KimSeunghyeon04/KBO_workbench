import {
  canonicalStringify,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { relayTextByEvent } from "../events/relay-text";
import { eventKindLabel } from "./event-presentation";

export type EventDifferenceKind = "added" | "removed" | "changed" | "moved";
export interface EventDifference {
  readonly eventId: string;
  readonly kind: EventDifferenceKind;
  readonly originalSequence: number | null;
  readonly currentSequence: number | null;
  readonly originalText: string | null;
  readonly currentText: string | null;
  readonly originalSummary: string | null;
  readonly currentSummary: string | null;
}
export interface OriginalComparison {
  readonly events: readonly EventDifference[];
  readonly eventCounts: Readonly<Record<EventDifferenceKind, number>>;
  readonly rosterChanges: number;
  readonly trackingChanges: number;
  readonly officialRecordChanges: number;
}

export function compareWithOriginal(
  original: StagingGameDocumentV2,
  current: StagingGameDocumentV2,
): OriginalComparison {
  const before = new Map(original.events.map((item) => [item.identity.eventId, item]));
  const after = new Map(current.events.map((item) => [item.identity.eventId, item]));
  const beforeText = relayTextByEvent(original);
  const afterText = relayTextByEvent(current);
  const events: EventDifference[] = [];
  for (const eventId of new Set([...before.keys(), ...after.keys()])) {
    const originalEvent = before.get(eventId);
    const currentEvent = after.get(eventId);
    const kind = differenceKind(originalEvent, currentEvent);
    if (kind === null) continue;
    events.push({
      eventId,
      kind,
      originalSequence: originalEvent?.sequence ?? null,
      currentSequence: currentEvent?.sequence ?? null,
      originalText: originalEvent === undefined ? null : (beforeText.get(eventId) ?? null),
      currentText: currentEvent === undefined ? null : (afterText.get(eventId) ?? null),
      originalSummary: originalEvent === undefined ? null : summary(originalEvent),
      currentSummary: currentEvent === undefined ? null : summary(currentEvent),
    });
  }
  events.sort(
    (left, right) =>
      (left.currentSequence ?? left.originalSequence ?? Infinity) -
      (right.currentSequence ?? right.originalSequence ?? Infinity),
  );
  return {
    events,
    eventCounts: {
      added: count(events, "added"),
      removed: count(events, "removed"),
      changed: count(events, "changed"),
      moved: count(events, "moved"),
    },
    rosterChanges: keyedChanges(
      rosterRows(original),
      rosterRows(current),
      (item) => `${item.side}:${item.player.playerId}`,
    ),
    trackingChanges: keyedChanges(
      original.trackingCandidates,
      current.trackingCandidates,
      (item) => item.trackingId,
    ),
    officialRecordChanges:
      keyedChanges(
        original.officialRecords.batters,
        current.officialRecords.batters,
        (item) => `${item.side}:${item.playerId}`,
      ) +
      keyedChanges(
        original.officialRecords.pitchers,
        current.officialRecords.pitchers,
        (item) => `${item.side}:${item.playerId}`,
      ),
  };
}

function differenceKind(
  original: StagingRelayEvent | undefined,
  current: StagingRelayEvent | undefined,
): EventDifferenceKind | null {
  if (original === undefined) return "added";
  if (current === undefined) return "removed";
  if (
    canonicalStringify({ ...original, sequence: 0 }) !==
    canonicalStringify({ ...current, sequence: 0 })
  )
    return "changed";
  return original.sequence === current.sequence ? null : "moved";
}
function summary(event: StagingRelayEvent): string {
  return `${String(event.inning)}회${event.half === "top" ? "초" : "말"} · ${eventKindLabel(event.kind)}`;
}
function count(rows: readonly EventDifference[], kind: EventDifferenceKind): number {
  return rows.filter((item) => item.kind === kind).length;
}
function rosterRows(document: StagingGameDocumentV2) {
  return (["away", "home"] as const).flatMap((side) =>
    document.rosters[side].players.map((player) => ({ side, player })),
  );
}
function keyedChanges<T>(
  before: readonly T[],
  after: readonly T[],
  key: (row: T) => string,
): number {
  const left = new Map(before.map((row) => [key(row), canonicalStringify(row)]));
  const right = new Map(after.map((row) => [key(row), canonicalStringify(row)]));
  return [...new Set([...left.keys(), ...right.keys()])].filter(
    (item) => left.get(item) !== right.get(item),
  ).length;
}
