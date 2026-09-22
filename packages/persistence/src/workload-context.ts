import type { PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WorkloadAppearanceSchema, type AnalysisScope } from "@kbo/contracts";
import {
  ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";

/** Both workload consumers use the same cross-season history and current-only selection. */
export async function readWorkloadContext(
  client: PoolClient,
  scope: AnalysisScope,
  pitcherId: string,
) {
  const manifest = await analysisSourceHash(client, scope);
  const raw = await client.query<Record<string, unknown>>(
    `SELECT f.game_id AS "gameId",f.revision,to_char(r.game_date,'YYYY-MM-DD') AS "gameDate",t.team_id AS "teamId",t.team_name AS "teamName",f.side,CASE WHEN starter.n=1 THEN CASE WHEN starter.id=f.player_id THEN 'starter' ELSE 'relief' END ELSE 'unknown' END AS role,f.pitches,f.batters_faced AS "battersFaced",f.outs_recorded AS outs
    FROM baseball.pitcher_game_facts f JOIN analytics.current_game_revisions r USING(game_id,revision) JOIN workbench.game_team_snapshots t ON t.game_id=f.game_id AND t.revision=f.revision AND t.side=f.side
    LEFT JOIN LATERAL(SELECT count(DISTINCT s.player_id) AS n,min(s.player_id COLLATE "C") AS id FROM workbench.game_roster_snapshots s JOIN workbench.game_roster_positions rp USING(game_id,revision,side,roster_index) WHERE s.game_id=f.game_id AND s.revision=f.revision AND s.side=f.side AND s.starter AND rp.position='P') starter ON TRUE
    WHERE f.player_id=$1 AND r.game_date<=$2::date ORDER BY r.game_date,f.game_id COLLATE "C"`,
    [pitcherId, scope.dateTo ?? `${scope.season}-12-31`],
  );
  const history = Value.Decode(Type.Array(WorkloadAppearanceSchema), raw.rows);
  const selected = Value.Decode(
    Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: false })),
    (
      await client.query<Record<string, unknown>>(
        `SELECT r.game_id AS id FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE} AND EXISTS(SELECT 1 FROM baseball.pitcher_game_facts f WHERE f.game_id=r.game_id AND f.revision=r.revision AND f.player_id=$5) ORDER BY r.game_id COLLATE "C"`,
        [...analysisScopeParameters(scope), pitcherId],
      )
    ).rows,
  ).map((r) => r.id);
  return { manifest, history, selected };
}
