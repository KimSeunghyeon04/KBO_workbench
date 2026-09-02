import type { CorrectionCommand, StagingGameDocumentV2, StagingRelayEvent } from "@kbo/contracts";

type MoveEventCommand = Extract<CorrectionCommand, { readonly kind: "move_event" }>;
type DeleteEventCommand = Extract<CorrectionCommand, { readonly kind: "delete_event" }>;

export type EventMoveDirection = "up" | "down";

export interface EventMoveCapabilities {
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

export function eventMoveCapabilities(
  events: readonly StagingRelayEvent[],
  eventId: string,
): EventMoveCapabilities {
  const index = eventIndex(events, eventId);
  return {
    canMoveUp: index > 0,
    canMoveDown: index >= 0 && index < events.length - 1,
  };
}

export function buildAdjacentMoveCommand(
  events: readonly StagingRelayEvent[],
  eventId: string,
  direction: EventMoveDirection,
  commandId: string,
): MoveEventCommand | null {
  const index = eventIndex(events, eventId);
  if (index < 0) return null;
  if (direction === "up") {
    const previous = events[index - 1];
    if (previous === undefined) return null;
    return {
      commandId,
      kind: "move_event",
      eventId,
      beforeEventId: previous.identity.eventId,
    };
  }
  const next = events[index + 1];
  if (next === undefined) return null;
  return {
    commandId,
    kind: "move_event",
    eventId,
    beforeEventId: events[index + 2]?.identity.eventId ?? null,
  };
}

export function buildImmediateDeleteCommand(
  _document: StagingGameDocumentV2,
  eventId: string,
  commandId: string,
): DeleteEventCommand {
  return {
    commandId,
    kind: "delete_event",
    eventId,
  };
}

export function selectionAfterDelete(
  events: readonly StagingRelayEvent[],
  eventId: string,
): string | null {
  const index = eventIndex(events, eventId);
  if (index < 0) return null;
  return events[index + 1]?.identity.eventId ?? events[index - 1]?.identity.eventId ?? null;
}

export function insertionReferenceAfter(
  events: readonly StagingRelayEvent[],
  eventId: string,
): string | null {
  const index = eventIndex(events, eventId);
  if (index < 0) return null;
  return events[index + 1]?.identity.eventId ?? null;
}

function eventIndex(events: readonly StagingRelayEvent[], eventId: string): number {
  return events.findIndex((event) => event.identity.eventId === eventId);
}
