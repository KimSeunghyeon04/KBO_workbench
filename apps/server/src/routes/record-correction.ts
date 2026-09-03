import {
  ApiErrorSchema,
  CorrectionMutationResultSchema,
  RecordCorrectionCaseSchema,
  RecordCorrectionDraftCreateResponseSchema,
  RecordCorrectionJobCreateRequestSchema,
  RecordCorrectionJobCreatedSchema,
  RecordCorrectionJobListSchema,
  RecordCorrectionListQuerySchema,
  RecordCorrectionListSchema,
  RecordCorrectionProposalApplyRequestSchema,
  RecordCorrectionProposalSchema,
  RecordCorrectionReviewActionRequestSchema,
  RecordCorrectionSummarySchema,
} from "@kbo/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { RouteContext } from "./context.js";
import { JobParamsSchema } from "./schemas.js";

const strict = { additionalProperties: false } as const;
const NoticeParamsSchema = Type.Object(
  { noticeId: Type.String({ minLength: 1, maxLength: 200 }) },
  strict,
);
const ProposalParamsSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1, maxLength: 200 }),
    noticeId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  strict,
);

export const recordCorrectionRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (
  app,
  context,
) => {
  const repository = context.runtime.recordCorrectionRepository;
  const service = context.runtime.recordCorrectionService;
  const jobs = context.runtime.recordCorrectionJobs;
  if (repository === undefined || service === undefined || jobs === undefined) return;
  app.post(
    "/api/v2/record-correction-jobs",
    {
      schema: {
        body: RecordCorrectionJobCreateRequestSchema,
        response: { 202: RecordCorrectionJobCreatedSchema, 409: ApiErrorSchema },
      },
    },
    async (request, reply) => reply.code(202).send(await jobs.create(request.body)),
  );

  app.get(
    "/api/v2/record-correction-jobs",
    { schema: { response: { 200: RecordCorrectionJobListSchema } } },
    async () => ({ jobs: [...(await jobs.list())] }),
  );

  app.delete(
    "/api/v2/record-correction-jobs/:jobId",
    {
      schema: {
        params: JobParamsSchema,
        response: { 204: Type.Null(), 404: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      await jobs.cancel(request.params.jobId);
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/api/v2/record-corrections/summary",
    { schema: { response: { 200: RecordCorrectionSummarySchema } } },
    async () => repository.summary(jobs.nextScheduledAt()),
  );

  app.get(
    "/api/v2/record-corrections",
    {
      schema: {
        querystring: RecordCorrectionListQuerySchema,
        response: { 200: RecordCorrectionListSchema },
      },
    },
    async (request) => ({
      cases: await service.listCaseSummaries(request.query),
    }),
  );

  app.get(
    "/api/v2/record-corrections/:noticeId",
    {
      schema: {
        params: NoticeParamsSchema,
        response: { 200: RecordCorrectionCaseSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const item = await service.case(request.params.noticeId);
      if (item === null)
        return reply.code(404).send({
          requestId: request.id,
          code: "record_correction_not_found",
          category: "domain",
          message: "기록정정 공지를 찾을 수 없습니다.",
          retryable: false,
          details: [],
        });
      return item;
    },
  );

  app.post(
    "/api/v2/record-corrections/:noticeId/review-actions",
    {
      schema: {
        params: NoticeParamsSchema,
        body: RecordCorrectionReviewActionRequestSchema,
        response: { 200: RecordCorrectionCaseSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request) => service.reviewAction(request.params.noticeId, request.body),
  );

  app.post(
    "/api/v2/record-corrections/:noticeId/correction-drafts",
    {
      schema: {
        params: NoticeParamsSchema,
        response: {
          201: RecordCorrectionDraftCreateResponseSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await service.createDraft(request.params.noticeId)),
  );

  app.get(
    "/api/v2/correction-sessions/:sessionId/record-correction-proposals/:noticeId",
    {
      schema: {
        params: ProposalParamsSchema,
        response: { 200: RecordCorrectionProposalSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request) => service.proposal(request.params.sessionId, request.params.noticeId),
  );

  app.post(
    "/api/v2/correction-sessions/:sessionId/record-correction-proposals/:noticeId",
    {
      schema: {
        params: ProposalParamsSchema,
        body: RecordCorrectionProposalApplyRequestSchema,
        response: {
          200: CorrectionMutationResultSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request) =>
      service.applyProposal(
        request.params.sessionId,
        request.params.noticeId,
        request.body.expectedSessionVersion,
        request.body.proposalHash,
      ),
  );
};
