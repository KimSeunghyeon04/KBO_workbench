import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisScopeQuerySchema,
  WorkloadComparisonCellSchema,
  canonicalStringify,
  resolveAnalysisScope,
  type AnalysisScopeQuery,
} from "@kbo/contracts";
import { readWorkloadContext } from "./workload-context.js";

export class WorkloadComparisonRepository {
  public constructor(private readonly pool: Pool) {}
  public async read(input: AnalysisScopeQuery, pitcherId: string) {
    const query = Value.Decode(AnalysisScopeQuerySchema, input),
      scope = resolveAnalysisScope(query, "regular");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const { manifest, history, selected } = await readWorkloadContext(client, scope, pitcherId);
      // Rank actual pitches/encounters before any comparison eligibility filter.
      // Read the narrow typed facts, avoiding the wide trajectory/zone view entirely.
      const result = await client.query<Record<string, unknown>>(
        `WITH pitches AS MATERIALIZED (
          SELECT p.game_id,p.revision,p.pitch_id,p.pitch_sequence,p.plate_appearance_event_id,p.batter_id,
            p.pitch_type,p.before_balls,p.before_strikes,p.speed_kph,p.swing,p.whiff,p.half,
            (least(3,(row_number() OVER(PARTITION BY p.game_id,p.revision ORDER BY p.pitch_sequence)-1)/25))::integer AS bucket
          FROM baseball.pitch_facts p JOIN workbench.games g ON g.game_id=p.game_id AND g.current_revision=p.revision
          WHERE p.game_id=ANY($1::text[]) AND p.pitcher_id=$2 AND p.actual
        ), firsts AS MATERIALIZED (
          SELECT sides.*,CASE WHEN opener.pitcher_id IS NULL THEN 'unknown' WHEN opener.pitcher_id=$2 THEN 'first_pitcher' ELSE 'later_pitcher' END AS observed_role
          FROM (SELECT DISTINCT game_id,revision,half FROM pitches) sides
          LEFT JOIN LATERAL (
            SELECT f.pitcher_id FROM baseball.pitch_facts f
            WHERE f.game_id=sides.game_id AND f.revision=sides.revision AND f.half=sides.half AND f.actual
            ORDER BY f.pitch_sequence LIMIT 1
          ) opener ON TRUE
        ), encounters AS (
          SELECT game_id,revision,plate_appearance_event_id,batter_id,min(pitch_sequence) AS first_sequence
          FROM pitches WHERE plate_appearance_event_id IS NOT NULL AND batter_id IS NOT NULL
          GROUP BY game_id,revision,plate_appearance_event_id,batter_id
        ), meetings AS MATERIALIZED (
          SELECT *,least(3,row_number() OVER(PARTITION BY game_id,revision,batter_id ORDER BY first_sequence))::integer AS meeting
          FROM encounters
        ), numbered AS MATERIALIZED (
          SELECT p.*,m.meeting FROM pitches p
          LEFT JOIN meetings m USING(game_id,revision,plate_appearance_event_id,batter_id)
        )
        SELECT p.game_id AS "gameId",p.revision,firsts.observed_role AS "observedRole",p.bucket AS "pitchBucket",p.meeting,
          p.pitch_type AS "pitchType",t.stance,p.before_balls AS balls,p.before_strikes AS strikes,
          count(*)::integer AS pitches,
          count(p.speed_kph) FILTER(WHERE p.speed_kph>0 AND p.speed_kph<'Infinity'::float8)::integer AS "speedCount",
          coalesce(sum(p.speed_kph ORDER BY p.pitch_sequence) FILTER(WHERE p.speed_kph>0 AND p.speed_kph<'Infinity'::float8),0) AS "speedSum",
          count(*) FILTER(WHERE p.swing)::integer AS swings,count(*) FILTER(WHERE p.whiff)::integer AS whiffs
        FROM numbered p JOIN firsts USING(game_id,revision,half)
        LEFT JOIN baseball.pitch_tracking_links l ON l.game_id=p.game_id AND l.revision=p.revision AND l.pitch_id=p.pitch_id
        LEFT JOIN workbench.tracking_observations t ON t.game_id=l.game_id AND t.revision=l.revision AND t.tracking_id=l.tracking_id
        GROUP BY p.game_id,p.revision,firsts.observed_role,p.bucket,p.meeting,p.pitch_type,t.stance,p.before_balls,p.before_strikes
        ORDER BY p.game_id COLLATE "C",p.bucket,p.meeting,p.pitch_type COLLATE "C",t.stance COLLATE "C",p.before_balls,p.before_strikes`,
        [selected, pitcherId],
      );
      const cells = Value.Decode(Type.Array(WorkloadComparisonCellSchema), result.rows);
      await release();
      return {
        query,
        scope,
        pitcherId,
        history,
        cells,
        sourceHash: createHash("sha256")
          .update(canonicalStringify({ version: 1, manifest, history }))
          .digest("hex"),
      };
    });
  }
}
