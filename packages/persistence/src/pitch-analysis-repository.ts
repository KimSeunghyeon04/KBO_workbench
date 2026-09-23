import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import {
  resolveAnalysisScope,
  inAnalysisPeriod,
  type AnalysisScope,
  type AnalysisScopeOptions,
} from "@kbo/contracts";
import { summarizePitchProfile } from "@kbo/game-core";
import {
  ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";
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
} from "@kbo/contracts";
import {
  alignPitchTrajectory,
  averagePitchTrajectory,
  comparePitchTrajectory,
  fitPitchReferenceDistribution,
  classifyPitchReference,
} from "@kbo/game-core";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { Pool, PoolClient } from "pg";
import { pitchTrackingJoinsSql } from "./analysis-pitch-input.js";

import type { PitchReferenceWorkspace } from "./pitch-reference-workspace.js";
import type { PitchCalibrationWorkspace } from "./pitch-calibration-workspace.js";
import {
  calculatePitchCalibration,
  calibratePitchTrajectory,
  middlePlaneTrajectory,
  pitchCalibrationHash,
  pitchCalibrationLookup,
} from "./pitch-calibration.js";

const numberOrNull = Type.Union([Type.Number(), Type.Null()]);
const textOrNull = Type.Union([Type.String(), Type.Null()]);
const rowSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: Type.Integer(),
    pitchId: Type.String(),
    gameDate: Type.String(),
    pitcherId: Type.String(),
    stadium: textOrNull,
    stance: textOrNull,
    balls: Type.Integer({ minimum: 0, maximum: 3 }),
    strikes: Type.Integer({ minimum: 0, maximum: 2 }),
    pitchType: textOrNull,
    speedKph: numberOrNull,
    swing: Type.Boolean(),
    whiff: Type.Boolean(),
    trackingId: textOrNull,
    supported: Type.Boolean(),
    x0: numberOrNull,
    y0: numberOrNull,
    z0: numberOrNull,
    vx0: numberOrNull,
    vy0: numberOrNull,
    vz0: numberOrNull,
    ax: numberOrNull,
    ay: numberOrNull,
    az: numberOrNull,
    crossPlateY: numberOrNull,
  },
  { additionalProperties: false },
);
type PitchRow = Static<typeof rowSchema>;
// A season contains hundreds of thousands of these rows. Compile the same strict
// boundary check once instead of interpreting its schema for every pitch.
const pitchRowValidator = TypeCompiler.Compile(rowSchema);
export type PitchAnalysisRow = PitchRow;
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
  ): Promise<PitchAnalysisSample>;
}
interface SampleCache {
  get(key: string): Promise<PitchAnalysisSample> | undefined;
  load(key: string, calculate: () => Promise<PitchAnalysisSample>): Promise<PitchAnalysisSample>;
}

const catalogRowSchema = Type.Object(
  {
    pitcherId: Type.String(),
    name: Type.String(),
    pitches: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const trajectoryColumns = ["x0", "y0", "z0", "vx0", "vy0", "vz0", "ax", "ay", "az", "cross_plate_y"]
  .map(
    (column) =>
      `CASE WHEN t.${column} > '-Infinity'::double precision AND t.${column} < 'Infinity'::double precision THEN t.${column} ELSE NULL END AS "${column === "cross_plate_y" ? "crossPlateY" : column}"`,
  )
  .join(",");

export class PitchAnalysisRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly references?: Pick<PitchReferenceWorkspace, "getOrCreate">,
    private readonly computation: PitchAnalysisComputation = {
      calibration: async (season, hash, rows, previous) =>
        calculatePitchCalibration(season, hash, rows, previous),
      reference: async (...args) => prepareReference(...args),
      sample: async (...args) => analyzeRows(...args),
    },
    private readonly samples?: SampleCache,
    private readonly calibrations?: Pick<PitchCalibrationWorkspace, "getOrCreate">,
  ) {}

  public async catalog(
    season: number,
    options: AnalysisScopeOptions = {},
  ): Promise<PitchAnalysisCatalog> {
    const scope = resolveAnalysisScope({ season, ...options });
    const result = await this.pool.query<Record<string, unknown>>(
      `
      SELECT pitcher_id AS "pitcherId", min(pitcher_name) AS name, count(*)::integer AS pitches
      FROM analytics.current_pitches p JOIN analytics.current_analysis_games r USING(game_id,revision) WHERE p.actual AND ${ANALYSIS_GAME_WHERE}
      GROUP BY pitcher_id ORDER BY count(*) DESC, pitcher_id COLLATE "C"
    `,
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

  public async analyze(
    season: number,
    pitcherId: string,
    options: AnalysisScopeOptions = {},
  ): Promise<PitchAnalysisSample> {
    const scope = resolveAnalysisScope({ season, ...options });
    const referenceScope = { ...scope, dateFrom: null, dateTo: null };
    return withAnalysisSnapshot(this.pool, async (client, releaseSnapshot) => {
      const referenceHash = await analysisSourceHash(client, referenceScope);
      const sourceHash = createHash("sha256")
        .update(canonicalStringify({ referenceHash, scope }))
        .digest("hex");
      const sampleKey = {
        modelVersion: PITCH_ANALYSIS_MODEL_VERSION,
        referenceVersion: PITCH_REFERENCE_VERSION,
        season,
        sourceHash,
        calibrationVersion: PITCH_CALIBRATION_PARAMETERS.modelVersion,
      } as const;
      const cacheKey = canonicalStringify({ ...sampleKey, pitcherId });
      const cached = this.samples?.get(cacheKey);
      if (cached !== undefined) {
        await releaseSnapshot();
        return structuredClone(await cached);
      }
      const calculateSample = async () => {
        let seasonRows: PitchRow[] | undefined;
        let targetRows: PitchRow[] | undefined;
        const calculateCalibration = async (previous: PitchCalibrationSeason | null) => {
          seasonRows = await readPitchRows(client, season, null, true, referenceScope);
          targetRows = seasonRows.filter(
            (r) => r.pitcherId === pitcherId && inAnalysisPeriod(r.gameDate, scope),
          );
          await releaseSnapshot();
          return this.computation.calibration(season, referenceHash, seasonRows, previous);
        };
        const calibration =
          this.calibrations === undefined
            ? await calculateCalibration(null)
            : await this.calibrations.getOrCreate(
                {
                  modelVersion: PITCH_CALIBRATION_PARAMETERS.modelVersion,
                  season,
                  sourceHash: referenceHash,
                },
                calculateCalibration,
              );
        const key = {
          modelVersion: PITCH_ANALYSIS_MODEL_VERSION,
          referenceVersion: PITCH_REFERENCE_VERSION,
          season,
          sourceHash: referenceHash,
          calibrationHash: pitchCalibrationHash(calibration),
        } as const;
        const calculateReference = async () => {
          const referenceRows =
            seasonRows?.filter((r) => r.pitchType === "직구") ??
            (await readPitchRows(client, season, null, false, referenceScope));
          targetRows ??= await readPitchRows(client, season, pitcherId, false, scope);
          await releaseSnapshot();
          return this.computation.reference(referenceRows, calibration);
        };
        const reference =
          this.references === undefined
            ? await calculateReference()
            : await this.references.getOrCreate(key, calculateReference);
        const rows = targetRows ?? (await readPitchRows(client, season, pitcherId, false, scope));
        await releaseSnapshot();
        return Value.Decode(
          PitchAnalysisSampleSchema,
          await this.computation.sample(
            season,
            pitcherId,
            sourceHash,
            rows,
            reference,
            calibration,
          ),
        );
      };
      // The key is checked in a fresh DB snapshot even on a cache hit. The loader reads
      // rows from that same snapshot, so a concurrent seal cannot mix revisions.
      const sample =
        this.samples === undefined
          ? await calculateSample()
          : await this.samples.load(cacheKey, calculateSample);
      await releaseSnapshot();
      return structuredClone(sample);
    });
  }
}

export async function readPitchRows(
  client: PoolClient,
  season: number,
  pitcherId: string | null,
  allPitchTypes = false,
  scope: AnalysisScope = resolveAnalysisScope({ season }),
  finalOnly = false,
): Promise<PitchRow[]> {
  const result = await client.query<Record<string, unknown>>(
    `
        WITH selected_games AS MATERIALIZED (
          SELECT r.game_id,r.revision,r.game_date,r.stadium FROM analytics.current_analysis_games r
          WHERE ${finalOnly ? "r.game_status='final' AND" : ""} ${ANALYSIS_GAME_WHERE}
        ) SELECT pitch.* FROM selected_games r CROSS JOIN LATERAL (
        SELECT p.game_id AS "gameId", p.revision, p.pitch_id AS "pitchId", p.pitch_sequence AS "pitchSequence",
          to_char(r.game_date,'YYYY-MM-DD') AS "gameDate", p.pitcher_id AS "pitcherId",
          p.pitch_type AS "pitchType", p.speed_kph AS "speedKph", t.tracking_id AS "trackingId",
          r.stadium, t.stance, p.before_balls AS balls, p.before_strikes AS strikes,
          p.swing, p.whiff,
          COALESCE(t.measurement_profile_id='naver_pts_v1',FALSE) AS supported,
          ${trajectoryColumns}
        FROM baseball.pitch_facts p
        ${pitchTrackingJoinsSql}
        WHERE p.game_id=r.game_id AND p.revision=r.revision AND p.actual AND ($5::text IS NULL OR p.pitcher_id=$5) AND ${allPitchTypes || pitcherId !== null ? "TRUE" : "p.pitch_type='직구'"}
        OFFSET 0) pitch
        ORDER BY pitch."gameId" COLLATE "C", pitch."pitchSequence"
      `,
    [...analysisScopeParameters(scope), pitcherId],
  );
  return result.rows.map(({ pitchSequence, ...row }) => {
    void pitchSequence;
    if (!pitchRowValidator.Check(row)) throw new Error("Invalid pitch analysis tracking row");
    return row;
  });
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
      ...adjustment,
      trajectory:
        trajectory === null ? null : calibratePitchTrajectory(trajectory, adjustment.coefficient),
    };
  });
}

export function prepareReference(
  rows: readonly PitchRow[],
  calibration: PitchCalibrationSeason | null = null,
): PitchReference["reference"] {
  const referenceRows = prepareRows(
    rows.filter((row) => row.pitchType === "직구"),
    calibration,
  );
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
): PitchAnalysisSample {
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
