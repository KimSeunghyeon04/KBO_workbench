import type {
  Half,
  PitchCall,
  PlateResult,
  RunnerAdvanceReason,
  RunnerOutKind,
  Side,
  StagingRelayEvent,
} from "@kbo/contracts";

export type FindingCategory = "source" | "domain" | "persistence";
export type FindingSeverity = "warning" | "blocking";
export interface FindingDetail {
  readonly field: string;
  readonly expected?: string | number | boolean | null;
  readonly actual?: string | number | boolean | null;
}
export interface Finding {
  readonly code: string;
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly gameId: string;
  readonly eventId?: string;
  readonly eventSequence?: number;
  readonly recordIdentity?: string;
  readonly details: readonly FindingDetail[];
}

export interface BaseOccupant {
  readonly runnerId: string;
  readonly responsiblePitcherId: string;
}
export type Bases = readonly [BaseOccupant | null, BaseOccupant | null, BaseOccupant | null];
export interface ActivePlateAppearance {
  readonly startEventId: string;
  readonly startBatterId: string;
  readonly currentBatterId: string;
  readonly startPitcherId: string;
  readonly currentPitcherId: string;
  readonly walkResponsiblePitcherId: string | null;
  readonly strikeoutResponsibleBatterId: string | null;
  readonly actualPitchCount: number;
  readonly eventIds: readonly string[];
}
export interface GameState {
  readonly inning: number;
  readonly half: Half;
  readonly halfActive: boolean;
  readonly balls: number;
  readonly strikes: number;
  readonly outs: number;
  readonly bases: Bases;
  readonly awayScore: number;
  readonly homeScore: number;
  readonly activePlateAppearance: ActivePlateAppearance | null;
  readonly activePitchers: Readonly<{ away: string | null; home: string | null }>;
}

export type PlateAppearanceTerminationReason =
  | "plate_result"
  | "third_out"
  | "walk_off"
  | "called_game"
  | "forfeit"
  | "source_boundary"
  | "end_of_document";
export interface PlateAppearanceSummary {
  readonly startEventId: string;
  readonly endEventId: string | null;
  readonly inning: number;
  readonly half: Half;
  readonly startBatterId: string;
  readonly batterId: string;
  readonly startPitcherId: string;
  readonly pitcherId: string;
  readonly result: PlateResult | null;
  readonly completed: boolean;
  readonly terminationReason: PlateAppearanceTerminationReason;
  readonly actualPitchCount: number;
  readonly eventIds: readonly string[];
}

export interface CompiledRunnerMovement {
  readonly movementId: string;
  readonly sourceEventId: string | null;
  readonly runnerId: string;
  readonly fromBase: number;
  readonly toBase: number;
  readonly outcome: "safe" | "out" | "scored";
  readonly outKind?: RunnerOutKind;
  readonly supersedesThirdOut?: boolean;
  readonly responsiblePitcherId: string;
  readonly reason: RunnerAdvanceReason | "plate_result";
  readonly derived: boolean;
  readonly sequence: number;
}

export interface CompiledPitchFact {
  readonly speedKph?: number;
  readonly pitchType?: string;
  readonly pitchId: string;
  readonly sequence: number;
  readonly inning: number;
  readonly half: Half;
  readonly plateAppearanceEventId: string | null;
  readonly pitchEventNumber: number | null;
  readonly actualPitchNumber: number | null;
  readonly batterId: string | null;
  readonly pitcherId: string | null;
  readonly sourcePitchId: string | null;
  readonly call: PitchCall;
  readonly actual: boolean;
  readonly ball: boolean;
  readonly calledStrike: boolean;
  readonly swing: boolean;
  readonly whiff: boolean;
  readonly foul: boolean;
  readonly inPlay: boolean;
  readonly strike: boolean;
  readonly csw: boolean;
  readonly before: GameState;
  readonly after: GameState;
}

export type CompiledPlayKind =
  | "half_inning_start"
  | "batter_start"
  | "pitch"
  | "plate_result"
  | "runner_advance"
  | "substitution"
  | "review"
  | "administrative"
  | "unresolved";
export interface CompiledPlay {
  readonly playId: string;
  readonly sequence: number;
  readonly kind: CompiledPlayKind;
  readonly inning: number;
  readonly half: Half;
  readonly relayEventIds: readonly string[];
  readonly relayTexts: readonly string[];
  readonly before: GameState;
  readonly after: GameState;
  readonly applied: boolean;
  readonly movements: readonly CompiledRunnerMovement[];
}

export interface BatterLine {
  readonly playerId: string;
  readonly side: Side;
  readonly plateAppearances: number;
  readonly atBats: number;
  readonly runs: number;
  readonly hits: number;
  readonly doubles: number;
  readonly triples: number;
  readonly homeRuns: number;
  readonly runsBattedIn: number;
  readonly walks: number;
  readonly intentionalWalks: number;
  readonly hitByPitch: number;
  readonly strikeouts: number;
  readonly sacrificeBunts: number;
  readonly sacrificeFlies: number;
}
export interface PitcherLine {
  readonly playerId: string;
  readonly side: Side;
  readonly battersFaced: number;
  readonly outsRecorded: number;
  readonly hits: number;
  readonly runs: number;
  readonly earnedRuns: null;
  readonly walks: number;
  readonly intentionalWalks: number;
  readonly hitByPitch: number;
  readonly strikeouts: number;
  readonly pitches: number;
  readonly strikes: number;
}
export interface BaserunnerLine {
  readonly playerId: string;
  readonly side: Side;
  readonly advances: number;
  readonly extraBasesTaken: number;
  readonly runs: number;
  readonly stolenBases: number;
  readonly caughtStealing: number;
  readonly pickoffs: number;
}
export interface ReplayFrame {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: StagingRelayEvent["kind"];
  readonly playId: string | null;
  readonly before: GameState;
  readonly after: GameState;
  readonly applied: boolean;
}
export interface ReplayResult {
  readonly gameId: string;
  readonly finalState: GameState;
  readonly frames: readonly ReplayFrame[];
  readonly plays: readonly CompiledPlay[];
  readonly plateAppearances: readonly PlateAppearanceSummary[];
  readonly pitchFacts: readonly CompiledPitchFact[];
  readonly batterLines: readonly BatterLine[];
  readonly pitcherLines: readonly PitcherLine[];
  readonly baserunnerLines: readonly BaserunnerLine[];
  readonly findings: readonly Finding[];
}

export type CompileResult = ReplayResult;
