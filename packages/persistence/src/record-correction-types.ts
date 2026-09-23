import type { RecordCorrectionCaseStatus, RecordCorrectionMatchCandidate } from "@kbo/contracts";
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

export interface RecordCorrectionAssessmentInput {
  readonly noticeId: string;
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
