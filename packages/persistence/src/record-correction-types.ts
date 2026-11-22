import type {
  RecordCorrectionApprovalReference,
  RecordCorrectionCaseStatus,
  RecordCorrectionMatchCandidate,
  RecordCorrectionNotice,
} from "@kbo/contracts";
export interface RecordCorrectionImportedSeason {
  readonly season: number;
  readonly revision: number | null;
  readonly sourceBundleHash: string;
  readonly noticeCount: number;
  readonly noChange: boolean;
}

export interface RecordCorrectionGameCandidate {
  readonly gameId: string;
  readonly revision: number;
  readonly documentHash: string;
  readonly sourceGameId: string;
  readonly gameDate: string;
  readonly stadium: string | null;
  readonly awayTeamName: string;
  readonly homeTeamName: string;
}

export interface RecordCorrectionResumableJob {
  readonly jobId: string;
  readonly seasons: readonly number[];
  readonly hasChanges: boolean;
}

export type RecordCorrectionMatchup = Pick<
  RecordCorrectionNotice,
  "gameDate" | "awayTeamName" | "homeTeamName"
>;
export interface RecordCorrectionMatchupContext {
  readonly generation: number;
  readonly games: readonly RecordCorrectionGameCandidate[];
  readonly notices: readonly {
    readonly notice: RecordCorrectionNotice;
    readonly selection: RecordCorrectionMatchCandidate | null;
  }[];
}
export interface RecordCorrectionApprovalEvidence {
  readonly noticeId: string;
  readonly actionSequence: number;
  readonly gameId: string;
  readonly revision: number;
  readonly baseHash: string;
  readonly eventId: string;
  readonly documentHash: string;
  readonly proposalHash: string;
}
export interface RecordCorrectionApprovalInput {
  readonly noticeId: string;
  readonly caseVersion: number;
  readonly sessionId: string;
  readonly proposalHash: string;
  readonly documentHash: string;
  readonly generation?: number;
  readonly carry?: readonly RecordCorrectionApprovalReference[];
  readonly previousDocumentHash?: string;
}
export interface RecordCorrectionAssessmentBasis {
  readonly caseVersion: number;
  readonly publication: number;
  readonly matchupGeneration: number;
  readonly actionSequence: number;
  readonly games: RecordCorrectionGameCandidate[];
  readonly selection: RecordCorrectionMatchCandidate | null;
  readonly peers?: RecordCorrectionMatchupContext["notices"];
}

export interface RecordCorrectionAssessmentInput {
  readonly noticeId: string;
  readonly noticeHash: string;
  readonly caseVersion: number;
  readonly basis: Omit<
    RecordCorrectionAssessmentBasis,
    "caseVersion" | "games" | "selection" | "peers"
  >;
  readonly matchup: Pick<RecordCorrectionNotice, "gameDate" | "awayTeamName" | "homeTeamName">;
  readonly gameBases:
    readonly Pick<RecordCorrectionGameCandidate, "gameId" | "revision" | "documentHash">[] | null;
  readonly status: RecordCorrectionCaseStatus;
  readonly gameId: string | null;
  readonly gameRevision: number | null;
  readonly documentHash: string | null;
  readonly eventId: string | null;
  readonly batterPlayerId: string | null;
  readonly pitcherPlayerId: string | null;
  readonly reasonCode: string;
  readonly reasonMessage: string;
  readonly proposalHash: string | null;
  readonly candidates: readonly RecordCorrectionMatchCandidate[];
  readonly assessedAt: string;
}
export class RecordCorrectionStaleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RecordCorrectionStaleError";
  }
}
