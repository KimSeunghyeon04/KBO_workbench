import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisScopeQuerySchema,
  BaserunningTotalsSchema,
  BaserunningResponseSchema,
  resolveAnalysisScope,
  canonicalStringify,
  type AnalysisScopeQuery,
  type BaserunningTotals,
} from "@kbo/contracts";
import { baserunningOpportunities, summarizeBaserunningOpportunities } from "@kbo/game-core";
import {
  ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";
import { readAnalysisPlays } from "./analysis-plays.js";
export class BaserunningAnalysisRepository {
  public constructor(private readonly pool: Pool) {}
  public async read(input: AnalysisScopeQuery, playerId: string | null = null) {
    const query = Value.Decode(AnalysisScopeQuerySchema, input),
      scope = resolveAnalysisScope(query, "regular"),
      client = await this.pool.connect();
    let released = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const manifest = await analysisSourceHash(client, scope);
      const raw = await client.query<Record<string, unknown>>(
        `SELECT f.player_identity_key AS identity,f.player_id AS "playerId",COALESCE(min(s.name),f.player_id) AS name,t.team_id AS "teamId",min(t.team_name) AS "teamName",count(DISTINCT f.game_id)::integer AS games,
    sum(f.advances)::integer AS advances,sum(f.extra_bases_taken)::integer AS "extraBases",sum(f.runs)::integer AS runs,sum(f.stolen_bases)::integer AS "stolenBases",sum(f.caught_stealing)::integer AS "caughtStealing",sum(f.pickoffs)::integer AS pickoffs
    FROM baseball.baserunner_game_facts f JOIN analytics.current_analysis_games r USING(game_id,revision)
    JOIN workbench.game_team_snapshots t ON t.game_id=f.game_id AND t.revision=f.revision AND t.side=f.side
    LEFT JOIN LATERAL(SELECT min(player_name COLLATE "C") AS name FROM workbench.game_roster_snapshots s WHERE s.game_id=f.game_id AND s.revision=f.revision AND s.player_id=f.player_id AND s.side=f.side) s ON TRUE
    WHERE ${ANALYSIS_GAME_WHERE} GROUP BY f.player_identity_key,f.player_id,t.team_id ORDER BY f.player_identity_key COLLATE "C",t.team_id COLLATE "C"`,
        analysisScopeParameters(scope),
      );
      const teamRaw = await client.query<Record<string, unknown>>(
        `SELECT t.team_identity_key AS identity,NULL AS "playerId",min(t.team_name) AS name,t.team_id AS "teamId",min(t.team_name) AS "teamName",count(DISTINCT f.game_id)::integer AS games,
    sum(f.advances)::integer AS advances,sum(f.extra_bases_taken)::integer AS "extraBases",sum(f.runs)::integer AS runs,sum(f.stolen_bases)::integer AS "stolenBases",sum(f.caught_stealing)::integer AS "caughtStealing",sum(f.pickoffs)::integer AS pickoffs
    FROM baseball.baserunner_game_facts f JOIN analytics.current_analysis_games r USING(game_id,revision) JOIN workbench.game_team_snapshots t ON t.game_id=f.game_id AND t.revision=f.revision AND t.side=f.side
    WHERE ${ANALYSIS_GAME_WHERE} GROUP BY t.team_identity_key,t.team_id ORDER BY t.team_id COLLATE "C"`,
        analysisScopeParameters(scope),
      );
      const gameIds =
        playerId === null
          ? []
          : Value.Decode(
              Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: false })),
              (
                await client.query<Record<string, unknown>>(
                  `SELECT f.game_id AS id FROM baseball.baserunner_game_facts f JOIN analytics.current_analysis_games r USING(game_id,revision) WHERE ${ANALYSIS_GAME_WHERE} AND f.player_id=$5 GROUP BY f.game_id ORDER BY f.game_id COLLATE "C"`,
                  [...analysisScopeParameters(scope), playerId],
                )
              ).rows,
            ).map((r) => r.id);
      const plays = await readAnalysisPlays(client, gameIds);
      await client.query("COMMIT");
      client.release();
      released = true;
      const rate = (r: BaserunningTotals) => ({
        ...r,
        stealRate:
          r.stolenBases + r.caughtStealing === 0
            ? null
            : r.stolenBases / (r.stolenBases + r.caughtStealing),
      });
      const players = Value.Decode(Type.Array(BaserunningTotalsSchema), raw.rows).map(rate),
        teams = Value.Decode(Type.Array(BaserunningTotalsSchema), teamRaw.rows).map(rate);
      const opportunities = playerId === null ? [] : baserunningOpportunities(plays, playerId);
      const sourceHash = createHash("sha256")
        .update(canonicalStringify({ manifest, players, teams }))
        .digest("hex");
      return Value.Decode(BaserunningResponseSchema, {
        query,
        scope,
        sourceHash,
        playerId,
        players,
        teams,
        opportunities,
        opportunitySummary: summarizeBaserunningOpportunities(opportunities),
      });
    } catch (error) {
      if (!released) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!released) client.release();
    }
  }
}
