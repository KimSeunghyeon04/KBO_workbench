import type { PitchCall, PitchEvent, PlateResult, StagingRelayEvent } from "@kbo/contracts";

export interface CountTransition {
  readonly balls: number;
  readonly strikes: number;
  readonly isActualPitch: boolean;
  readonly isPitchingStrike: boolean;
}

export function applyPitchCall(balls: number, strikes: number, call: PitchCall): CountTransition {
  switch (call) {
    case "no_pitch":
      return { balls, strikes, isActualPitch: false, isPitchingStrike: false };
    case "automatic_ball":
      return { balls: balls + 1, strikes, isActualPitch: false, isPitchingStrike: false };
    case "automatic_strike":
      return { balls, strikes: strikes + 1, isActualPitch: false, isPitchingStrike: false };
    case "ball":
      return { balls: balls + 1, strikes, isActualPitch: true, isPitchingStrike: false };
    case "hit_by_pitch":
      return { balls, strikes, isActualPitch: true, isPitchingStrike: false };
    case "foul":
      return {
        balls,
        strikes: strikes < 2 ? strikes + 1 : strikes,
        isActualPitch: true,
        isPitchingStrike: true,
      };
    case "called_strike":
    case "swinging_strike":
    case "foul_bunt":
    case "foul_tip":
      return { balls, strikes: strikes + 1, isActualPitch: true, isPitchingStrike: true };
    case "in_play":
      return { balls, strikes, isActualPitch: true, isPitchingStrike: true };
  }
}

export function findTerminalPitchForPlateResult(
  events: readonly StagingRelayEvent[],
  resultIndex: number,
): PitchEvent | undefined {
  const result = events[resultIndex];
  if (result?.kind !== "plate_result") return undefined;

  let pitchIndex = resultIndex - 1;
  while (pitchIndex >= 0) {
    const candidate = events[pitchIndex];
    if (candidate?.kind !== "administrative" && candidate?.kind !== "review") break;
    pitchIndex -= 1;
  }

  const pitch = events[pitchIndex];
  if (
    pitch?.kind !== "pitch" ||
    pitch.inning !== result.inning ||
    pitch.half !== result.half ||
    (pitch.payload.batterId !== undefined && pitch.payload.batterId !== result.payload.batterId) ||
    (pitch.payload.pitcherId !== undefined && pitch.payload.pitcherId !== result.payload.pitcherId)
  ) {
    return undefined;
  }
  return pitch;
}

export function isWalkTransferredToPreviousPitcher(balls: number, strikes: number): boolean {
  return (
    (balls === 2 && (strikes === 0 || strikes === 1)) ||
    (balls === 3 && (strikes === 0 || strikes === 1 || strikes === 2))
  );
}

export function isAtBat(result: PlateResult): boolean {
  return ![
    "walk",
    "intentional_walk",
    "hit_by_pitch",
    "sacrifice_bunt",
    "sacrifice_fly",
    "interference",
  ].includes(result);
}

export function isHit(result: PlateResult): boolean {
  return ["single", "double", "triple", "home_run"].includes(result);
}

export function requiredBatterDestination(result: PlateResult): number | null {
  switch (result) {
    case "single":
    case "walk":
    case "intentional_walk":
    case "hit_by_pitch":
    case "fielder_choice":
    case "reached_on_error":
    case "interference":
      return 1;
    case "double":
      return 2;
    case "triple":
      return 3;
    case "home_run":
      return 4;
    default:
      return null;
  }
}

export function thirdOutCancelsEveryRun(outKind: string): boolean {
  return ["force", "appeal_force", "batter_runner_before_first", "strikeout"].includes(outKind);
}
