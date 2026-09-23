import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import { createHash } from "node:crypto";
import {
  PitcherChangesQuerySchema,
  PitcherChangesResponseSchema,
  resolveAnalysisScope,
  canonicalStringify,
  PITCH_CALIBRATION_PARAMETERS,
  PITCH_REFERENCE_VERSION,
  PITCH_ANALYSIS_MODEL_VERSION,
  type PitcherChangesQuery,
  type PitcherChangesResponse,
  type PitchChangeObservation,
  type PitchCalibrationSeason,
} from "@kbo/contracts";
import { analyzePitcherChanges } from "@kbo/game-core";
import {
  readPitchRows,
  prepareReference,
  analyzeRows,
  type PitchAnalysisComputation,
  type PitchAnalysisRow,
} from "./pitch-analysis-repository.js";
import { calculatePitchCalibration, pitchCalibrationHash } from "./pitch-calibration.js";
import { analysisSourceHash } from "./analysis-scope.js";
import type { PitchCalibrationWorkspace } from "./pitch-calibration-workspace.js";
import type { PitchReferenceWorkspace } from "./pitch-reference-workspace.js";
interface Options {
  computation?: PitchAnalysisComputation;
  calibrations?: Pick<PitchCalibrationWorkspace, "getOrCreate">;
  references?: Pick<PitchReferenceWorkspace, "getOrCreate">;
  cache?: {
    get(key: string): Promise<PitcherChangesResponse> | undefined;
    load(key: string, fn: () => Promise<PitcherChangesResponse>): Promise<PitcherChangesResponse>;
  };
}
export class PitcherChangesRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly options: Options = {},
  ) {}
  public async analyze(input: PitcherChangesQuery, pitcherId: string) {
    const query = Value.Decode(PitcherChangesQuerySchema, input),
      scope = resolveAnalysisScope(query, "regular"),
      referenceScope = { ...scope, dateFrom: null };
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const referenceHash = createHash("sha256")
          .update(
            canonicalStringify({
              sourceHash: await analysisSourceHash(client, referenceScope),
              finalOnly: true,
            }),
          )
          .digest("hex"),
        sourceHash = createHash("sha256")
          .update(canonicalStringify({ version: 1, referenceHash, scope, pitcherId }))
          .digest("hex");
      const cached = this.options.cache?.get(sourceHash);
      if (cached !== undefined) {
        await release();
        return structuredClone(await cached);
      }
      const calculate = async () => {
        let seasonRows: PitchAnalysisRow[] | undefined;
        let targetRows: PitchAnalysisRow[] | undefined;
        const compute = this.options.computation ?? {
          calibration: async (...args: Parameters<typeof calculatePitchCalibration>) =>
            calculatePitchCalibration(...args),
          reference: async (...args: Parameters<typeof prepareReference>) =>
            prepareReference(...args),
          sample: async (...args: Parameters<typeof analyzeRows>) => analyzeRows(...args),
        };
        const calibrationKey = {
          modelVersion: PITCH_CALIBRATION_PARAMETERS.modelVersion,
          season: query.season,
          sourceHash: referenceHash,
        };
        const calculateCalibration = async (previous: PitchCalibrationSeason | null) => {
          seasonRows = await readPitchRows(client, query.season, null, true, referenceScope, true);
          targetRows = seasonRows.filter(
            (r) =>
              r.pitcherId === pitcherId &&
              (scope.dateFrom === null || r.gameDate >= scope.dateFrom),
          );
          await release();
          return compute.calibration(query.season, referenceHash, seasonRows, previous);
        };
        const calibration =
          this.options.calibrations === undefined
            ? await calculateCalibration(null)
            : await this.options.calibrations.getOrCreate(calibrationKey, calculateCalibration);
        const referenceKey = {
          modelVersion: PITCH_ANALYSIS_MODEL_VERSION,
          referenceVersion: PITCH_REFERENCE_VERSION,
          season: query.season,
          sourceHash: referenceHash,
          calibrationHash: pitchCalibrationHash(calibration),
        } as const;
        const calculateReference = async () => {
          const referenceRows =
            seasonRows ??
            (await readPitchRows(client, query.season, null, false, referenceScope, true));
          targetRows ??= await readPitchRows(client, query.season, pitcherId, false, scope, true);
          await release();
          return compute.reference(referenceRows, calibration);
        };
        const reference =
          this.options.references === undefined
            ? await calculateReference()
            : await this.options.references.getOrCreate(referenceKey, calculateReference);
        const target =
          targetRows ?? (await readPitchRows(client, query.season, pitcherId, false, scope, true));
        await release();
        const sample = await compute.sample(
          query.season,
          pitcherId,
          sourceHash,
          target,
          reference,
          calibration,
        );
        const points = new Map(
          sample.points.map((p) => [JSON.stringify([p.gameId, p.revision, p.pitchId]), p]),
        );
        const observations: PitchChangeObservation[] = target.map((r) => {
          const p = points.get(JSON.stringify([r.gameId, r.revision, r.pitchId]));
          return {
            gameId: r.gameId,
            revision: r.revision,
            gameDate: r.gameDate,
            pitchId: r.pitchId,
            stadium: r.stadium,
            pitchType: r.pitchType,
            speedKph: r.speedKph,
            stance: r.stance,
            balls: r.balls,
            strikes: r.strikes,
            swing: r.swing,
            whiff: r.whiff,
            xCm: p?.xCm ?? null,
            zCm: p?.zCm ?? null,
            arrivalMs: p?.arrivalMs ?? null,
            calibrated: p?.calibrationStatus === "applied",
          };
        });
        return Value.Decode(
          PitcherChangesResponseSchema,
          analyzePitcherChanges(
            query,
            pitcherId,
            scope,
            sourceHash,
            observations,
            reference?.summary.lastGameDate ?? null,
          ),
        );
      };
      const result =
        this.options.cache === undefined
          ? await calculate()
          : await this.options.cache.load(sourceHash, calculate);
      await release();
      return structuredClone(result);
    });
  }
}
