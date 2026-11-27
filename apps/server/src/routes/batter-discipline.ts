import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  AnalysisScopeQuerySchema,
  DisciplineCatalogSchema,
  DisciplineParamsSchema,
  DisciplineQuerySchema,
  DisciplineResponseSchema,
  DisciplinePeriodQuerySchema,
  DisciplinePeriodResponseSchema,
  analysisPeriodQueries,
  canonicalStringify,
  type DisciplineQuery,
  type DisciplineResponse,
} from "@kbo/contracts";
import { compareDisciplinePeriods } from "@kbo/game-core";
import { assertPeriodSourceHash, periodSnapshot } from "../analysis-period-pair.js";
import {
  BatterDisciplineRepository,
  type DisciplinePreparedWorkspace,
  type PitchReferenceWorkspace,
  type PitchAnalysisComputation,
} from "@kbo/persistence";
import type { RouteContext } from "./context.js";
import { BatterDisciplineService } from "../batter-discipline-service.js";
import { BoundedReadCache } from "../bounded-read-cache.js";

type Options = Pick<RouteContext, "pool"> & {
  references: Pick<PitchReferenceWorkspace, "getOrCreate">;
  computeReference?: PitchAnalysisComputation["reference"];
  disciplinePrepared?: Pick<DisciplinePreparedWorkspace, "read" | "write">;
};
export const batterDisciplineRoutes: FastifyPluginAsyncTypebox<Options> = async (app, context) => {
  const repository = new BatterDisciplineRepository(
    context.pool,
    context.references,
    context.computeReference,
  );
  const service = new BatterDisciplineService(
    repository,
    context.disciplinePrepared === undefined
      ? undefined
      : {
          store: context.disciplinePrepared,
          sourceHash: (query) => repository.readSourceHash(query),
          reportError: (err) => app.log.warn({ err }, "Discipline prepared cache unavailable"),
        },
  );
  const periods = new BoundedReadCache<DisciplineResponse>(16 * 1024 * 1024, 16, 300_000);
  const readPeriods = async (first: DisciplineQuery, second: DisciplineQuery, batterId: string) => {
    const firstKey = canonicalStringify([first, batterId]);
    const secondKey = canonicalStringify([second, batterId]);
    let [a, b] = await Promise.all([periods.get(firstKey), periods.get(secondKey)]);
    if (a !== undefined || b !== undefined) {
      const [firstHash, secondHash] = await repository.readPeriodSourceHashes(first, second);
      if (a?.sourceHash !== firstHash) a = undefined;
      if (b?.sourceHash !== secondHash) b = undefined;
      if (a !== undefined && b !== undefined) return { first: a, second: b };
    }
    a ??= await periods.load(firstKey, () => service.analyze(first, batterId), true);
    b ??=
      firstKey === secondKey
        ? a
        : await periods.load(secondKey, () => service.analyze(second, batterId), true);
    const [firstHash, secondHash] = await repository.readPeriodSourceHashes(first, second);
    assertPeriodSourceHash(a.sourceHash, firstHash);
    assertPeriodSourceHash(b.sourceHash, secondHash);
    return { first: a, second: b };
  };
  app.get(
    "/api/v2/analysis/batter-discipline/:batterId/comparison",
    {
      schema: {
        params: DisciplineParamsSchema,
        querystring: DisciplinePeriodQuerySchema,
        response: {
          200: DisciplinePeriodResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const { first, second } = analysisPeriodQueries(request.query);
      const playerId = request.params.batterId;
      const pair = await readPeriods(first, second, playerId);
      const snapshot = (d: typeof pair.first) =>
        periodSnapshot(d.query, d.sourceHash, [
          { label: "실제 투구", count: d.coverage.actualPitches },
          { label: "상황 제외", count: d.coverage.excludedSituations },
          { label: "지도 표본", count: d.coverage.locationPitches },
          { label: "포심 공통 표본", count: d.coverage.comparisonPitches },
          { label: "리그 지도 표본", count: d.coverage.leagueLocationPitches },
        ]);
      return {
        query: request.query,
        playerId,
        first: snapshot(pair.first),
        second: snapshot(pair.second),
        metrics: compareDisciplinePeriods(pair.first, pair.second),
        warnings: [
          "실제 코스의 관측 선구 지표를 비교합니다. 같은 구종·카운트·타석 좌우 조건을 유지하며 포심 가정 좌표를 시즌 간 차감하지 않습니다.",
        ],
      };
    },
  );
  app.addHook("onClose", async () => {
    periods.clear();
    await service.close();
  });
  app.get(
    "/api/v2/analysis/batter-discipline",
    {
      schema: {
        querystring: AnalysisScopeQuerySchema,
        response: { 200: DisciplineCatalogSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const { season, ...scope } = request.query;
      return repository.catalog(season, scope);
    },
  );
  app.get(
    "/api/v2/analysis/batter-discipline/:batterId",
    {
      schema: {
        params: DisciplineParamsSchema,
        querystring: DisciplineQuerySchema,
        response: {
          200: DisciplineResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request) => service.analyze({ ...request.query }, request.params.batterId),
  );
};
