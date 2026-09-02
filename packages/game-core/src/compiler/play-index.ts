import type { RunnerAdvanceEvent, StagingGameDocumentV2, StagingRelayEvent } from "@kbo/contracts";

import type { Finding } from "../types.js";

export interface PlayIndex {
  readonly linkedByResult: ReadonlyMap<string, readonly RunnerAdvanceEvent[]>;
  readonly nonStateByResult: ReadonlyMap<string, readonly StagingRelayEvent[]>;
  readonly independentByLeader: ReadonlyMap<string, readonly RunnerAdvanceEvent[]>;
  readonly nonStateByIndependentLeader: ReadonlyMap<string, readonly StagingRelayEvent[]>;
  readonly invalidPlayLeaderIds: ReadonlySet<string>;
  readonly findingByEvent: ReadonlyMap<string, readonly Finding[]>;
}

/** 원장 순서를 immutable play 관계로 색인하며 상태 계산은 수행하지 않는다. */
export function buildPlayIndex(document: StagingGameDocumentV2): PlayIndex {
  const eventsById = new Map(document.events.map((event) => [event.identity.eventId, event]));
  const linked = new Map<string, RunnerAdvanceEvent[]>();
  const nonStateByResult = new Map<string, StagingRelayEvent[]>();
  const independentByLeader = new Map<string, RunnerAdvanceEvent[]>();
  const nonStateByIndependentLeader = new Map<string, StagingRelayEvent[]>();
  const invalidPlayLeaderIds = new Set<string>();
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
      invalidPlayLeaderIds.add(targetId);
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
    if (event.inning !== target.inning || event.half !== target.half) {
      invalidPlayLeaderIds.add(targetId);
      pushFinding(
        findingByEvent,
        targetId,
        finding(
          document,
          event,
          "linked_play_half_mismatch",
          "연결 주자 이동과 타석 결과의 반이닝이 다릅니다.",
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
      invalidPlayLeaderIds.add(targetId);
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
    const annotations: StagingRelayEvent[] = [];
    while (index + 1 < document.events.length) {
      const next = document.events[index + 1];
      if (
        next !== undefined &&
        isNonState(next) &&
        next.inning === leader.inning &&
        next.half === leader.half
      ) {
        annotations.push(next);
        index += 1;
        continue;
      }
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
    if (annotations.length > 0)
      nonStateByIndependentLeader.set(leader.identity.eventId, annotations);
  }
  attachTrailingPlateAnnotations(document, linked, nonStateByResult, invalidPlayLeaderIds);
  validateReviewReferences(
    document,
    linked,
    nonStateByResult,
    independentByLeader,
    nonStateByIndependentLeader,
    invalidPlayLeaderIds,
    findingByEvent,
  );
  return {
    linkedByResult: linked,
    nonStateByResult,
    independentByLeader,
    nonStateByIndependentLeader,
    invalidPlayLeaderIds,
    findingByEvent,
  };
}

function attachTrailingPlateAnnotations(
  document: StagingGameDocumentV2,
  linked: ReadonlyMap<string, readonly RunnerAdvanceEvent[]>,
  nonStateByResult: Map<string, StagingRelayEvent[]>,
  invalidPlayLeaderIds: ReadonlySet<string>,
): void {
  for (const event of document.events) {
    if (event.kind !== "plate_result" || invalidPlayLeaderIds.has(event.identity.eventId)) continue;
    const runners = linked.get(event.identity.eventId) ?? [];
    let sequence = runners.at(-1)?.sequence ?? event.sequence;
    const annotations = nonStateByResult.get(event.identity.eventId) ?? [];
    while (sequence + 1 < document.events.length) {
      const next = document.events[sequence + 1];
      if (
        next === undefined ||
        !isNonState(next) ||
        next.inning !== event.inning ||
        next.half !== event.half
      ) {
        break;
      }
      if (!annotations.some((annotation) => annotation.sequence === next.sequence)) {
        annotations.push(next);
      }
      sequence += 1;
    }
    if (annotations.length > 0) {
      annotations.sort((left, right) => left.sequence - right.sequence);
      nonStateByResult.set(event.identity.eventId, annotations);
    }
  }
}

function validateReviewReferences(
  document: StagingGameDocumentV2,
  linked: ReadonlyMap<string, readonly RunnerAdvanceEvent[]>,
  nonStateByResult: ReadonlyMap<string, readonly StagingRelayEvent[]>,
  independentByLeader: ReadonlyMap<string, readonly RunnerAdvanceEvent[]>,
  nonStateByIndependentLeader: ReadonlyMap<string, readonly StagingRelayEvent[]>,
  invalidPlayLeaderIds: Set<string>,
  findingByEvent: Map<string, Finding[]>,
): void {
  const eventsById = new Map(document.events.map((event) => [event.identity.eventId, event]));
  const leaderByEvent = new Map<string, string>();
  for (const event of document.events) {
    if (!isNonState(event)) leaderByEvent.set(event.identity.eventId, event.identity.eventId);
  }
  for (const [leader, runners] of linked) {
    for (const member of runners) leaderByEvent.set(member.identity.eventId, leader);
    for (const member of nonStateByResult.get(leader) ?? [])
      leaderByEvent.set(member.identity.eventId, leader);
  }
  for (const [leader, runners] of independentByLeader) {
    for (const member of runners) leaderByEvent.set(member.identity.eventId, leader);
    for (const member of nonStateByIndependentLeader.get(leader) ?? [])
      leaderByEvent.set(member.identity.eventId, leader);
  }

  for (const review of document.events) {
    if (review.kind !== "review" || review.payload.reviewedEventId === undefined) continue;
    const target = eventsById.get(review.payload.reviewedEventId);
    let code: string | null = null;
    let message = "";
    if (target === undefined) {
      code = "dangling_review_reference";
      message = "검토 대상 원장 행을 찾을 수 없습니다.";
    } else if (target.sequence >= review.sequence) {
      code =
        target.sequence === review.sequence ? "self_review_reference" : "future_review_reference";
      message = "검토 대상은 같은 행이나 미래 행일 수 없습니다.";
    } else if (target.inning !== review.inning || target.half !== review.half) {
      code = "review_half_mismatch";
      message = "검토 행과 대상 행의 반이닝이 다릅니다.";
    } else {
      const reviewLeader = leaderByEvent.get(review.identity.eventId);
      const precedingLeader = previousStateLeader(document, review.sequence, leaderByEvent);
      const expectedLeader = reviewLeader ?? precedingLeader;
      const targetLeader = leaderByEvent.get(target.identity.eventId) ?? target.identity.eventId;
      if (expectedLeader !== targetLeader) {
        code = "review_target_outside_play";
        message = "검토 대상이 현재 atomic play 경계 밖에 있습니다.";
      }
    }
    if (code === null) continue;
    const leader = leaderByEvent.get(review.identity.eventId);
    const key = leader ?? review.identity.eventId;
    if (leader !== undefined) invalidPlayLeaderIds.add(leader);
    pushFinding(findingByEvent, key, finding(document, review, code, message));
  }
}

function previousStateLeader(
  document: StagingGameDocumentV2,
  sequence: number,
  leaderByEvent: ReadonlyMap<string, string>,
): string | undefined {
  for (let index = sequence - 1; index >= 0; index -= 1) {
    const event = document.events[index];
    if (event === undefined || isNonState(event)) continue;
    return leaderByEvent.get(event.identity.eventId) ?? event.identity.eventId;
  }
  return undefined;
}

function isNonState(event: StagingRelayEvent): boolean {
  return event.kind === "review" || event.kind === "administrative";
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
