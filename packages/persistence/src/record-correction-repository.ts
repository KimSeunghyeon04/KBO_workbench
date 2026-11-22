import type {
  RecordCorrectionApprovalReference,
  RecordCorrectionCase,
  RecordCorrectionCaseStatus,
  RecordCorrectionJob,
  RecordCorrectionListItem,
  RecordCorrectionNotice,
  RecordCorrectionQueue,
  RecordCorrectionReviewActionRequest,
  RecordCorrectionSummary,
} from "@kbo/contracts";
import type { Pool } from "pg";
import { RecordCorrectionCases } from "./record-correction-cases.js";
import { RecordCorrectionJobs } from "./record-correction-jobs.js";
import { RecordCorrectionSources } from "./record-correction-sources.js";
import type {
  RecordCorrectionApprovalInput,
  RecordCorrectionApprovalEvidence,
  RecordCorrectionMatchup,
  RecordCorrectionMatchupContext,
  RecordCorrectionAssessmentInput,
  RecordCorrectionAssessmentBasis,
  RecordCorrectionGameCandidate,
  RecordCorrectionImportedSeason,
  RecordCorrectionResumableJob,
} from "./record-correction-types.js";
export {
  RecordCorrectionStaleError,
  type RecordCorrectionApprovalEvidence,
  type RecordCorrectionMatchupContext,
  type RecordCorrectionAssessmentInput,
  type RecordCorrectionAssessmentBasis,
  type RecordCorrectionGameCandidate,
  type RecordCorrectionImportedSeason,
  type RecordCorrectionResumableJob,
} from "./record-correction-types.js";
export class RecordCorrectionRepository {
  private readonly jobsStore: RecordCorrectionJobs;
  private readonly sources: RecordCorrectionSources;
  private readonly cases: RecordCorrectionCases;
  public constructor(pool: Pool, expectedMigrationVersion: string) {
    this.jobsStore = new RecordCorrectionJobs(pool, expectedMigrationVersion);
    this.sources = new RecordCorrectionSources(pool, expectedMigrationVersion);
    this.cases = new RecordCorrectionCases(pool);
  }
  public async seasonsWithSealedGames(): Promise<number[]> {
    return this.jobsStore.seasonsWithSealedGames();
  }

  public async createJob(
    jobId: string,
    trigger: "manual" | "scheduled",
    idempotencyKey: string,
    seasons: readonly number[],
    createdAt: string,
  ): Promise<{ readonly created: boolean; readonly job: RecordCorrectionJob }> {
    return this.jobsStore.createJob(jobId, trigger, idempotencyKey, seasons, createdAt);
  }

  public async setJobRunning(jobId: string, startedAt: string): Promise<void> {
    return this.jobsStore.setJobRunning(jobId, startedAt);
  }

  public async resumableJobs(): Promise<RecordCorrectionResumableJob[]> {
    return this.jobsStore.resumableJobs();
  }

  public async setJobCancelling(jobId: string): Promise<boolean> {
    return this.jobsStore.setJobCancelling(jobId);
  }

  public async finishJob(
    jobId: string,
    status: "cancelled" | "succeeded" | "failed" | "no_change",
    finishedAt: string,
    errorCategory: "source" | "domain" | "persistence" | null = null,
    errorMessage: string | null = null,
  ): Promise<void> {
    return this.jobsStore.finishJob(jobId, status, finishedAt, errorCategory, errorMessage);
  }

  public async markSeasonRunning(jobId: string, season: number): Promise<void> {
    return this.jobsStore.markSeasonRunning(jobId, season);
  }

  public async markSeasonFailed(jobId: string, season: number): Promise<void> {
    return this.jobsStore.markSeasonFailed(jobId, season);
  }

  public async importSeason(
    runId: string,
    input: unknown,
    sourceBundleHash: string,
  ): Promise<RecordCorrectionImportedSeason> {
    return this.sources.importSeason(runId, input, sourceBundleHash);
  }

  public async gameCandidates(
    notice: RecordCorrectionNotice,
  ): Promise<RecordCorrectionGameCandidate[]> {
    return this.cases.gameCandidates(notice);
  }

  public async currentNotice(noticeId: string): Promise<RecordCorrectionNotice | null> {
    return this.sources.currentNotice(noticeId);
  }

  public async assessmentBasis(
    notice: RecordCorrectionNotice,
  ): Promise<RecordCorrectionAssessmentBasis> {
    return this.cases.assessmentBasis(notice);
  }

  public async pendingNoticeIds(after: string, limit: number, season?: number): Promise<string[]> {
    return this.cases.pendingNoticeIds(after, limit, season);
  }

  public async seasonHasPendingAssessments(season: number): Promise<boolean> {
    return this.cases.seasonHasPendingAssessments(season);
  }

  public async assess(input: RecordCorrectionAssessmentInput): Promise<RecordCorrectionCase> {
    return this.cases.assess(input);
  }

  public async reviewAction(
    noticeId: string,
    request: RecordCorrectionReviewActionRequest,
  ): Promise<RecordCorrectionCase> {
    return this.cases.reviewAction(noticeId, request);
  }

  public async matchupContext(
    notice: RecordCorrectionMatchup,
  ): Promise<RecordCorrectionMatchupContext> {
    return this.cases.matchupContext(notice);
  }

  public async approvalEvidence(
    references: readonly RecordCorrectionApprovalReference[],
  ): Promise<RecordCorrectionApprovalEvidence[]> {
    return this.cases.approvalEvidence(references);
  }

  public async markProposalApplied(
    input: RecordCorrectionApprovalInput,
  ): Promise<RecordCorrectionApprovalReference> {
    return this.cases.markProposalApplied(input);
  }

  public async markProposalBundle(
    input: RecordCorrectionApprovalInput,
  ): Promise<RecordCorrectionApprovalReference[]> {
    return this.cases.markProposalBundle(input);
  }

  public async summary(nextScheduledAt: string | null): Promise<RecordCorrectionSummary> {
    return this.cases.summary(nextScheduledAt);
  }

  public async listCases(
    filters: {
      readonly season?: number;
      readonly status?: RecordCorrectionCaseStatus;
      readonly search?: string;
    } = {},
  ): Promise<RecordCorrectionCase[]> {
    return this.cases.listCases(filters);
  }

  public async listCasesForImport(
    gameId: string,
    revision: number,
  ): Promise<RecordCorrectionCase[]> {
    return this.cases.listCasesForImport(gameId, revision);
  }

  public async listCaseSummaries(
    filters: {
      readonly season?: number;
      readonly status?: RecordCorrectionCaseStatus;
      readonly queue?: RecordCorrectionQueue;
      readonly search?: string;
    } = {},
  ): Promise<RecordCorrectionListItem[]> {
    return this.cases.listCaseSummaries(filters);
  }

  public async case(noticeId: string): Promise<RecordCorrectionCase | null> {
    return this.cases.case(noticeId);
  }

  public async job(jobId: string): Promise<RecordCorrectionJob> {
    return this.jobsStore.job(jobId);
  }

  public async jobs(): Promise<RecordCorrectionJob[]> {
    return this.jobsStore.jobs();
  }
}

export { matchesRecordCorrectionDoubleheader } from "./record-correction-matchups.js";
