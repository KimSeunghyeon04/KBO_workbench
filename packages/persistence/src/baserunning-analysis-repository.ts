import { withAnalysisSnapshot } from "./analysis-snapshot.js";
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
  analysisScopeParameters,
  analysisSourceHash,
  scopedAnalysisGamesSql,
} from "./analysis-scope.js";
import { readAnalysisPlays } from "./analysis-plays.js";

const scopedBaserunnerFacts = `WITH candidates AS (${scopedAnalysisGamesSql()}),
  scoped_facts AS (
    SELECT f.* FROM candidates r JOIN baseball.baserunner_game_facts f USING(game_id,revision)
  )`;
const gameTeamJoin = `JOIN workbench.game_team_snapshots t
  ON t.game_id=f.game_id AND t.revision=f.revision AND t.side=f.side`;
const baserunningTotals = `count(DISTINCT f.game_id)::integer AS games,
  sum(f.advances)::integer AS advances,sum(f.extra_bases_taken)::integer AS "extraBases",
  sum(f.runs)::integer AS runs,sum(f.stolen_bases)::integer AS "stolenBases",
  sum(f.caught_stealing)::integer AS "caughtStealing",sum(f.pickoffs)::integer AS pickoffs`;

export class BaserunningAnalysisRepository {
  public constructor(private readonly pool: Pool) {}
  public async read(input: AnalysisScopeQuery, playerId: string | null = null) {
    const query = Value.Decode(AnalysisScopeQuerySchema, input),
      scope = resolveAnalysisScope(query, "regular");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const manifest = await analysisSourceHash(client, scope);
      const raw = await client.query<Record<string, unknown>>(
        `${scopedBaserunnerFacts}
    SELECT f.player_identity_key AS identity,f.player_id AS "playerId",COALESCE(min(s.name),f.player_id) AS name,
    t.team_id AS "teamId",min(t.team_name) AS "teamName",${baserunningTotals}
    FROM scoped_facts f ${gameTeamJoin}
    LEFT JOIN LATERAL(SELECT min(player_name COLLATE "C") AS name FROM workbench.game_roster_snapshots s WHERE s.game_id=f.game_id AND s.revision=f.revision AND s.player_id=f.player_id AND s.side=f.side) s ON TRUE
    GROUP BY f.player_identity_key,f.player_id,t.team_id ORDER BY f.player_identity_key COLLATE "C",t.team_id COLLATE "C"`,
        analysisScopeParameters(scope),
      );
      const teamRaw = await client.query<Record<string, unknown>>(
        `${scopedBaserunnerFacts}
    SELECT t.team_identity_key AS identity,NULL AS "playerId",min(t.team_name) AS name,
    t.team_id AS "teamId",min(t.team_name) AS "teamName",${baserunningTotals}
    FROM scoped_facts f ${gameTeamJoin}
    GROUP BY t.team_identity_key,t.team_id ORDER BY t.team_id COLLATE "C"`,
        analysisScopeParameters(scope),
      );
      const gameIds =
        playerId === null
          ? []
          : Value.Decode(
              Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: false })),
              (
                await client.query<Record<string, unknown>>(
                  `${scopedBaserunnerFacts}
                   SELECT f.game_id AS id FROM scoped_facts f WHERE f.player_id=$5
                   GROUP BY f.game_id ORDER BY f.game_id COLLATE "C"`,
                  [...analysisScopeParameters(scope), playerId],
                )
              ).rows,
            ).map((r) => r.id);
      const plays = await readAnalysisPlays(client, gameIds);
      await release();
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
    });
  }
}
