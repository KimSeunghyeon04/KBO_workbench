import { compareCanonicalStrings, type PlateResultEvent } from "@kbo/contracts";

import { isAtBat } from "../rules.js";
import { plateResultCounts } from "../player-statistics.js";
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
  const counts = plateResultCounts(event.payload.result);
  for (const line of [batter, pitcher]) {
    line.hits += counts.hits;
    line.walks += counts.walks;
    line.intentionalWalks += counts.intentionalWalks;
    line.hitByPitch += counts.hitByPitch;
    line.strikeouts += counts.strikeouts;
  }
  batter.doubles += counts.doubles;
  batter.triples += counts.triples;
  batter.homeRuns += counts.homeRuns;
  batter.sacrificeBunts += counts.sacrificeBunts;
  batter.sacrificeFlies += counts.sacrificeFlies;
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
