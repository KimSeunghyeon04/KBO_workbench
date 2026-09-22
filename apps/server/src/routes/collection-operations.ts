import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  CollectionDateRangeSchema,
  CollectionDiscoveryCreateSchema,
  CollectionDiscoverySchema,
  CollectionDiscoveryListSchema,
  CollectionOverviewSchema,
  CollectionOverviewQuerySchema,
  CollectionGamesQuerySchema,
  CollectionGamePageSchema,
  CollectionSelectionCreateSchema,
  CollectionSelectionSchema,
  CollectionHistoryPageSchema,
  CollectionHistoryRecordSchema,
  CollectionHistoryItemsSchema,
  CollectionHistoryQuerySchema,
} from "@kbo/contracts";
import type { RouteContext } from "./context.js";

const params = Type.Object(
  { id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" }) },
  { additionalProperties: false },
);
const errors = { 400: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema };

export const collectionOperationsRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (
  app,
  context,
) => {
  const service = context.runtime.collectionOperations;
  if (service === undefined) return;
  app.post(
    "/api/v2/collection-discoveries",
    {
      schema: {
        body: CollectionDiscoveryCreateSchema,
        response: { 202: CollectionDiscoverySchema, ...errors },
      },
    },
    async (request, reply) => reply.code(202).send(await service.create(request.body)),
  );
  app.get(
    "/api/v2/collection-discoveries",
    {
      schema: {
        querystring: CollectionDateRangeSchema,
        response: { 200: CollectionDiscoveryListSchema, ...errors },
      },
    },
    async (request) => service.list(request.query),
  );
  app.get(
    "/api/v2/collection-discoveries/:id",
    { schema: { params, response: { 200: CollectionDiscoverySchema, ...errors } } },
    async (request) => service.get(request.params.id),
  );
  app.delete(
    "/api/v2/collection-discoveries/:id",
    { schema: { params, response: { 200: CollectionDiscoverySchema, ...errors } } },
    async (request) => service.cancel(request.params.id),
  );
  app.get(
    "/api/v2/collection-discoveries/:id/overview",
    {
      schema: {
        params,
        querystring: CollectionOverviewQuerySchema,
        response: { 200: CollectionOverviewSchema, ...errors },
      },
    },
    async (request) => service.overview(request.params.id, request.query),
  );
  app.get(
    "/api/v2/collection-discoveries/:id/games",
    {
      schema: {
        params,
        querystring: CollectionGamesQuerySchema,
        response: { 200: CollectionGamePageSchema, ...errors },
      },
    },
    async (request) => service.games(request.params.id, request.query),
  );
  app.post(
    "/api/v2/collection-selections",
    {
      schema: {
        body: CollectionSelectionCreateSchema,
        response: { 201: CollectionSelectionSchema, ...errors },
      },
    },
    async (request, reply) => reply.code(201).send(await service.select(request.body)),
  );
  app.get(
    "/api/v2/collection-history",
    {
      schema: {
        querystring: CollectionHistoryQuerySchema,
        response: { 200: CollectionHistoryPageSchema, ...errors },
      },
    },
    async (request) => service.history(request.query.page, request.query.limit),
  );
  app.get(
    "/api/v2/collection-history/:id",
    { schema: { params, response: { 200: CollectionHistoryRecordSchema, ...errors } } },
    async (request) => service.historyRecord(request.params.id),
  );
  app.get(
    "/api/v2/collection-history/:id/games",
    {
      schema: {
        params,
        querystring: CollectionHistoryQuerySchema,
        response: { 200: CollectionHistoryItemsSchema, ...errors },
      },
    },
    async (request) =>
      service.historyItems(
        request.params.id,
        request.query.page,
        request.query.limit,
        request.query.problemsOnly,
      ),
  );
};
