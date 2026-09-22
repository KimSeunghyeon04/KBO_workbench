import { resolveAnalysisScope, type AnalysisScopeOptions } from "@kbo/contracts";
import {
  ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
  canonicalStringify,
  DisciplineCatalogSchema,
  DisciplineRowSchema,
  PITCH_ANALYSIS_MODEL_VERSION,
  PITCH_REFERENCE_VERSION,
  type DisciplineCatalog,
  type DisciplineSnapshot,
  type DisciplineRow,
} from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { Pool } from "pg";
import type { PitchReferenceWorkspace } from "./pitch-reference-workspace.js";
import {
  prepareReference,
  readPitchRows,
  type PitchAnalysisComputation,
} from "./pitch-analysis-repository.js";

const rowValidator = TypeCompiler.Compile(DisciplineRowSchema);
const heightInputSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: Type.Integer(),
    playerId: Type.Union([Type.String(), Type.Null()]),
    heightCm: Type.Union([Type.Integer(), Type.Null()]),
  },
  { additionalProperties: false },
);
const columns = [
  "x0",
  "y0",
  "z0",
  "vx0",
  "vy0",
  "vz0",
  "ax",
  "ay",
  "az",
  "cross_plate_x",
  "cross_plate_y",
  "speed_kph",
]
  .map(
    (column) => `CASE WHEN p.${column} > '-Infinity'::float8 AND p.${column} < 'Infinity'::float8
    THEN p.${column} ELSE NULL END AS "${column.replace(/_([a-z])/gu, (_, c: string) => c.toUpperCase())}"`,
  )
  .join(",");

export class BatterDisciplineRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly references: Pick<PitchReferenceWorkspace, "getOrCreate">,
    private readonly computeReference: PitchAnalysisComputation["reference"] = async (rows) =>
      prepareReference(rows),
  ) {}

  public async catalog(
    season: number,
    options: AnalysisScopeOptions = {},
  ): Promise<DisciplineCatalog> {
    const scope = resolveAnalysisScope({ season, ...options });
    const result = await this.pool.query<Record<string, unknown>>(
      `
      SELECT batter_id AS "batterId", COALESCE(min(batter_name),batter_id) AS name,
        count(*)::integer AS pitches
      FROM analytics.current_pitches p JOIN analytics.current_analysis_games r USING(game_id,revision)
      WHERE p.actual AND ${ANALYSIS_GAME_WHERE} AND batter_id IS NOT NULL
      GROUP BY batter_id ORDER BY count(*) DESC, batter_id COLLATE "C"`,
      analysisScopeParameters(scope),
    );
    return Value.Decode(DisciplineCatalogSchema, { season, scope, batters: result.rows });
  }

  public async snapshot(
    season: number,
    knownHash?: string,
    options: AnalysisScopeOptions = {},
  ): Promise<DisciplineSnapshot> {
    const selectedScope = resolveAnalysisScope({ season, ...options });
    const scope = { ...selectedScope, dateFrom: null, dateTo: null };
    const client = await this.pool.connect();
    let released = false;
    const releaseSnapshot = async () => {
      if (!released) {
        await client.query("COMMIT");
        client.release();
        released = true;
      }
    };
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const referenceHash = await analysisSourceHash(client, scope);
      // Hash effective frozen heights: supplement imports leave sealed game hashes unchanged.
      const heights = await client.query<Record<string, unknown>>(
        `
        SELECT r.game_id AS "gameId",r.revision,h.player_id AS "playerId",h.height_cm AS "heightCm"
        FROM analytics.current_analysis_games r
        LEFT JOIN analytics.game_batter_heights h ON h.game_id=r.game_id AND h.revision=r.revision
        WHERE ${ANALYSIS_GAME_WHERE} ORDER BY r.game_id COLLATE "C",h.player_id COLLATE "C"`,
        analysisScopeParameters(scope),
      );
      const sourceHash = createHash("sha256")
        .update(
          canonicalStringify({
            referenceHash,
            zonePolicy: "frozen-player-height-2024-through-2024-2025-through-2026-v3",
            heights: Value.Decode(Type.Array(heightInputSchema), heights.rows),
          }),
        )
        .digest("hex");
      if (sourceHash === knownHash) {
        await client.query("COMMIT");
        return { season, sourceHash, reference: null, rows: null };
      }
      const result = await client.query<Record<string, unknown>>(
        `
        SELECT p.game_id AS "gameId", p.revision, p.pitch_id AS "pitchId",
          to_char(p.game_date,'YYYY-MM-DD') AS "gameDate", p.batter_id AS "batterId",
          p.pitch_type AS "pitchType", p.stance, p.before_balls AS balls, p.before_strikes AS strikes,
          p.season, p.batter_height_cm AS "batterHeightCm",
          p.swing, p.whiff, p.tracking_id AS "trackingId", p.in_zone AS "inZone",
          (p.pitch_call NOT IN ('hit_by_pitch','foul_bunt') AND
            NOT COALESCE(pa.is_bunt,FALSE) AND pa.result IS DISTINCT FROM 'intentional_walk') AS eligible,
          COALESCE(t.measurement_profile_id='naver_pts_v1',FALSE) AS supported, ${columns}
        FROM analytics.current_pitches p
        JOIN analytics.current_analysis_games r ON r.game_id=p.game_id AND r.revision=p.revision
        LEFT JOIN workbench.tracking_observations t
          ON t.game_id=p.game_id AND t.revision=p.revision AND t.tracking_id=p.tracking_id
        LEFT JOIN baseball.plate_appearance_facts pa
          ON pa.game_id=p.game_id AND pa.revision=p.revision
            AND pa.start_event_id=p.plate_appearance_event_id
        WHERE p.actual AND ${ANALYSIS_GAME_WHERE} AND p.batter_id IS NOT NULL
        ORDER BY p.game_id COLLATE "C", p.pitch_sequence`,
        analysisScopeParameters(scope),
      );
      const rows: DisciplineRow[] = [];
      for (const row of result.rows) {
        if (!rowValidator.Check(row)) throw new Error("Invalid discipline tracking row");
        rows.push(row);
        if (rows.length % 2000 === 0) await setImmediate();
      }
      const reference = await this.references.getOrCreate(
        {
          season,
          sourceHash: referenceHash,
          modelVersion: PITCH_ANALYSIS_MODEL_VERSION,
          referenceVersion: PITCH_REFERENCE_VERSION,
          calibrationHash: null,
        },
        async () => {
          const referenceRows = await readPitchRows(client, season, null, false, scope);
          await releaseSnapshot();
          return this.computeReference(referenceRows, null);
        },
      );
      await releaseSnapshot();
      return { season, sourceHash, reference, rows };
    } catch (error: unknown) {
      if (!released) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!released) client.release();
    }
  }
}
