import { ContractValidationError } from "@kbo/contracts";
import { CorrectionCommandError } from "@kbo/correction";
import {
  BlockingImportError,
  DatabaseContractError,
  GameAlreadyImportedError,
  GameRevisionNotFoundError,
  PersistenceIntegrityError,
  RevisionConflictError,
  StaleStagingDocumentError,
  RecordCorrectionStaleError,
} from "@kbo/persistence";
import type { FastifyInstance } from "fastify";

import {
  CorrectionCommitBlockedError,
  CorrectionSessionNotFoundError,
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
import { InvalidReplayCursorError } from "./replay-service.js";
import {
  RecordCorrectionConflictError,
  RecordCorrectionNotFoundError,
} from "./record-correction-service.js";
import {
  RecordCorrectionJobConflictError,
  RecordCorrectionJobNotFoundError,
} from "./jobs/record-correction-job-manager.js";
import { apiError, hasValidation } from "./routes/http.js";

export function installHttpErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof JobNotFoundError) {
      return reply
        .code(404)
        .send(apiError(request.id, "not_found", "domain", error.message, false));
    }
    if (error instanceof ImportJobNotFoundError || error instanceof GameRevisionNotFoundError) {
      return reply
        .code(404)
        .send(apiError(request.id, "not_found", "domain", error.message, false));
    }
    if (
      error instanceof RecordCorrectionNotFoundError ||
      error instanceof RecordCorrectionJobNotFoundError
    ) {
      return reply
        .code(404)
        .send(apiError(request.id, "record_correction_not_found", "domain", error.message, false));
    }
    if (
      error instanceof CorrectionSessionNotFoundError ||
      error instanceof CorrectionSourceNotFoundError
    ) {
      return reply
        .code(404)
        .send(apiError(request.id, "correction_not_found", "domain", error.message, false));
    }
    if (
      error instanceof StaleCorrectionSessionError ||
      error instanceof StaleStagingDocumentError ||
      error instanceof RevisionConflictError ||
      error instanceof RecordCorrectionStaleError ||
      error instanceof RecordCorrectionConflictError ||
      error instanceof RecordCorrectionJobConflictError
    ) {
      return reply
        .code(409)
        .send(apiError(request.id, "stale_session", "domain", error.message, false));
    }
    if (error instanceof CorrectionCommitBlockedError) {
      return reply
        .code(422)
        .send(apiError(request.id, "correction_blocked", "domain", error.message, false));
    }
    if (error instanceof CorrectionCommandError) {
      return reply
        .code(400)
        .send(apiError(request.id, "invalid_command", "domain", error.message, false));
    }
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
    if (error instanceof InvalidReplayCursorError) {
      return reply
        .code(400)
        .send(apiError(request.id, "invalid_replay_cursor", "domain", error.message, false));
    }
    if (error instanceof IdempotencyConflictError) {
      return reply
        .code(409)
        .send(apiError(request.id, "idempotency_conflict", "domain", error.message, false));
    }
    if (
      error instanceof ImportIdempotencyConflictError ||
      error instanceof GameAlreadyImportedError
    ) {
      return reply
        .code(409)
        .send(apiError(request.id, "import_conflict", "domain", error.message, false));
    }
    if (error instanceof ImportSourceNotReadyError) {
      return reply
        .code(409)
        .send(apiError(request.id, "source_not_ready", "domain", error.message, false));
    }
    if (error instanceof BlockingImportError) {
      return reply
        .code(422)
        .send(apiError(request.id, "blocking_findings", "domain", error.message, false));
    }
    if (error instanceof DatabaseContractError) {
      return reply
        .code(503)
        .send(apiError(request.id, "database_contract", "persistence", error.message, true));
    }
    if (error instanceof PersistenceIntegrityError) {
      return reply
        .code(500)
        .send(apiError(request.id, "integrity_error", "persistence", error.message, false));
    }
    if (error instanceof InvalidCollectionRequestError) {
      return reply
        .code(400)
        .send(apiError(request.id, "invalid_request", "domain", error.message, false));
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
          "persistence",
          "요청 처리 중 오류가 발생했습니다.",
          false,
        ),
      );
  });
}
