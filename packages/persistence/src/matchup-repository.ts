import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  MatchupQuerySchema,
  MatchupResponseSchema,
  MatchupConditionCountsSchema,
  resolveAnalysisScope,
  canonicalStringify,
  type MatchupQuery,
} from "@kbo/contracts";
import { analyzeMatchup } from "@kbo/game-core";
import {
  ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";
import { readPitchOutcomeRows } from "./pitch-outcomes.js";
import { pitchEligibilitySql, pitchTrackingJoinsSql } from "./analysis-pitch-input.js";
export class MatchupRepository {
  public constructor(private readonly pool: Pool) {}
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
    SELECT r.game_id,r.revision FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE}
   ), eligible AS (
    SELECT eligible.* FROM selected_games r CROSS JOIN LATERAL (
    SELECT p.pitch_type AS "pitchType",p.before_balls AS balls,p.before_strikes AS strikes,t.stance,floor(p.speed_kph/5)::integer AS "speedBand",p.pitcher_id,p.batter_id,p.swing,p.whiff,p.called_strike
    FROM baseball.pitch_facts p
    ${pitchTrackingJoinsSql}
    LEFT JOIN baseball.plate_appearance_facts pa ON pa.game_id=p.game_id AND pa.revision=p.revision AND pa.start_event_id=p.plate_appearance_event_id
    WHERE p.game_id=r.game_id AND p.revision=r.revision AND p.actual AND p.pitch_type IS NOT NULL AND p.speed_kph>0 AND p.speed_kph<500 AND t.stance IS NOT NULL
    AND ${pitchEligibilitySql}
    OFFSET 0) eligible
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
