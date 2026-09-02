import { compareCanonicalStrings, type PlateResultEvent } from "@kbo/contracts";

import { isAtBat, isHit } from "../rules.js";
import type { CompileContext, MutableBatterLine, MutablePitcherLine } from "./model.js";

export function updateCompletedLines(
  context: CompileContext,
  event: PlateResultEvent,
  resultBatterId: string,
  resultPitcherId: string,
  runsScored: number,
): void {
  const batter = batterLine(context, resultBatterId);
  const pitcher = pitcherLine(context, resultPitcherId);
  batter.plateAppearances += 1;
  pitcher.battersFaced += 1;
  if (isAtBat(event.payload.result)) batter.atBats += 1;
  if (isHit(event.payload.result)) {
    batter.hits += 1;
    pitcher.hits += 1;
  }
  if (event.payload.result === "double") batter.doubles += 1;
  if (event.payload.result === "triple") batter.triples += 1;
  if (event.payload.result === "home_run") batter.homeRuns += 1;
  if (event.payload.result === "walk") {
    batter.walks += 1;
    pitcher.walks += 1;
  }
  if (event.payload.result === "intentional_walk") {
    batter.walks += 1;
    pitcher.walks += 1;
    batter.intentionalWalks += 1;
    pitcher.intentionalWalks += 1;
  }
  if (event.payload.result === "hit_by_pitch") {
    batter.hitByPitch += 1;
    pitcher.hitByPitch += 1;
  }
  if (event.payload.result === "strikeout") {
    batter.strikeouts += 1;
    pitcher.strikeouts += 1;
  }
  if (event.payload.result === "sacrifice_bunt") batter.sacrificeBunts += 1;
  if (event.payload.result === "sacrifice_fly") batter.sacrificeFlies += 1;
  if (event.payload.creditedRbi === undefined && runsScored > 0) {
    context.uncertainRbiBatterIds.add(resultBatterId);
  }
  batter.runsBattedIn += event.payload.creditedRbi ?? 0;
}

export function batterLine(context: CompileContext, playerId: string): MutableBatterLine {
  const existing = context.batterLines.get(playerId);
  if (existing !== undefined) return existing;
  const line: MutableBatterLine = {
    playerId,
    side: context.playerSides.get(playerId) ?? "away",
    plateAppearances: 0,
    atBats: 0,
    runs: 0,
    hits: 0,
    doubles: 0,
    triples: 0,
    homeRuns: 0,
    runsBattedIn: 0,
    walks: 0,
    intentionalWalks: 0,
    hitByPitch: 0,
    strikeouts: 0,
    sacrificeBunts: 0,
    sacrificeFlies: 0,
  };
  context.batterLines.set(playerId, line);
  return line;
}

export function pitcherLine(context: CompileContext, playerId: string): MutablePitcherLine {
  const existing = context.pitcherLines.get(playerId);
  if (existing !== undefined) return existing;
  const line: MutablePitcherLine = {
    playerId,
    side: context.playerSides.get(playerId) ?? "away",
    battersFaced: 0,
    outsRecorded: 0,
    hits: 0,
    runs: 0,
    walks: 0,
    intentionalWalks: 0,
    hitByPitch: 0,
    strikeouts: 0,
    pitches: 0,
    strikes: 0,
  };
  context.pitcherLines.set(playerId, line);
  return line;
}

export function comparePlayerLine(
  left: { readonly playerId: string },
  right: { readonly playerId: string },
): number {
  return compareCanonicalStrings(left.playerId, right.playerId);
}
