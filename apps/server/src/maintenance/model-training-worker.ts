import { parentPort, workerData } from "node:worker_threads";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Pool } from "pg";
import { AnalysisModelKindSchema, AnalysisModelTrainingSeasonSchema } from "@kbo/contracts";
import {
  PitchQualityRepository,
  PitchQualityWorkspace,
  pitchQualitySourceHash,
  trainPitchQualityFromFacts,
  RunValueRepository,
  runTrainingHash,
  ParkEnvironmentRepository,
  parkTrainingHash,
} from "@kbo/persistence";
import {
  trainMatchupModel,
  trainParkEnvironment,
  trainRunExpectancy,
  trainCountRunExpectancy,
  trainWinProbability,
  modelTrainingPeriod,
} from "@kbo/game-core";
import { loadConfig } from "../config.js";
import { ModelTrainingResultSchema, type ModelTrainingResult } from "../model-training-protocol.js";
const { kind, through, baseDirectory } = Value.Decode(
  Type.Object(
    {
      kind: AnalysisModelKindSchema,
      through: AnalysisModelTrainingSeasonSchema,
      baseDirectory: Type.String(),
    },
    { additionalProperties: false },
  ),
  workerData,
);
const port = parentPort;
if (port === null) throw new Error("Model training requires a worker");
if (modelTrainingPeriod(kind, through + 1).support !== "eligible")
  throw new Error("Insufficient supported model history");
const pool = new Pool({ ...loadConfig().database, max: 1 });
async function train(): Promise<ModelTrainingResult> {
  if (kind === "quality" || kind === "matchup") {
    const base =
      kind === "matchup"
        ? await new PitchQualityWorkspace(baseDirectory, async () => {
            throw new Error("Read only base model");
          }).read(through)
        : null;
    const input = await new PitchQualityRepository(pool)
      .training(through)
      .finally(() => pool.end());
    const sourceHash = pitchQualitySourceHash(input.manifest);
    port?.postMessage({ phase: "fitting" });
    if (kind === "quality")
      return {
        kind,
        manifest: input.manifest,
        model: trainPitchQualityFromFacts(input.rows, sourceHash, through),
      };
    if (base === null || base.model.sourceHash !== sourceHash)
      throw new Error("Current quality model required");
    return {
      kind,
      manifest: input.manifest,
      model: trainMatchupModel(input.rows, base.model, base.hash, sourceHash),
    };
  }
  if (kind === "park") {
    const input = await new ParkEnvironmentRepository(pool)
      .training(through)
      .finally(() => pool.end());
    port?.postMessage({ phase: "fitting" });
    return {
      kind,
      manifest: input.manifest,
      model: trainParkEnvironment(input.rows, parkTrainingHash(input.manifest), through),
    };
  }
  const input = await new RunValueRepository(pool)
    .training(through, undefined, kind)
    .finally(() => pool.end());
  const sourceHash = runTrainingHash(input.manifest);
  port?.postMessage({ phase: "fitting" });
  if (kind === "re24")
    return {
      kind,
      manifest: input.manifest,
      model: trainRunExpectancy(input.observations, sourceHash, through),
    };
  if (kind === "count")
    return {
      kind,
      manifest: input.manifest,
      model: trainCountRunExpectancy(
        input.countObservations,
        input.observations,
        sourceHash,
        through,
      ),
    };
  return {
    kind,
    manifest: input.manifest,
    model: trainWinProbability(input.winObservations, sourceHash, through),
  };
}
port.postMessage(Value.Decode(ModelTrainingResultSchema, await train()));
