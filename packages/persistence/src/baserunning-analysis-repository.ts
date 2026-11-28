import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisScopeQuerySchema,
  BaserunningTotalsSchema,
  BaserunningResponseSchema,
  resolveAnalysisScope,
  canonicalStringify,
  type AnalysisScope,
  type AnalysisScopeQuery,
  type BaserunningResponse,
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

type Summary = Pick<BaserunningResponse, "players" | "teams" | "sourceHash">;
interface SummaryCache {
  load(key: string, read: () => Promise<Summary>): Promise<Summary>;
}

async function readSummary(
  client: PoolClient,
  scope: AnalysisScope,
  manifest: string,
): Promise<Summary> {
  const { rows } = await client.query<Record<string, unknown>>(
    `${scopedBaserunnerFacts}, team_facts AS MATERIALIZED (
      SELECT f.*,t.team_id,t.team_name,t.team_identity_key FROM scoped_facts f ${gameTeamJoin}
    ), totals AS (
      SELECT 0 AS kind,f.player_identity_key AS identity,f.player_id AS "playerId",
        COALESCE(min(s.name),f.player_id) AS name,f.team_id AS "teamId",
        min(f.team_name) AS "teamName",${baserunningTotals}
      FROM team_facts f
      LEFT JOIN LATERAL (
        SELECT min(player_name COLLATE "C") AS name FROM workbench.game_roster_snapshots s
        WHERE s.game_id=f.game_id AND s.revision=f.revision AND s.player_id=f.player_id AND s.side=f.side
      ) s ON TRUE
      GROUP BY f.player_identity_key,f.player_id,f.team_id
      UNION ALL
      SELECT 1 AS kind,f.team_identity_key AS identity,NULL AS "playerId",min(f.team_name) AS name,
        f.team_id AS "teamId",min(f.team_name) AS "teamName",${baserunningTotals}
      FROM team_facts f GROUP BY f.team_identity_key,f.team_id
    ) SELECT * FROM totals
      ORDER BY kind,(CASE WHEN kind=0 THEN identity END) COLLATE "C","teamId" COLLATE "C"`,
    analysisScopeParameters(scope),
  );
  const players: BaserunningResponse["players"] = [],
    teams: BaserunningResponse["teams"] = [];
  const rate = (r: BaserunningTotals) => ({
    ...r,
    stealRate:
      r.stolenBases + r.caughtStealing === 0
        ? null
        : r.stolenBases / (r.stolenBases + r.caughtStealing),
  });
  for (const { kind, ...row } of rows) {
    const entry = rate(Value.Decode(BaserunningTotalsSchema, row));
    if (kind === 0) players.push(entry);
    else if (kind === 1) teams.push(entry);
    else throw new Error("Invalid baserunning summary group");
  }
  const sourceHash = createHash("sha256")
    .update(canonicalStringify({ manifest, players, teams }))
    .digest("hex");
  return { players, teams, sourceHash };
}

export class BaserunningAnalysisRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly summaries?: SummaryCache,
  ) {}
  public async read(input: AnalysisScopeQuery, playerId: string | null = null) {
    const query = Value.Decode(AnalysisScopeQuerySchema, input),
      scope = resolveAnalysisScope(query, "regular");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const manifest = await analysisSourceHash(client, scope);
      const summary = await (this.summaries?.load(manifest, () =>
        readSummary(client, scope, manifest),
      ) ?? readSummary(client, scope, manifest));
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
      const opportunities = playerId === null ? [] : baserunningOpportunities(plays, playerId);
      return Value.Decode(BaserunningResponseSchema, {
        query,
        scope,
        playerId,
        ...structuredClone(summary),
        opportunities,
        opportunitySummary: summarizeBaserunningOpportunities(opportunities),
      });
    });
  }
}
