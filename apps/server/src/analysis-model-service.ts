import type { AnalysisModelKind, AnalysisModelStatus, AnalysisModelJob } from "@kbo/contracts";
import { modelTrainingPeriod } from "@kbo/game-core";
import { AnalysisModelSourceRepository, type StagingWorkspace } from "@kbo/persistence";
import type { Pool } from "pg";
import { ModelTrainingSession, runModelTraining } from "./model-training-runner.js";
export const MODEL_ORDER: readonly AnalysisModelKind[] = [
  "re24",
  "count",
  "win",
  "park",
  "quality",
  "matchup",
];
type Phase = AnalysisModelJob["steps"][number]["phase"];
type StoredModel = {
  hash: string;
  sourceHash: string;
  adoptedTargets: number;
  baseModelHash?: string;
};

function modelStatus(
  kind: AnalysisModelKind,
  season: number,
  entry: StoredModel | null,
  sourceHash: string | null,
  qualityHash?: string,
): AnalysisModelStatus {
  const period = modelTrainingPeriod(kind, season);
  return {
    ...period,
    kind,
    state:
      period.support !== "eligible"
        ? "unsupported"
        : entry === null
          ? "missing"
          : entry.sourceHash !== sourceHash ||
              (kind === "matchup" && entry.baseModelHash !== qualityHash)
            ? "stale"
            : "current",
    sourceHash: period.support === "eligible" ? sourceHash : null,
    modelHash: entry?.hash ?? null,
    adoptedTargets: entry?.adoptedTargets ?? 0,
    totalTargets: kind === "quality" || kind === "matchup" ? 3 : kind === "park" ? 2 : 1,
  };
}

function storedModel(
  entry: { hash: string; model: { sourceHash: string } } | null,
  adoptedTargets: number,
): StoredModel | null {
  return entry === null
    ? null
    : { hash: entry.hash, sourceHash: entry.model.sourceHash, adoptedTargets };
}
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
    if (
      MODEL_ORDER.every(
        (kind) => modelTrainingPeriod(kind, applicationSeason).support !== "eligible",
      )
    )
      return MODEL_ORDER.map((kind) => modelStatus(kind, applicationSeason, null, null));
    const through = applicationSeason - 1;
    const sources = await this.sources.read(through);
    const [re24, count, win, park, quality, matchup] = await Promise.all([
      this.readStored("re24", through),
      this.readStored("count", through),
      this.readStored("win", through),
      this.readStored("park", through),
      this.readStored("quality", through),
      this.readStored("matchup", through),
    ]);
    const stored = { re24, count, win, park, quality, matchup };
    return MODEL_ORDER.map((kind) =>
      modelStatus(kind, applicationSeason, stored[kind], sources[kind], quality?.hash),
    );
  }

  public async statusForKind(kind: AnalysisModelKind, applicationSeason: number) {
    const period = modelTrainingPeriod(kind, applicationSeason);
    if (period.support !== "eligible") return modelStatus(kind, applicationSeason, null, null);
    const through = period.trainedThrough;
    const sourceHash = await this.sources.readForKind(through, kind);
    const [entry, base] = await Promise.all([
      this.readStored(kind, through),
      kind === "matchup" ? this.workspace.pitchQuality.read(through) : null,
    ]);
    return modelStatus(kind, applicationSeason, entry, sourceHash, base?.hash);
  }

  private async readStored(kind: AnalysisModelKind, through: number): Promise<StoredModel | null> {
    switch (kind) {
      case "re24": {
        const entry = await this.workspace.runExpectancy.read(through);
        return storedModel(entry, Number(entry?.model.status === "ready"));
      }
      case "count": {
        const entry = await this.workspace.runExpectancy.readCount(through);
        return storedModel(entry, Number(entry?.model.status === "ready"));
      }
      case "win": {
        const entry = await this.workspace.runExpectancy.readWin(through);
        return storedModel(entry, Number(entry?.model.status === "ready"));
      }
      case "park": {
        const entry = await this.workspace.parkEnvironment.read(through);
        return storedModel(
          entry,
          entry?.model.metrics.filter((target) => target.adopted).length ?? 0,
        );
      }
      case "quality": {
        const entry = await this.workspace.pitchQuality.read(through);
        return storedModel(
          entry,
          entry?.model.targets.filter((target) => target.adopted).length ?? 0,
        );
      }
      case "matchup": {
        const entry = await this.workspace.matchupModels.read(through);
        return entry === null
          ? null
          : {
              hash: entry.hash,
              sourceHash: entry.model.sourceHash,
              adoptedTargets: entry.model.targets.filter((target) => target.adopted).length,
              baseModelHash: entry.model.baseModelHash,
            };
      }
    }
  }

  public startTrainingJob() {
    const session =
      this.train === runModelTraining ? new ModelTrainingSession(this.root) : undefined;
    return {
      refresh: (
        kind: AnalysisModelKind,
        signal: AbortSignal,
        phase: (value: Phase) => Promise<void>,
        season: number,
        sourceHash: string | null,
      ) => this.refresh(kind, signal, phase, season, session, sourceHash),
      close: async () => session?.close(),
    };
  }
  public async refresh(
    kind: AnalysisModelKind,
    signal: AbortSignal,
    phase: (value: Phase) => Promise<void>,
    applicationSeason = 2025,
    session?: ModelTrainingSession,
    sourceHash: string | null = null,
  ) {
    const period = modelTrainingPeriod(kind, applicationSeason);
    if (period.support !== "eligible") throw new Error("Insufficient supported model history");
    const through = period.trainedThrough;
    const onFit = () => phase("fitting");
    const result =
      session === undefined
        ? await this.train(kind, this.root, signal, onFit, through)
        : await session.run(
            { kind, through, ...(sourceHash === null ? {} : { sourceHash }) },
            signal,
            onFit,
          );
    signal.throwIfAborted();
    await phase("checking");
    const currentSource = await this.sources.readForKind(through, kind);
    if (
      result.kind !== kind ||
      result.model.trainedThrough !== through ||
      result.model.sourceHash !== currentSource
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
