import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  BatterCountFlowResponseSchema,
  BatterCountFlowQuerySchema,
  BatterCountFlowRowSchema,
  canonicalStringify,
  PitchCountFlowQuerySchema,
  PitchCountFlowResponseSchema,
  PitchCountFlowRowSchema,
  pitchOutcomeScope,
  type PitchCountFlowQuery,
  type BatterCountFlowQuery,
} from "@kbo/contracts";
import { analyzeBatterCountFlow, analyzePitchCountFlow } from "@kbo/game-core";
import {
  effectiveBattingSideSql,
  gameBattingProfileJoinSql,
  gamePitchRowsSql,
  lastPitchesCteSql,
  pitchEligibilitySql,
  pitchPlateAppearanceJoinSql,
  pitchViewObservationJoinSql,
} from "./analysis-pitch-input.js";
import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { readGamePitcherHands, type ResolvePitcherHand } from "./pitcher-hands.js";
import {
  analysisScopeParameters,
  analysisSourceHash,
  scopedAnalysisGamesSql,
} from "./analysis-scope.js";

export async function readPitchCountFlow(
  pool: Pool,
  input: PitchCountFlowQuery,
  pitcherId: string,
) {
  const query = Value.Decode(PitchCountFlowQuerySchema, input);
  const scope = pitchOutcomeScope(query);
  const sample = await withAnalysisSnapshot(pool, (client) =>
    readCountFlowInput(client, scope, pitcherId, "pitcher"),
  );
  const rows = Value.Decode(Type.Array(PitchCountFlowRowSchema), sample.rows);
  const sourceHash = hashCountFlow({ version: 1, manifest: sample.manifest, pitcherId, rows });
  return Value.Decode(
    PitchCountFlowResponseSchema,
    analyzePitchCountFlow(query, pitcherId, scope, sourceHash, rows),
  );
}

export async function readBatterCountFlow(
  pool: Pool,
  input: BatterCountFlowQuery,
  batterId: string,
  resolveHand?: ResolvePitcherHand,
) {
  const query = Value.Decode(BatterCountFlowQuerySchema, input);
  const scope = pitchOutcomeScope(query);
  const { rows, manifest } = await withAnalysisSnapshot(pool, async (client) => {
    const sample = await readCountFlowInput(client, scope, batterId, "batter");
    const targets = Value.Decode(batterPitchInputSchema, sample.rows);
    const handFor =
      query.split !== undefined && resolveHand !== undefined
        ? await readGamePitcherHands(client, targets, resolveHand)
        : undefined;
    return {
      rows: targets.map(({ pitcherId, ...row }) => ({
        ...row,
        ...(handFor === undefined ? {} : { pitcherHand: handFor({ ...row, pitcherId }) }),
      })),
      manifest: sample.manifest,
    };
  });
  const sourceHash = hashCountFlow({ version: 1, manifest, batterId, rows });
  return Value.Decode(
    BatterCountFlowResponseSchema,
    analyzeBatterCountFlow(query, batterId, scope, sourceHash, rows),
  );
}

const batterPitchInputSchema = Type.Array(
  Type.Object(
    {
      ...BatterCountFlowRowSchema.properties,
      pitcherId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    },
    { additionalProperties: false },
  ),
);

function hashCountFlow(input: Parameters<typeof canonicalStringify>[0]) {
  return createHash("sha256").update(canonicalStringify(input)).digest("hex");
}

async function readCountFlowInput(
  client: PoolClient,
  scope: ReturnType<typeof pitchOutcomeScope>,
  actorId: string,
  role: "pitcher" | "batter",
) {
  const actorColumn = role === "pitcher" ? "pitcher_id" : "batter_id";
  const result = await client.query(
    `WITH selected_games AS MATERIALIZED (
        ${scopedAnalysisGamesSql()}
      ), selected_pitches AS MATERIALIZED (
        SELECT p.game_id,p.revision,p.pitch_id,p.pitch_sequence,p.plate_appearance_event_id,
          p.inning,p.half,p.batter_id,p.pitcher_id,p.pitch_call,p.pitch_type,p.in_play,
          p.before_balls,p.before_strikes,p.after_balls,p.after_strikes,p.tracking_id
          ${role === "batter" ? ",p.swing" : ""}
        FROM selected_games r CROSS JOIN LATERAL (
          ${gamePitchRowsSql({ pitchPredicate: `p.${actorColumn}=$5` })}
        ) p
      ), selected_pas AS (
        SELECT DISTINCT game_id,revision,plate_appearance_event_id AS pa_id
        FROM selected_pitches WHERE plate_appearance_event_id IS NOT NULL
      ), ${lastPitchesCteSql}, hbp_predecessors AS (
        SELECT pa.game_id,pa.revision,pa.start_event_id,previous.event_id
        FROM selected_pas s JOIN baseball.plate_appearance_facts pa
          ON pa.game_id=s.game_id AND pa.revision=s.revision AND pa.start_event_id=s.pa_id
        JOIN workbench.relay_event_facts ending
          ON ending.game_id=pa.game_id AND ending.revision=pa.revision AND ending.event_id=pa.end_event_id
          AND ending.kind='plate_result'
        CROSS JOIN LATERAL (
          SELECT prior.event_id,prior.kind FROM workbench.relay_event_facts prior
          WHERE prior.game_id=ending.game_id AND prior.revision=ending.revision
            AND prior.event_sequence<ending.event_sequence
            AND prior.kind NOT IN ('review','administrative')
          ORDER BY prior.event_sequence DESC LIMIT 1
        ) previous
        WHERE pa.completed AND pa.result='hit_by_pitch' AND previous.kind='pitch'
      )
      SELECT p.game_id AS "gameId",p.revision,p.pitch_id AS "pitchId",p.pitch_type AS "pitchType",
        ${effectiveBattingSideSql} AS stance,p.before_balls AS balls,p.before_strikes AS strikes,
        p.after_balls AS "afterBalls",p.after_strikes AS "afterStrikes",p.pitch_call AS "pitchCall",
        p.in_play AS "inPlay",${pitchEligibilitySql} AS eligible,
        ${role === "batter" ? 'p.swing,p.pitcher_id AS "pitcherId",' : ""}
        CASE WHEN pa.completed THEN
          CASE WHEN pa.result='hit_by_pitch' THEN
            CASE WHEN hbp.event_id=p.pitch_id AND p.inning=pa.inning AND p.half=pa.half
              AND p.batter_id=pa.batter_id AND p.pitcher_id=pa.pitcher_id
              AND p.pitch_call IN ('ball','hit_by_pitch') THEN pa.result END
          WHEN q.pitch_id=p.pitch_id THEN pa.result END
        END AS "terminalResult"
      FROM selected_pitches p
      ${pitchPlateAppearanceJoinSql}
      LEFT JOIN last_pitches q
        ON q.game_id=pa.game_id AND q.revision=pa.revision AND q.plate_appearance_event_id=pa.start_event_id
      LEFT JOIN hbp_predecessors hbp
        ON hbp.game_id=pa.game_id AND hbp.revision=pa.revision AND hbp.start_event_id=pa.start_event_id
      ${pitchViewObservationJoinSql}
      ${gameBattingProfileJoinSql("p")}
      ORDER BY p.game_id COLLATE "C",p.pitch_sequence`,
    [...analysisScopeParameters(scope), actorId],
  );
  return {
    rows: result.rows,
    manifest: await analysisSourceHash(client, scope),
  };
}
