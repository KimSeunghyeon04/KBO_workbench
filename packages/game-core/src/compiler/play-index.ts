import type { RunnerAdvanceEvent, StagingGameDocumentV2, StagingRelayEvent } from "@kbo/contracts";

import type { Finding } from "../types.js";

export interface PlayIndex {
  readonly linkedByResult: ReadonlyMap<string, readonly RunnerAdvanceEvent[]>;
  readonly nonStateByResult: ReadonlyMap<string, readonly StagingRelayEvent[]>;
  readonly independentByLeader: ReadonlyMap<string, readonly RunnerAdvanceEvent[]>;
  readonly invalidResultIds: ReadonlySet<string>;
  readonly findingByEvent: ReadonlyMap<string, readonly Finding[]>;
}

/** 원장 순서를 immutable play 관계로 색인하며 상태 계산은 수행하지 않는다. */
export function buildPlayIndex(document: StagingGameDocumentV2): PlayIndex {
  const eventsById = new Map(document.events.map((event) => [event.identity.eventId, event]));
  const linked = new Map<string, RunnerAdvanceEvent[]>();
  const nonStateByResult = new Map<string, StagingRelayEvent[]>();
  const independentByLeader = new Map<string, RunnerAdvanceEvent[]>();
  const invalidResultIds = new Set<string>();
  const findingByEvent = new Map<string, Finding[]>();
  for (const event of document.events) {
    if (event.kind !== "runner_advance" || event.payload.context.kind !== "plate_result") continue;
    const targetId = event.payload.context.plateResultEventId;
    const target = eventsById.get(targetId);
    if (target?.kind !== "plate_result") {
      pushFinding(
        findingByEvent,
        event.identity.eventId,
        finding(
          document,
          event,
          "dangling_plate_result_link",
          "연결한 타석 결과 행을 찾을 수 없습니다.",
        ),
      );
      continue;
    }
    if (event.sequence <= target.sequence) {
      invalidResultIds.add(targetId);
      pushFinding(
        findingByEvent,
        event.identity.eventId,
        finding(
          document,
          event,
          "runner_advance_before_result",
          "연결 주자 이동은 타석 결과 뒤에 있어야 합니다.",
        ),
      );
      continue;
    }
    const list = linked.get(targetId) ?? [];
    list.push(event);
    linked.set(targetId, list);
  }
  for (const [targetId, runners] of linked) {
    const target = eventsById.get(targetId);
    if (target === undefined) continue;
    const lastSequence = Math.max(...runners.map((event) => event.sequence));
    for (let sequence = target.sequence + 1; sequence <= lastSequence; sequence += 1) {
      const between = document.events[sequence];
      if (between === undefined) continue;
      if (between.kind === "review" || between.kind === "administrative") {
        const annotations = nonStateByResult.get(targetId) ?? [];
        annotations.push(between);
        nonStateByResult.set(targetId, annotations);
        continue;
      }
      if (
        between.kind === "runner_advance" &&
        between.payload.context.kind === "plate_result" &&
        between.payload.context.plateResultEventId === targetId
      ) {
        continue;
      }
      invalidResultIds.add(targetId);
      pushFinding(
        findingByEvent,
        between.identity.eventId,
        finding(
          document,
          between,
          "state_event_inside_linked_play",
          "연결 플레이 사이에 다른 상태 변경 행이 있습니다.",
        ),
      );
    }
  }
  for (const list of linked.values()) list.sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < document.events.length; index += 1) {
    const leader = document.events[index];
    if (!isIndependentRunner(leader)) continue;
    const group = [leader];
    while (index + 1 < document.events.length) {
      const next = document.events[index + 1];
      if (
        !isIndependentRunner(next) ||
        next.inning !== leader.inning ||
        next.half !== leader.half
      ) {
        break;
      }
      group.push(next);
      index += 1;
    }
    independentByLeader.set(leader.identity.eventId, group);
  }
  return {
    linkedByResult: linked,
    nonStateByResult,
    independentByLeader,
    invalidResultIds,
    findingByEvent,
  };
}

export function findBatterHeadersConfirmedBySubstitution(
  document: StagingGameDocumentV2,
): ReadonlySet<string> {
  const confirmed = new Set<string>();
  for (const [index, event] of document.events.entries()) {
    if (event.kind !== "batter_start") continue;
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const previous = document.events[previousIndex];
      if (
        previous === undefined ||
        previous.inning !== event.inning ||
        previous.half !== event.half
      ) {
        break;
      }
      if (
        previous.kind === "administrative" ||
        previous.kind === "review" ||
        (previous.kind === "substitution" && previous.payload.role !== "batter")
      ) {
        continue;
      }
      if (
        previous.kind === "substitution" &&
        previous.payload.role === "batter" &&
        previous.payload.incomingPlayerId === event.payload.batterId
      ) {
        confirmed.add(event.identity.eventId);
      }
      break;
    }
    for (let nextIndex = index + 1; nextIndex < document.events.length; nextIndex += 1) {
      const next = document.events[nextIndex];
      if (next === undefined || next.inning !== event.inning || next.half !== event.half) break;
      if (
        next.kind === "administrative" ||
        next.kind === "review" ||
        (next.kind === "substitution" && next.payload.role !== "batter")
      ) {
        continue;
      }
      if (
        next.kind === "substitution" &&
        next.payload.role === "batter" &&
        next.payload.incomingPlayerId === event.payload.batterId
      ) {
        confirmed.add(event.identity.eventId);
      }
      break;
    }
  }
  return confirmed;
}

function isIndependentRunner(event: StagingRelayEvent | undefined): event is RunnerAdvanceEvent & {
  readonly payload: RunnerAdvanceEvent["payload"] & {
    readonly context: { readonly kind: "independent"; readonly reason: string };
  };
} {
  return event?.kind === "runner_advance" && event.payload.context.kind === "independent";
}

function finding(
  document: StagingGameDocumentV2,
  event: StagingRelayEvent,
  code: string,
  message: string,
): Finding {
  return {
    code,
    category: "source",
    severity: "blocking",
    message,
    gameId: document.metadata.gameId,
    eventId: event.identity.eventId,
    eventSequence: event.sequence,
    details: [],
  };
}

function pushFinding(target: Map<string, Finding[]>, eventId: string, value: Finding): void {
  const list = target.get(eventId) ?? [];
  list.push(value);
  target.set(eventId, list);
}
