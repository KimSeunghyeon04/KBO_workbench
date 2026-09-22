import {
  canonicalStringify,
  parseCorrectionCommand,
  parseStagingGameDocumentV2,
  parseStagingRelayEvent,
  type AtomicCorrectionCommand,
  type CorrectionCommand,
  type CorrectionPreview,
  type Side,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
  type TrackingCandidate,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2, type ReplayResult } from "@kbo/game-core";

import { buildCorrectionPreview } from "./preview.js";

export interface CorrectionResult {
  readonly document: StagingGameDocumentV2;
  readonly replay: ReplayResult;
  readonly preview: CorrectionPreview;
}
export class CorrectionCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CorrectionCommandError";
  }
}

export function applyCorrectionCommand(
  input: StagingGameDocumentV2,
  command: CorrectionCommand,
): CorrectionResult {
  const document = parseStagingGameDocumentV2(input);
  const before = compileStagingGameDocumentV2(document);
  return applyCompiledCorrectionCommand(document, before, command);
}

// Package-internal: the proposal builder owns this exact decoded document and compile.
export function applyCompiledCorrectionCommand(
  document: StagingGameDocumentV2,
  before: ReplayResult,
  command: CorrectionCommand,
): CorrectionResult {
  let corrected: StagingGameDocumentV2;
  let replay: ReplayResult;
  try {
    const decoded = parseCorrectionCommand(command);
    const raw =
      decoded.kind === "correction_batch"
        ? decoded.commands.reduce((current, item) => applyAtomic(current, item), document)
        : applyAtomic(document, decoded);
    const provisional = parseStagingGameDocumentV2(resequence(raw));
    const provisionalReplay = compileStagingGameDocumentV2(provisional);
    const followed = followStableTrackingPlateAppearanceContexts(
      document,
      before,
      provisional,
      provisionalReplay,
    );
    // Reuse only the compile of this exact decoded document, before any tracking changes.
    corrected = followed === provisional ? provisional : parseStagingGameDocumentV2(followed);
    replay = followed === provisional ? provisionalReplay : compileStagingGameDocumentV2(corrected);
  } catch (error: unknown) {
    throw new CorrectionCommandError(
      error instanceof Error ? error.message : "보정 명령을 적용할 수 없습니다.",
    );
  }
  return {
    document: corrected,
    replay,
    preview: buildCorrectionPreview(document, before, corrected, replay),
  };
}

function applyAtomic(
  document: StagingGameDocumentV2,
  command: AtomicCorrectionCommand,
): StagingGameDocumentV2 {
  switch (command.kind) {
    case "add_event":
      return withEvents(
        document,
        insertEvent(document.events, command.event, command.beforeEventId),
      );
    case "delete_event":
      return deleteEvent(document, command.eventId);
    case "replace_event":
      return replaceEvent(document, command.eventId, command.event);
    case "update_observed_state": {
      const index = requiredIndex(document.events, command.eventId);
      const current = document.events[index];
      if (current?.identity.kind !== "source") {
        throw new Error("관측값 수정은 원문에서 수집한 행에만 적용할 수 있습니다.");
      }
      const events = [...document.events];
      const corrected = structuredClone(current);
      if (Object.keys(command.observedStateAfter).length === 0) delete corrected.observedStateAfter;
      else corrected.observedStateAfter = command.observedStateAfter;
      events[index] = parseStagingRelayEvent(corrected);
      return withEvents(document, events);
    }
    case "move_event":
      return withEvents(
        document,
        moveEvent(document.events, command.eventId, command.beforeEventId),
      );
    case "update_roster_player":
      return updateRosterPlayer(document, command.side, command.playerId, command.player);
    case "update_roster_position":
      return updateRosterPosition(document, command.side, command.playerId, command.positions);
    case "update_official_record":
      return command.recordType === "batter"
        ? updateBatterRecord(document, command.playerId, command.record)
        : updatePitcherRecord(document, command.playerId, command.record);
    case "link_tracking_candidate":
      return updateTrackingResolution(document, command.trackingId, {
        kind: "linked",
        pitchEventId: command.pitchEventId,
      });
    case "mark_tracking_duplicate":
      if (command.trackingId === command.canonicalTrackingId) {
        throw new Error("tracking 후보는 자기 자신을 중복 대표로 선택할 수 없습니다.");
      }
      requiredTrackingCandidate(document, command.canonicalTrackingId);
      return updateTrackingResolution(document, command.trackingId, {
        kind: "duplicate",
        canonicalTrackingId: command.canonicalTrackingId,
      });
    case "exclude_tracking_candidate":
      return updateTrackingResolution(document, command.trackingId, {
        kind: "excluded",
        reason: command.reason,
        ...(command.note === undefined ? {} : { note: command.note }),
      });
    case "unlink_tracking_candidate":
      return updateTrackingResolution(document, command.trackingId, { kind: "pending" });
    case "reconcile_tracking_plate_appearance_contexts":
      return reconcileTrackingPlateAppearanceContexts(document);
  }
}

function insertEvent(
  events: readonly StagingRelayEvent[],
  event: StagingRelayEvent,
  beforeEventId: string | null,
): StagingRelayEvent[] {
  if (event.identity.kind !== "manual") {
    throw new Error("수동 추가 명령은 source identity를 만들 수 없습니다.");
  }
  if (events.some((candidate) => candidate.identity.eventId === event.identity.eventId))
    throw new Error(`이미 존재하는 원장 event ID입니다: ${event.identity.eventId}`);
  const result = [...events];
  if (beforeEventId === null) result.push(event);
  else {
    const index = requiredIndex(result, beforeEventId);
    result.splice(index, 0, event);
  }
  return result;
}

function deleteEvent(document: StagingGameDocumentV2, eventId: string): StagingGameDocumentV2 {
  const index = requiredIndex(document.events, eventId);
  const removed = document.events[index];
  const events = [...document.events];
  events.splice(index, 1);
  const withoutEvent = withEvents(document, events);
  return removed?.kind === "pitch"
    ? excludeTrackingForPitch(withoutEvent, eventId, "연결된 원장 투구 행이 삭제되었습니다.")
    : withoutEvent;
}

function updateTrackingResolution(
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

function requiredTrackingCandidate(
  document: StagingGameDocumentV2,
  trackingId: string,
): StagingGameDocumentV2["trackingCandidates"][number] {
  const candidate = document.trackingCandidates.find((item) => item.trackingId === trackingId);
  if (candidate === undefined) throw new Error(`tracking 후보를 찾을 수 없습니다: ${trackingId}`);
  return candidate;
}

function reconcileTrackingPlateAppearanceContexts(
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

function followStableTrackingPlateAppearanceContexts(
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

function replaceEvent(
  document: StagingGameDocumentV2,
  eventId: string,
  replacement: StagingRelayEvent,
): StagingGameDocumentV2 {
  const index = requiredIndex(document.events, eventId);
  const current = document.events[index];
  if (current === undefined) throw new Error(`원장 event를 찾을 수 없습니다: ${eventId}`);
  const events = [...document.events];
  const common = {
    ...replacement,
    identity: current.identity,
    sequence: current.sequence,
  };
  if (current.identity.kind === "source") delete common.observedStateAfter;
  events[index] = parseStagingRelayEvent(
    current.identity.kind === "source"
      ? {
          ...common,
          ...(replacement.relayText !== undefined || current.relayText === undefined
            ? {}
            : { relayText: current.relayText }),
          ...(current.observedStateAfter === undefined
            ? {}
            : { observedStateAfter: current.observedStateAfter }),
        }
      : common,
  );
  const replaced = withEvents(document, events);
  return current.kind === "pitch" && replacement.kind !== "pitch"
    ? excludeTrackingForPitch(
        replaced,
        eventId,
        "연결된 원장 투구 행이 비투구 행으로 교체되었습니다.",
      )
    : replaced;
}

function excludeTrackingForPitch(
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

function moveEvent(
  events: readonly StagingRelayEvent[],
  eventId: string,
  beforeEventId: string | null,
): StagingRelayEvent[] {
  if (beforeEventId === eventId) return [...events];
  const result = [...events];
  const source = requiredIndex(result, eventId);
  const [event] = result.splice(source, 1);
  if (event === undefined) throw new Error(`원장 event를 찾을 수 없습니다: ${eventId}`);
  if (beforeEventId === null) result.push(event);
  else result.splice(requiredIndex(result, beforeEventId), 0, event);
  return result;
}

function updateRosterPlayer(
  document: StagingGameDocumentV2,
  side: Side,
  playerId: string,
  player: StagingGameDocumentV2["rosters"][Side]["players"][number],
): StagingGameDocumentV2 {
  if (player.playerId !== playerId)
    throw new Error("roster 선수 ID는 update 명령으로 변경할 수 없습니다.");
  const players = [...document.rosters[side].players];
  const index = players.findIndex((candidate) => candidate.playerId === playerId);
  if (index < 0) throw new Error(`roster 선수를 찾을 수 없습니다: ${playerId}`);
  players[index] = player;
  return {
    ...document,
    rosters: { ...document.rosters, [side]: { ...document.rosters[side], players } },
  };
}

function updateRosterPosition(
  document: StagingGameDocumentV2,
  side: Side,
  playerId: string,
  positions: readonly string[],
): StagingGameDocumentV2 {
  const player = document.rosters[side].players.find(
    (candidate) => candidate.playerId === playerId,
  );
  if (player === undefined) throw new Error(`roster 선수를 찾을 수 없습니다: ${playerId}`);
  return updateRosterPlayer(document, side, playerId, { ...player, positions: [...positions] });
}

function updateBatterRecord(
  document: StagingGameDocumentV2,
  playerId: string,
  record: StagingGameDocumentV2["officialRecords"]["batters"][number],
): StagingGameDocumentV2 {
  if (record.playerId !== playerId)
    throw new Error("공식 타자 기록의 선수 ID가 update 대상과 다릅니다.");
  const records = [...document.officialRecords.batters];
  const index = records.findIndex((candidate) => candidate.playerId === playerId);
  if (index < 0) records.push(record);
  else records[index] = record;
  return { ...document, officialRecords: { ...document.officialRecords, batters: records } };
}

function updatePitcherRecord(
  document: StagingGameDocumentV2,
  playerId: string,
  record: StagingGameDocumentV2["officialRecords"]["pitchers"][number],
): StagingGameDocumentV2 {
  if (record.playerId !== playerId)
    throw new Error("공식 투수 기록의 선수 ID가 update 대상과 다릅니다.");
  const records = [...document.officialRecords.pitchers];
  const index = records.findIndex((candidate) => candidate.playerId === playerId);
  if (index < 0) records.push(record);
  else records[index] = record;
  return { ...document, officialRecords: { ...document.officialRecords, pitchers: records } };
}

function withEvents(
  document: StagingGameDocumentV2,
  events: readonly StagingRelayEvent[],
): StagingGameDocumentV2 {
  return {
    ...document,
    // Commands and replacements are decoded at entry. Decode the entire draft once after the
    // atomic batch; decoding every unchanged row per child makes large pitch edits quadratic.
    events: events.map((event, sequence) => ({ ...event, sequence })),
  };
}
function resequence(document: StagingGameDocumentV2): StagingGameDocumentV2 {
  return {
    ...withEvents(document, document.events),
    trackingCandidates: document.trackingCandidates.map((observation, sequence) => ({
      ...observation,
      sequence,
    })),
  };
}
function requiredIndex(events: readonly StagingRelayEvent[], eventId: string): number {
  const index = events.findIndex((event) => event.identity.eventId === eventId);
  if (index < 0) throw new Error(`원장 event를 찾을 수 없습니다: ${eventId}`);
  return index;
}

export function cloneStagingDocument(document: StagingGameDocumentV2): StagingGameDocumentV2 {
  return parseStagingGameDocumentV2(JSON.parse(canonicalStringify(document)) as unknown);
}
