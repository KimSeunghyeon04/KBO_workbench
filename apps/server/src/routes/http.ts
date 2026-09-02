import {
  canonicalStringify,
  parseCorrectionCommand,
  type ErrorCategory,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { CorrectionCommandError } from "@kbo/correction";
import type { FastifyReply } from "fastify";

export function apiError(
  requestId: string,
  code: string,
  category: ErrorCategory,
  message: string,
  retryable: boolean,
  details: { field: string; message: string }[] = [],
) {
  return { requestId, code, category, message, retryable, details };
}

export function hasValidation(error: unknown): error is { readonly validation: unknown } {
  return typeof error === "object" && error !== null && "validation" in error;
}

export function parseCorrectionCommandRequest(value: unknown) {
  try {
    return parseCorrectionCommand(value);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "명령 형식이 올바르지 않습니다.";
    throw new CorrectionCommandError(message);
  }
}

export function sendCanonicalDocument(
  reply: FastifyReply,
  document: StagingGameDocumentV2,
): FastifyReply {
  return reply.type("application/json; charset=utf-8").send(canonicalStringify(document));
}
