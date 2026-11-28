import { parentPort, workerData } from "node:worker_threads";
import { on } from "node:events";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Pool } from "pg";
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
import {
  ModelTrainingRequestSchema,
  ModelTrainingResultSchema,
  type ModelTrainingRequest,
  type ModelTrainingResult,
} from "../model-training-protocol.js";
const baseDirectory = Value.Decode(Type.String(), workerData);
const port = parentPort;
if (port === null) throw new Error("Model training requires a worker");
type TrainingInput =
  | { family: "run"; input: Awaited<ReturnType<RunValueRepository["training"]>> }
  | { family: "quality"; input: Awaited<ReturnType<PitchQualityRepository["training"]>> };
let retained: (TrainingInput & { through: number; hash: string }) | undefined;

async function withPool<T>(read: (pool: Pool) => Promise<T>) {
  const pool = new Pool({ ...loadConfig().database, max: 1 });
  try {
    return await read(pool);
  } finally {
    await pool.end();
  }
}

async function train(
  { kind, through, sourceHash: expectedHash }: ModelTrainingRequest,
  fitting: () => void,
): Promise<ModelTrainingResult> {
  if (modelTrainingPeriod(kind, through + 1).support !== "eligible")
    throw new Error("Insufficient supported model history");
  const family =
    kind === "park" ? "park" : kind === "quality" || kind === "matchup" ? "quality" : "run";
  if (retained?.family !== family || retained.through !== through || retained.hash !== expectedHash)
    retained = undefined;
  if (kind === "quality" || kind === "matchup") {
    const base =
      kind === "matchup"
        ? await new PitchQualityWorkspace(baseDirectory, async () => {
            throw new Error("Read only base model");
          }).read(through)
        : null;
    const input =
      retained?.family === "quality"
        ? retained.input
        : await withPool((pool) => new PitchQualityRepository(pool).training(through));
    const sourceHash = pitchQualitySourceHash(input.manifest);
    fitting();
    if (kind === "quality") {
      if (expectedHash !== undefined)
        retained = { family: "quality", through, hash: sourceHash, input };
      return {
        kind,
        manifest: input.manifest,
        model: trainPitchQualityFromFacts(input.rows, sourceHash, through),
      };
    }
    retained = undefined;
    if (base === null || base.model.sourceHash !== sourceHash)
      throw new Error("Current quality model required");
    return {
      kind,
      manifest: input.manifest,
      model: trainMatchupModel(input.rows, base.model, base.hash, sourceHash),
    };
  }
  if (kind === "park") {
    const input = await withPool((pool) => new ParkEnvironmentRepository(pool).training(through));
    fitting();
    return {
      kind,
      manifest: input.manifest,
      model: trainParkEnvironment(input.rows, parkTrainingHash(input.manifest), through),
    };
  }
  const share = expectedHash !== undefined && kind !== "win";
  const input =
    retained?.family === "run"
      ? retained.input
      : await withPool((pool) =>
          new RunValueRepository(pool).training(through, undefined, share ? "all" : kind),
        );
  const sourceHash = runTrainingHash(input.manifest);
  retained = share ? { family: "run", through, hash: sourceHash, input } : undefined;
  fitting();
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
for await (const [message] of on(port, "message")) {
  const request = Value.Decode(ModelTrainingRequestSchema, message);
  const result = await train(request, () => port.postMessage({ phase: "fitting" }));
  port.postMessage(Value.Decode(ModelTrainingResultSchema, result));
}
