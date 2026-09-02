import type { Side, StagingGameDocumentV2 } from "@kbo/contracts";

import type { BaseOccupant, Finding, PlateAppearanceSummary } from "../types.js";

export interface MutablePlateAppearance {
  startEventId: string;
  startBatterId: string;
  currentBatterId: string;
  startPitcherId: string;
  currentPitcherId: string;
  walkResponsiblePitcherId: string | null;
  strikeoutResponsibleBatterId: string | null;
  actualPitchCount: number;
  eventIds: string[];
}

export interface MutableState {
  inning: number;
  half: "top" | "bottom";
  halfActive: boolean;
  balls: number;
  strikes: number;
  outs: number;
  bases: [BaseOccupant | null, BaseOccupant | null, BaseOccupant | null];
  awayScore: number;
  homeScore: number;
  activePlateAppearance: MutablePlateAppearance | null;
  activePitchers: { away: string | null; home: string | null };
}

export interface MutableBatterLine {
  playerId: string;
  side: Side;
  plateAppearances: number;
  atBats: number;
  runs: number;
  hits: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  runsBattedIn: number;
  walks: number;
  intentionalWalks: number;
  hitByPitch: number;
  strikeouts: number;
  sacrificeBunts: number;
  sacrificeFlies: number;
}

export interface MutablePitcherLine {
  playerId: string;
  side: Side;
  battersFaced: number;
  outsRecorded: number;
  hits: number;
  runs: number;
  walks: number;
  intentionalWalks: number;
  hitByPitch: number;
  strikeouts: number;
  pitches: number;
  strikes: number;
}

export interface CompileContext {
  readonly document: StagingGameDocumentV2;
  readonly playerSides: ReadonlyMap<string, Side>;
  findings: Finding[];
  plateAppearances: PlateAppearanceSummary[];
  batterLines: Map<string, MutableBatterLine>;
  pitcherLines: Map<string, MutablePitcherLine>;
  readonly batterHeadersConfirmedBySubstitution: ReadonlySet<string>;
  observationMismatchFields: Set<string>;
  uncertainRbiBatterIds: Set<string>;
}
