import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { Pool, PoolClient } from "pg";
import {
  canonicalStringify,
  resolveAnalysisScope,
  PitchQualityRowSchema,
  type PitchQualityRow,
  type PitchQualityModel,
  type AnalysisScopeQuery,
  type AnalysisScope,
} from "@kbo/contracts";
import {
  analysisSourceHash,
  analysisScopeParameters,
  ANALYSIS_GAME_WHERE,
} from "./analysis-scope.js";
import { pitchGeometrySql, pitchEligibilitySql } from "./analysis-pitch-input.js";
import { analysisVenueId } from "./analysis-venues.js";
import { pitchQualityHeightCache } from "./pitch-quality-height-cache.js";
const strict = { additionalProperties: false } as const,
  hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const PitchQualityManifestSchema = Type.Object(
  {
    version: Type.Literal(1),
    through: Type.Integer(),
    seasons: Type.Array(
      Type.Object({ season: Type.Integer(), sourceHash: hash, heightHash: hash }, strict),
    ),
    games: Type.Array(
      Type.Object({ gameId: Type.String(), revision: Type.Integer(), documentHash: hash }, strict),
    ),
  },
  strict,
);
export type PitchQualityManifest = Static<typeof PitchQualityManifestSchema>;
export const pitchQualitySourceHash = (value: unknown) =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");
const heightRowsValidator = TypeCompiler.Compile(
  Type.Array(
    Type.Object(
      {
        season: Type.Integer(),
        gameId: Type.String(),
        revision: Type.Integer(),
        playerId: Type.String(),
        height: Type.Union([Type.Integer(), Type.Null()]),
      },
      strict,
    ),
  ),
);
const qualityRowValidator = TypeCompiler.Compile(PitchQualityRowSchema);
async function manifest(
  client: PoolClient,
  through: number,
  pool?: Pool,
): Promise<PitchQualityManifest> {
  const seasons: PitchQualityManifest["seasons"] = [];
  const cache = pool === undefined ? null : await pitchQualityHeightCache(client, pool, through);
  let heightHashes = cache?.hashes ?? null;
  if (heightHashes === null) {
    // Read the effective heights once, in stable season/player order. Six independent scans of
    // the height view dominate every model request even though all six share the same snapshot.
    const heights = (
      await client.query<Record<string, unknown>>(
        `WITH selected_games AS MATERIALIZED (
         SELECT game_id,revision,season FROM analytics.current_analysis_games WHERE competition='regular' AND season BETWEEN 2020 AND $1
       ) SELECT r.season,h.game_id AS "gameId",h.revision,h.player_id AS "playerId",h.height_cm AS height
       FROM selected_games r CROSS JOIN LATERAL (
         SELECT h.* FROM analytics.game_batter_heights h WHERE h.game_id=r.game_id AND h.revision=r.revision OFFSET 0
       ) h ORDER BY r.season,h.game_id COLLATE "C",h.player_id COLLATE "C"`,
        [through + 1],
      )
    ).rows;
    if (!heightRowsValidator.Check(heights)) throw new Error("Invalid pitch quality height rows");
    const bySeason = new Map<number, Omit<(typeof heights)[number], "season">[]>();
    for (const { season, ...height } of heights) {
      const values = bySeason.get(season) ?? [];
      values.push(height);
      bySeason.set(season, values);
    }
    heightHashes = new Map();
    for (let season = 2020; season <= through + 1; season++)
      heightHashes.set(season, pitchQualitySourceHash(bySeason.get(season) ?? []));
    cache?.save(heightHashes);
  }
  for (let season = 2020; season <= through + 1; season++) {
    const scope = resolveAnalysisScope({ season }, "regular"),
      sourceHash = await analysisSourceHash(client, scope);
    seasons.push({
      season,
      sourceHash,
      heightHash: heightHashes.get(season) ?? pitchQualitySourceHash([]),
    });
  }
  const games = await client.query<Record<string, unknown>>(
    `SELECT game_id AS "gameId",revision,document_hash AS "documentHash" FROM analytics.current_analysis_games WHERE season BETWEEN 2020 AND $1 AND competition='regular' ORDER BY game_id COLLATE "C"`,
    [through + 1],
  );
  return Value.Decode(PitchQualityManifestSchema, {
    version: 1,
    through,
    seasons,
    games: games.rows,
  });
}
async function readRows(
  client: PoolClient,
  scope: AnalysisScope,
  pitcherId: string | null,
  actor: "pitcher" | "batter" = "pitcher",
): Promise<PitchQualityRow[]> {
  // Bound the view's height/tracking joins by selected games before expanding pitches. Without
  // this boundary, a monthly query can rescan the entire season once per underestimated game.
  const result = await client.query<Record<string, unknown>>(
    `WITH selected_games AS MATERIALIZED (
      SELECT r.* FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE} AND r.game_status='final'
    ) SELECT p.game_id AS "gameId",p.revision,p.pitch_id AS "pitchId",to_char(p.game_date,'YYYY-MM-DD') AS "gameDate",p.pitcher_id AS "pitcherId",p.batter_id AS "batterId",p.pitch_type AS "pitchType",p.stance,p.before_balls AS balls,p.before_strikes AS strikes,p.swing,p.whiff,p.called_strike AS "calledStrike",p.season,p.batter_height_cm AS "batterHeightCm",p.tracking_id AS "trackingId",p.in_zone AS "inZone",r.stadium,
    COALESCE(t.measurement_profile_id='naver_pts_v1',FALSE) AS supported,${pitchEligibilitySql} AS eligible,${pitchGeometrySql}
    FROM selected_games r CROSS JOIN LATERAL (
      SELECT p.* FROM analytics.current_pitches p
      WHERE p.game_id=r.game_id AND p.revision=r.revision AND p.actual AND ($5::text IS NULL OR p.${actor === "pitcher" ? "pitcher_id" : "batter_id"}=$5)
      OFFSET 0
    ) p
    LEFT JOIN workbench.tracking_observations t ON t.game_id=p.game_id AND t.revision=p.revision AND t.tracking_id=p.tracking_id
    LEFT JOIN baseball.plate_appearance_facts pa ON pa.game_id=p.game_id AND pa.revision=p.revision AND pa.start_event_id=p.plate_appearance_event_id
    ORDER BY p.game_id COLLATE "C",p.pitch_id COLLATE "C"`,
    [...analysisScopeParameters(scope), pitcherId],
  );
  return result.rows.map((r) => {
    const row = {
      ...r,
      parkId: analysisVenueId(scope.season, typeof r.stadium === "string" ? r.stadium : null),
    };
    if (!qualityRowValidator.Check(row)) throw new Error("Invalid pitch quality tracking row");
    return row;
  });
}
export { manifest as readPitchQualityManifest, readRows as readPitchQualityRows };
export class PitchQualityRepository {
  public constructor(private readonly pool: Pool) {}
  public async training(through: number, signal?: AbortSignal) {
    if (!Number.isInteger(through) || through < 2020 || through > 2024)
      throw new Error("훈련 마지막 시즌은 2020–2024여야 합니다.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const source = await manifest(client, through),
        rows: PitchQualityRow[] = [];
      for (let season = 2020; season <= through + 1; season++)
        for (let month = 1; month <= 12; month++) {
          signal?.throwIfAborted();
          const dateFrom = `${season}-${String(month).padStart(2, "0")}-01`,
            dateTo = new Date(Date.UTC(season, month, 0)).toISOString().slice(0, 10);
          const batch = await readRows(
            client,
            resolveAnalysisScope({ season, competition: "regular", dateFrom, dateTo }),
            null,
          );
          for (const row of batch) rows.push(row);
        }
      await client.query("COMMIT");
      return { rows, manifest: source };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  public async read(
    query: AnalysisScopeQuery,
    pitcherId: string,
    model: PitchQualityModel | null,
    modelHash: string | null,
  ) {
    const scope = resolveAnalysisScope(query, "regular"),
      client = await this.pool.connect();
    let rows: PitchQualityRow[], sourceHash: string;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      sourceHash = await analysisSourceHash(client, scope);
      if (scope.competition !== "regular") {
        model = null;
        modelHash = null;
      }
      if (
        model !== null &&
        (model.trainedThrough !== scope.season - 1 ||
          pitchQualitySourceHash(await manifest(client, model.trainedThrough, this.pool)) !==
            model.sourceHash)
      ) {
        model = null;
        modelHash = null;
      }
      rows = await readRows(client, scope, pitcherId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return {
      rows,
      scope,
      pitcherId,
      sourceHash: pitchQualitySourceHash({ sourceHash, rows }),
      model,
      modelHash,
    };
  }
}
