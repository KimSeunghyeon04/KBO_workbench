import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  PitchOutcomeRowSchema,
  TerminalPaRowSchema,
  type AnalysisScope,
  type PitcherHand,
  type PitchOutcomeRow,
  type TerminalPaRow,
} from "@kbo/contracts";
import {
  analysisScopeParameters,
  scopedAnalysisGamesSql,
  analysisSourceHash,
} from "./analysis-scope.js";

import {
  effectiveBattingSideSql,
  gameBattingProfileJoinSql,
  lastPitchesCteSql,
  pitchTrackingJoinsSql,
  scopedTrackedPitchRowsSql,
} from "./analysis-pitch-input.js";
import { readPitchOutcomeSources } from "./pitch-outcome-sources.js";
import { readGamePitcherHands, type ResolvePitcherHand } from "./pitcher-hands.js";

type WithPitcherHand<T> = T & { readonly pitcherHand?: PitcherHand | null };

export interface PitchOutcomeSnapshot {
  readonly scope: AnalysisScope;
  readonly sourceHash: string;
  readonly rows: readonly WithPitcherHand<PitchOutcomeRow>[];
  readonly plateAppearances: readonly WithPitcherHand<TerminalPaRow>[];
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
  resolveHand?: ResolvePitcherHand,
) {
  const input = await withAnalysisSnapshot(pool, (client) =>
    readPitchOutcomeInput(client, scope, actorId, role, cache, resolveHand),
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
  resolveHand?: ResolvePitcherHand,
) {
  const [first, second] = await withAnalysisSnapshot(
    pool,
    async (client) =>
      [
        await readPitchOutcomeInput(client, firstScope, actorId, role, cache, resolveHand),
        await readPitchOutcomeInput(client, secondScope, actorId, role, cache, resolveHand),
      ] as const,
  );
  return {
    first: await finishPitchOutcomeInput(first, role, actorId, cache),
    second: await finishPitchOutcomeInput(second, role, actorId, cache),
  };
}

async function readPitchOutcomeInput(
  client: PoolClient,
  scope: AnalysisScope,
  actorId: string,
  role: "pitcher" | "batter",
  cache?: PitchOutcomeCache,
  resolveHand?: ResolvePitcherHand,
) {
  const source = cache === undefined ? undefined : await readPitchOutcomeSources(client, scope);
  const key =
    source === undefined
      ? undefined
      : canonicalStringify([
          role,
          actorId,
          source.manifest,
          source.supplements,
          ...(resolveHand === undefined ? [] : ["pitcher-hands"]),
        ]);
  const cached = key === undefined ? undefined : cache?.get(key);
  if (cached !== undefined) return { cached };
  const outcomes = await readPitchOutcomeRows(client, scope, actorId, role);
  return {
    scope,
    manifest: source?.manifest ?? (await analysisSourceHash(client, scope)),
    key,
    ...(resolveHand === undefined
      ? outcomes
      : await withPitcherHands(client, outcomes, resolveHand)),
  };
}

async function withPitcherHands(
  client: PoolClient,
  { rows, plateAppearances }: Awaited<ReturnType<typeof readPitchOutcomeRows>>,
  resolve: ResolvePitcherHand,
) {
  const opponent = (pa: TerminalPaRow) => ({
    ...pa,
    pitcherId: pa.terminalPitcherId ?? pa.pitcherId,
  });
  const handFor = await readGamePitcherHands(
    client,
    [...rows, ...plateAppearances.map(opponent)],
    resolve,
  );
  return {
    rows: rows.map((row) => ({ ...row, pitcherHand: handFor(row) })),
    plateAppearances: plateAppearances.map((row) => ({
      ...row,
      pitcherHand: handFor(opponent(row)),
    })),
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
  opponentId?: string,
) {
  const actorColumn = role === "pitcher" ? "pitcher_id" : "batter_id",
    opponentColumn = role === "pitcher" ? "batter_id" : "pitcher_id",
    parameters = [...analysisScopeParameters(scope), actorId, opponentId ?? null];
  const pitches = await client.query<Record<string, unknown>>(
    scopedTrackedPitchRowsSql({
      select: `${effectiveBattingSideSql} AS stance,p.pitcher_id AS "pitcherId",
        p.pitch_sequence AS "pitchSequence",p.plate_appearance_event_id AS "paId",
        p.pitch_call AS "pitchCall",p.called_strike AS "calledStrike",p.csw,p.in_play AS "inPlay"`,
      pitchPredicate: `p.${actorColumn}=$5 AND ($6::text IS NULL OR p.${opponentColumn}=$6)`,
      joins: gameBattingProfileJoinSql("p"),
    }),
    parameters,
  );
  const paResult = await client.query<Record<string, unknown>>(
    `WITH selected_games AS (
      ${scopedAnalysisGamesSql("r.game_id,r.revision,r.game_date")}
    ), selected_pas AS (
      SELECT pa.game_id,pa.revision,pa.start_event_id AS pa_id FROM baseball.plate_appearance_facts pa
        JOIN selected_games r USING(game_id,revision) WHERE pa.${actorColumn}=$5
          AND ($6::text IS NULL OR pa.${opponentColumn}=$6)
      UNION
      SELECT p.game_id,p.revision,p.plate_appearance_event_id AS pa_id FROM baseball.pitch_facts p
        JOIN selected_games r USING(game_id,revision) WHERE p.${actorColumn}=$5 AND p.plate_appearance_event_id IS NOT NULL
          AND ($6::text IS NULL OR p.${opponentColumn}=$6)
    ), ${lastPitchesCteSql}
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
    ${pitchTrackingJoinsSql("q")}
    ${gameBattingProfileJoinSql("q")}
    ORDER BY pa.game_id COLLATE "C",pa.plate_appearance_index`,
    parameters,
  );
  const rows = Value.Decode(Type.Array(PitchOutcomeRowSchema), pitches.rows);
  const plateAppearances = Value.Decode(Type.Array(TerminalPaRowSchema), paResult.rows);
  return { rows, plateAppearances };
}
