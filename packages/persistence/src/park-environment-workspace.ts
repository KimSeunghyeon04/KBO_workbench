import { Type } from "@sinclair/typebox";
import { modelTrainingPeriod, validModelEvaluationSeasons } from "@kbo/game-core";
import { ParkEnvironmentModelSchema, type ParkEnvironmentModel } from "@kbo/contracts";
import { readAnalysisModelFile, writeAnalysisModelFile } from "./analysis-model-files.js";
import { parkTrainingHash, type ParkEnvironmentRepository } from "./park-environment-repository.js";
type Manifest = Awaited<ReturnType<ParkEnvironmentRepository["training"]>>["manifest"];
const strict = { additionalProperties: false } as const,
  hash = Type.String({ pattern: "^[a-f0-9]{64}$" }),
  envelope = Type.Object(
    {
      model: ParkEnvironmentModelSchema,
      manifest: Type.Object(
        {
          version: Type.Literal(1),
          through: Type.Integer(),
          seasons: Type.Array(Type.Object({ season: Type.Integer(), hash }, strict)),
          games: Type.Array(
            Type.Object(
              { gameId: Type.String(), revision: Type.Integer(), documentHash: hash },
              strict,
            ),
          ),
        },
        strict,
      ),
    },
    strict,
  );
export const ParkTrainingManifestSchema = envelope.properties.manifest;
function valid(model: ParkEnvironmentModel, manifest: Manifest) {
  return (
    modelTrainingPeriod("park", model.trainedThrough + 1).support === "eligible" &&
    model.metrics.every(
      (metric) =>
        (metric.evaluation === null || metric.evaluation.season === model.trainedThrough + 1) &&
        metric.validation.every((candidate) =>
          validModelEvaluationSeasons(model.trainedThrough, candidate.evaluations),
        ),
    ) &&
    model.sourceHash === parkTrainingHash(manifest) &&
    model.trainedThrough === manifest.through &&
    model.metrics[0]?.metric === "home_runs" &&
    model.metrics[1]?.metric === "runs" &&
    model.metrics.every(
      (m) =>
        m.metric === m.fitted.metric &&
        m.fitted.columns.length === m.fitted.coefficients.length &&
        new Set(m.fitted.columns).size === m.fitted.columns.length &&
        (!m.adopted || (m.fitted.withPark && m.fitted.identifiable && m.fitted.converged)) &&
        m.fitted.factors.every((f) =>
          !m.adopted
            ? f.index === null
            : f.status !== "supported" ||
              (f.index !== null &&
                f.low95 !== null &&
                f.high95 !== null &&
                f.low95 <= f.index &&
                f.index <= f.high95),
        ),
    )
  );
}
export class ParkEnvironmentWorkspace {
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}
  public async save(model: ParkEnvironmentModel, manifest: Manifest, signal?: AbortSignal) {
    if (!valid(model, manifest)) throw new Error("Invalid park model provenance");
    return writeAnalysisModelFile(
      this.root,
      "park-environment",
      model.trainedThrough,
      envelope,
      { model, manifest },
      this.assertWriter,
      signal,
    );
  }
  public async read(
    through: number,
  ): Promise<{ model: ParkEnvironmentModel; hash: string } | null> {
    const result = await readAnalysisModelFile(this.root, "park-environment", through, envelope);
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
}
