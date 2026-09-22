import type {
  ObservedState,
  PlateResultEvent,
  RunnerAdvanceEvent,
  StagingGameDocumentV2,
  StagingRelayEvent,
} from "@kbo/contracts";

import type { FindingDetail } from "../types.js";
import { addFinding } from "./findings.js";
import type { CompileContext, MutableState } from "./model.js";
export function compareObservedState(
  state: MutableState,
  event: StagingRelayEvent,
  context: CompileContext,
  options: {
    readonly includeCount?: boolean;
    readonly includeBalls?: boolean;
    readonly includeStrikes?: boolean;
    readonly includeBases?: boolean;
    readonly includeOuts?: boolean;
    readonly includeScore?: boolean;
  } = {},
): void {
  const observed = event.observedStateAfter;
  if (observed === undefined) return;
  const details: FindingDetail[] = [];
  const comparedFields = new Set<string>();
  if (options.includeCount !== false) {
    if (options.includeBalls !== false) {
      if (observed.balls !== undefined) comparedFields.add("balls");
      appendObservedNumberMismatch(details, observed, "balls", state.balls);
    }
    if (options.includeStrikes !== false) {
      if (observed.strikes !== undefined) comparedFields.add("strikes");
      appendObservedNumberMismatch(details, observed, "strikes", state.strikes);
    }
  }
  if (options.includeOuts !== false) {
    if (observed.outs !== undefined) comparedFields.add("outs");
    appendObservedNumberMismatch(details, observed, "outs", state.outs);
  }
  if (options.includeScore !== false) {
    if (observed.awayScore !== undefined) comparedFields.add("awayScore");
    if (observed.homeScore !== undefined) comparedFields.add("homeScore");
    appendObservedNumberMismatch(details, observed, "awayScore", state.awayScore);
    appendObservedNumberMismatch(details, observed, "homeScore", state.homeScore);
  }
  if (options.includeBases !== false && observed.bases !== undefined) {
    for (let index = 0; index < 3; index += 1) {
      const field = `bases.${String(index + 1)}`;
      comparedFields.add(field);
      const actual = state.bases[index]?.runnerId ?? null;
      const expected = observed.bases[index];
      const matches =
        expected === true
          ? actual !== null
          : expected === false || expected === null
            ? actual === null
            : expected === actual;
      if (!matches) details.push({ field, expected: expected ?? null, actual });
    }
  }
  const mismatchedFields = new Set(details.map((detail) => detail.field));
  for (const field of comparedFields) {
    if (!mismatchedFields.has(field)) context.observationMismatchFields.delete(field);
  }
  const newlyMismatched = details.filter(
    (detail) => !context.observationMismatchFields.has(detail.field),
  );
  for (const detail of newlyMismatched) context.observationMismatchFields.add(detail.field);
  if (newlyMismatched.length > 0) {
    addFinding(
      context,
      event,
      "source_observation_mismatch",
      "source",
      "원천 관측값과 compiler 계산값이 다릅니다.",
      newlyMismatched,
    );
  }
}

export function comparePlatePlayObservedState(
  state: MutableState,
  result: PlateResultEvent,
  linkedRunners: readonly RunnerAdvanceEvent[],
  context: CompileContext,
): void {
  const finalStateEvent = linkedRunners.at(-1) ?? result;
  if (finalStateEvent.observedStateAfter !== undefined) {
    compareObservedState(state, finalStateEvent, context, {
      includeCount: false,
      includeBases: state.outs < 3 && !isFinalWalkOff(state, finalStateEvent, context),
    });
  }
}

export function compareIndependentPlayObservedState(
  state: MutableState,
  runners: readonly RunnerAdvanceEvent[],
  context: CompileContext,
): void {
  const finalStateEvent = runners.at(-1);
  if (finalStateEvent?.observedStateAfter !== undefined) {
    compareObservedState(state, finalStateEvent, context, {
      includeBases: state.outs < 3 && !isFinalWalkOff(state, finalStateEvent, context),
    });
  }
}

function isFinalWalkOff(
  state: MutableState,
  finalStateEvent: StagingRelayEvent,
  context: CompileContext,
): boolean {
  const { document } = context;
  if (
    document.metadata.status !== "final" ||
    state.half !== "bottom" ||
    state.inning < document.metadata.scheduledInnings ||
    state.homeScore <= state.awayScore
  ) {
    return false;
  }
  // 끝내기 이후 원천의 잔루 표시는 정리 중인 값일 수 있다. 실제 진행이 더 있으면
  // 종료 지점으로 간주하지 않으며, 점수·아웃과 명시적 이동 검증은 그대로 유지한다.
  for (const event of document.events.slice(finalStateEvent.sequence + 1)) {
    if (event.kind !== "administrative" && event.kind !== "review") return false;
  }
  return true;
}

export function compareFinalObservedScore(
  state: MutableState,
  document: StagingGameDocumentV2,
  context: CompileContext,
): void {
  if (document.metadata.status !== "final") return;
  let candidateIndex = -1;
  for (let index = document.events.length - 1; index >= 0; index -= 1) {
    const event = document.events[index];
    if (
      event?.identity.kind === "source" &&
      event.observedStateAfter?.awayScore !== undefined &&
      event.observedStateAfter.homeScore !== undefined
    ) {
      candidateIndex = index;
      break;
    }
  }
  if (candidateIndex < 0) return;
  const candidate = document.events[candidateIndex];
  if (candidate === undefined) return;

  const laterSourceCanScore = document.events
    .slice(candidateIndex + 1)
    .some((event) => event.identity.kind === "source" && eventCanChangeScore(event));
  if (laterSourceCanScore) return;

  compareObservedState(state, candidate, context, {
    includeCount: false,
    includeBases: false,
    includeOuts: false,
    includeScore: true,
  });
}

function appendObservedNumberMismatch(
  details: FindingDetail[],
  observed: ObservedState,
  key: "balls" | "strikes" | "outs" | "awayScore" | "homeScore",
  actual: number,
): void {
  const expected = observed[key];
  if (expected !== undefined && expected !== actual) details.push({ field: key, expected, actual });
}

function eventCanChangeScore(event: StagingRelayEvent): boolean {
  if (event.kind === "runner_advance") return event.payload.toBase === 4;
  if (event.kind === "plate_result") return event.payload.result === "home_run";
  return (
    event.kind === "unresolved" &&
    (event.payload.suspectedKind === "runner_advance" ||
      event.payload.suspectedKind === "plate_result")
  );
}
