import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  MatchupQuerySchema,
  MatchupOpponentsQuerySchema,
  MatchupOpponentsResponseSchema,
  DirectMatchupResponseSchema,
  MatchupResponseSchema,
  MatchupConditionCountsSchema,
  resolveAnalysisScope,
  canonicalStringify,
  type MatchupQuery,
  type MatchupOpponentsQuery,
} from "@kbo/contracts";
import { analyzeMatchup, summarizeDirectMatchup } from "@kbo/game-core";
import {
  analysisScopeParameters,
  analysisSourceHash,
  scopedAnalysisGamesSql,
} from "./analysis-scope.js";
import { readPitchOutcomeRows } from "./pitch-outcomes.js";
import {
  effectiveBattingSideSql,
  gameBattingProfileJoinSql,
  gamePitchRowsSql,
  pitchEligibilitySql,
  pitchPlateAppearanceJoinSql,
  pitchTrackingJoinsSql,
} from "./analysis-pitch-input.js";
export class MatchupRepository {
  public constructor(private readonly pool: Pool) {}
  public async opponents(input: MatchupOpponentsQuery) {
    const query = Value.Decode(MatchupOpponentsQuerySchema, input);
    const { role, playerId, ...scopeQuery } = query;
    const scope = resolveAnalysisScope(scopeQuery, "regular");
    const actor = role === "pitcher" ? "pitcher_id" : "batter_id";
    const opponent = role === "pitcher" ? "batter_id" : "pitcher_id";
    const { rows } = await withAnalysisSnapshot(this.pool, (client) =>
      client.query<Record<string, unknown>>(
        `WITH selected_games AS MATERIALIZED (
          ${scopedAnalysisGamesSql()}
        ), observations AS (
          SELECT p.${opponent} AS id, count(*) AS pitches, 0 AS pa
          FROM selected_games r JOIN baseball.pitch_facts p USING (game_id, revision)
          WHERE p.actual AND p.${actor}=$5 AND p.${opponent} IS NOT NULL
          GROUP BY p.${opponent}
          UNION ALL
          SELECT f.${opponent} AS id, 0 AS pitches, count(*) AS pa
          FROM selected_games r JOIN baseball.plate_appearance_facts f USING (game_id, revision)
          WHERE f.completed AND f.counts_as_plate_appearance
            AND f.${actor}=$5 AND f.${opponent} IS NOT NULL
          GROUP BY f.${opponent}
        ), direct AS (
          SELECT id, sum(pitches)::integer AS pitches, sum(pa)::integer AS pa
          FROM observations GROUP BY id
        ), season_rosters AS (
          SELECT s.player_id AS id, min(s.player_name COLLATE "C") AS name,
            array_agg(DISTINCT t.team_name COLLATE "C" ORDER BY t.team_name COLLATE "C") AS teams
          FROM analytics.current_analysis_games r
          JOIN workbench.game_roster_snapshots s USING (game_id, revision)
          JOIN workbench.game_team_snapshots t ON (t.game_id,t.revision,t.side)=(s.game_id,s.revision,s.side)
          WHERE r.season=$1 AND r.competition<>'allstar'
          GROUP BY s.player_id
        )
        SELECT COALESCE(r.id,d.id) AS id, COALESCE(r.name,d.id) AS name,
          COALESCE(r.teams,ARRAY[]::text[]) AS teams, COALESCE(d.pitches,0) AS pitches,
          COALESCE(d.pa,0) AS "plateAppearances"
        FROM season_rosters r FULL JOIN direct d USING (id)
        ORDER BY COALESCE(d.pa,0) DESC, COALESCE(d.pitches,0) DESC, COALESCE(r.id,d.id) COLLATE "C"`,
        [...analysisScopeParameters(scope), playerId],
      ),
    );
    return Value.Decode(MatchupOpponentsResponseSchema, { query, scope, players: rows });
  }
  public async direct(input: MatchupQuery) {
    const query = Value.Decode(MatchupQuerySchema, input);
    const { pitcherId, batterId, ...scopeQuery } = query;
    const scope = resolveAnalysisScope(scopeQuery, "regular");
    const { rows, plateAppearances } = await withAnalysisSnapshot(this.pool, (client) =>
      readPitchOutcomeRows(client, scope, batterId, "batter", pitcherId),
    );
    return Value.Decode(
      DirectMatchupResponseSchema,
      summarizeDirectMatchup(query, scope, rows, plateAppearances),
    );
  }
  public async analyze(input: MatchupQuery) {
    const query = Value.Decode(MatchupQuerySchema, input),
      { pitcherId, batterId, ...scopeQuery } = query,
      scope = resolveAnalysisScope(scopeQuery, "regular");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const manifest = await analysisSourceHash(client, scope);
      const { rows, plateAppearances } = await readPitchOutcomeRows(
        client,
        scope,
        batterId,
        "batter",
      );
      // Aggregate conditions in SQL instead of transporting the full league's tracking trajectories.
      const groups = await client.query<Record<string, unknown>>(
        `WITH selected_games AS MATERIALIZED (
    ${scopedAnalysisGamesSql()}
   ), eligible AS (
    SELECT eligible.* FROM selected_games r CROSS JOIN LATERAL (
      ${gamePitchRowsSql({
        source: "facts",
        select: `p.pitch_type AS "pitchType",p.before_balls AS balls,p.before_strikes AS strikes,
          ${effectiveBattingSideSql} AS stance,floor(p.speed_kph/5)::integer AS "speedBand",
          p.pitcher_id,p.batter_id,p.swing,p.whiff,p.called_strike`,
        joins: `${pitchTrackingJoinsSql()} ${gameBattingProfileJoinSql("p")} ${pitchPlateAppearanceJoinSql}`,
        pitchPredicate: `p.pitch_type IS NOT NULL AND p.speed_kph>0 AND p.speed_kph<500
          AND ${effectiveBattingSideSql} IS NOT NULL AND ${pitchEligibilitySql}`,
      })}
    ) eligible
   ), targets AS (SELECT DISTINCT "pitchType",balls,strikes,stance,"speedBand" FROM eligible WHERE pitcher_id=$5)
   SELECT 'pitcher' AS kind,"pitchType",balls,strikes,stance,"speedBand",count(*)::integer AS pitches,count(*) FILTER(WHERE swing)::integer AS swings,count(*) FILTER(WHERE whiff)::integer AS whiffs,count(*) FILTER(WHERE called_strike)::integer AS "calledStrikes"
   FROM eligible WHERE pitcher_id=$5 GROUP BY "pitchType",balls,strikes,stance,"speedBand"
   UNION ALL
   SELECT 'league' AS kind,e."pitchType",e.balls,e.strikes,e.stance,e."speedBand",count(*)::integer AS pitches,count(*) FILTER(WHERE e.swing)::integer AS swings,count(*) FILTER(WHERE e.whiff)::integer AS whiffs,count(*) FILTER(WHERE e.called_strike)::integer AS "calledStrikes"
   FROM eligible e JOIN targets t USING("pitchType",balls,strikes,stance,"speedBand") WHERE e.batter_id<>$6 GROUP BY e."pitchType",e.balls,e.strikes,e.stance,e."speedBand"
   ORDER BY kind,"pitchType",balls,strikes,stance,"speedBand"`,
        [...analysisScopeParameters(scope), pitcherId, batterId],
      );
      await release();
      const decoded = Value.Decode(
        Type.Array(
          Type.Object(
            {
              ...MatchupConditionCountsSchema.properties,
              kind: Type.Union([Type.Literal("pitcher"), Type.Literal("league")]),
            },
            { additionalProperties: false },
          ),
        ),
        groups.rows,
      );
      decoded.sort((a, b) => {
        const left = canonicalStringify(a),
          right = canonicalStringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      const target = decoded
          .filter((g) => g.kind === "pitcher")
          .map(({ kind, ...g }) => {
            void kind;
            return g;
          }),
        league = decoded
          .filter((g) => g.kind === "league")
          .map(({ kind, ...g }) => {
            void kind;
            return g;
          });
      const sourceHash = createHash("sha256")
        .update(
          canonicalStringify({ version: 1, manifest, rows, plateAppearances, target, league }),
        )
        .digest("hex");
      return Value.Decode(
        MatchupResponseSchema,
        analyzeMatchup(query, scope, sourceHash, rows, plateAppearances, target, league),
      );
    });
  }
}
