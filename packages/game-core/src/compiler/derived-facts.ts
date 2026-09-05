import type { Side, StagingRelayEvent } from "@kbo/contracts";

import type {
  BaserunnerLine,
  CompiledPitchFact,
  CompiledPlay,
  PlateAppearanceSummary,
  ReplayFrame,
} from "../types.js";
import { comparePlayerLine } from "./statistics.js";

export function compilePitchFacts(
  events: readonly StagingRelayEvent[],
  plateAppearances: readonly PlateAppearanceSummary[],
  frames: readonly ReplayFrame[],
): CompiledPitchFact[] {
  const eventById = new Map(events.map((event) => [event.identity.eventId, event]));
  const frameByEventId = new Map(frames.map((frame) => [frame.eventId, frame]));
  const plateContext = new Map<
    string,
    {
      readonly plateAppearanceEventId: string;
      readonly pitchEventNumber: number;
      readonly actualPitchNumber: number | null;
    }
  >();
  for (const plateAppearance of plateAppearances) {
    let pitchEventNumber = 0;
    let actualPitchNumber = 0;
    for (const eventId of plateAppearance.eventIds) {
      const event = eventById.get(eventId);
      if (event?.kind !== "pitch") continue;
      pitchEventNumber += 1;
      const actual = isActualPitch(event.payload.call);
      if (actual) actualPitchNumber += 1;
      plateContext.set(eventId, {
        plateAppearanceEventId: plateAppearance.startEventId,
        pitchEventNumber,
        actualPitchNumber: actual ? actualPitchNumber : null,
      });
    }
  }
  return events.flatMap((event) => {
    if (event.kind !== "pitch") return [];
    const eventId = event.identity.eventId;
    const frame = frameByEventId.get(eventId);
    if (frame === undefined) return [];
    const context = plateContext.get(eventId);
    const actual = isActualPitch(event.payload.call);
    const swing = ["swinging_strike", "foul", "foul_bunt", "foul_tip", "in_play"].includes(
      event.payload.call,
    );
    const whiff = event.payload.call === "swinging_strike";
    const calledStrike = event.payload.call === "called_strike";
    const foul = ["foul", "foul_bunt", "foul_tip"].includes(event.payload.call);
    const inPlay = event.payload.call === "in_play";
    const strike = calledStrike || swing;
    const beforePlateAppearance = frame.before.activePlateAppearance;
    return [
      {
        pitchId: eventId,
        sequence: event.sequence,
        inning: event.inning,
        half: event.half,
        plateAppearanceEventId: context?.plateAppearanceEventId ?? null,
        pitchEventNumber: context?.pitchEventNumber ?? null,
        actualPitchNumber: context?.actualPitchNumber ?? null,
        batterId: event.payload.batterId ?? beforePlateAppearance?.currentBatterId ?? null,
        pitcherId: event.payload.pitcherId ?? beforePlateAppearance?.currentPitcherId ?? null,
        sourcePitchId: event.payload.sourcePitchId ?? null,
        ...(event.payload.speedKph === undefined ? {} : { speedKph: event.payload.speedKph }),
        ...(event.payload.pitchType === undefined ? {} : { pitchType: event.payload.pitchType }),
        call: event.payload.call,
        actual,
        ball: event.payload.call === "ball",
        calledStrike,
        swing,
        whiff,
        foul,
        inPlay,
        strike,
        csw: calledStrike || whiff,
        before: frame.before,
        after: frame.after,
      },
    ];
  });
}

export function compileBaserunnerLines(
  plays: readonly CompiledPlay[],
  playerSideById: ReadonlyMap<string, Side>,
): BaserunnerLine[] {
  const lines = new Map<string, BaserunnerLine>();
  for (const movement of plays.flatMap((play) => play.movements)) {
    if (movement.fromBase === 0) continue;
    const side = playerSideById.get(movement.runnerId);
    if (side === undefined) continue;
    const current = lines.get(movement.runnerId) ?? {
      playerId: movement.runnerId,
      side,
      advances: 0,
      extraBasesTaken: 0,
      runs: 0,
      stolenBases: 0,
      caughtStealing: 0,
      pickoffs: 0,
    };
    const successful = movement.outcome === "safe" || movement.outcome === "scored";
    lines.set(movement.runnerId, {
      ...current,
      advances: current.advances + Number(successful),
      extraBasesTaken:
        current.extraBasesTaken +
        (successful ? Math.max(0, movement.toBase - movement.fromBase - 1) : 0),
      runs: current.runs + Number(movement.outcome === "scored"),
      stolenBases: current.stolenBases + Number(movement.reason === "stolen_base" && successful),
      caughtStealing:
        current.caughtStealing +
        Number(movement.reason === "caught_stealing" && movement.outcome === "out"),
      pickoffs:
        current.pickoffs + Number(movement.reason === "pickoff" && movement.outcome === "out"),
    });
  }
  return [...lines.values()].sort(comparePlayerLine);
}

function isActualPitch(call: string): boolean {
  return call !== "automatic_ball" && call !== "automatic_strike" && call !== "no_pitch";
}
