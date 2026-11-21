import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  resolveAnalysisScope,
  PitchOutcomeRowSchema,
  TerminalPaRowSchema,
  type AnalysisScope,
  type PitchOutcomeQuery,
  type PitchOutcomeRow,
  type TerminalPaRow,
} from "@kbo/contracts";
import {
  ANALYSIS_GAME_WHERE,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";

import {
  effectiveBattingSideSql,
  gameBattingProfileJoinSql,
  pitchGeometrySql,
  pitchEligibilitySql,
} from "./analysis-pitch-input.js";
import { readPitchOutcomeSources } from "./pitch-outcome-sources.js";

export interface PitchOutcomeSnapshot {
  readonly scope: AnalysisScope;
  readonly sourceHash: string;
  readonly rows: readonly PitchOutcomeRow[];
  readonly plateAppearances: readonly TerminalPaRow[];
}

export interface PitchOutcomeCache {
  get(key: string): Promise<PitchOutcomeSnapshot> | undefined;
  load(key: string, load: () => Promise<PitchOutcomeSnapshot>): Promise<PitchOutcomeSnapshot>;
}

/** Physical pitch rows and compiler PA rows are separate reads in one immutable-source snapshot. */
export async function readPitchOutcomes(
  pool: Pool,
  scope: AnalysisScope,
  actorId: string,
  role: "pitcher" | "batter",
  cache?: PitchOutcomeCache,
) {
  const input = await withAnalysisSnapshot(pool, (client) =>
    readPitchOutcomeInput(client, scope, actorId, role, cache),
  );
  return finishPitchOutcomeInput(input, role, actorId, cache);
}

export async function readPitchOutcomePair(
  pool: Pool,
  firstScope: AnalysisScope,
  secondScope: AnalysisScope,
  actorId: string,
  role: "pitcher" | "batter",
  cache?: PitchOutcomeCache,
) {
  const [first, second] = await withAnalysisSnapshot(
    pool,
    async (client) =>
      [
        await readPitchOutcomeInput(client, firstScope, actorId, role, cache),
        await readPitchOutcomeInput(client, secondScope, actorId, role, cache),
      ] as const,
  );
  return {
    first: await finishPitchOutcomeInput(first, role, actorId, cache),
    second: await finishPitchOutcomeInput(second, role, actorId, cache),
  };
}

export function pitchOutcomeScope({ season, competition, dateFrom, dateTo }: PitchOutcomeQuery) {
  return resolveAnalysisScope(
    {
      season,
      ...(competition === undefined ? {} : { competition }),
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
    },
    "regular",
  );
}

async function readPitchOutcomeInput(
  client: PoolClient,
  scope: AnalysisScope,
  actorId: string,
  role: "pitcher" | "batter",
  cache?: PitchOutcomeCache,
) {
  const source = cache === undefined ? undefined : await readPitchOutcomeSources(client, scope);
  const key =
    source === undefined
      ? undefined
      : canonicalStringify([role, actorId, source.manifest, source.supplements]);
  const cached = key === undefined ? undefined : cache?.get(key);
  if (cached !== undefined) return { cached };
  return {
    scope,
    manifest: source?.manifest ?? (await analysisSourceHash(client, scope)),
    key,
    ...(await readPitchOutcomeRows(client, scope, actorId, role)),
  };
}

async function finishPitchOutcomeInput(
  input: Awaited<ReturnType<typeof readPitchOutcomeInput>>,
  role: "pitcher" | "batter",
  actorId: string,
  cache?: PitchOutcomeCache,
): Promise<PitchOutcomeSnapshot> {
  // Wait for cache work and hash the full response inputs after returning the connection.
  if (input.cached !== undefined) return input.cached;
  const { scope, manifest, rows, plateAppearances, key } = input;
  const snapshot = async () => ({
    scope,
    sourceHash: pitchOutcomeSourceHash(manifest, role, actorId, rows, plateAppearances),
    rows,
    plateAppearances,
  });
  return key === undefined || cache === undefined ? snapshot() : cache.load(key, snapshot);
}

function pitchOutcomeSourceHash(
  manifest: string,
  role: "pitcher" | "batter",
  actorId: string,
  rows: readonly PitchOutcomeRow[],
  plateAppearances: readonly TerminalPaRow[],
) {
  return createHash("sha256")
    .update(canonicalStringify({ version: 1, manifest, role, actorId, rows, plateAppearances }))
    .digest("hex");
}

/** Reuses the caller's snapshot when several actor cohorts must be compared. */
export async function readPitchOutcomeRows(
  client: PoolClient,
  scope: AnalysisScope,
  actorId: string,
  role: "pitcher" | "batter",
) {
  const actorColumn = role === "pitcher" ? "pitcher_id" : "batter_id",
    parameters = [...analysisScopeParameters(scope), actorId];
  const pitches = await client.query<Record<string, unknown>>(
    `WITH selected_games AS MATERIALIZED (
      SELECT r.game_id,r.revision FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE}
    ) SELECT p.game_id AS "gameId",p.revision,p.pitch_id AS "pitchId",
      p.pitch_sequence AS "pitchSequence",p.plate_appearance_event_id AS "paId",to_char(p.game_date,'YYYY-MM-DD') AS "gameDate",
      p.pitcher_id AS "pitcherId",p.batter_id AS "batterId",p.pitch_type AS "pitchType",${effectiveBattingSideSql} AS stance,p.before_balls AS balls,p.before_strikes AS strikes,
      p.pitch_call AS "pitchCall",p.swing,p.whiff,p.called_strike AS "calledStrike",p.csw,p.in_play AS "inPlay",
      p.season,p.batter_height_cm AS "batterHeightCm",p.tracking_id AS "trackingId",p.in_zone AS "inZone",
      COALESCE(t.measurement_profile_id='naver_pts_v1',FALSE) AS supported,
      ${pitchEligibilitySql} AS eligible,
      ${pitchGeometrySql}
      FROM selected_games r CROSS JOIN LATERAL (
        SELECT p.* FROM analytics.current_pitches p
        WHERE p.game_id=r.game_id AND p.revision=r.revision AND p.actual AND p.${actorColumn}=$5 OFFSET 0
      ) p
      LEFT JOIN workbench.tracking_observations t ON t.game_id=p.game_id AND t.revision=p.revision AND t.tracking_id=p.tracking_id
      ${gameBattingProfileJoinSql("p")}
      LEFT JOIN baseball.plate_appearance_facts pa ON pa.game_id=p.game_id AND pa.revision=p.revision AND pa.start_event_id=p.plate_appearance_event_id
      ORDER BY p.game_id COLLATE "C",p.pitch_sequence`,
    parameters,
  );
  const paResult = await client.query<Record<string, unknown>>(
    `WITH selected_games AS (
      SELECT r.game_id,r.revision,r.game_date FROM analytics.current_analysis_games r WHERE ${ANALYSIS_GAME_WHERE}
    ), selected_pas AS (
      SELECT pa.game_id,pa.revision,pa.start_event_id AS pa_id FROM baseball.plate_appearance_facts pa
        JOIN selected_games r USING(game_id,revision) WHERE pa.${actorColumn}=$5
      UNION
      SELECT p.game_id,p.revision,p.plate_appearance_event_id AS pa_id FROM baseball.pitch_facts p
        JOIN selected_games r USING(game_id,revision) WHERE p.${actorColumn}=$5 AND p.plate_appearance_event_id IS NOT NULL
    ), last_pitches AS (
      SELECT DISTINCT ON (q.game_id,q.revision,q.plate_appearance_event_id) q.*
      FROM baseball.pitch_facts q JOIN selected_pas s ON s.game_id=q.game_id AND s.revision=q.revision AND s.pa_id=q.plate_appearance_event_id
      WHERE q.pitch_call<>'no_pitch'
      ORDER BY q.game_id,q.revision,q.plate_appearance_event_id,q.pitch_sequence DESC
    )
    SELECT pa.game_id AS "gameId",pa.revision,to_char(r.game_date,'YYYY-MM-DD') AS "gameDate",pa.start_event_id AS "paId",
      pa.batter_id AS "batterId",pa.pitcher_id AS "pitcherId",pa.completed,pa.counts_as_plate_appearance AS "countsAsPa",
      pa.counts_as_at_bat AS "countsAsAb",pa.counts_as_batter_faced AS "countsAsBf",pa.result,
      (NOT COALESCE(pa.is_bunt,FALSE) AND pa.result IS DISTINCT FROM 'intentional_walk' AND
        COALESCE(q.pitch_call NOT IN ('hit_by_pitch','foul_bunt'),TRUE)) AS eligible,
      q.pitch_id AS "pitchId",q.actual AS "terminalActual",q.batter_id AS "terminalBatterId",q.pitcher_id AS "terminalPitcherId",
      q.pitch_type AS "pitchType",${effectiveBattingSideSql} AS stance,CASE WHEN q.speed_kph > '-Infinity'::float8 AND q.speed_kph < 'Infinity'::float8 THEN q.speed_kph ELSE NULL END AS "speedKph",q.pitch_call AS "pitchCall",q.in_play AS "inPlay",
      q.before_balls AS "beforeBalls",q.before_strikes AS "beforeStrikes",q.after_balls AS "afterBalls",q.after_strikes AS "afterStrikes"
    FROM selected_pas s JOIN baseball.plate_appearance_facts pa ON pa.game_id=s.game_id AND pa.revision=s.revision AND pa.start_event_id=s.pa_id
    JOIN selected_games r ON r.game_id=pa.game_id AND r.revision=pa.revision
    LEFT JOIN last_pitches q ON q.game_id=pa.game_id AND q.revision=pa.revision AND q.plate_appearance_event_id=pa.start_event_id
    LEFT JOIN baseball.pitch_tracking_links l ON l.game_id=q.game_id AND l.revision=q.revision AND l.pitch_id=q.pitch_id
    LEFT JOIN workbench.tracking_observations t ON t.game_id=l.game_id AND t.revision=l.revision AND t.tracking_id=l.tracking_id
    ${gameBattingProfileJoinSql("q")}
    ORDER BY pa.game_id COLLATE "C",pa.plate_appearance_index`,
    parameters,
  );
  const rows = Value.Decode(Type.Array(PitchOutcomeRowSchema), pitches.rows);
  const plateAppearances = Value.Decode(Type.Array(TerminalPaRowSchema), paResult.rows);
  return { rows, plateAppearances };
}
