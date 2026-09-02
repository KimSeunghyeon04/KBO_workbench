import type { CorrectionTimelinePresentation } from "./event-presentation";

export type EventCollapseKind = "inning" | "plate";

export interface EventCollapseGroup {
  readonly eventId: string;
  readonly kind: EventCollapseKind;
  readonly label: string;
  readonly childCount: number;
}

export interface EventCollapseOwners {
  readonly inningEventId?: string;
  readonly plateEventId?: string;
}

export interface EventCollapseModel {
  readonly groupsByEventId: ReadonlyMap<string, readonly EventCollapseGroup[]>;
  readonly ownersByEventId: ReadonlyMap<string, EventCollapseOwners>;
  readonly inningEventIds: readonly string[];
  readonly plateEventIds: readonly string[];
}

export function buildEventCollapseModel(
  rows: readonly CorrectionTimelinePresentation[],
): EventCollapseModel {
  const mutableGroups = new Map<string, EventCollapseGroup[]>();
  const ownersByEventId = new Map<string, EventCollapseOwners>();
  const inningEventIds: string[] = [];
  const plateEventIds: string[] = [];
  let inningEventId: string | undefined;
  let plateEventId: string | undefined;
  let inningChildCount = 0;
  let plateChildCount = 0;

  const finishInning = (): void => {
    if (inningEventId === undefined) return;
    const row = rows.find(
      (candidate) => candidate.presentation.event.identity.eventId === inningEventId,
    );
    if (row !== undefined)
      addGroup(mutableGroups, {
        eventId: inningEventId,
        kind: "inning",
        label: row.presentation.location,
        childCount: inningChildCount,
      });
  };
  const finishPlate = (): void => {
    if (plateEventId === undefined) return;
    const row = rows.find(
      (candidate) => candidate.presentation.event.identity.eventId === plateEventId,
    );
    if (row !== undefined)
      addGroup(mutableGroups, {
        eventId: plateEventId,
        kind: "plate",
        label: row.presentation.title,
        childCount: plateChildCount,
      });
  };

  for (const row of rows) {
    const presentation = row.presentation;
    const event = presentation.event;
    const eventId = event.identity.eventId;
    if (presentation.startsHalf) {
      finishPlate();
      finishInning();
      inningEventId = eventId;
      plateEventId = undefined;
      inningChildCount = 0;
      plateChildCount = 0;
      inningEventIds.push(eventId);
    } else {
      inningChildCount += 1;
    }
    if (event.kind === "batter_start") {
      finishPlate();
      plateEventId = eventId;
      plateChildCount = 0;
      plateEventIds.push(eventId);
    } else if (plateEventId !== undefined) {
      plateChildCount += 1;
    }
    ownersByEventId.set(eventId, {
      ...(inningEventId === undefined ? {} : { inningEventId }),
      ...(plateEventId === undefined ? {} : { plateEventId }),
    });
  }
  finishPlate();
  finishInning();

  return { groupsByEventId: mutableGroups, ownersByEventId, inningEventIds, plateEventIds };
}

export function applyEventCollapse(
  rows: readonly CorrectionTimelinePresentation[],
  model: EventCollapseModel,
  collapsedInningEventIds: ReadonlySet<string>,
  collapsedPlateEventIds: ReadonlySet<string>,
  filtersActive: boolean,
): CorrectionTimelinePresentation[] {
  if (filtersActive) return [...rows];
  return rows.filter((row) => {
    const eventId = row.presentation.event.identity.eventId;
    const owners = model.ownersByEventId.get(eventId);
    if (
      owners?.inningEventId !== undefined &&
      owners.inningEventId !== eventId &&
      collapsedInningEventIds.has(owners.inningEventId)
    )
      return false;
    return !(
      owners?.plateEventId !== undefined &&
      owners.plateEventId !== eventId &&
      collapsedPlateEventIds.has(owners.plateEventId)
    );
  });
}

export function collapseOwnersForEvent(
  model: EventCollapseModel,
  eventId: string,
): EventCollapseOwners {
  return model.ownersByEventId.get(eventId) ?? {};
}

function addGroup(groups: Map<string, EventCollapseGroup[]>, group: EventCollapseGroup): void {
  groups.set(group.eventId, [...(groups.get(group.eventId) ?? []), group]);
}
