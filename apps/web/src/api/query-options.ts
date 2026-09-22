import { queryOptions, type QueryKey } from "@tanstack/react-query";

import { getCollectionJobs, getGameCatalog } from "./collection-client";
import {
  getCorrectionGameCatalog,
  getCorrectionOriginal,
  getCorrectionSourceEvidence,
} from "./correction-client";
import { getImportJobs } from "./import-client";
import { getRevisionCatalog } from "./replay-client";
import {
  getRecordCorrectionCase,
  getRecordCorrectionCases,
  getRecordCorrectionJobs,
  getRecordCorrectionProposal,
  getRecordCorrectionSummary,
} from "./record-correction-client";
import type { RecordCorrectionCaseStatus, RecordCorrectionQueue } from "@kbo/contracts";
import { getDashboard, getDatabaseOverview, getSystemStatus } from "./system-client";

export const queryKeys = {
  catalog: ["catalog", "games"] as const,
  dashboard: ["dashboard"] as const,
  databaseOverview: ["database", "overview"] as const,
  jobs: {
    all: ["jobs"] as const,
    collection: ["jobs", "collection"] as const,
    import: ["jobs", "import"] as const,
    recordCorrection: ["jobs", "record-correction"] as const,
  },
  revisions: (gameId: string) => ["games", gameId, "revisions"] as const,
  systemStatus: ["system", "status"] as const,
  correction: {
    games: ["correction", "games"] as const,
    original: (sessionId: string) => ["correction", sessionId, "original"] as const,
    sourceEvidence: (sessionId: string, eventId: string, sessionVersion: number) =>
      ["correction", sessionId, "source-evidence", eventId, sessionVersion] as const,
  },
  recordCorrections: {
    all: ["record-corrections"] as const,
    summary: ["record-corrections", "summary"] as const,
    detail: (noticeId: string) => ["record-corrections", "detail", noticeId] as const,
    list: (filters: {
      readonly season?: number;
      readonly status?: RecordCorrectionCaseStatus;
      readonly queue?: RecordCorrectionQueue;
      readonly search?: string;
    }) => ["record-corrections", "list", filters] as const,
    proposal: (sessionId: string, noticeId: string) =>
      ["record-corrections", "proposal", sessionId, noticeId] as const,
  },
} as const;

export const catalogQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.catalog, queryFn: () => getGameCatalog() });
export const storedCatalogQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.catalog, "database"],
    queryFn: () => getGameCatalog("database"),
  });
export const correctionGamesQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.correction.games, queryFn: getCorrectionGameCatalog });
export const dashboardQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.dashboard, queryFn: getDashboard });
export const systemStatusQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.systemStatus, queryFn: getSystemStatus });
export const databaseOverviewQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.databaseOverview, queryFn: getDatabaseOverview });
export const collectionJobsQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.jobs.collection, queryFn: getCollectionJobs });
export const importJobsQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.jobs.import, queryFn: getImportJobs });
export const revisionCatalogQueryOptions = (gameId: string) =>
  queryOptions({
    queryKey: queryKeys.revisions(gameId),
    queryFn: () => getRevisionCatalog(gameId),
  });
export const recordCorrectionSummaryQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.recordCorrections.summary,
    queryFn: getRecordCorrectionSummary,
  });
export const recordCorrectionJobsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.jobs.recordCorrection,
    queryFn: getRecordCorrectionJobs,
  });
export const recordCorrectionCasesQueryOptions = (filters: {
  readonly season?: number;
  readonly status?: RecordCorrectionCaseStatus;
  readonly queue?: RecordCorrectionQueue;
  readonly search?: string;
}) =>
  queryOptions({
    queryKey: queryKeys.recordCorrections.list(filters),
    queryFn: () => getRecordCorrectionCases(filters),
  });
export const recordCorrectionCaseQueryOptions = (noticeId: string) =>
  queryOptions({
    queryKey: queryKeys.recordCorrections.detail(noticeId),
    queryFn: () => getRecordCorrectionCase(noticeId),
  });
export const recordCorrectionProposalQueryOptions = (sessionId: string, noticeId: string) =>
  queryOptions({
    queryKey: queryKeys.recordCorrections.proposal(sessionId, noticeId),
    queryFn: () => getRecordCorrectionProposal(sessionId, noticeId),
  });
export const correctionOriginalQueryOptions = (sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.correction.original(sessionId),
    queryFn: () => getCorrectionOriginal(sessionId),
  });
export const correctionSourceEvidenceQueryOptions = (
  sessionId: string,
  eventId: string,
  sessionVersion: number,
) =>
  queryOptions({
    queryKey: queryKeys.correction.sourceEvidence(sessionId, eventId, sessionVersion),
    queryFn: ({ signal }) => getCorrectionSourceEvidence(sessionId, eventId, signal),
    staleTime: Infinity,
  });

export type QueryRefreshTarget = "catalog" | "collectionJobs" | "dashboard";

export function queryKeyForRefreshTarget(target: QueryRefreshTarget): QueryKey {
  return {
    catalog: queryKeys.catalog,
    collectionJobs: queryKeys.jobs.collection,
    dashboard: queryKeys.dashboard,
  }[target];
}
