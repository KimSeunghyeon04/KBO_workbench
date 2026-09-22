import type { AnalysisModelKind, AnalysisModelStatus, AnalysisModelJob } from "@kbo/contracts";
import { modelTrainingPeriod } from "@kbo/game-core";
import { AnalysisModelSourceRepository, type StagingWorkspace } from "@kbo/persistence";
import type { Pool } from "pg";
import { runModelTraining } from "./model-training-runner.js";
export const MODEL_ORDER: readonly AnalysisModelKind[] = [
  "re24",
  "count",
  "win",
  "park",
  "quality",
  "matchup",
];
type Phase = AnalysisModelJob["steps"][number]["phase"];
export class ModelSourceChangedError extends Error {
  public constructor() {
    super("학습 중 원천 또는 기반 모델이 변경되었습니다. 현재 자료로 다시 갱신해 주세요.");
  }
}
export class AnalysisModelService {
  private readonly sources: AnalysisModelSourceRepository;
  public constructor(
    pool: Pool,
    private readonly workspace: Pick<
      StagingWorkspace,
      "runExpectancy" | "parkEnvironment" | "pitchQuality" | "matchupModels"
    >,
    private readonly root: string,
    private readonly train = runModelTraining,
  ) {
    this.sources = new AnalysisModelSourceRepository(pool);
  }
  public async status(applicationSeason = 2025): Promise<AnalysisModelStatus[]> {
    const periods = MODEL_ORDER.map((kind) => modelTrainingPeriod(kind, applicationSeason));
    if (periods.every((period) => period.support !== "eligible"))
      return MODEL_ORDER.map((kind) => ({
        ...modelTrainingPeriod(kind, applicationSeason),
        kind,
        state: "unsupported",
        sourceHash: null,
        modelHash: null,
        adoptedTargets: 0,
        totalTargets: kind === "quality" || kind === "matchup" ? 3 : kind === "park" ? 2 : 1,
      }));
    const through = applicationSeason - 1;
    const sources = await this.sources.read(through);
    const [re24, count, win, park, quality, matchup] = await Promise.all([
      this.workspace.runExpectancy.read(through),
      this.workspace.runExpectancy.readCount(through),
      this.workspace.runExpectancy.readWin(through),
      this.workspace.parkEnvironment.read(through),
      this.workspace.pitchQuality.read(through),
      this.workspace.matchupModels.read(through),
    ]);
    const stored = { re24, count, win, park, quality, matchup };
    return MODEL_ORDER.map((kind) => {
      const entry = stored[kind],
        period = modelTrainingPeriod(kind, applicationSeason);
      const adopted =
        kind === "quality"
          ? (quality?.model.targets.filter((t) => t.adopted).length ?? 0)
          : kind === "matchup"
            ? (matchup?.model.targets.filter((t) => t.adopted).length ?? 0)
            : kind === "park"
              ? (park?.model.metrics.filter((t) => t.adopted).length ?? 0)
              : kind === "re24"
                ? Number(re24?.model.status === "ready")
                : kind === "count"
                  ? Number(count?.model.status === "ready")
                  : Number(win?.model.status === "ready");
      return {
        ...period,
        kind,
        state:
          period.support !== "eligible"
            ? "unsupported"
            : entry === null
              ? "missing"
              : entry.model.sourceHash !== sources[kind] ||
                  (kind === "matchup" && matchup?.model.baseModelHash !== quality?.hash)
                ? "stale"
                : "current",
        sourceHash: period.support === "eligible" ? sources[kind] : null,
        modelHash: entry?.hash ?? null,
        adoptedTargets: adopted,
        totalTargets: kind === "quality" || kind === "matchup" ? 3 : kind === "park" ? 2 : 1,
      };
    });
  }
  public async refresh(
    kind: AnalysisModelKind,
    signal: AbortSignal,
    phase: (value: Phase) => Promise<void>,
    applicationSeason = 2025,
  ) {
    const period = modelTrainingPeriod(kind, applicationSeason);
    if (period.support !== "eligible") throw new Error("Insufficient supported model history");
    const through = period.trainedThrough;
    const result = await this.train(kind, this.root, signal, () => phase("fitting"), through);
    signal.throwIfAborted();
    await phase("checking");
    const sources = await this.sources.read(through);
    if (
      result.kind !== kind ||
      result.model.trainedThrough !== through ||
      result.model.sourceHash !== sources[kind]
    )
      throw new ModelSourceChangedError();
    if (result.kind === "matchup") {
      const base = await this.workspace.pitchQuality.read(through);
      if (base?.hash !== result.model.baseModelHash) throw new ModelSourceChangedError();
    }
    signal.throwIfAborted();
    await phase("publishing");
    switch (result.kind) {
      case "re24":
        return this.workspace.runExpectancy.save(result.model, result.manifest, signal);
      case "count":
        return this.workspace.runExpectancy.saveCount(result.model, result.manifest, signal);
      case "win":
        return this.workspace.runExpectancy.saveWin(result.model, result.manifest, signal);
      case "park":
        return this.workspace.parkEnvironment.save(result.model, result.manifest, signal);
      case "quality":
        return this.workspace.pitchQuality.save(result.model, result.manifest, signal);
      case "matchup":
        return this.workspace.matchupModels.save(result.model, result.manifest, signal);
    }
  }
}
