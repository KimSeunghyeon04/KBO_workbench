import type { Side, StagingGameDocumentV2 } from "@kbo/contracts";

import type { GameState, PlateAppearanceSummary } from "../types.js";
import type { CompileContext, MutableState } from "./model.js";

export function initialState(): MutableState {
  return {
    inning: 0,
    half: "bottom",
    halfActive: false,
    balls: 0,
    strikes: 0,
    outs: 0,
    bases: [null, null, null],
    awayScore: 0,
    homeScore: 0,
    activePlateAppearance: null,
    activePitchers: { away: null, home: null },
  };
}

export function snapshot(state: MutableState): GameState {
  return {
    ...state,
    bases: [copyBase(state.bases[0]), copyBase(state.bases[1]), copyBase(state.bases[2])],
    activePitchers: { ...state.activePitchers },
    activePlateAppearance:
      state.activePlateAppearance === null
        ? null
        : {
            ...state.activePlateAppearance,
            eventIds: [...state.activePlateAppearance.eventIds],
          },
  };
}

export function cloneState(state: MutableState): MutableState {
  return {
    ...state,
    bases: [copyBase(state.bases[0]), copyBase(state.bases[1]), copyBase(state.bases[2])],
    activePitchers: { ...state.activePitchers },
    activePlateAppearance:
      state.activePlateAppearance === null
        ? null
        : { ...state.activePlateAppearance, eventIds: [...state.activePlateAppearance.eventIds] },
  };
}

function copyBase(base: GameState["bases"][number]): GameState["bases"][number] {
  return base === null ? null : { ...base };
}

export function cloneContext(context: CompileContext): CompileContext {
  return {
    ...context,
    findings: [...context.findings],
    plateAppearances: [...context.plateAppearances],
    batterLines: new Map([...context.batterLines].map(([key, value]) => [key, { ...value }])),
    pitcherLines: new Map([...context.pitcherLines].map(([key, value]) => [key, { ...value }])),
    observationMismatchFields: new Set(context.observationMismatchFields),
    uncertainRbiBatterIds: new Set(context.uncertainRbiBatterIds),
  };
}

export function partialPlateAppearance(
  state: MutableState,
  endEventId: string | null,
  reason:
    "third_out" | "walk_off" | "called_game" | "forfeit" | "source_boundary" | "end_of_document",
): PlateAppearanceSummary {
  const pa = state.activePlateAppearance;
  if (pa === null) throw new Error("partial plate appearance가 없습니다.");
  return {
    startEventId: pa.startEventId,
    endEventId,
    inning: state.inning,
    half: state.half,
    startBatterId: pa.startBatterId,
    batterId: pa.currentBatterId,
    startPitcherId: pa.startPitcherId,
    pitcherId: pa.currentPitcherId,
    result: null,
    completed: false,
    terminationReason: reason,
    actualPitchCount: pa.actualPitchCount,
    eventIds: [...pa.eventIds],
  };
}

export function playerSides(document: StagingGameDocumentV2): ReadonlyMap<string, Side> {
  return new Map([
    ...document.rosters.away.players.map((player) => [player.playerId, "away"] as const),
    ...document.rosters.home.players.map((player) => [player.playerId, "home"] as const),
  ]);
}

export function appendPlateEvent(state: MutableState, eventId: string): void {
  const events = state.activePlateAppearance?.eventIds;
  if (events !== undefined && !events.includes(eventId)) events.push(eventId);
}

export function nextHalf(state: MutableState): { inning: number; half: "top" | "bottom" } {
  if (state.inning === 0) return { inning: 1, half: "top" };
  return state.half === "top"
    ? { inning: state.inning, half: "bottom" }
    : { inning: state.inning + 1, half: "top" };
}

export function battingSide(half: "top" | "bottom"): Side {
  return half === "top" ? "away" : "home";
}

export function opposite(side: Side): Side {
  return side === "away" ? "home" : "away";
}
