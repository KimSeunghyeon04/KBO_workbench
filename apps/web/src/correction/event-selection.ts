import type { StagingRelayEvent } from "@kbo/contracts";

export interface EventSelection {
  readonly eventIds: ReadonlySet<string>;
  readonly activeId: string | null;
  readonly anchorId: string | null;
}
export interface EventSelectionIntent {
  readonly toggle?: boolean;
  readonly range?: boolean;
}
export function singleEventSelection(eventId: string | null): EventSelection {
  return {
    eventIds: new Set(eventId === null ? [] : [eventId]),
    activeId: eventId,
    anchorId: eventId,
  };
}
export function selectEventRows(
  events: readonly StagingRelayEvent[],
  current: EventSelection,
  eventId: string,
  intent: EventSelectionIntent = {},
): EventSelection {
  const index = events.findIndex((event) => event.identity.eventId === eventId);
  if (index < 0) return current;
  if (intent.range) {
    const foundAnchor = events.findIndex((event) => event.identity.eventId === current.anchorId);
    const anchor = foundAnchor < 0 ? index : foundAnchor;
    const ids = new Set(intent.toggle ? current.eventIds : []);
    for (const event of events.slice(Math.min(index, anchor), Math.max(index, anchor) + 1))
      ids.add(event.identity.eventId);
    return {
      eventIds: ids,
      activeId: eventId,
      anchorId: events[anchor]?.identity.eventId ?? eventId,
    };
  }
  if (!intent.toggle) return singleEventSelection(eventId);
  const ids = new Set(current.eventIds);
  if (ids.has(eventId)) ids.delete(eventId);
  else ids.add(eventId);
  const activeId = ids.has(eventId)
    ? eventId
    : current.activeId !== null && ids.has(current.activeId)
      ? current.activeId
      : ([...events].reverse().find((event) => ids.has(event.identity.eventId))?.identity.eventId ??
        null);
  return { eventIds: ids, activeId, anchorId: eventId };
}
export function reconcileEventSelection(
  selection: EventSelection,
  before: readonly StagingRelayEvent[],
  after: readonly StagingRelayEvent[],
): EventSelection {
  if (selection.eventIds.size === 0) return singleEventSelection(null);
  const valid = new Set(after.map((event) => event.identity.eventId));
  const eventIds = new Set(
    after
      .filter((event) => selection.eventIds.has(event.identity.eventId))
      .map((event) => event.identity.eventId),
  );
  if (eventIds.size === 0) {
    const first = before.findIndex((event) => selection.eventIds.has(event.identity.eventId));
    const next =
      before.slice(Math.max(0, first)).find((event) => valid.has(event.identity.eventId)) ??
      before
        .slice(0, Math.max(0, first))
        .reverse()
        .find((event) => valid.has(event.identity.eventId));
    return singleEventSelection(next?.identity.eventId ?? after[0]?.identity.eventId ?? null);
  }
  const activeId =
    selection.activeId !== null && eventIds.has(selection.activeId)
      ? selection.activeId
      : ([...eventIds][0] ?? null);
  return {
    eventIds,
    activeId,
    anchorId:
      selection.anchorId !== null && valid.has(selection.anchorId) ? selection.anchorId : activeId,
  };
}
