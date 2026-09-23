import type {
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
  RecordCorrectionAssessmentInput,
  RecordCorrectionGameCandidate,
  RecordCorrectionImportedSeason,
  RecordCorrectionResumableJob,
} from "./record-correction-types.js";
export {
  RecordCorrectionStaleError,
  type RecordCorrectionAssessmentInput,
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
    this.cases = new RecordCorrectionCases(pool, this.sources);
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

  public async markProposalApplied(input: {
    readonly noticeId: string;
    readonly caseVersion: number;
    readonly sessionId: string;
    readonly proposalHash: string;
    readonly documentHash: string;
  }): Promise<void> {
    return this.cases.markProposalApplied(input);
  }

  public async markResolvedIfImported(
    gameId: string,
    revision: number,
    documentHash: string,
  ): Promise<string[]> {
    return this.cases.markResolvedIfImported(gameId, revision, documentHash);
  }

  public async markResolvedAfterReassessment(input: {
    readonly noticeId: string;
    readonly caseVersion: number;
    readonly gameId: string;
    readonly revision: number;
    readonly documentHash: string;
  }): Promise<boolean> {
    return this.cases.markResolvedAfterReassessment(input);
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
