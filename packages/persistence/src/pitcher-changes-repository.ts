import { withAnalysisReadSnapshot } from "./analysis-snapshot.js";
import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import { createHash } from "node:crypto";
import {
  PitcherChangesQuerySchema,
  PitcherChangesResponseSchema,
  resolveAnalysisScope,
  canonicalStringify,
  type PitcherChangesQuery,
  type PitcherChangesResponse,
  type PitchChangeObservation,
} from "@kbo/contracts";
import { analyzePitcherChanges } from "@kbo/game-core";
import {
  inlinePitchAnalysisComputation,
  type PitchAnalysisComputation,
} from "./pitch-analysis-repository.js";
import { preparePitchInputs } from "./pitch-trajectory-preparation.js";
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
    return withAnalysisReadSnapshot(this.pool, async (snapshot) => {
      const referenceHash = createHash("sha256")
          .update(
            canonicalStringify({
              sourceHash: await snapshot.sourceHash(referenceScope),
              finalOnly: true,
            }),
          )
          .digest("hex"),
        sourceHash = createHash("sha256")
          .update(canonicalStringify({ version: 1, referenceHash, scope, pitcherId }))
          .digest("hex");
      const cached = this.options.cache?.get(sourceHash);
      if (cached !== undefined) {
        await snapshot.release();
        return structuredClone(await cached);
      }
      const calculate = async () => {
        const compute = this.options.computation ?? inlinePitchAnalysisComputation;
        const { calibration, reference, rowsFor } = await preparePitchInputs(snapshot, {
          referenceScope,
          referenceHash,
          pitcherId,
          scopes: [scope],
          targetFinalOnly: true,
          computation: compute,
          calibrations: this.options.calibrations,
          references: this.options.references,
        });
        const target = rowsFor(scope);
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
      await snapshot.release();
      return structuredClone(result);
    });
  }
}
