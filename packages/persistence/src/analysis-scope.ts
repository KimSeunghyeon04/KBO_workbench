import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";
import { canonicalStringify, resolveAnalysisScope, type AnalysisScope } from "@kbo/contracts";

// Only game selection is shared. Each consumer owns its grain, eligibility and reference period.
// This fragment always uses alias r and parameters 1–4; feature parameters start at 5.
const competitionAndDates = `r.competition=$2
  AND ($3::date IS NULL OR r.game_date >= $3::date) AND ($4::date IS NULL OR r.game_date <= $4::date)`;
export const ANALYSIS_GAME_WHERE = `r.season=$1 AND ${competitionAndDates}`;
export function scopedAnalysisGamesSql(columns = "r.game_id,r.revision", predicate?: string) {
  return `SELECT ${columns} FROM analytics.current_analysis_games r
    WHERE ${ANALYSIS_GAME_WHERE}${predicate === undefined ? "" : ` AND (${predicate})`}`;
}
export const OPTIONAL_SEASON_ANALYSIS_GAME_WHERE = `($1::integer IS NULL OR r.season=$1) AND ${competitionAndDates}`;
export function analysisScopeParameters(scope: AnalysisScope) {
  return [scope.season, scope.competition, scope.dateFrom, scope.dateTo];
}
const sourceSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: Type.Integer(),
    documentHash: Type.String(),
    competition: Type.String(),
    datasetHash: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
const sourceListSchema = Type.Array(sourceSchema);
const datasetListSchema = Type.Array(
  Type.Object({ hash: Type.String() }, { additionalProperties: false }),
);
const regularModelScopeRowsSchema = Type.Array(
  Type.Object(
    {
      season: Type.Integer(),
      sources: sourceListSchema,
      anchor: Type.Union([Type.String(), Type.Null()]),
    },
    { additionalProperties: false },
  ),
);
export const ANALYSIS_SOURCE_COLUMNS = `r.game_id AS "gameId",r.revision,
  r.document_hash AS "documentHash",r.competition,r.competition_dataset_hash AS "datasetHash"`;
export const ANALYSIS_COMPETITION_DATASET =
  "SELECT dataset_hash AS hash FROM reference.current_competition_datasets WHERE season=$1";
const analysisSourcesSql = scopedAnalysisGamesSql(ANALYSIS_SOURCE_COLUMNS);

export async function analysisSourceHash(
  executor: Pick<Pool | PoolClient, "query">,
  scope: AnalysisScope,
): Promise<string> {
  return (await readAnalysisSource(executor, scope)).manifest;
}

export async function readAnalysisSource(
  executor: Pick<Pool | PoolClient, "query">,
  scope: AnalysisScope,
) {
  // Both inputs share the statement snapshot. Keep the dataset even when no game matches.
  const { rows } = await executor.query<Record<string, unknown>>(
    `SELECT dataset.hash, sources.*
    FROM (SELECT (${ANALYSIS_COMPETITION_DATASET}) AS hash) dataset
    LEFT JOIN (${analysisSourcesSql}) sources ON TRUE ORDER BY sources."gameId" COLLATE "C"`,
    analysisScopeParameters(scope),
  );
  const hash = rows[0]?.hash;
  const sources = rows
    .filter((source) => source.gameId !== null)
    .map(({ hash: datasetHash, ...source }) => {
      void datasetHash;
      return source;
    });
  return buildAnalysisManifest(scope, sources, hash === null ? [] : [{ hash }]);
}

export interface RegularModelScopeHash {
  readonly season: number;
  readonly hash: string;
}

export async function readRegularModelScopeHashes(
  client: PoolClient,
  through: number,
): Promise<RegularModelScopeHash[]> {
  const lastSeason = Math.floor(through + 1);
  if (lastSeason < 2020) return [];
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT s.season,g.sources,d.regular_model_dataset_hash AS anchor
    FROM generate_series(2020,$1::integer) s(season)
    CROSS JOIN LATERAL (
      SELECT COALESCE(json_agg(source ORDER BY source."gameId" COLLATE "C"),'[]'::json) AS sources
      FROM (
        SELECT ${ANALYSIS_SOURCE_COLUMNS} FROM analytics.current_analysis_games r
        WHERE r.season=s.season AND r.competition='regular'
      ) source
    ) g
    LEFT JOIN reference.current_competition_datasets d ON d.season=s.season
    ORDER BY s.season`,
    [lastSeason],
  );
  return Value.Decode(regularModelScopeRowsSchema, rows).map(({ season, sources, anchor }) => {
    const scope = resolveAnalysisScope({ season, competition: "regular" });
    // The v1 model fingerprint stays stable across nonregular dataset adoptions.
    const modelSources = sources.map((row) => ({ ...row, datasetHash: anchor }));
    const dataset = anchor === null ? [] : [{ hash: anchor }];
    return { season, hash: analysisManifestHash(scope, modelSources, dataset) };
  });
}

export function analysisManifestHash(scope: AnalysisScope, sources: unknown, dataset: unknown) {
  return buildAnalysisManifest(scope, sources, dataset).manifest;
}

function buildAnalysisManifest(scope: AnalysisScope, sources: unknown, dataset: unknown) {
  const parsedSources = Value.Decode(sourceListSchema, sources);
  const manifest = createHash("sha256")
    .update(
      canonicalStringify({
        version: 1,
        scope,
        sources: parsedSources,
        dataset: Value.Decode(datasetListSchema, dataset),
      }),
    )
    .digest("hex");
  return { sources: parsedSources, manifest };
}
