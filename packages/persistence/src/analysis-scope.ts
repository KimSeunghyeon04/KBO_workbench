import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { PoolClient } from "pg";
import { canonicalStringify, type AnalysisScope } from "@kbo/contracts";

// Only game selection is shared. Each consumer owns its grain, eligibility and reference period.
// This fragment always uses alias r and parameters 1–4; feature parameters start at 5.
export const ANALYSIS_GAME_WHERE = `r.season=$1 AND ($2='all' OR r.competition=$2)
  AND ($3::date IS NULL OR r.game_date >= $3::date) AND ($4::date IS NULL OR r.game_date <= $4::date)`;
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

export async function analysisSourceHash(
  client: PoolClient,
  scope: AnalysisScope,
): Promise<string> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${ANALYSIS_SOURCE_COLUMNS}
    FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE} ORDER BY r.game_id COLLATE "C"`,
    analysisScopeParameters(scope),
  );
  const dataset = await client.query<Record<string, unknown>>(ANALYSIS_COMPETITION_DATASET, [
    scope.season,
  ]);
  return analysisManifestHash(scope, result.rows, dataset.rows);
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
