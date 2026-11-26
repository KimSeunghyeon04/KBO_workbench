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
export const ANALYSIS_SOURCE_COLUMNS = `r.game_id AS "gameId",r.revision,
  r.document_hash AS "documentHash",r.competition,r.competition_dataset_hash AS "datasetHash"`;
export const ANALYSIS_COMPETITION_DATASET =
  "SELECT dataset_hash AS hash FROM reference.current_competition_datasets WHERE season=$1";
const analysisSourcesSql = `SELECT ${ANALYSIS_SOURCE_COLUMNS}
    FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE}`;

export async function analysisSourceHash(
  client: PoolClient,
  scope: AnalysisScope,
): Promise<string> {
  const result = await client.query<Record<string, unknown>>(
    `${analysisSourcesSql} ORDER BY r.game_id COLLATE "C"`,
    analysisScopeParameters(scope),
  );
  const dataset = await client.query<Record<string, unknown>>(ANALYSIS_COMPETITION_DATASET, [
    scope.season,
  ]);
  return analysisManifestHash(scope, result.rows, dataset.rows);
}

/** Keep the v1 fingerprint for existing regular-season models across nonregular adoption. */
export async function regularModelScopeHash(client: PoolClient, season: number): Promise<string> {
  const scope = resolveAnalysisScope({ season, competition: "regular" });
  const { rows } = await client.query<Record<string, unknown>>(
    `${analysisSourcesSql} ORDER BY r.game_id COLLATE "C"`,
    analysisScopeParameters(scope),
  );
  const dataset = Value.Decode(
    datasetListSchema,
    (
      await client.query<Record<string, unknown>>(
        `SELECT regular_model_dataset_hash AS hash FROM reference.current_competition_datasets
       WHERE season=$1 AND regular_model_dataset_hash IS NOT NULL`,
        [season],
      )
    ).rows,
  );
  const anchor = dataset[0]?.hash ?? null;
  const sources = Value.Decode(sourceListSchema, rows).map((row) => ({
    ...row,
    datasetHash: anchor,
  }));
  return analysisManifestHash(scope, sources, dataset);
}

export async function recheckAnalysisSourceHash(
  pool: Pick<Pool, "query">,
  scope: AnalysisScope,
): Promise<string> {
  // Both inputs share the statement snapshot. Keep the dataset even when no game matches.
  const { rows } = await pool.query<Record<string, unknown>>(
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
  return analysisManifestHash(scope, sources, hash === null ? [] : [{ hash }]);
}

export function analysisManifestHash(scope: AnalysisScope, sources: unknown, dataset: unknown) {
  return createHash("sha256")
    .update(
      canonicalStringify({
        version: 1,
        scope,
        sources: Value.Decode(sourceListSchema, sources),
        dataset: Value.Decode(datasetListSchema, dataset),
      }),
    )
    .digest("hex");
}
