import type { Pool } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  PitchSequenceQuerySchema,
  PitchSequenceRowSchema,
  PitchSequenceResponseSchema,
  resolveAnalysisScope,
  type PitchSequenceQuery,
} from "@kbo/contracts";
import { analyzePitchSequences } from "@kbo/game-core";
import {
  ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";
import { pitchGeometrySql, pitchEligibilitySql } from "./analysis-pitch-input.js";
export class PitchSequenceRepository {
  public constructor(private readonly pool: Pool) {}
  public async analyze(input: PitchSequenceQuery, pitcherId: string) {
    const query = Value.Decode(PitchSequenceQuerySchema, input),
      { season, balls, strikes, pitchType, stance, cohort, previousType, ...options } = query;
    void balls;
    void strikes;
    void pitchType;
    void stance;
    void cohort;
    void previousType;
    const scope = resolveAnalysisScope({ season, ...options }, "regular"),
      client = await this.pool.connect();
    let released = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const sourceHash = await analysisSourceHash(client, scope);
      const result = await client.query<Record<string, unknown>>(
        `WITH selected_games AS MATERIALIZED (
    SELECT r.* FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE}
    AND EXISTS(SELECT 1 FROM baseball.pitch_facts own WHERE own.game_id=r.game_id AND own.revision=r.revision AND own.pitcher_id=$5)
   ), ordered AS (
    SELECT p.*,r.stadium,e.event_sequence,lag(e.event_sequence) OVER(PARTITION BY p.game_id,p.revision ORDER BY p.pitch_sequence) AS previous_event_sequence
    FROM selected_games r CROSS JOIN LATERAL (
      SELECT p.* FROM analytics.current_pitches p WHERE p.game_id=r.game_id AND p.revision=r.revision OFFSET 0
    ) p
    JOIN workbench.relay_event_facts e ON e.game_id=p.game_id AND e.revision=p.revision AND e.event_id=p.pitch_id
   ) SELECT p.game_id AS "gameId",p.revision,to_char(p.game_date,'YYYY-MM-DD') AS "gameDate",p.stadium,p.pitch_id AS "pitchId",p.pitch_sequence AS "pitchSequence",p.plate_appearance_event_id AS "paId",
    p.pitcher_id AS "pitcherId",p.batter_id AS "batterId",p.pitch_type AS "pitchType",p.stance,p.before_balls AS balls,p.before_strikes AS strikes,p.actual,p.pitch_call AS "pitchCall",p.swing,p.whiff,p.called_strike AS "calledStrike",
    ${pitchEligibilitySql} AS eligible,
    EXISTS(SELECT 1 FROM workbench.relay_substitutions s WHERE s.game_id=p.game_id AND s.revision=p.revision AND s.event_sequence>p.previous_event_sequence AND s.event_sequence<p.event_sequence
     AND (s.incoming_player_id IN (p.pitcher_id,p.batter_id) OR s.outgoing_player_id IN (p.pitcher_id,p.batter_id))) AS "interveningChange",
    p.tracking_id AS "trackingId",COALESCE(t.measurement_profile_id='naver_pts_v1',FALSE) AS supported,${pitchGeometrySql}
    FROM ordered p LEFT JOIN workbench.tracking_observations t ON t.game_id=p.game_id AND t.revision=p.revision AND t.tracking_id=p.tracking_id
    LEFT JOIN baseball.plate_appearance_facts pa ON pa.game_id=p.game_id AND pa.revision=p.revision AND pa.start_event_id=p.plate_appearance_event_id
    ORDER BY p.game_id COLLATE "C",p.pitch_sequence`,
        [...analysisScopeParameters(scope), pitcherId],
      );
      await client.query("COMMIT");
      client.release();
      released = true;
      const rows = Value.Decode(Type.Array(PitchSequenceRowSchema), result.rows);
      return Value.Decode(
        PitchSequenceResponseSchema,
        analyzePitchSequences(query, pitcherId, scope, sourceHash, rows),
      );
    } catch (error) {
      if (!released) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!released) client.release();
    }
  }
}
