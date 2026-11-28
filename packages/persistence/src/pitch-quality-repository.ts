import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { Pool, PoolClient } from "pg";
import {
  resolveAnalysisScope,
  PitchQualityRowSchema,
  type PitchQualityRow,
  type PitchQualityModel,
  type AnalysisScopeQuery,
  type AnalysisScope,
} from "@kbo/contracts";
import {
  analysisSourceHash,
  readRegularModelScopeHashes,
  type RegularModelScopeHash,
  analysisScopeParameters,
} from "./analysis-scope.js";
import { scopedTrackedPitchRowsSql } from "./analysis-pitch-input.js";
import { analysisVenueId } from "./analysis-venues.js";
import { pitchQualityHeightCache } from "./pitch-quality-height-cache.js";
import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import {
  PITCH_QUALITY_MANIFEST_VERSION,
  PitchQualityManifestSchema,
  pitchQualitySourceHash,
  type PitchQualityManifest,
} from "./pitch-quality-manifest.js";
export {
  PitchQualityManifestSchema,
  pitchQualitySourceHash,
  type PitchQualityManifest,
} from "./pitch-quality-manifest.js";
const strict = { additionalProperties: false } as const;
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
const trainingMonthsSchema = Type.Array(
  Type.Object({ season: Type.Integer(), month: Type.Integer({ minimum: 1, maximum: 12 }) }, strict),
);
async function manifest(
  client: PoolClient,
  through: number,
  pool?: Pool,
  sharedScopeHashes?: RegularModelScopeHash[],
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
  const scopeHashes = sharedScopeHashes ?? (await readRegularModelScopeHashes(client, through));
  for (const { season, hash: sourceHash } of scopeHashes) {
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
    version: PITCH_QUALITY_MANIFEST_VERSION,
    through,
    seasons,
    games: games.rows,
  });
}
async function readRows(
  client: PoolClient,
  scope: AnalysisScope,
  pitcherId: string | null,
  batterId?: string,
): Promise<PitchQualityRow[]> {
  const result = await client.query<Record<string, unknown>>(
    scopedTrackedPitchRowsSql({
      select: 'p.pitcher_id AS "pitcherId",p.stance,p.called_strike AS "calledStrike",r.stadium',
      pitchPredicate:
        batterId === undefined
          ? "$5::text IS NULL OR p.pitcher_id=$5"
          : "p.pitcher_id=$5 OR p.batter_id=$6",
      gameColumns: "r.game_id,r.revision,r.stadium",
      gamePredicate: "r.game_status='final'",
      orderByPitchId: true,
    }),
    [...analysisScopeParameters(scope), pitcherId, ...(batterId === undefined ? [] : [batterId])],
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
    if (!Number.isInteger(through) || through < 2020 || through > 2199)
      throw new Error("훈련 마지막 시즌은 2020–2199여야 합니다.");
    return withAnalysisSnapshot(this.pool, async (client) => {
      signal?.throwIfAborted();
      const source = await manifest(client, through),
        rows: PitchQualityRow[] = [];
      const months = await client.query<Record<string, unknown>>(
        `SELECT DISTINCT season,extract(month FROM game_date)::integer AS month
         FROM analytics.current_analysis_games
         WHERE competition='regular' AND game_status='final' AND season BETWEEN 2020 AND $1
           AND game_date>=make_date(season,1,1) AND game_date<make_date(season+1,1,1)
         ORDER BY season,month`,
        [through + 1],
      );
      signal?.throwIfAborted();
      for (const { season, month } of Value.Decode(trainingMonthsSchema, months.rows)) {
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
      return { rows, manifest: source };
    });
  }
  public async read(
    query: AnalysisScopeQuery,
    pitcherId: string,
    model: PitchQualityModel | null,
    modelHash: string | null,
  ) {
    const scope = resolveAnalysisScope(query, "regular");
    const { rows, sourceHash } = await withAnalysisSnapshot(this.pool, async (client) => {
      const sourceHash = await analysisSourceHash(client, scope);
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
      return { rows: await readRows(client, scope, pitcherId), sourceHash };
    });
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
