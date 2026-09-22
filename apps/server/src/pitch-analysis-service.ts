import {
  canonicalStringify,
  resolveAnalysisScope,
  type AnalysisScopeOptions,
  PITCH_CLUSTER_PARAMETERS,
  PitchAnalysisResponseSchema,
  PitchAnalysisSampleSchema,
  PitchClusterResultSchema,
  type PitchAnalysisResponse,
  type PitchAnalysisSample,
  type PitchClusterInput,
  type PitchClusterResult,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { summarizePitchExpectation } from "@kbo/game-core";
import { PitchClusteringWorkers } from "./pitch-clustering-workers.js";

export class InvalidPitchClusterCountError extends Error {}
interface Samples {
  analyze(
    season: number,
    pitcherId: string,
    options?: AnalysisScopeOptions,
  ): Promise<PitchAnalysisSample>;
}
interface Runner {
  fit(input: PitchClusterInput): Promise<PitchClusterResult>;
  close(): Promise<void>;
}

export class PitchAnalysisService {
  private readonly cache = new Map<string, PitchClusterResult>();
  private readonly pending = new Map<string, Promise<PitchClusterResult>>();
  private closed = false;
  public constructor(
    private readonly samples: Samples,
    private readonly runner: Runner = new PitchClusteringWorkers(),
  ) {}

  public async analyze(
    season: number,
    pitcherId: string,
    requestedCount?: number,
    options: AnalysisScopeOptions = {},
  ): Promise<PitchAnalysisResponse> {
    if (this.closed) throw new Error("Pitch analysis is closed");
    const scope = resolveAnalysisScope({ season, ...options });
    const sample = Value.Decode(
      PitchAnalysisSampleSchema,
      await this.samples.analyze(season, pitcherId, options),
    );
    const typeCount = new Set(
      sample.points.flatMap((p) => (p.pitchType === null ? [] : [p.pitchType])),
    ).size;
    const defaultClusterCount = sample.points.length === 0 ? 0 : Math.max(1, typeCount);
    const maxClusterCount = Math.min(sample.points.length, Math.max(12, typeCount));
    if (
      requestedCount !== undefined &&
      (!Number.isSafeInteger(requestedCount) ||
        requestedCount < 1 ||
        requestedCount > maxClusterCount)
    )
      throw new InvalidPitchClusterCountError(
        `군집 수는 1~${maxClusterCount} 사이여야 합니다.${maxClusterCount === 0 ? " 계산 가능한 투구가 없습니다." : ""}`,
      );
    const componentCount = requestedCount ?? defaultClusterCount;
    const key = canonicalStringify({
      season,
      pitcherId,
      sourceHash: sample.sourceHash,
      trajectory: sample.modelVersion,
      calibrationHash: sample.calibration.profileHash,
      parameters: PITCH_CLUSTER_PARAMETERS,
      componentCount,
    });
    let fitted = this.cache.get(key);
    if (fitted !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, fitted);
    }
    if (fitted === undefined) {
      let pending = this.pending.get(key);
      if (pending === undefined) {
        const input = {
          componentCount,
          points: sample.points.map(({ xCm, zCm, distanceToPlateCm }) => ({
            xCm,
            zCm,
            distanceToPlateCm,
          })),
        };
        pending = (
          componentCount === 0
            ? Promise.resolve<PitchClusterResult>({
                status: "empty",
                componentCount: 0,
                clusterCount: 0,
                unassignedCount: 0,
                iterations: 0,
                labels: [],
              })
            : this.runner.fit(input)
        )
          .then((value) => {
            const result = Value.Decode(PitchClusterResultSchema, value);
            validateResult(result, sample.points.length, componentCount);
            if (!this.closed) {
              this.cache.set(key, result);
              while (this.cache.size > 32) {
                const oldest = this.cache.keys().next().value;
                if (oldest !== undefined) this.cache.delete(oldest);
              }
            }
            return result;
          })
          .finally(() => {
            this.pending.delete(key);
          });
        this.pending.set(key, pending);
      }
      fitted = await pending;
    }
    const { labels, ...summary } = fitted;
    const points = sample.points.map((p, i) => ({ ...p, clusterId: labels[i] ?? null }));
    return Value.Decode(PitchAnalysisResponseSchema, {
      ...sample,
      scope,
      expectation: summarizePitchExpectation(points, sample.referenceDistribution),
      clustering: { ...PITCH_CLUSTER_PARAMETERS, ...summary, defaultClusterCount, maxClusterCount },
      points,
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.cache.clear();
    await this.runner.close();
  }
}

function validateResult(result: PitchClusterResult, n: number, k: number): void {
  const assigned = result.labels.filter((id) => id !== null);
  if (
    result.labels.length !== n ||
    result.componentCount !== k ||
    new Set(assigned).size !== result.clusterCount ||
    n - assigned.length !== result.unassignedCount ||
    assigned.some((id) => id > k) ||
    (result.status === "ready" ? result.unassignedCount !== 0 || n === 0 : assigned.length !== 0) ||
    (result.status === "empty" && n !== 0)
  )
    throw new Error("Inconsistent pitch clustering result");
}
