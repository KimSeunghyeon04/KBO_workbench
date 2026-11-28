import {
  readAnalysisPeriods,
  withAnalysisReadSnapshot,
  type AnalysisReadSnapshot,
} from "./analysis-snapshot.js";
import {
  resolveAnalysisScope,
  type AnalysisScope,
  type AnalysisScopeOptions,
  type AnalysisScopeQuery,
} from "@kbo/contracts";
import { summarizePitchProfile } from "@kbo/game-core";
import { analysisScopeParameters, analysisSourceHash } from "./analysis-scope.js";
import { createHash } from "node:crypto";

import {
  canonicalStringify,
  PITCH_ANALYSIS_MODEL_VERSION,
  PITCH_REFERENCE_VERSION,
  PITCH_CALIBRATION_PARAMETERS,
  PitchAnalysisSampleSchema,
  type PitchAnalysisCatalog,
  type PitchAnalysisSample,
  type PitchReference,
  type PitchCalibrationSeason,
  type PitchReleaseGroup,
} from "@kbo/contracts";
import {
  alignPitchTrajectory,
  averagePitchTrajectory,
  comparePitchTrajectory,
  fitPitchReferenceDistribution,
  classifyPitchReference,
  estimatePitchReleases,
} from "@kbo/game-core";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";
import { analysisPitchCatalogSql } from "./analysis-pitch-input.js";
import {
  pitchReferenceScope,
  type PitchAnalysisRow as PitchRow,
} from "./pitch-trajectory-input.js";
import { preparePitchInputs } from "./pitch-trajectory-preparation.js";

import type { PitchReferenceWorkspace } from "./pitch-reference-workspace.js";
import type { PitchCalibrationWorkspace } from "./pitch-calibration-workspace.js";
import {
  calculatePitchCalibration,
  calibratePitchTrajectory,
  middlePlaneTrajectory,
  pitchCalibrationHash,
  pitchCalibrationLookup,
} from "./pitch-calibration.js";

export interface PitchAnalysisComputation {
  calibration(
    season: number,
    sourceHash: string,
    rows: readonly PitchRow[],
    previous: PitchCalibrationSeason | null,
    signal?: AbortSignal,
  ): Promise<PitchCalibrationSeason>;
  reference(
    rows: readonly PitchRow[],
    calibration: PitchCalibrationSeason | null,
  ): Promise<PitchReference["reference"]>;
  sample(
    season: number,
    pitcherId: string,
    sourceHash: string,
    rows: readonly PitchRow[],
    reference: PitchReference["reference"],
    calibration: PitchCalibrationSeason,
    releaseRows?: readonly PitchRow[],
  ): Promise<PitchAnalysisSample>;
}
interface SampleCache {
  get(key: string): Promise<PitchAnalysisSample> | undefined;
  load(key: string, calculate: () => Promise<PitchAnalysisSample>): Promise<PitchAnalysisSample>;
}
interface PitchSampleInput {
  readonly scope: AnalysisScope;
  readonly sourceHash: string;
  readonly cacheKey: string;
}

const catalogRowSchema = Type.Object(
  {
    pitcherId: Type.String(),
    name: Type.String(),
    pitches: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
function pitchAnalysisSourceHash(referenceHash: string, scope: AnalysisScope): string {
  return createHash("sha256")
    .update(
      canonicalStringify({
        referenceHash,
        scope,
        referenceVersion: PITCH_REFERENCE_VERSION,
      }),
    )
    .digest("hex");
}

export const inlinePitchAnalysisComputation: PitchAnalysisComputation = {
  calibration: async (season, hash, rows, previous) =>
    calculatePitchCalibration(season, hash, rows, previous),
  reference: async (...args) => prepareReference(...args),
  sample: async (...args) => analyzeRows(...args),
};

export class PitchAnalysisRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly references?: Pick<PitchReferenceWorkspace, "getOrCreate">,
    private readonly computation = inlinePitchAnalysisComputation,
    private readonly samples?: SampleCache,
    private readonly calibrations?: Pick<PitchCalibrationWorkspace, "getOrCreate">,
  ) {}

  public async catalog(
    season: number,
    options: AnalysisScopeOptions = {},
  ): Promise<PitchAnalysisCatalog> {
    const scope = resolveAnalysisScope({ season, ...options });
    const result = await this.pool.query<Record<string, unknown>>(
      analysisPitchCatalogSql("pitcher"),
      analysisScopeParameters(scope),
    );
    return {
      season,
      scope,
      pitchers: result.rows.map((row) => {
        if (!Value.Check(catalogRowSchema, row))
          throw new Error("Invalid pitch analysis catalog row");
        return row;
      }),
    };
  }

  public async readSourceHash(input: AnalysisScopeQuery) {
    const scope = resolveAnalysisScope(input);
    const referenceHash = await analysisSourceHash(this.pool, pitchReferenceScope(scope));
    return pitchAnalysisSourceHash(referenceHash, scope);
  }

  public async analyze(
    season: number,
    pitcherId: string,
    options: AnalysisScopeOptions = {},
  ): Promise<PitchAnalysisSample> {
    const scope = resolveAnalysisScope({ season, ...options });
    return withAnalysisReadSnapshot(
      this.pool,
      async (snapshot) => (await this.analyzeInputs(snapshot, pitcherId, scope)).first,
    );
  }

  public compare(first: AnalysisScopeQuery, second: AnalysisScopeQuery, pitcherId: string) {
    return readAnalysisPeriods(
      this.pool,
      resolveAnalysisScope(first),
      resolveAnalysisScope(second),
      (snapshot, a, b) => this.analyzeInputs(snapshot, pitcherId, a, b),
      pitchReferenceScope,
    );
  }

  private async analyzeInputs(
    snapshot: AnalysisReadSnapshot,
    pitcherId: string,
    firstScope: AnalysisScope,
    secondScope?: AnalysisScope,
  ) {
    const referenceScope = pitchReferenceScope(firstScope);
    const referenceHash = await snapshot.sourceHash(referenceScope);
    const sampleInput = (scope: AnalysisScope): PitchSampleInput => {
      const sourceHash = pitchAnalysisSourceHash(referenceHash, scope);
      const cacheKey = canonicalStringify({
        modelVersion: PITCH_ANALYSIS_MODEL_VERSION,
        referenceVersion: PITCH_REFERENCE_VERSION,
        calibrationVersion: PITCH_CALIBRATION_PARAMETERS.modelVersion,
        season: scope.season,
        sourceHash,
        pitcherId,
      });
      return { scope, sourceHash, cacheKey };
    };
    const a = sampleInput(firstScope);
    const b = secondScope === undefined ? undefined : sampleInput(secondScope);
    const cachedA = this.samples?.get(a.cacheKey);
    const cachedB = b === undefined ? undefined : this.samples?.get(b.cacheKey);
    const missing: PitchSampleInput[] = [];
    if (cachedA === undefined) missing.push(a);
    if (b !== undefined && cachedB === undefined) missing.push(b);

    let preparation: ReturnType<typeof preparePitchInputs> | undefined;
    const load = (input: PitchSampleInput, earlier?: Promise<PitchAnalysisSample>) => {
      const calculate = async () => {
        const { calibration, reference, releaseRows, rowsFor } = await (preparation ??=
          preparePitchInputs(snapshot, {
            referenceScope,
            referenceHash,
            pitcherId,
            scopes: missing.map(({ scope }) => scope),
            includeSeasonReleaseRows: true,
            computation: this.computation,
            calibrations: this.calibrations,
            references: this.references,
          }));
        // A failed comparison partner must not invalidate an independently usable cached sample.
        await earlier?.catch(() => undefined);
        return Value.Decode(
          PitchAnalysisSampleSchema,
          await this.computation.sample(
            input.scope.season,
            pitcherId,
            input.sourceHash,
            rowsFor(input.scope),
            reference,
            calibration,
            releaseRows,
          ),
        );
      };
      return this.samples === undefined
        ? calculate()
        : this.samples.load(input.cacheKey, calculate);
    };
    // Register both samples before yielding. They share preparation but submit calculations in
    // the same order as separate requests.
    const first = cachedA ?? load(a);
    const second = b === undefined ? first : (cachedB ?? load(b, first));
    if (missing.length === 0) await snapshot.release();
    void second.catch(() => undefined);
    const firstResult = structuredClone(await first);
    return {
      first: firstResult,
      second: b === undefined ? firstResult : structuredClone(await second),
    };
  }
}

function prepareRows(rows: readonly PitchRow[], calibration: PitchCalibrationSeason | null) {
  const lookup = calibration === null ? null : pitchCalibrationLookup(calibration);
  return rows.map((row) => {
    const adjustment = lookup?.(row) ?? { status: "insufficient_data" as const, coefficient: null };
    const trajectory =
      calibration === null
        ? row.supported && row.trackingId !== null
          ? alignPitchTrajectory(row)
          : null
        : middlePlaneTrajectory(row);
    return {
      row,
      status: adjustment.status,
      coefficient: adjustment.coefficient,
      trajectory:
        trajectory === null ? null : calibratePitchTrajectory(trajectory, adjustment.coefficient),
    };
  });
}

export function prepareReference(
  rows: readonly PitchRow[],
  calibration: PitchCalibrationSeason | null = null,
): PitchReference["reference"] {
  const fastballs = rows.filter((row) => row.pitchType === "직구");
  const referenceRows = prepareRows(fastballs, calibration);
  const referenceSamples = referenceRows.flatMap(({ trajectory }) =>
    trajectory === null ? [] : [trajectory],
  );
  const reference = averagePitchTrajectory(referenceSamples);
  const referenceDates = referenceRows
    .flatMap(({ row, trajectory }) => (trajectory === null ? [] : [row.gameDate]))
    .sort();
  const firstGameDate = referenceDates[0];
  const lastGameDate = referenceDates.at(-1);
  if (reference === null || firstGameDate === undefined || lastGameDate === undefined) return null;
  return {
    trajectory: reference,
    distribution: fitPitchReferenceDistribution(
      referenceSamples.map((sample) => {
        const point = comparePitchTrajectory(sample, reference);
        if (point === null) throw new Error("Invalid reference comparison");
        return point;
      }),
    ),
    summary: {
      pitchType: "직구",
      candidateCount: referenceRows.length,
      sampleCount: referenceSamples.length,
      excludedCount: referenceRows.length - referenceSamples.length,
      arrivalMs: reference.arrivalSeconds * 1000,
      speedKphAt50Feet: reference.speedKph,
      firstGameDate,
      lastGameDate,
    },
  };
}

export function analyzeRows(
  season: number,
  pitcherId: string,
  sourceHash: string,
  rows: readonly PitchRow[],
  baseline: PitchReference["reference"],
  calibration: PitchCalibrationSeason,
  releaseRows?: readonly PitchRow[],
): PitchAnalysisSample {
  const releaseGroups: PitchReleaseGroup[] | undefined =
    releaseRows === undefined ? undefined : estimatePitchReleases(releaseRows);
  const selected = prepareRows(rows, calibration);
  const points: PitchAnalysisSample["points"] = [];
  let invalidTrackingCount = 0;
  let missingTrackingCount = 0;
  for (const { row, trajectory, status, coefficient } of selected) {
    if (row.trackingId === null) {
      missingTrackingCount++;
      continue;
    }
    if (trajectory === null) {
      invalidTrackingCount++;
      continue;
    }
    if (baseline === null) continue;
    const comparison = comparePitchTrajectory(trajectory, baseline.trajectory);
    if (comparison === null) {
      invalidTrackingCount++;
      continue;
    }
    points.push({
      gameId: row.gameId,
      revision: row.revision,
      pitchId: row.pitchId,
      trackingId: row.trackingId,
      gameDate: row.gameDate,
      stadium: row.stadium,
      calibrationStatus: status,
      calibrationXcm:
        coefficient === null
          ? null
          : ((coefficient.lateralBias * baseline.trajectory.arrivalSeconds ** 2) / 2) * 30.48,
      calibrationZcm:
        coefficient === null
          ? null
          : ((coefficient.verticalBias * baseline.trajectory.arrivalSeconds ** 2) / 2) * 30.48,
      pitchType: row.pitchType,
      speedKph: row.speedKph,
      swing: row.swing,
      whiff: row.whiff,
      referenceBand: classifyPitchReference(comparison, baseline.distribution),
      ...comparison,
    });
  }
  return {
    modelVersion: PITCH_ANALYSIS_MODEL_VERSION,
    season,
    pitcherId,
    sourceHash,
    baseline: baseline?.summary ?? null,
    referenceSourceHash: calibration.sourceHash,
    profile: summarizePitchProfile(rows, points),
    referenceDistribution: baseline?.distribution ?? null,
    actualPitchCount: selected.length,
    missingTrackingCount,
    invalidTrackingCount,
    ...(releaseGroups === undefined ? {} : { releaseGroups }),
    calibration: {
      modelVersion: PITCH_CALIBRATION_PARAMETERS.modelVersion,
      profileHash: pitchCalibrationHash(calibration),
      windowDays: PITCH_CALIBRATION_PARAMETERS.windowDays,
      halfLifeDays: PITCH_CALIBRATION_PARAMETERS.halfLifeDays,
      plane: "middle",
      calibratedCount: points.filter((p) => p.calibrationStatus === "applied").length,
      uncalibratedCount: points.filter((p) => p.calibrationStatus !== "applied").length,
    },
    points,
  };
}

export type { PitchAnalysisRow } from "./pitch-trajectory-input.js";
