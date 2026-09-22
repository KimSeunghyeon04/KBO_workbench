import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type {
  PitchAnalysisComputation,
  AnalysisCoverageWorkspace,
  PitchReferenceWorkspace,
  PitchCalibrationWorkspace,
  RunExpectancyWorkspace,
  ParkEnvironmentWorkspace,
  PitchQualityWorkspace,
  MatchupModelWorkspace,
} from "@kbo/persistence";
import { ComputationPool } from "../computation-pool.js";
import type { RouteContext } from "./context.js";
import { pitchAnalysisRoutes } from "./pitch-analysis.js";
import { batterDisciplineRoutes } from "./batter-discipline.js";
import { analysisCoverageRoutes } from "./analysis-coverage.js";
import { playerStatisticsRoutes } from "./player-statistics.js";
import { batterProfileRoutes } from "./batter-profile.js";
import { pitcherChangesRoutes } from "./pitcher-changes.js";
import { pitchSequenceRoutes } from "./pitch-sequences.js";
import { baserunningAnalysisRoutes } from "./baserunning-analysis.js";
import { pitcherWorkloadRoutes } from "./pitcher-workload.js";
import { matchupRoutes } from "./matchups.js";
import { runValueRoutes } from "./run-value.js";
import { pitchQualityRoutes } from "./pitch-quality.js";
import { parkEnvironmentRoutes } from "./park-environment.js";
import { pitchLocationRoutes } from "./pitch-location.js";
import { pitchAnglesRoutes } from "./pitch-angles.js";

type Options = Pick<RouteContext, "pool"> & {
  summaries: Pick<AnalysisCoverageWorkspace, "read" | "write">;
  references: Pick<PitchReferenceWorkspace, "getOrCreate">;
  calibrations: Pick<PitchCalibrationWorkspace, "getOrCreate">;
  runModels: Pick<RunExpectancyWorkspace, "read" | "readCount" | "readWin">;
  qualityModels: Pick<PitchQualityWorkspace, "read">;
  matchupModels: Pick<MatchupModelWorkspace, "read">;
  parkModels: Pick<ParkEnvironmentWorkspace, "read">;
};
/** Composition only: trajectory and fixed-model consumers share a bounded CPU pool. */
export const analysisRoutes: FastifyPluginAsyncTypebox<Options> = async (app, context) => {
  const workers = new ComputationPool(1, 16);
  const computation: PitchAnalysisComputation = {
    async calibration(season, sourceHash, rows, previous, signal) {
      const result = await workers.run(
        {
          kind: "pitch_calibration",
          season,
          sourceHash,
          rows,
          previous,
        },
        signal,
      );
      if (result.kind !== "pitch_calibration") throw new Error("Unexpected calibration result");
      return result.value;
    },
    async reference(rows, calibration) {
      const result = await workers.run({
        kind: "pitch_reference",
        rows,
        ...(calibration === null ? {} : { calibration }),
      });
      if (result.kind !== "pitch_reference") throw new Error("Unexpected reference result");
      return result.value;
    },
    async sample(season, pitcherId, sourceHash, rows, reference, calibration) {
      const result = await workers.run({
        kind: "pitch_sample",
        season,
        pitcherId,
        sourceHash,
        rows,
        reference,
        calibration,
      });
      if (result.kind !== "pitch_sample") throw new Error("Unexpected sample result");
      return result.value;
    },
  };
  await app.register(pitchAnalysisRoutes, { ...context, computation });
  await app.register(batterDisciplineRoutes, {
    pool: context.pool,
    references: context.references,
    computeReference: computation.reference,
  });
  await app.register(analysisCoverageRoutes, {
    pool: context.pool,
    calibrations: context.calibrations,
    calibrate: computation.calibration,
    summaries: context.summaries,
  });
  await app.register(playerStatisticsRoutes, { pool: context.pool });
  await app.register(pitchLocationRoutes, { pool: context.pool });
  await app.register(pitchAnglesRoutes, { pool: context.pool, computation: workers });
  await app.register(runValueRoutes, { pool: context.pool, models: context.runModels });
  await app.register(pitchQualityRoutes, {
    pool: context.pool,
    models: context.qualityModels,
    computation: workers,
  });
  await app.register(parkEnvironmentRoutes, { pool: context.pool, models: context.parkModels });
  await app.register(matchupRoutes, {
    pool: context.pool,
    models: context.matchupModels,
    computation: workers,
  });
  await app.register(pitcherWorkloadRoutes, { pool: context.pool, computation: workers });
  await app.register(baserunningAnalysisRoutes, { pool: context.pool });
  await app.register(pitchSequenceRoutes, { pool: context.pool });
  await app.register(pitcherChangesRoutes, { ...context, computation });
  await app.register(batterProfileRoutes, { pool: context.pool });
  app.addHook("onClose", async () => workers.close());
};
