import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PitchAnalysisCatalogSchema,
  PitchAnalysisPitcherParamsSchema,
  PitchAnalysisQuerySchema,
  PitchAnalysisDetailQuerySchema,
  PitchAnalysisResponseSchema,
  type PitchAnalysisSample,
  PitchProfilePeriodQuerySchema,
  PitchProfilePeriodResponseSchema,
  analysisPeriodQueries,
} from "@kbo/contracts";
import { comparePitchProfilePeriods } from "@kbo/game-core";
import { readAnalysisPeriodPair, periodSnapshot } from "../analysis-period-pair.js";
import {
  PitchAnalysisRepository,
  type PitchReferenceWorkspace,
  type PitchCalibrationWorkspace,
  type PitchAnalysisComputation,
} from "@kbo/persistence";

import type { RouteContext } from "./context.js";
import { PitchAnalysisService } from "../pitch-analysis-service.js";
import { BoundedReadCache } from "../bounded-read-cache.js";

type Options = Pick<RouteContext, "pool"> & {
  references: Pick<PitchReferenceWorkspace, "getOrCreate">;
  computation?: PitchAnalysisComputation;
  calibrations?: Pick<PitchCalibrationWorkspace, "getOrCreate">;
};

export const pitchAnalysisRoutes: FastifyPluginAsyncTypebox<Options> = async (app, context) => {
  const samples = new BoundedReadCache<PitchAnalysisSample>(32 * 1024 * 1024, 32, 300_000);
  const repository = new PitchAnalysisRepository(
    context.pool,
    context.references,
    context.computation,
    samples,
    context.calibrations,
  );
  const service = new PitchAnalysisService(repository);
  app.get(
    "/api/v2/analysis/pitch-shape/:pitcherId/comparison",
    {
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: PitchProfilePeriodQuerySchema,
        response: {
          200: PitchProfilePeriodResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const { first, second } = analysisPeriodQueries(request.query);
      const playerId = request.params.pitcherId;
      const pair = await readAnalysisPeriodPair(
        () => repository.compare(first, second, playerId),
        () => repository.readSourceHash(first),
      );
      const snapshot = (q: typeof first, d: PitchAnalysisSample) =>
        periodSnapshot(q, d.sourceHash, [
          { label: "실제 투구", count: d.actualPitchCount },
          { label: "유효 궤적", count: d.points.length },
          {
            label: "보정 표본",
            count: d.profile.groups.reduce((n, g) => n + g.calibratedCount, 0),
          },
          { label: "포심 기준", count: d.baseline?.sampleCount ?? 0 },
        ]);
      return {
        query: request.query,
        playerId,
        first: snapshot(first, pair.first),
        second: snapshot(second, pair.second),
        metrics: comparePitchProfilePeriods(pair.first, pair.second),
        warnings: [
          "원 중계 구종 기준입니다. 평균 구속은 유효 구속, 보정 좌표는 보정 완료 표본만 사용합니다. 구장·카운트·좌우 구성 변화가 포함된 관측 차이입니다.",
          ...(first.season === second.season
            ? []
            : [
                "시즌별 포심 기준이 다릅니다. 상대 좌표와 도착 시간의 시즌 간 차이는 제공하지 않으며, 각 기간 값과 구속·사용률을 비교하세요.",
              ]),
        ],
      };
    },
  );
  app.addHook("onClose", async () => {
    await service.close();
    samples.clear();
  });
  app.get(
    "/api/v2/analysis/pitch-shape",
    {
      schema: {
        querystring: PitchAnalysisQuerySchema,
        response: { 200: PitchAnalysisCatalogSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const { season, ...scope } = request.query;
      return repository.catalog(season, scope);
    },
  );
  app.get(
    "/api/v2/analysis/pitch-shape/:pitcherId",
    {
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: PitchAnalysisDetailQuerySchema,
        response: {
          200: PitchAnalysisResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const { season, clusterCount, ...scope } = request.query;
      return service.analyze(season, request.params.pitcherId, clusterCount, scope);
    },
  );
};
