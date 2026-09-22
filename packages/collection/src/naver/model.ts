import type { Half, Side, StagingRelayEvent } from "@kbo/contracts";

import type { JsonRecord } from "./source-values.js";

export interface RelayRosterPlayer {
  readonly playerId: string;
  readonly name: string;
  readonly side: Side;
  readonly battingOrder?: number;
  readonly starter: boolean;
  readonly positions: readonly string[];
}

export interface RelayBlockInput {
  readonly endpoint: string;
  readonly endpointBlockIndex: number;
  readonly block: JsonRecord;
}

export interface NormalizedRelayBlock extends RelayBlockInput {
  readonly sourceBlockIndex: number;
}

export interface RelayNormalizationResult {
  readonly events: readonly StagingRelayEvent[];
  readonly findings: readonly import("../types.js").SourceFinding[];
  readonly blocks: readonly NormalizedRelayBlock[];
  readonly pitchEventIdsByBlock: ReadonlyMap<number, ReadonlyMap<string, readonly string[]>>;
  readonly excludedPitchIdsByBlock?: ReadonlyMap<number, ReadonlySet<string>>;
}

export interface CanonicalSourceState {
  readonly batterId: string | null;
  readonly pitcherId: string | null;
  readonly balls: number | null;
  readonly strikes: number | null;
  readonly outs: number | null;
  readonly bases: readonly [unknown, unknown, unknown];
  readonly hasBases: boolean;
  readonly awayScore: number | null;
  readonly homeScore: number | null;
}

export interface CanonicalPlayerChange {
  readonly type: string | null;
  readonly incomingPlayerId: string | null;
  readonly incomingPosition: string | null;
  readonly outgoingPlayerId: string | null;
  readonly outgoingPosition: string | null;
  readonly battingOrder: number | null;
}

export interface CanonicalNaverRow {
  readonly source: NormalizedRelayBlock;
  readonly rawIndex: number;
  readonly inning: number;
  readonly half: Half;
  readonly sourceSequence: number | null;
  readonly sourceEventId: string | null;
  readonly explicitKind: string | null;
  readonly numericType: number | null;
  readonly sourceType: string;
  readonly relayText: string | null;
  readonly pitchCallCode: string | null;
  readonly pitchSpeed: unknown;
  readonly pitchType: unknown;
  readonly resultCode: string | null;
  readonly outcomeCode: string | null;
  readonly reasonCode: string | null;
  readonly sourcePitchId: string | null;
  readonly batterId: string | null;
  readonly pitcherId: string | null;
  readonly runnerId: string | null;
  readonly fromBase: number | null;
  readonly toBase: number | null;
  readonly plateResultEventId: string | null;
  readonly creditedRbi: number | null;
  readonly outsRecorded: number | null;
  readonly batterDestination: number | null;
  readonly responsiblePitcherId: string | null;
  readonly supersedesThirdOut: boolean;
  readonly side: Side | null;
  readonly roleHint: string | null;
  readonly fieldPosition: string | null;
  readonly incomingPlayerId: string | null;
  readonly outgoingPlayerId: string | null;
  readonly playerChange: CanonicalPlayerChange;
  readonly reviewDecision: string | null;
  readonly reviewedEventId: string | null;
  readonly administrativeCode: string | null;
  readonly observedState: CanonicalSourceState;
  readonly semanticFingerprint: string;
}

export interface PlayerIndex {
  readonly sideById: ReadonlyMap<string, Side>;
  readonly nameById: ReadonlyMap<string, string>;
  readonly idsByNameAndSide: ReadonlyMap<string, readonly string[]>;
  readonly battingOrder: Readonly<Record<Side, Map<number, string>>>;
}

export type BaseIdentityState = [string | null, string | null, string | null];

export interface NormalizationPlatePlay {
  readonly originBases: BaseIdentityState;
  readonly batterPlacement: {
    readonly batterId: string;
    readonly destination: number;
  } | null;
  readonly movements: readonly {
    readonly runnerId: string;
    readonly fromBase: number;
    readonly toBase: number;
    readonly outcome: "safe" | "out" | "scored";
  }[];
}

export interface ParseContext {
  readonly players: PlayerIndex;
  readonly currentBatter: Record<Side, string | null>;
  readonly currentPitcher: Record<Side, string | null>;
  readonly latestPlateResult: Record<string, string | null>;
  readonly pitchEventIdsByBlock: Map<number, Map<string, string[]>>;
  readonly observedRunners: Record<string, BaseIdentityState>;
  readonly inferredBases: Record<string, BaseIdentityState>;
  readonly basesTrusted: Record<string, boolean>;
  readonly platePlay: Record<string, NormalizationPlatePlay | null>;
  readonly pendingPitchClockAward: Record<string, import("@kbo/contracts").PitchCall | null>;
}
