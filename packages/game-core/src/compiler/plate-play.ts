import type { PlateResultEvent, RunnerAdvanceEvent, StagingRelayEvent } from "@kbo/contracts";

import { requiredBatterDestination } from "../rules.js";
import type { CompiledRunnerMovement, PlateAppearanceSummary } from "../types.js";
import { addFinding } from "./findings.js";
import type { CompileContext, MutableState } from "./model.js";
import { orderPlayMovements, transitionMovements } from "./movement-engine.js";
import { appendPlateEvent, battingSide, opposite } from "./state.js";
import { batterLine, pitcherLine, updateCompletedLines } from "./statistics.js";

interface PlatePlayApplication {
  readonly relayEventIds: readonly string[];
  readonly relayTexts: readonly string[];
  readonly movements: readonly CompiledRunnerMovement[];
}

export function applyPlateResultPlay(
  state: MutableState,
  event: PlateResultEvent,
  linkedRunners: readonly RunnerAdvanceEvent[],
  attachedNonState: readonly StagingRelayEvent[],
  context: CompileContext,
): PlatePlayApplication {
  const relayRows = [event, ...linkedRunners, ...attachedNonState].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const baseApplication = { relayEventIds: relayRows.map(id), relayTexts: relayTextsOf(relayRows) };
  const pa = state.activePlateAppearance;
  if (pa === null) {
    addFinding(
      context,
      event,
      "result_without_plate_appearance",
      "source",
      "타석 시작 없이 타석 결과가 있습니다.",
    );
    return { ...baseApplication, movements: [] };
  }
  if (event.payload.result === "other") {
    addFinding(
      context,
      event,
      "unresolved_plate_result",
      "source",
      "other 결과는 DB 적재 전에 구체화해야 합니다.",
    );
    return { ...baseApplication, movements: [] };
  }
  if (event.payload.batterId !== pa.currentBatterId) {
    addFinding(
      context,
      event,
      "result_batter_mismatch",
      "source",
      "결과 행의 타자가 현재 타자와 다릅니다.",
    );
    return { ...baseApplication, movements: [] };
  }
  if (event.payload.pitcherId !== pa.currentPitcherId) {
    addFinding(
      context,
      event,
      "result_pitcher_mismatch",
      "source",
      "결과 행의 투수가 현재 투수와 다릅니다.",
    );
    return { ...baseApplication, movements: [] };
  }
  if (event.payload.result === "walk" && state.balls !== 4) {
    addFinding(
      context,
      event,
      "walk_without_four_balls",
      "source",
      "볼넷 결과 앞의 투구 행이 완전하지 않습니다.",
    );
  }
  if (event.payload.result === "strikeout" && state.strikes !== 3) {
    addFinding(
      context,
      event,
      "strikeout_without_three_strikes",
      "source",
      "삼진 결과 앞의 투구 행이 완전하지 않습니다.",
    );
  }
  if (linkedRunners.some((runner) => runner.payload.fromBase < 1)) {
    addFinding(
      context,
      event,
      "duplicate_batter_advance",
      "source",
      "한 타석 결과에 타자주자 행이 여러 개 연결되어 있습니다.",
    );
    return { ...baseApplication, movements: [] };
  }
  const resultBatterId =
    event.payload.result === "strikeout"
      ? (pa.strikeoutResponsibleBatterId ?? pa.currentBatterId)
      : pa.currentBatterId;
  const resultPitcherId =
    event.payload.result === "walk" || event.payload.result === "intentional_walk"
      ? (pa.walkResponsiblePitcherId ?? pa.currentPitcherId)
      : pa.currentPitcherId;
  const rawMovements: CompiledRunnerMovement[] = [deriveBatterMovement(event, resultPitcherId)];
  for (const runner of linkedRunners)
    rawMovements.push(explicitMovement(runner, state, pa.currentPitcherId, rawMovements));
  const chronologicalMovements = inheritFielderChoiceResponsibilities(
    state,
    event,
    rawMovements,
    pa.currentPitcherId,
  );
  const placementMovements = orderPlayMovements(state, chronologicalMovements);
  const scoreBefore = state.half === "top" ? state.awayScore : state.homeScore;
  const applied = applyMovementsAtomically(
    state,
    event,
    placementMovements,
    event.payload.outsRecorded,
    context,
    chronologicalMovements,
  );
  if (!applied) return { ...baseApplication, movements: [] };

  for (const row of relayRows) appendPlateEvent(state, row.identity.eventId);
  const completed: PlateAppearanceSummary = {
    startEventId: pa.startEventId,
    endEventId: event.identity.eventId,
    inning: state.inning,
    half: state.half,
    startBatterId: pa.startBatterId,
    batterId: resultBatterId,
    startPitcherId: pa.startPitcherId,
    pitcherId: resultPitcherId,
    result: event.payload.result,
    completed: true,
    terminationReason: "plate_result",
    actualPitchCount: pa.actualPitchCount,
    eventIds: [...pa.eventIds],
  };
  context.plateAppearances.push(completed);
  const scoreAfter = state.half === "top" ? state.awayScore : state.homeScore;
  updateCompletedLines(context, event, resultBatterId, resultPitcherId, scoreAfter - scoreBefore);
  state.activePlateAppearance = null;
  state.balls = 0;
  state.strikes = 0;
  return { ...baseApplication, movements: placementMovements };
}

export function applyIndependentRunnerPlay(
  state: MutableState,
  event: RunnerAdvanceEvent,
  runners: readonly RunnerAdvanceEvent[],
  context: CompileContext,
): PlatePlayApplication {
  const pitcherId =
    state.activePlateAppearance?.currentPitcherId ??
    state.activePitchers[opposite(battingSide(state.half))];
  if (pitcherId === null) {
    addFinding(
      context,
      event,
      "runner_advance_without_pitcher",
      "domain",
      "주자 이동의 책임 투수를 결정할 수 없습니다.",
    );
    return { relayEventIds: runners.map(id), relayTexts: relayTextsOf(runners), movements: [] };
  }
  const rawMovements: CompiledRunnerMovement[] = [];
  for (const runner of runners) {
    rawMovements.push(explicitMovement(runner, state, pitcherId, rawMovements));
  }
  const placementMovements = orderPlayMovements(state, rawMovements);
  const applied = applyMovementsAtomically(
    state,
    event,
    placementMovements,
    0,
    context,
    rawMovements,
  );
  for (const runner of runners.slice(1)) appendPlateEvent(state, id(runner));
  return {
    relayEventIds: runners.map(id),
    relayTexts: relayTextsOf(runners),
    movements: applied ? placementMovements : [],
  };
}

function inheritFielderChoiceResponsibilities(
  state: MutableState,
  event: PlateResultEvent,
  movements: readonly CompiledRunnerMovement[],
  resultPitcherId: string,
): CompiledRunnerMovement[] {
  if (event.payload.result !== "fielder_choice") return [...movements];

  const finalByBase = state.bases.map((base) => base?.runnerId ?? null) as [
    string | null,
    string | null,
    string | null,
  ];
  for (const movement of movements) {
    if (movement.fromBase > 0) finalByBase[movement.fromBase - 1] = null;
  }
  for (const movement of movements) {
    if (movement.outcome === "safe" && movement.toBase < 4)
      finalByBase[movement.toBase - 1] = movement.runnerId;
  }

  const finalRunners = [...finalByBase]
    .reverse()
    .filter((runnerId): runnerId is string => runnerId !== null);
  const responsibilityByRunner = new Map<string, string>();
  for (const base of state.bases) {
    if (base !== null) responsibilityByRunner.set(base.runnerId, base.responsiblePitcherId);
  }
  for (const movement of movements) {
    if (movement.outcome === "safe" && movement.toBase < 4)
      responsibilityByRunner.set(movement.runnerId, movement.responsiblePitcherId);
  }
  const slots = finalRunners.map(
    (runnerId) => responsibilityByRunner.get(runnerId) ?? resultPitcherId,
  );
  const inheritedOuts = movements.filter((movement) => {
    if (movement.fromBase === 0 || movement.outcome !== "out") return false;
    const occupant = state.bases[movement.fromBase - 1];
    return (
      occupant !== null &&
      occupant !== undefined &&
      occupant.responsiblePitcherId !== resultPitcherId
    );
  });
  for (const movement of [...inheritedOuts].reverse()) {
    const occupant = state.bases[movement.fromBase - 1];
    if (occupant === null || occupant === undefined) continue;
    const leadRank = finalByBase
      .slice(movement.fromBase)
      .filter((runnerId) => runnerId !== null).length;
    slots.splice(Math.min(leadRank, slots.length), 0, occupant.responsiblePitcherId);
  }
  slots.length = finalRunners.length;
  const inheritedByRunner = new Map(
    finalRunners.map((runnerId, index) => [runnerId, slots[index]]),
  );
  return movements.map((movement) => {
    const inherited = inheritedByRunner.get(movement.runnerId);
    return inherited === undefined ? movement : { ...movement, responsiblePitcherId: inherited };
  });
}

function deriveBatterMovement(event: PlateResultEvent, pitcherId: string): CompiledRunnerMovement {
  const destination =
    event.payload.batterDestination ?? requiredBatterDestination(event.payload.result);
  const isOut = destination === null;
  return {
    movementId: `derived:${id(event)}:batter`,
    sourceEventId: null,
    runnerId: event.payload.batterId,
    fromBase: 0,
    toBase: destination ?? 1,
    outcome: destination === 4 ? "scored" : isOut ? "out" : "safe",
    ...(isOut ? { outKind: defaultOutKind(event) } : {}),
    responsiblePitcherId: pitcherId,
    reason: "plate_result",
    derived: true,
    sequence: 0,
  };
}

function explicitMovement(
  event: RunnerAdvanceEvent,
  state: MutableState,
  fallbackPitcherId: string,
  preceding: readonly CompiledRunnerMovement[],
): CompiledRunnerMovement {
  const occupant = event.payload.fromBase === 0 ? null : state.bases[event.payload.fromBase - 1];
  const prior = [...preceding]
    .reverse()
    .find((movement) => movement.runnerId === event.payload.runnerId);
  return {
    movementId: `relay:${id(event)}`,
    sourceEventId: id(event),
    runnerId: event.payload.runnerId,
    fromBase: event.payload.fromBase,
    toBase: event.payload.toBase,
    outcome: event.payload.outcome,
    ...(event.payload.outKind === undefined ? {} : { outKind: event.payload.outKind }),
    ...(event.payload.supersedesThirdOut === undefined
      ? {}
      : { supersedesThirdOut: event.payload.supersedesThirdOut }),
    responsiblePitcherId:
      event.payload.responsiblePitcherId ??
      prior?.responsiblePitcherId ??
      occupant?.responsiblePitcherId ??
      fallbackPitcherId,
    reason:
      event.payload.context.kind === "plate_result" ? "plate_result" : event.payload.context.reason,
    derived: false,
    sequence: event.sequence,
  };
}

function applyMovementsAtomically(
  state: MutableState,
  event: StagingRelayEvent,
  placementMovements: readonly CompiledRunnerMovement[],
  directOuts: number | undefined,
  context: CompileContext,
  chronologicalMovements: readonly CompiledRunnerMovement[] = placementMovements,
): boolean {
  const transition = transitionMovements(
    state,
    placementMovements,
    directOuts,
    chronologicalMovements,
  );
  if (!transition.ok) {
    addFinding(
      context,
      event,
      transition.code,
      "domain",
      transition.message,
      transition.details === undefined ? [] : [...transition.details],
    );
    return false;
  }
  state.outs = transition.outs;
  state.bases = transition.bases.map((base) =>
    base === null ? null : { ...base },
  ) as MutableState["bases"];
  if (state.half === "top") state.awayScore += transition.scored.length;
  else state.homeScore += transition.scored.length;
  const pitcher =
    state.activePlateAppearance?.currentPitcherId ??
    state.activePitchers[opposite(battingSide(state.half))];
  if (pitcher !== null) pitcherLine(context, pitcher).outsRecorded += transition.outsAdded;
  for (const score of transition.scored) {
    batterLine(context, score.runnerId).runs += 1;
    pitcherLine(context, score.responsiblePitcherId).runs += 1;
  }
  return true;
}

function id(event: StagingRelayEvent): string {
  return event.identity.eventId;
}

function relayTextsOf(events: readonly StagingRelayEvent[]): string[] {
  return events.flatMap((event) => (event.relayText === undefined ? [] : [event.relayText]));
}

function defaultOutKind(
  event: PlateResultEvent,
): "batter_runner_before_first" | "strikeout" | "fly_catch" {
  if (event.payload.result === "strikeout") return "strikeout";
  if (["fly_ball", "line_drive", "popup"].includes(event.payload.battedBallType ?? ""))
    return "fly_catch";
  return "batter_runner_before_first";
}
