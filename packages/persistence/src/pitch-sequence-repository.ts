import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import type { Pool } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createHash } from "node:crypto";
import {
  PitchSequenceQuerySchema,
  PitchSequenceRowSchema,
  PitchSequenceResponseSchema,
  resolveAnalysisScope,
  canonicalStringify,
  type PitchReleaseGroup,
  type PitchSequenceQuery,
} from "@kbo/contracts";
import { analyzePitchSequences, estimatePitchReleases } from "@kbo/game-core";
import {
  pitchReferenceScope,
  readSeasonPitchReleaseRows,
  type PitchAnalysisRow,
} from "./pitch-analysis-repository.js";
import {
  analysisScopeParameters,
  analysisSourceHash,
  scopedAnalysisGamesSql,
} from "./analysis-scope.js";
import {
  gamePitchRowsSql,
  pitchGeometrySql,
  pitchEligibilitySql,
  pitchPlateAppearanceJoinSql,
  pitchViewObservationJoinSql,
} from "./analysis-pitch-input.js";
export class PitchSequenceRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly estimateReleases: (
      rows: readonly PitchAnalysisRow[],
    ) => Promise<PitchReleaseGroup[]> = async (rows) => estimatePitchReleases(rows),
  ) {}
  public async analyze(input: PitchSequenceQuery, pitcherId: string) {
    const query = Value.Decode(PitchSequenceQuerySchema, input),
      { season, balls, strikes, pitchType, stance, cohort, previousType, ...options } = query;
    void balls;
    void strikes;
    void pitchType;
    void stance;
    void cohort;
    void previousType;
    const scope = resolveAnalysisScope({ season, ...options }, "regular");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const sampleHash = await analysisSourceHash(client, scope);
      const releaseScope = pitchReferenceScope(scope);
      const releaseHash =
        scope.dateFrom === null && scope.dateTo === null
          ? sampleHash
          : await analysisSourceHash(client, releaseScope);
      const sourceHash = createHash("sha256")
        .update(canonicalStringify({ sampleHash, releaseHash, timing: "50ft-v1" }))
        .digest("hex");
      const result = await client.query<Record<string, unknown>>(
        `WITH selected_games AS MATERIALIZED (
    ${scopedAnalysisGamesSql(
      "r.game_id,r.revision,r.stadium",
      "EXISTS(SELECT 1 FROM baseball.pitch_facts own WHERE own.game_id=r.game_id AND own.revision=r.revision AND own.pitcher_id=$5)",
    )}
   ), ordered AS (
    SELECT p.*,r.stadium,e.event_sequence,lag(e.event_sequence) OVER(PARTITION BY p.game_id,p.revision ORDER BY p.pitch_sequence) AS previous_event_sequence
    FROM selected_games r CROSS JOIN LATERAL (
      ${gamePitchRowsSql({ includeNonActual: true })}
    ) p
    JOIN workbench.relay_event_facts e ON e.game_id=p.game_id AND e.revision=p.revision AND e.event_id=p.pitch_id
   ) SELECT p.game_id AS "gameId",p.revision,to_char(p.game_date,'YYYY-MM-DD') AS "gameDate",p.stadium,p.pitch_id AS "pitchId",p.pitch_sequence AS "pitchSequence",p.plate_appearance_event_id AS "paId",
    p.pitcher_id AS "pitcherId",p.batter_id AS "batterId",p.pitch_type AS "pitchType",p.stance,p.before_balls AS balls,p.before_strikes AS strikes,p.actual,p.pitch_call AS "pitchCall",p.swing,p.whiff,p.called_strike AS "calledStrike",
    ${pitchEligibilitySql} AS eligible,
    EXISTS(SELECT 1 FROM workbench.relay_substitutions s WHERE s.game_id=p.game_id AND s.revision=p.revision AND s.event_sequence>p.previous_event_sequence AND s.event_sequence<p.event_sequence
     AND (s.incoming_player_id IN (p.pitcher_id,p.batter_id) OR s.outgoing_player_id IN (p.pitcher_id,p.batter_id))) AS "interveningChange",
    p.tracking_id AS "trackingId",COALESCE(t.measurement_profile_id='naver_pts_v1',FALSE) AS supported,${pitchGeometrySql}
    FROM ordered p ${pitchViewObservationJoinSql}
    ${pitchPlateAppearanceJoinSql}
    ORDER BY p.game_id COLLATE "C",p.pitch_sequence`,
        [...analysisScopeParameters(scope), pitcherId],
      );
      const releaseRows = await readSeasonPitchReleaseRows(client, releaseScope, pitcherId);
      await release();
      const rows = Value.Decode(Type.Array(PitchSequenceRowSchema), result.rows);
      const groups = await this.estimateReleases(releaseRows);
      return Value.Decode(
        PitchSequenceResponseSchema,
        analyzePitchSequences(query, pitcherId, scope, sourceHash, rows, groups),
      );
    });
  }
}
