import { Type, type TSchema, type Static } from "@sinclair/typebox";
import { winInningLimit, modelTrainingPeriod, validModelEvaluationSeasons } from "@kbo/game-core";
import {
  RunExpectancyModelSchema,
  CountRunModelSchema,
  type CountRunModel,
  WinModelSchema,
  type WinModel,
  RunTrainingGameSchema,
  type RunExpectancyModel,
} from "@kbo/contracts";
import { readAnalysisModelFile, writeAnalysisModelFile } from "./analysis-model-files.js";
import { runTrainingHash, type RunValueRepository } from "./run-value-repository.js";
type Manifest = Awaited<ReturnType<RunValueRepository["training"]>>["manifest"];
const hashSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const envelope = Type.Object(
  {
    model: RunExpectancyModelSchema,
    manifest: Type.Object(
      {
        version: Type.Literal(1),
        through: Type.Integer(),
        games: Type.Array(RunTrainingGameSchema),
        scopeHashes: Type.Array(
          Type.Object(
            { season: Type.Integer(), hash: hashSchema },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const countEnvelope = Type.Object(
  { model: CountRunModelSchema, manifest: envelope.properties.manifest },
  { additionalProperties: false },
);
export const RunTrainingManifestSchema = envelope.properties.manifest;
const winEnvelope = Type.Object(
  { model: WinModelSchema, manifest: envelope.properties.manifest },
  { additionalProperties: false },
);
function valid(model: RunExpectancyModel, manifest: Manifest) {
  return (
    modelTrainingPeriod("re24", model.trainedThrough + 1).support === "eligible" &&
    model.validation.every((v) =>
      validModelEvaluationSeasons(model.trainedThrough, v.evaluations),
    ) &&
    (model.evaluation === null || model.evaluation.season === model.trainedThrough + 1) &&
    model.sourceHash === runTrainingHash(manifest) &&
    model.trainedThrough === manifest.through &&
    model.cells.every(
      (c, i) =>
        c.outs === Math.floor(i / 8) &&
        c.bases === i % 8 &&
        (c.samples === 0 ? c.mean === null : c.mean !== null && c.mean >= 0),
    )
  );
}
export class RunExpectancyWorkspace {
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}
  public async save(model: RunExpectancyModel, manifest: Manifest, signal?: AbortSignal) {
    if (!valid(model, manifest)) throw new Error("Invalid RE24 model provenance");
    return this.write(
      "run-expectancy",
      envelope,
      { model, manifest },
      model.trainedThrough,
      signal,
    );
  }
  public async saveCount(model: CountRunModel, manifest: Manifest, signal?: AbortSignal) {
    if (!validCount(model, manifest)) throw new Error("Invalid count RE model provenance");
    return this.write(
      "count-run-expectancy",
      countEnvelope,
      { model, manifest },
      model.trainedThrough,
      signal,
    );
  }
  public async saveWin(model: WinModel, manifest: Manifest, signal?: AbortSignal) {
    if (!validWin(model, manifest)) throw new Error("Invalid win model provenance");
    return this.write(
      "win-probability",
      winEnvelope,
      { model, manifest },
      model.trainedThrough,
      signal,
    );
  }
  public async readWin(through: number): Promise<{ model: WinModel; hash: string } | null> {
    const result = await this.readFile("win-probability", through, winEnvelope);
    if (result === null) return null;
    try {
      return validWin(result.payload.model, result.payload.manifest) &&
        result.payload.model.trainedThrough === through
        ? { model: result.payload.model, hash: result.hash }
        : null;
    } catch {
      return null;
    }
  }
  private async write<S extends TSchema>(
    kind: string,
    schema: S,
    payload: Static<S>,
    through: number,
    signal?: AbortSignal,
  ) {
    return writeAnalysisModelFile(
      this.root,
      kind,
      through,
      schema,
      payload,
      this.assertWriter,
      signal,
    );
  }
  public async read(through: number): Promise<{ model: RunExpectancyModel; hash: string } | null> {
    const result = await this.readFile("run-expectancy", through, envelope);
    if (result === null) return null;
    try {
      return valid(result.payload.model, result.payload.manifest) &&
        result.payload.model.trainedThrough === through
        ? { model: result.payload.model, hash: result.hash }
        : null;
    } catch {
      return null;
    }
  }
  public async readCount(through: number): Promise<{ model: CountRunModel; hash: string } | null> {
    const result = await this.readFile("count-run-expectancy", through, countEnvelope);
    if (result === null) return null;
    try {
      return validCount(result.payload.model, result.payload.manifest) &&
        result.payload.model.trainedThrough === through
        ? { model: result.payload.model, hash: result.hash }
        : null;
    } catch {
      return null;
    }
  }
  private async readFile<S extends TSchema>(
    kind: string,
    through: number,
    schema: S,
  ): Promise<{ payload: Static<S>; hash: string } | null> {
    return readAnalysisModelFile(this.root, kind, through, schema);
  }
}

function validWin(model: WinModel, manifest: Manifest) {
  const probabilities = [model.prior, ...model.table.map((r) => r.probability)];
  return (
    modelTrainingPeriod("win", model.trainedThrough + 1).support === "eligible" &&
    model.validation.every((v) =>
      validModelEvaluationSeasons(model.trainedThrough, v.evaluations, 2022),
    ) &&
    (model.evaluation === null || model.evaluation.season === model.trainedThrough + 1) &&
    model.sourceHash === runTrainingHash(manifest) &&
    model.trainedThrough === manifest.through &&
    model.limits.every((limit) => limit === winInningLimit(model.trainedThrough + 1)) &&
    (model.status !== "ready" || model.limits.length === 1) &&
    model.means.length === 13 &&
    model.scales.length === 13 &&
    (model.method === "state_table"
      ? model.coefficients.length === 0
      : model.coefficients.length === 42 && model.converged) &&
    new Set(model.table.map((r) => r.key)).size === model.table.length &&
    probabilities.every(
      (p) =>
        Math.abs(p.homeWin + p.draw + p.homeLoss - 1) < 1e-8 &&
        Math.abs(p.value - p.homeWin - 0.5 * p.draw) < 1e-8,
    )
  );
}
function validCount(model: CountRunModel, manifest: Manifest) {
  return (
    modelTrainingPeriod("count", model.trainedThrough + 1).support === "eligible" &&
    model.validation.every((v) =>
      validModelEvaluationSeasons(model.trainedThrough, v.evaluations),
    ) &&
    (model.evaluation === null || model.evaluation.season === model.trainedThrough + 1) &&
    model.sourceHash === runTrainingHash(manifest) &&
    model.trainedThrough === manifest.through &&
    model.cells.every(
      (c, i) =>
        c.outs === Math.floor(i / 96) &&
        c.bases === Math.floor(i / 12) % 8 &&
        c.balls === Math.floor((i % 12) / 3) &&
        c.strikes === i % 3 &&
        (c.mean === null || c.mean >= 0),
    )
  );
}
