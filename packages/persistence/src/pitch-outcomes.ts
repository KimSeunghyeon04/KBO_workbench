import { withAnalysisReadSnapshot, type AnalysisReadSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  inAnalysisPeriod,
  PitchOutcomeRowSchema,
  TerminalPaRowSchema,
  type AnalysisScope,
  type PitcherHand,
  type PitchOutcomeRow,
  type TerminalPaRow,
} from "@kbo/contracts";
import { analysisScopeParameters, scopedAnalysisGamesSql } from "./analysis-scope.js";

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

interface PitchOutcomeRead {
  readonly actorId: string;
  readonly role: "pitcher" | "batter";
  readonly cache: PitchOutcomeCache | undefined;
  readonly resolveHand: ResolvePitcherHand | undefined;
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
  const read = { actorId, role, cache, resolveHand };
  const input = await withAnalysisReadSnapshot(pool, (snapshot) =>
    readPitchOutcomeInput(snapshot, scope, read),
  );
  return finishPitchOutcomeInput(input, read);
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
  if (
    firstScope.season === secondScope.season &&
    firstScope.competition === secondScope.competition &&
    firstScope.dateFrom === secondScope.dateFrom &&
    firstScope.dateTo === secondScope.dateTo
  ) {
    const snapshot = await readPitchOutcomes(pool, firstScope, actorId, role, cache, resolveHand);
    return { first: snapshot, second: snapshot };
  }
  const read = { actorId, role, cache, resolveHand };
  const sharedScope = overlappingReadScope(firstScope, secondScope);
  const [first, second] = await withAnalysisReadSnapshot(pool, async (snapshot) => {
    const { client, release } = snapshot;
    if (sharedScope === undefined)
      return [
        await readPitchOutcomeInput(snapshot, firstScope, read),
        await readPitchOutcomeInput(snapshot, secondScope, read),
      ] as const;
    const firstIdentity = await readPitchOutcomeIdentity(snapshot, firstScope, read);
    const secondIdentity = await readPitchOutcomeIdentity(snapshot, secondScope, read);
    if (firstIdentity.cached !== undefined || secondIdentity.cached !== undefined)
      return [
        await readKnownPitchOutcomeInput(client, firstIdentity, read),
        await readKnownPitchOutcomeInput(client, secondIdentity, read),
      ] as const;
    const { rows, plateAppearances } = await readScopedPitchOutcomes(client, sharedScope, read);
    await release();
    const forScope = ({ scope, manifest, key }: typeof firstIdentity) => ({
      scope,
      manifest,
      key,
      rows: rows.filter((row) => inAnalysisPeriod(row.gameDate, scope)),
      plateAppearances: plateAppearances.filter((row) => inAnalysisPeriod(row.gameDate, scope)),
    });
    return [forScope(firstIdentity), forScope(secondIdentity)] as const;
  });
  return {
    first: await finishPitchOutcomeInput(first, read),
    second: await finishPitchOutcomeInput(second, read),
  };
}

function overlappingReadScope(
  first: AnalysisScope,
  second: AnalysisScope,
): AnalysisScope | undefined {
  const { season, competition } = first;
  if (
    season !== second.season ||
    competition !== second.competition ||
    (first.dateTo !== null && second.dateFrom !== null && first.dateTo < second.dateFrom) ||
    (second.dateTo !== null && first.dateFrom !== null && second.dateTo < first.dateFrom)
  )
    return undefined;
  return {
    season,
    competition,
    dateFrom:
      first.dateFrom === null || second.dateFrom === null
        ? null
        : first.dateFrom < second.dateFrom
          ? first.dateFrom
          : second.dateFrom,
    dateTo:
      first.dateTo === null || second.dateTo === null
        ? null
        : first.dateTo > second.dateTo
          ? first.dateTo
          : second.dateTo,
  };
}

async function readPitchOutcomeInput(
  snapshot: AnalysisReadSnapshot,
  scope: AnalysisScope,
  read: PitchOutcomeRead,
) {
  const identity = await readPitchOutcomeIdentity(snapshot, scope, read);
  return readKnownPitchOutcomeInput(snapshot.client, identity, read);
}

async function readPitchOutcomeIdentity(
  snapshot: AnalysisReadSnapshot,
  scope: AnalysisScope,
  { actorId, role, cache, resolveHand }: PitchOutcomeRead,
) {
  if (cache === undefined)
    return {
      scope,
      manifest: await snapshot.sourceHash(scope),
      key: undefined,
      cached: undefined,
    };
  const { manifest, supplements } = await readPitchOutcomeSources(snapshot.client, scope);
  const key = canonicalStringify([
    role,
    actorId,
    manifest,
    supplements,
    ...(resolveHand === undefined ? [] : ["pitcher-hands"]),
  ]);
  return { scope, manifest, key, cached: cache.get(key) };
}

async function readKnownPitchOutcomeInput(
  client: PoolClient,
  { cached, ...identity }: Awaited<ReturnType<typeof readPitchOutcomeIdentity>>,
  read: PitchOutcomeRead,
) {
  if (cached !== undefined) return { cached };
  return { ...identity, ...(await readScopedPitchOutcomes(client, identity.scope, read)) };
}

async function readScopedPitchOutcomes(
  client: PoolClient,
  scope: AnalysisScope,
  { actorId, role, resolveHand }: PitchOutcomeRead,
) {
  const outcomes = await readPitchOutcomeRows(client, scope, actorId, role);
  return resolveHand === undefined ? outcomes : withPitcherHands(client, outcomes, resolveHand);
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
  input: Awaited<ReturnType<typeof readKnownPitchOutcomeInput>>,
  { role, actorId, cache }: PitchOutcomeRead,
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
  const { rows, appearances } = await readPitchOutcomeCohort(
    client,
    scope,
    actorId,
    role,
    opponentId,
  );
  return { rows, plateAppearances: appearances.map(({ row }) => row) };
}

export interface PitchOutcomeCohort {
  rows: PitchOutcomeRow[];
  appearances: { index: number; row: TerminalPaRow }[];
}

const indexedPaSchema = Type.Array(
  Type.Object(
    { ...TerminalPaRowSchema.properties, paIndex: Type.Integer() },
    { additionalProperties: false },
  ),
);

export async function readPitchOutcomeCohort(
  client: PoolClient,
  scope: AnalysisScope,
  actorId: string,
  role: "pitcher" | "batter",
  opponentId?: string,
  covered?: PitchOutcomeCohort,
): Promise<PitchOutcomeCohort> {
  const actorColumn = role === "pitcher" ? "pitcher_id" : "batter_id",
    opponentColumn = role === "pitcher" ? "batter_id" : "pitcher_id",
    parameters = [...analysisScopeParameters(scope), actorId, opponentId ?? null];
  const opponentPitch =
    covered === undefined
      ? `($6::text IS NULL OR p.${opponentColumn}=$6)`
      : `p.${opponentColumn} IS DISTINCT FROM $6::text`;
  const pitches = await client.query<Record<string, unknown>>(
    scopedTrackedPitchRowsSql({
      select: `${effectiveBattingSideSql} AS stance,p.pitcher_id AS "pitcherId",
        p.pitch_sequence AS "pitchSequence",p.plate_appearance_event_id AS "paId",
        p.pitch_call AS "pitchCall",p.called_strike AS "calledStrike",p.csw,p.in_play AS "inPlay"`,
      pitchPredicate: `p.${actorColumn}=$5 AND ${opponentPitch}`,
      joins: gameBattingProfileJoinSql("p"),
    }),
    parameters,
  );
  const coveredAppearances = covered?.appearances.map(({ row }) => ({
    game_id: row.gameId,
    revision: row.revision,
    pa_id: row.paId,
  }));
  const paResult = await client.query<Record<string, unknown>>(
    `WITH selected_games AS (
      ${scopedAnalysisGamesSql("r.game_id,r.revision,r.game_date")}
    ), candidates AS (
      SELECT pa.game_id,pa.revision,pa.start_event_id AS pa_id FROM baseball.plate_appearance_facts pa
        JOIN selected_games r USING(game_id,revision) WHERE pa.${actorColumn}=$5
          AND ($6::text IS NULL OR pa.${opponentColumn}=$6)
      UNION
      SELECT p.game_id,p.revision,p.plate_appearance_event_id AS pa_id FROM baseball.pitch_facts p
        JOIN selected_games r USING(game_id,revision) WHERE p.${actorColumn}=$5 AND p.plate_appearance_event_id IS NOT NULL
          AND ($6::text IS NULL OR p.${opponentColumn}=$6)
    ), selected_pas AS (
      SELECT c.* FROM candidates c
      ${
        coveredAppearances === undefined
          ? ""
          : `WHERE NOT EXISTS (
        SELECT 1 FROM json_to_recordset($7::json) AS cached(game_id text,revision integer,pa_id text)
        WHERE (cached.game_id,cached.revision,cached.pa_id)=(c.game_id,c.revision,c.pa_id)
      )`
      }
    ), ${lastPitchesCteSql}
    SELECT pa.game_id AS "gameId",pa.revision,to_char(r.game_date,'YYYY-MM-DD') AS "gameDate",pa.start_event_id AS "paId",pa.plate_appearance_index AS "paIndex",
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
    coveredAppearances === undefined
      ? parameters
      : [...analysisScopeParameters(scope), actorId, null, JSON.stringify(coveredAppearances)],
  );
  const rows = Value.Decode(Type.Array(PitchOutcomeRowSchema), pitches.rows);
  const appearances = Value.Decode(indexedPaSchema, paResult.rows).map(({ paIndex, ...row }) => ({
    index: paIndex,
    row,
  }));
  if (covered === undefined) return { rows, appearances };

  const compareId = (first: string, second: string) =>
    Buffer.compare(Buffer.from(first), Buffer.from(second));
  return {
    rows: [...covered.rows, ...rows].sort(
      (a, b) => compareId(a.gameId, b.gameId) || a.pitchSequence - b.pitchSequence,
    ),
    appearances: [...covered.appearances, ...appearances].sort(
      (a, b) => compareId(a.row.gameId, b.row.gameId) || a.index - b.index,
    ),
  };
}
