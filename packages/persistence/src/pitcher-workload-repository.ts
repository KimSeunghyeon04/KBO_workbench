import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisScopeQuerySchema,
  WorkloadEncounterSchema,
  WorkloadPitchBucketSchema,
  PitcherWorkloadResponseSchema,
  resolveAnalysisScope,
  canonicalStringify,
  type AnalysisScopeQuery,
} from "@kbo/contracts";
import { analyzePitcherWorkload } from "@kbo/game-core";
import { readWorkloadContext } from "./workload-context.js";
import { readAnalysisPlays } from "./analysis-plays.js";
export class PitcherWorkloadRepository {
  public constructor(private readonly pool: Pool) {}
  public async analyze(input: AnalysisScopeQuery, pitcherId: string) {
    const query = Value.Decode(AnalysisScopeQuerySchema, input),
      scope = resolveAnalysisScope(query, "regular");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const { manifest, history, selected } = await readWorkloadContext(client, scope, pitcherId);
      const encounters = Value.Decode(
        Type.Array(WorkloadEncounterSchema),
        (
          await client.query<Record<string, unknown>>(
            `SELECT p.game_id AS "gameId",p.revision,p.plate_appearance_event_id AS "paId",p.batter_id AS "batterId",min(p.pitch_sequence)::integer AS "firstSequence",count(*)::integer AS pitches
    FROM baseball.pitch_facts p JOIN workbench.games g ON g.game_id=p.game_id AND g.current_revision=p.revision WHERE p.game_id=ANY($1::text[]) AND p.pitcher_id=$2 AND p.actual AND p.plate_appearance_event_id IS NOT NULL AND p.batter_id IS NOT NULL GROUP BY p.game_id,p.revision,p.plate_appearance_event_id,p.batter_id ORDER BY p.game_id COLLATE "C",min(p.pitch_sequence)`,
            [selected, pitcherId],
          )
        ).rows,
      );
      const buckets = Value.Decode(
        Type.Array(WorkloadPitchBucketSchema),
        (
          await client.query<Record<string, unknown>>(
            `WITH ordered AS (SELECT p.*,tracking.stance,row_number() OVER(PARTITION BY p.game_id,p.revision ORDER BY p.pitch_sequence) AS ordinal FROM baseball.pitch_facts p JOIN workbench.games g ON g.game_id=p.game_id AND g.current_revision=p.revision LEFT JOIN baseball.pitch_tracking_links links ON links.game_id=p.game_id AND links.revision=p.revision AND links.pitch_id=p.pitch_id LEFT JOIN workbench.tracking_observations tracking ON tracking.game_id=links.game_id AND tracking.revision=links.revision AND tracking.tracking_id=links.tracking_id WHERE p.game_id=ANY($1::text[]) AND p.pitcher_id=$2 AND p.actual),grouped AS (SELECT *,CASE WHEN ordinal<=25 THEN '1–25' WHEN ordinal<=50 THEN '26–50' WHEN ordinal<=75 THEN '51–75' ELSE '76+' END AS bucket FROM ordered)
    SELECT game_id AS "gameId",revision,bucket,pitch_type AS "pitchType",stance,count(*)::integer AS pitches,count(speed_kph) FILTER(WHERE speed_kph>0 AND speed_kph<'Infinity'::float8)::integer AS "speedCount",avg(speed_kph) FILTER(WHERE speed_kph>0 AND speed_kph<'Infinity'::float8) AS "meanSpeedKph",count(*) FILTER(WHERE swing)::integer AS swings,count(*) FILTER(WHERE whiff)::integer AS whiffs FROM grouped GROUP BY game_id,revision,bucket,pitch_type,stance ORDER BY game_id COLLATE "C",bucket COLLATE "C",pitch_type COLLATE "C",stance COLLATE "C"`,
            [selected, pitcherId],
          )
        ).rows,
      );
      const plays = await readAnalysisPlays(client, selected);
      await release();
      const sourceHash = createHash("sha256")
        .update(canonicalStringify({ version: 1, manifest, history }))
        .digest("hex");
      return Value.Decode(
        PitcherWorkloadResponseSchema,
        analyzePitcherWorkload(
          query,
          pitcherId,
          scope,
          sourceHash,
          history,
          new Set(selected),
          encounters,
          plays,
          buckets,
        ),
      );
    });
  }
}
