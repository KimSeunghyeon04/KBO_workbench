import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ParkEnvironmentRowSchema,
  ParkEnvironmentResponseSchema,
  canonicalStringify,
  resolveAnalysisScope,
  type AnalysisScope,
  type AnalysisScopeQuery,
  type ParkEnvironmentRow,
  type ParkEnvironmentModel,
} from "@kbo/contracts";
import { analyzeParkEnvironment } from "@kbo/game-core";
import {
  analysisSourceHash,
  ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
} from "./analysis-scope.js";
import { analysisVenueId } from "./analysis-venues.js";
export class ParkEnvironmentRepository {
  public constructor(private readonly pool: Pool) {}
  public async read(
    query: AnalysisScopeQuery,
    model: ParkEnvironmentModel | null = null,
    modelHash: string | null = null,
  ) {
    const scope = resolveAnalysisScope(query, "regular");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const hash = await analysisSourceHash(client, scope),
        rows = await readParkRows(client, scope);
      if (
        model !== null &&
        (model.trainedThrough !== scope.season - 1 ||
          model.sourceHash !== parkTrainingHash(await parkManifest(client, model.trainedThrough)))
      ) {
        model = null;
        modelHash = null;
      }
      await release();
      return Value.Decode(
        ParkEnvironmentResponseSchema,
        analyzeParkEnvironment(scope, hash, rows, model, modelHash),
      );
    });
  }
  public async training(through: number, signal?: AbortSignal) {
    if (!Number.isInteger(through) || through < 2020 || through > 2024)
      throw new Error("Invalid training season");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const manifest = await parkManifest(client, through),
        rows: ParkEnvironmentRow[] = [];
      for (let season = 2020; season <= through + 1; season++) {
        signal?.throwIfAborted();
        rows.push(
          ...(await readParkRows(client, resolveAnalysisScope({ season, competition: "regular" }))),
        );
      }
      await release();
      return { manifest, rows };
    });
  }
}
export async function parkManifest(client: PoolClient, through: number) {
  const seasons: { season: number; hash: string }[] = [];
  for (let season = 2020; season <= through + 1; season++)
    seasons.push({
      season,
      hash: await analysisSourceHash(
        client,
        resolveAnalysisScope({ season, competition: "regular" }),
      ),
    });
  const games = Value.Decode(
    Type.Array(
      Type.Object(
        { gameId: Type.String(), revision: Type.Integer(), documentHash: Type.String() },
        { additionalProperties: false },
      ),
    ),
    (
      await client.query<Record<string, unknown>>(
        `SELECT game_id AS "gameId",revision,document_hash AS "documentHash" FROM analytics.current_analysis_games WHERE competition='regular' AND season BETWEEN 2020 AND $1 ORDER BY game_id COLLATE "C"`,
        [through + 1],
      )
    ).rows,
  );
  return { version: 1 as const, through, seasons, games };
}
export const parkTrainingHash = (
  manifest: Awaited<ReturnType<ParkEnvironmentRepository["training"]>>["manifest"],
) => createHash("sha256").update(canonicalStringify(manifest)).digest("hex");
async function readParkRows(
  client: PoolClient,
  scope: AnalysisScope,
): Promise<ParkEnvironmentRow[]> {
  const result = await client.query<Record<string, unknown>>(
    `WITH games AS (
    SELECT r.*,(r.game_status='final' AND r.scheduled_innings=9 AND f.final_inning>=9 AND NOT EXISTS(SELECT 1 FROM workbench.relay_administrative a WHERE a.game_id=r.game_id AND a.revision=r.revision AND a.administrative_code IN('called_game','forfeit')) AND NOT EXISTS(SELECT 1 FROM baseball.plate_appearance_facts pa WHERE pa.game_id=r.game_id AND pa.revision=r.revision AND pa.termination_reason IN('called_game','forfeit'))) AS normal_end,f.final_away_score AS away_score,f.final_home_score AS home_score
    FROM analytics.current_analysis_games r JOIN baseball.game_final_states f USING(game_id,revision) WHERE ${ANALYSIS_GAME_WHERE} AND r.game_status='final'
  ), pas AS (
    SELECT p.game_id,p.revision,p.half,count(*) FILTER(WHERE p.counts_as_plate_appearance)::integer AS pa,count(*) FILTER(WHERE p.result='home_run' AND p.counts_as_plate_appearance)::integer AS hr
    FROM baseball.plate_appearance_facts p JOIN games g USING(game_id,revision) WHERE p.completed GROUP BY p.game_id,p.revision,p.half
  ), bounds AS MATERIALIZED (
    SELECT p.game_id,p.revision,p.inning,p.half,min(p.play_sequence) AS first_sequence,max(p.play_sequence) AS last_sequence
    FROM baseball.play_facts p JOIN games g USING(game_id,revision) WHERE p.applied GROUP BY p.game_id,p.revision,p.inning,p.half
  ), halves AS (
    SELECT s.game_id,s.revision,s.half,s.inning,(g.normal_end AND s.inning<=8 AND s.kind='half_inning_start' AND s.after_outs=0 AND s.after_base1_runner_id IS NULL AND s.after_base2_runner_id IS NULL AND s.after_base3_runner_id IS NULL AND e.after_outs=3 AND e.after_inning=s.inning AND e.after_half=s.half) AS complete,
    CASE WHEN s.half='top' THEN e.after_away_score-s.after_away_score ELSE e.after_home_score-s.after_home_score END AS runs
    FROM bounds b JOIN baseball.play_facts s ON s.game_id=b.game_id AND s.revision=b.revision AND s.play_sequence=b.first_sequence
    JOIN baseball.play_facts e ON e.game_id=b.game_id AND e.revision=b.revision AND e.play_sequence=b.last_sequence
    JOIN games g ON g.game_id=b.game_id AND g.revision=b.revision
  ), half_summary AS MATERIALIZED (SELECT game_id,revision,half,count(*) FILTER(WHERE complete)::integer AS complete_halves,COALESCE(sum(runs) FILTER(WHERE complete),0)::integer AS complete_runs,count(*) FILTER(WHERE NOT complete)::integer AS excluded_halves FROM halves GROUP BY game_id,revision,half)
  SELECT g.game_id AS "gameId",g.revision,g.season,to_char(g.game_date,'YYYY-MM-DD') AS "gameDate",g.document_hash AS "documentHash",g.stadium,t.team_id AS "teamId",o.team_id AS "opponentId",t.side,g.normal_end AS "normalEnd",COALESCE(p.pa,0) AS pa,COALESCE(p.hr,0) AS "homeRuns",CASE WHEN t.side='away' THEN g.away_score ELSE g.home_score END AS runs,COALESCE(h.complete_halves,0) AS "completeHalves",COALESCE(h.complete_runs,0) AS "completeRuns",COALESCE(h.excluded_halves,0) AS "excludedHalves"
  FROM games g JOIN workbench.game_team_snapshots t USING(game_id,revision) JOIN workbench.game_team_snapshots o ON o.game_id=g.game_id AND o.revision=g.revision AND o.side<>t.side
  LEFT JOIN pas p ON p.game_id=g.game_id AND p.revision=g.revision AND p.half=CASE WHEN t.side='away' THEN 'top' ELSE 'bottom' END
  LEFT JOIN half_summary h ON h.game_id=g.game_id AND h.revision=g.revision AND h.half=CASE WHEN t.side='away' THEN 'top' ELSE 'bottom' END
  ORDER BY g.game_id COLLATE "C",t.side COLLATE "C"`,
    analysisScopeParameters(scope),
  );
  return Value.Decode(
    Type.Array(ParkEnvironmentRowSchema),
    result.rows.map((r) => ({
      ...r,
      parkId:
        typeof r.season === "number" && (typeof r.stadium === "string" || r.stadium === null)
          ? analysisVenueId(r.season, r.stadium)
          : null,
    })),
  );
}
