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
import { pitchTrackingJoinsSql } from "./analysis-pitch-input.js";
const workloadPitchRows = Type.Object(
  {
    encounters: Type.Array(WorkloadEncounterSchema),
    buckets: Type.Array(WorkloadPitchBucketSchema),
  },
  { additionalProperties: false },
);
export class PitcherWorkloadRepository {
  public constructor(private readonly pool: Pool) {}
  public async analyze(input: AnalysisScopeQuery, pitcherId: string) {
    const query = Value.Decode(AnalysisScopeQuerySchema, input),
      scope = resolveAnalysisScope(query, "regular");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const { manifest, history, selected } = await readWorkloadContext(client, scope, pitcherId);
      const { rows } = await client.query<Record<string, unknown>>(
        `WITH selected_pitches AS MATERIALIZED (
          SELECT p.game_id,p.revision,p.pitch_id,p.pitch_sequence,p.plate_appearance_event_id,
            p.batter_id,p.pitch_type,p.speed_kph,p.swing,p.whiff
          FROM baseball.pitch_facts p
          JOIN workbench.games g ON g.game_id=p.game_id AND g.current_revision=p.revision
          WHERE p.game_id=ANY($1::text[]) AND p.pitcher_id=$2 AND p.actual
        ), encounters AS (
          SELECT game_id AS "gameId",revision,plate_appearance_event_id AS "paId",batter_id AS "batterId",
            min(pitch_sequence)::integer AS "firstSequence",count(*)::integer AS pitches
          FROM selected_pitches
          WHERE plate_appearance_event_id IS NOT NULL AND batter_id IS NOT NULL
          GROUP BY game_id,revision,plate_appearance_event_id,batter_id
        ), ordered AS (
          SELECT p.*,t.stance,row_number() OVER(PARTITION BY p.game_id,p.revision ORDER BY p.pitch_sequence) AS ordinal
          FROM selected_pitches p
          ${pitchTrackingJoinsSql()}
        ), grouped AS (
          SELECT *,CASE WHEN ordinal<=25 THEN '1–25' WHEN ordinal<=50 THEN '26–50' WHEN ordinal<=75 THEN '51–75' ELSE '76+' END AS bucket
          FROM ordered
        ), buckets AS (
          SELECT game_id AS "gameId",revision,bucket,pitch_type AS "pitchType",stance,count(*)::integer AS pitches,
            count(speed_kph) FILTER(WHERE speed_kph>0 AND speed_kph<'Infinity'::float8)::integer AS "speedCount",
            avg(speed_kph) FILTER(WHERE speed_kph>0 AND speed_kph<'Infinity'::float8) AS "meanSpeedKph",
            count(*) FILTER(WHERE swing)::integer AS swings,count(*) FILTER(WHERE whiff)::integer AS whiffs
          FROM grouped GROUP BY game_id,revision,bucket,pitch_type,stance
        )
        SELECT (
          SELECT COALESCE(json_agg(e ORDER BY e."gameId" COLLATE "C",e."firstSequence"),'[]'::json)
          FROM encounters e
        ) AS encounters, (
          SELECT COALESCE(json_agg(b ORDER BY b."gameId" COLLATE "C",b.bucket COLLATE "C",
            b."pitchType" COLLATE "C",b.stance COLLATE "C"),'[]'::json)
          FROM buckets b
        ) AS buckets`,
        [selected, pitcherId],
      );
      const { encounters, buckets } = Value.Decode(workloadPitchRows, rows[0]);
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
