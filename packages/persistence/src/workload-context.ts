import type { PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  WorkloadAppearanceSchema,
  type AnalysisScope,
  type WorkloadAppearance,
} from "@kbo/contracts";
import { readAnalysisSource } from "./analysis-scope.js";

const appearanceIdentities = Type.Array(
  Type.Object(
    { gameId: Type.String(), revision: Type.Integer(), inHistory: Type.Boolean() },
    { additionalProperties: false },
  ),
);
export interface WorkloadHistoryCache {
  load(key: string, read: () => Promise<WorkloadAppearance[]>): Promise<WorkloadAppearance[]>;
}

/** Both workload consumers use all collected appearance history and the scoped target games. */
export async function readWorkloadContext(
  client: PoolClient,
  scope: AnalysisScope,
  pitcherId: string,
  cache?: WorkloadHistoryCache,
) {
  const { sources, manifest } = await readAnalysisSource(client, scope);
  const cutoff = scope.dateTo ?? `${scope.season}-12-31`;
  const identities = Value.Decode(
    appearanceIdentities,
    (
      await client.query<Record<string, unknown>>(
        `SELECT f.game_id AS "gameId",f.revision,r.game_date<=$2::date AS "inHistory"
      FROM baseball.pitcher_game_facts f JOIN analytics.current_game_revisions r USING(game_id,revision)
      WHERE f.player_id=$1 AND (r.game_date<=$2::date OR f.game_id=ANY($3::text[]))
      ORDER BY f.game_id COLLATE "C",f.revision`,
        [pitcherId, cutoff, sources.map(({ gameId }) => gameId)],
      )
    ).rows,
  );
  const revisions = new Map(identities.map(({ gameId, revision }) => [gameId, revision]));
  const selected = sources
    .filter(({ gameId, revision }) => revisions.get(gameId) === revision)
    .map(({ gameId }) => gameId);
  const historyRevisions = identities
    .filter((entry) => entry.inHistory)
    .map(({ gameId, revision }) => ({ game_id: gameId, revision }));
  const readHistory = () => readWorkloadHistory(client, pitcherId, historyRevisions);
  const history = await (cache?.load(JSON.stringify([pitcherId, historyRevisions]), readHistory) ??
    readHistory());
  return { manifest, history, selected };
}

async function readWorkloadHistory(
  client: PoolClient,
  pitcherId: string,
  revisions: { game_id: string; revision: number }[],
) {
  if (revisions.length === 0) return [];
  const raw = await client.query<Record<string, unknown>>(
    `SELECT f.game_id AS "gameId",f.revision,to_char(r.game_date,'YYYY-MM-DD') AS "gameDate",t.team_id AS "teamId",t.team_name AS "teamName",f.side,CASE WHEN starter.n=1 THEN CASE WHEN starter.id=f.player_id THEN 'starter' ELSE 'relief' END ELSE 'unknown' END AS role,f.pitches,f.batters_faced AS "battersFaced",f.outs_recorded AS outs
    FROM (SELECT DISTINCT game_id,revision FROM json_to_recordset($2::json) AS mapped(game_id text,revision integer)) selected
    CROSS JOIN LATERAL (
      SELECT f.* FROM baseball.pitcher_game_facts f
      WHERE f.game_id=selected.game_id AND f.revision=selected.revision AND f.player_id=$1 OFFSET 0
    ) f
    JOIN workbench.game_revisions r ON r.game_id=f.game_id AND r.revision=f.revision
    JOIN workbench.game_team_snapshots t ON t.game_id=f.game_id AND t.revision=f.revision AND t.side=f.side
    LEFT JOIN LATERAL(SELECT count(DISTINCT s.player_id) AS n,min(s.player_id COLLATE "C") AS id FROM workbench.game_roster_snapshots s JOIN workbench.game_roster_positions rp USING(game_id,revision,side,roster_index) WHERE s.game_id=f.game_id AND s.revision=f.revision AND s.side=f.side AND s.starter AND rp.position='P') starter ON TRUE
    ORDER BY r.game_date,f.game_id COLLATE "C"`,
    [pitcherId, JSON.stringify(revisions)],
  );
  return Value.Decode(Type.Array(WorkloadAppearanceSchema), raw.rows);
}
