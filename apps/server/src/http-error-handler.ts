import {
  ContractValidationError,
  InvalidAnalysisScopeError,
  type ErrorCategory,
} from "@kbo/contracts";
import { CorrectionCommandError } from "@kbo/correction";
import {
  BlockingImportError,
  DatabaseContractError,
  GameAlreadyImportedError,
  GameRevisionNotFoundError,
  PersistenceIntegrityError,
  RecordCorrectionStaleError,
  RevisionConflictError,
  StaleStagingDocumentError,
} from "@kbo/persistence";
import type { FastifyInstance } from "fastify";

import {
  CorrectionCommitBlockedError,
  CorrectionSessionNotFoundError,
  CorrectionSessionLimitError,
  CorrectionSourceNotFoundError,
  StaleCorrectionSessionError,
} from "./correction-session-manager.js";
import {
  IdempotencyConflictError,
  InvalidCollectionRequestError,
  JobNotFoundError,
} from "./jobs/collection-job-manager.js";
import {
  ImportIdempotencyConflictError,
  ImportJobNotFoundError,
  ImportSourceNotReadyError,
} from "./jobs/import-job-manager.js";
import {
  RecordCorrectionJobConflictError,
  RecordCorrectionJobNotFoundError,
} from "./jobs/record-correction-job-manager.js";
import { InvalidReplayCursorError } from "./replay-service.js";
import {
  RecordCorrectionConflictError,
  RecordCorrectionNotFoundError,
} from "./record-correction-service.js";
import { apiError, hasValidation } from "./routes/http.js";
import { InvalidPitchClusterCountError } from "./pitch-analysis-service.js";
import { PitchAnalysisBusyError } from "./pitch-clustering-workers.js";
import { ComputationBusyError } from "./computation-pool.js";
import {
  AnalysisModelJobConflictError,
  AnalysisModelJobNotFoundError,
} from "./jobs/analysis-model-job-manager.js";

interface HttpErrorDescriptor {
  readonly status: number;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly matches: (error: Error) => boolean;
}

const HTTP_ERROR_DESCRIPTORS: readonly HttpErrorDescriptor[] = [
  descriptor(409, "analysis_model_job_conflict", "domain", false, AnalysisModelJobConflictError),
  descriptor(404, "analysis_model_job_not_found", "domain", false, AnalysisModelJobNotFoundError),
  descriptor(400, "invalid_analysis_scope", "domain", false, InvalidAnalysisScopeError),
  descriptor(400, "invalid_pitch_cluster_count", "domain", false, InvalidPitchClusterCountError),
  descriptor(503, "pitch_analysis_busy", "domain", true, PitchAnalysisBusyError),
  descriptor(503, "computation_busy", "domain", true, ComputationBusyError),
  descriptor(404, "collection_job_not_found", "domain", false, JobNotFoundError),
  descriptor(404, "import_not_found", "domain", false, ImportJobNotFoundError),
  descriptor(404, "revision_not_found", "domain", false, GameRevisionNotFoundError),
  descriptor(404, "record_correction_not_found", "domain", false, RecordCorrectionNotFoundError),
  descriptor(
    404,
    "record_correction_job_not_found",
    "domain",
    false,
    RecordCorrectionJobNotFoundError,
  ),
  descriptor(404, "correction_not_found", "domain", false, CorrectionSessionNotFoundError),
  descriptor(429, "correction_session_limit", "domain", false, CorrectionSessionLimitError),
  descriptor(404, "correction_source_not_found", "domain", false, CorrectionSourceNotFoundError),
  descriptor(409, "stale_session", "domain", false, StaleCorrectionSessionError),
  descriptor(409, "stale_document", "domain", false, StaleStagingDocumentError),
  descriptor(409, "revision_conflict", "domain", false, RevisionConflictError),
  descriptor(409, "record_correction_stale", "domain", false, RecordCorrectionStaleError),
  descriptor(409, "record_correction_conflict", "domain", false, RecordCorrectionConflictError),
  descriptor(
    409,
    "record_correction_job_conflict",
    "domain",
    false,
    RecordCorrectionJobConflictError,
  ),
  descriptor(422, "correction_blocked", "domain", false, CorrectionCommitBlockedError),
  descriptor(400, "invalid_command", "domain", false, CorrectionCommandError),
  descriptor(400, "invalid_replay_cursor", "domain", false, InvalidReplayCursorError),
  descriptor(409, "idempotency_conflict", "domain", false, IdempotencyConflictError),
  descriptor(409, "import_idempotency_conflict", "domain", false, ImportIdempotencyConflictError),
  descriptor(409, "game_already_imported", "domain", false, GameAlreadyImportedError),
  descriptor(409, "source_not_ready", "domain", false, ImportSourceNotReadyError),
  descriptor(422, "blocking_findings", "domain", false, BlockingImportError),
  descriptor(503, "database_contract", "persistence", true, DatabaseContractError),
  descriptor(500, "integrity_error", "persistence", false, PersistenceIntegrityError),
  descriptor(400, "invalid_request", "domain", false, InvalidCollectionRequestError),
];

export function installHttpErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ContractValidationError) {
      return reply.code(400).send(
        apiError(
          request.id,
          "contract_validation",
          "domain",
          "보정 결과가 strict 계약을 위반합니다.",
          false,
          error.issues.map((issue) => ({ field: issue.path, message: issue.message })),
        ),
      );
    }
    if (error instanceof Error) {
      const known = HTTP_ERROR_DESCRIPTORS.find((candidate) => candidate.matches(error));
      if (known !== undefined) {
        return reply
          .code(known.status)
          .send(apiError(request.id, known.code, known.category, error.message, known.retryable));
      }
    }
    if (hasValidation(error)) {
      return reply
        .code(400)
        .send(
          apiError(
            request.id,
            "invalid_request",
            "domain",
            "요청 형식이 올바르지 않습니다.",
            false,
          ),
        );
    }
    request.log.error({ err: error }, "request failed");
    return reply
      .code(500)
      .send(
        apiError(
          request.id,
          "internal_error",
          "internal",
          "요청 처리 중 오류가 발생했습니다.",
          false,
        ),
      );
  });
}

function descriptor<E extends Error>(
  status: number,
  code: string,
  category: ErrorCategory,
  retryable: boolean,
  constructor: abstract new (...args: never[]) => E,
): HttpErrorDescriptor {
  return {
    status,
    code,
    category,
    retryable,
    matches: (error) => error instanceof constructor,
  };
}
