import {
  resolveAnalysisScope,
  canonicalStringify,
  PITCH_CALIBRATION_PARAMETERS,
  type AnalysisScope,
  type AnalysisScopeOptions,
  type AnalysisCoverageResponse,
} from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";
import {
  ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";
import { readPitchRows, type PitchAnalysisComputation } from "./pitch-analysis-repository.js";
import { calculatePitchCalibration } from "./pitch-calibration.js";
import type { PitchCalibrationWorkspace } from "./pitch-calibration-workspace.js";
import type { AnalysisCoverageWorkspace } from "./analysis-coverage-workspace.js";
import {
  COVERAGE_SUMMARY_VERSION,
  CoverageGameSchema,
  buildCoverageSeason,
  coverageResponse,
  coverageHash,
  type CoverageGame,
  type CoverageSeason,
} from "./analysis-coverage-summary.js";

interface Cache {
  get(key: string): Promise<CoverageSeason> | undefined;
  load(key: string, loader: () => Promise<CoverageSeason>): Promise<CoverageSeason>;
}
export interface CoverageInspection {
  sourceKey: string;
  scope: AnalysisScope;
  response: AnalysisCoverageResponse | null;
}
export class AnalysisCoverageRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly calibrations?: Pick<PitchCalibrationWorkspace, "getOrCreate">,
    private readonly calibrate: PitchAnalysisComputation["calibration"] = async (
      season,
      hash,
      rows,
      previous,
    ) => calculatePitchCalibration(season, hash, rows, previous),
    private readonly cache?: Cache,
    private readonly summaries?: Pick<AnalysisCoverageWorkspace, "read" | "write">,
  ) {}

  public inspect(season: number, options: AnalysisScopeOptions = {}): Promise<CoverageInspection> {
    return this.load(season, options, false);
  }

  /** Heavy preparation is called by the bounded server job, or explicitly by offline tools. */
  public async read(
    season: number,
    options: AnalysisScopeOptions = {},
    signal?: AbortSignal,
  ): Promise<AnalysisCoverageResponse> {
    const result = await this.load(season, options, true, signal);
    if (result.response === null) throw new Error("Coverage preparation produced no summary");
    return result.response;
  }

  private async load(
    season: number,
    options: AnalysisScopeOptions,
    prepare: boolean,
    signal?: AbortSignal,
  ): Promise<CoverageInspection> {
    signal?.throwIfAborted();
    const scope = resolveAnalysisScope({ season, ...options });
    const referenceScope = { ...scope, dateFrom: null, dateTo: null };
    const client = await this.pool.connect();
    let released = false;
    const release = async () => {
      if (!released) {
        await client.query("COMMIT");
        client.release();
        released = true;
      }
    };
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const referenceHash = await analysisSourceHash(client, referenceScope);
      const heights = Value.Decode(
        Type.Array(
          Type.Object(
            {
              gameId: Type.String(),
              revision: Type.Integer(),
              playerId: Type.String(),
              height: Type.Union([Type.Integer(), Type.Null()]),
            },
            { additionalProperties: false },
          ),
        ),
        (
          await client.query<Record<string, unknown>>(
            `WITH selected_games AS MATERIALIZED (
            SELECT r.game_id,r.revision FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE}
          ) SELECT h.game_id AS "gameId",h.revision,h.player_id AS "playerId",h.height_cm AS height
          FROM selected_games r CROSS JOIN LATERAL (
            SELECT h.* FROM analytics.game_batter_heights h WHERE h.game_id=r.game_id AND h.revision=r.revision OFFSET 0
          ) h ORDER BY h.game_id COLLATE "C",h.player_id COLLATE "C"`,
            analysisScopeParameters(referenceScope),
          )
        ).rows,
      );
      const sourceKey = coverageHash({
        version: COVERAGE_SUMMARY_VERSION,
        scope: referenceScope,
        referenceHash,
        heights,
        calibration: PITCH_CALIBRATION_PARAMETERS,
      });
      const result = (summary: CoverageSeason | null): CoverageInspection => ({
        sourceKey,
        scope,
        response: summary === null ? null : coverageResponse(summary, scope),
      });
      const cached = await (this.cache?.get(sourceKey) ?? this.summaries?.read(sourceKey));
      signal?.throwIfAborted();
      if (
        cached != null &&
        canonicalStringify(cached.scope) === canonicalStringify(referenceScope) &&
        cached.referenceHash === referenceHash &&
        cached.sourceKey === sourceKey
      ) {
        await release();
        if (this.cache !== undefined) await this.cache.load(sourceKey, async () => cached);
        return result(cached);
      }
      if (!prepare) {
        await release();
        return result(null);
      }
      const games = await readCoverageGames(client, referenceScope);
      signal?.throwIfAborted();
      const rows = await readPitchRows(client, season, null, true, referenceScope);
      await release();
      signal?.throwIfAborted();
      const loader = (previous: Parameters<PitchAnalysisComputation["calibration"]>[3]) =>
        this.calibrate(season, referenceHash, rows, previous, signal);
      const calibration =
        this.calibrations === undefined
          ? await loader(null)
          : await this.calibrations.getOrCreate(
              {
                season,
                sourceHash: referenceHash,
                modelVersion: PITCH_CALIBRATION_PARAMETERS.modelVersion,
              },
              loader,
            );
      signal?.throwIfAborted();
      const summary = await buildCoverageSeason(
        referenceScope,
        sourceKey,
        referenceHash,
        games,
        rows,
        calibration,
        signal,
      );
      await this.summaries?.write(summary, signal);
      signal?.throwIfAborted();
      if (this.cache !== undefined) await this.cache.load(sourceKey, async () => summary);
      return result(summary);
    } catch (error) {
      if (!released) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!released) client.release();
    }
  }
}

async function readCoverageGames(
  client: PoolClient,
  scope: AnalysisScope,
): Promise<CoverageGame[]> {
  // Bound the zone view by game and aggregate each grain before joining it.
  const result = await client.query<Record<string, unknown>>(
    `WITH selected_games AS MATERIALIZED (
      SELECT r.* FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE}
    ) SELECT r.game_id AS "gameId",r.revision,r.document_hash AS "documentHash",
      to_char(r.game_date,'YYYY-MM-DD') AS "gameDate",r.stadium,r.competition,
      p.actual AS "actualPitches",p.types AS "withPitchType",p.speeds AS "withSpeed",p.zones AS "zoneKnown",
      a.completed AS "completedPlateAppearances"
    FROM selected_games r CROSS JOIN LATERAL (
      SELECT count(*)::integer AS actual,count(pitch_type)::integer AS types,
        count(speed_kph)::integer AS speeds,count(in_zone)::integer AS zones
      FROM analytics.current_pitches p WHERE p.game_id=r.game_id AND p.revision=r.revision AND p.actual
    ) p CROSS JOIN LATERAL (
      SELECT count(*)::integer AS completed FROM baseball.plate_appearance_facts pa
      WHERE pa.game_id=r.game_id AND pa.revision=r.revision AND pa.completed AND pa.counts_as_plate_appearance
    ) a ORDER BY r.game_id COLLATE "C"`,
    analysisScopeParameters(scope),
  );
  return Value.Decode(Type.Array(CoverageGameSchema), result.rows);
}
