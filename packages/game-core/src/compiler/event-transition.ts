import type { RunnerAdvanceEvent, Side, StagingRelayEvent } from "@kbo/contracts";

import { applyPitchCall, isWalkTransferredToPreviousPitcher } from "../rules.js";
import type { CompiledRunnerMovement } from "../types.js";
import { addFinding } from "./findings.js";
import type { CompileContext, MutableState } from "./model.js";
import { applyIndependentRunnerPlay, applyPlateResultPlay } from "./plate-play.js";
import {
  appendPlateEvent,
  battingSide,
  nextHalf,
  opposite,
  partialPlateAppearance,
} from "./state.js";
import { pitcherLine } from "./statistics.js";

interface EventApplication {
  readonly relayEventIds: readonly string[];
  readonly relayTexts: readonly string[];
  readonly movements: readonly CompiledRunnerMovement[];
}

const noBases = (): [null, null, null] => [null, null, null];

export function applyLedgerEvent(
  state: MutableState,
  event: StagingRelayEvent,
  context: CompileContext,
  linkedRunners: readonly RunnerAdvanceEvent[],
  attachedNonState: readonly StagingRelayEvent[],
  independentRunners: readonly RunnerAdvanceEvent[],
): EventApplication {
  const simple = (): EventApplication => ({
    relayEventIds: [event.identity.eventId],
    relayTexts: relayTextsOf([event]),
    movements: [],
  });
  if (context.ignoreTrailingFinalArtifact) return simple();
  if (
    event.kind !== "half_inning_start" &&
    event.kind !== "administrative" &&
    event.kind !== "review" &&
    event.kind !== "unresolved"
  ) {
    if (!state.halfActive) {
      addFinding(
        context,
        event,
        "event_without_half",
        "domain",
        "반이닝 시작 전 상태 변경 중계가 있습니다.",
      );
      return simple();
    }
    if (state.inning !== event.inning || state.half !== event.half) {
      addFinding(
        context,
        event,
        "event_half_mismatch",
        "domain",
        "원장 행의 이닝이 compiler 상태와 다릅니다.",
        [
          { field: "inning", expected: state.inning, actual: event.inning },
          { field: "half", expected: state.half, actual: event.half },
        ],
      );
      return simple();
    }
  }
  appendPlateEvent(state, event.identity.eventId);
  switch (event.kind) {
    case "half_inning_start":
      applyHalfStart(state, event, context);
      return simple();
    case "batter_start":
      applyBatterStart(state, event, context);
      return simple();
    case "pitch":
      applyPitch(state, event, context);
      return simple();
    case "plate_result":
      return applyPlateResultPlay(state, event, linkedRunners, attachedNonState, context);
    case "runner_advance":
      if (event.payload.context.kind === "plate_result") return simple();
      return applyIndependentRunnerPlay(
        state,
        event,
        independentRunners.length === 0 ? [event] : independentRunners,
        context,
      );
    case "substitution":
      applySubstitution(state, event, context);
      return simple();
    case "review":
    case "administrative":
      return simple();
    case "unresolved":
      addFinding(
        context,
        event,
        "unresolved_relay_row",
        "source",
        "해석되지 않은 원천 중계 행이 남아 있습니다.",
        [{ field: "sourceType", actual: event.payload.sourceType }],
      );
      return simple();
  }
}

function applyHalfStart(
  state: MutableState,
  event: Extract<StagingRelayEvent, { kind: "half_inning_start" }>,
  context: CompileContext,
): void {
  if (isTrailingFinalArtifact(state, event, context)) {
    context.ignoreTrailingFinalArtifact = true;
    return;
  }
  const expected = nextHalf(state);
  if (state.halfActive) {
    const boundaryReason = state.outs === 3 ? "third_out" : "source_boundary";
    if (state.activePlateAppearance !== null) {
      context.plateAppearances.push(
        partialPlateAppearance(state, event.identity.eventId, boundaryReason),
      );
    }
    if (state.outs < 3) {
      addFinding(
        context,
        event,
        "source_half_incomplete",
        "source",
        "3아웃 전에 다음 반이닝 원천 행이 시작되었습니다.",
        [{ field: "outs", expected: 3, actual: state.outs }],
      );
    }
  }
  if (event.inning !== expected.inning || event.half !== expected.half) {
    addFinding(
      context,
      event,
      "unexpected_half_start",
      "domain",
      "반이닝 시작 순서가 올바르지 않습니다.",
      [
        { field: "inning", expected: expected.inning, actual: event.inning },
        { field: "half", expected: expected.half, actual: event.half },
      ],
    );
    return;
  }
  state.inning = event.inning;
  state.half = event.half;
  state.halfActive = true;
  state.balls = 0;
  state.strikes = 0;
  state.outs = 0;
  state.bases = noBases();
  state.activePlateAppearance = null;
  context.observationMismatchFields.clear();
}

function isTrailingFinalArtifact(
  state: MutableState,
  event: Extract<StagingRelayEvent, { kind: "half_inning_start" }>,
  context: CompileContext,
): boolean {
  if (
    context.document.metadata.status !== "final" ||
    !state.halfActive ||
    state.outs !== 3 ||
    state.inning < context.document.metadata.scheduledInnings
  )
    return false;
  const gameAlreadyDecided =
    (state.half === "bottom" && state.awayScore !== state.homeScore) ||
    (state.half === "top" && state.homeScore > state.awayScore);
  if (!gameAlreadyDecided) return false;
  return context.document.events
    .slice(event.sequence + 1)
    .every((trailing) =>
      ["batter_start", "review", "administrative", "unresolved"].includes(trailing.kind),
    );
}

function applyBatterStart(
  state: MutableState,
  event: Extract<StagingRelayEvent, { kind: "batter_start" }>,
  context: CompileContext,
): void {
  if (state.outs >= 3) {
    addFinding(
      context,
      event,
      "batter_start_after_three_outs",
      "domain",
      "3아웃 뒤에 타석이 시작되었습니다.",
    );
    return;
  }
  if (state.activePlateAppearance !== null) {
    if (
      context.batterHeadersConfirmedBySubstitution.has(event.identity.eventId) &&
      state.activePlateAppearance.currentBatterId === event.payload.batterId &&
      state.activePlateAppearance.currentPitcherId === event.payload.pitcherId
    )
      return;
    if (
      state.activePlateAppearance.currentBatterId === event.payload.batterId &&
      state.activePlateAppearance.currentPitcherId === event.payload.pitcherId &&
      state.activePlateAppearance.actualPitchCount === 0 &&
      state.balls === 0 &&
      state.strikes === 0
    ) {
      return;
    }
    if (
      context.batterHeadersConfirmedBySubstitution.has(event.identity.eventId) &&
      state.activePlateAppearance.currentPitcherId === event.payload.pitcherId
    ) {
      const batting = battingSide(state.half);
      if (!requirePlayer(event.payload.batterId, batting, event, context, "batterId")) return;
      const pa = state.activePlateAppearance;
      if (state.strikes >= 2 && pa.strikeoutResponsibleBatterId === null)
        pa.strikeoutResponsibleBatterId = pa.currentBatterId;
      if (state.strikes < 2) pa.strikeoutResponsibleBatterId = event.payload.batterId;
      pa.currentBatterId = event.payload.batterId;
      return;
    }
    addFinding(
      context,
      event,
      "plate_appearance_overlap",
      "source",
      "이전 타석 결과가 없는 상태에서 다음 타석이 시작되었습니다.",
    );
    return;
  }
  const batting = battingSide(state.half);
  if (!requirePlayer(event.payload.batterId, batting, event, context, "batterId")) return;
  if (!requirePlayer(event.payload.pitcherId, opposite(batting), event, context, "pitcherId"))
    return;
  state.balls = 0;
  state.strikes = 0;
  state.activePitchers[opposite(batting)] = event.payload.pitcherId;
  state.activePlateAppearance = {
    startEventId: event.identity.eventId,
    startBatterId: event.payload.batterId,
    currentBatterId: event.payload.batterId,
    startPitcherId: event.payload.pitcherId,
    currentPitcherId: event.payload.pitcherId,
    walkResponsiblePitcherId: null,
    strikeoutResponsibleBatterId: null,
    actualPitchCount: 0,
    eventIds: [event.identity.eventId],
  };
}

function applyPitch(
  state: MutableState,
  event: Extract<StagingRelayEvent, { kind: "pitch" }>,
  context: CompileContext,
): void {
  const pa = state.activePlateAppearance;
  if (pa === null) {
    addFinding(
      context,
      event,
      "pitch_without_plate_appearance",
      "source",
      "타석 시작 없이 투구 행이 있습니다.",
    );
    return;
  }
  if (event.payload.batterId !== undefined && event.payload.batterId !== pa.currentBatterId) {
    addFinding(
      context,
      event,
      "pitch_batter_mismatch",
      "source",
      "투구 행의 타자가 현재 타자와 다릅니다.",
    );
    return;
  }
  if (event.payload.pitcherId !== undefined && event.payload.pitcherId !== pa.currentPitcherId) {
    addFinding(
      context,
      event,
      "pitch_pitcher_mismatch",
      "source",
      "투구 행의 투수가 현재 투수와 다릅니다.",
    );
    return;
  }
  if (state.balls >= 4 || state.strikes >= 3) {
    addFinding(
      context,
      event,
      "pitch_after_terminal_count",
      "source",
      "종료 count 뒤에 결과 없이 투구가 이어집니다.",
    );
    return;
  }
  const next = applyPitchCall(state.balls, state.strikes, event.payload.call);
  if (next.balls > 4 || next.strikes > 3) {
    addFinding(
      context,
      event,
      "invalid_terminal_count",
      "domain",
      "투구가 허용 범위를 넘는 count를 만들었습니다.",
    );
    return;
  }
  state.balls = next.balls;
  state.strikes = next.strikes;
  if (next.isActualPitch) {
    pa.actualPitchCount += 1;
    const line = pitcherLine(context, pa.currentPitcherId);
    line.pitches += 1;
    if (next.isPitchingStrike) line.strikes += 1;
  }
}

function applySubstitution(
  state: MutableState,
  event: Extract<StagingRelayEvent, { kind: "substitution" }>,
  context: CompileContext,
): void {
  if (
    !requirePlayer(
      event.payload.incomingPlayerId,
      event.payload.side,
      event,
      context,
      "incomingPlayerId",
    )
  )
    return;
  const pa = state.activePlateAppearance;
  if (event.payload.role === "pitcher") {
    state.activePitchers[event.payload.side] = event.payload.incomingPlayerId;
    if (pa !== null && event.payload.side === opposite(battingSide(state.half))) {
      pa.walkResponsiblePitcherId = isWalkTransferredToPreviousPitcher(state.balls, state.strikes)
        ? pa.currentPitcherId
        : event.payload.incomingPlayerId;
      pa.currentPitcherId = event.payload.incomingPlayerId;
    }
  } else if (
    event.payload.role === "batter" &&
    pa !== null &&
    event.payload.side === battingSide(state.half)
  ) {
    if (state.strikes >= 2 && pa.strikeoutResponsibleBatterId === null)
      pa.strikeoutResponsibleBatterId = pa.currentBatterId;
    if (state.strikes < 2) pa.strikeoutResponsibleBatterId = event.payload.incomingPlayerId;
    pa.currentBatterId = event.payload.incomingPlayerId;
  } else if (event.payload.role === "runner" && event.payload.outgoingPlayerId !== undefined) {
    const index = state.bases.findIndex(
      (base) => base?.runnerId === event.payload.outgoingPlayerId,
    );
    if (index < 0) {
      addFinding(
        context,
        event,
        "substitution_runner_not_on_base",
        "domain",
        "교체 대상 주자가 베이스에 없습니다.",
      );
      return;
    }
    const current = state.bases[index];
    if (current !== null && current !== undefined)
      state.bases[index] = { ...current, runnerId: event.payload.incomingPlayerId };
  }
}

function requirePlayer(
  playerId: string,
  side: Side,
  event: StagingRelayEvent,
  context: CompileContext,
  field: string,
): boolean {
  const actual = context.playerSides.get(playerId);
  if (actual === side) return true;
  addFinding(
    context,
    event,
    "player_roster_mismatch",
    "domain",
    "선수 ID가 기대한 팀 roster에 없습니다.",
    [{ field, expected: side, actual: actual ?? null }],
  );
  return false;
}

function relayTextsOf(events: readonly StagingRelayEvent[]): string[] {
  return events.flatMap((event) => (event.relayText === undefined ? [] : [event.relayText]));
}
