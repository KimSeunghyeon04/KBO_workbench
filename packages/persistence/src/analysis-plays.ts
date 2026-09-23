import type { PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisPlaySchema,
  AnalysisStateSchema,
  AnalysisMovementSchema,
  type AnalysisPlay,
} from "@kbo/contracts";
const key = (row: { gameId: string; revision: number; sequence: number }) =>
  JSON.stringify([row.gameId, row.revision, row.sequence]);
const playIdentitySchema = Type.Pick(AnalysisPlaySchema, ["gameId", "revision", "sequence"]);
const movementRowsSchema = Type.Array(
  Type.Object(
    {
      gameId: Type.String(),
      revision: Type.Integer(),
      playSequence: Type.Integer(),
      ...AnalysisMovementSchema.properties,
    },
    { additionalProperties: false },
  ),
);
const stateColumns = [
  "inning",
  "half",
  "half_active",
  "balls",
  "strikes",
  "outs",
  "away_score",
  "home_score",
  "batter_id",
  "pitcher_id",
  "active_away_pitcher_id",
  "active_home_pitcher_id",
  "pa_start_event_id",
  ...[1, 2, 3].flatMap((n) => [`base${n}_runner_id`, `base${n}_pitcher_id`]),
];
function state(row: Record<string, unknown>, prefix: "before" | "after") {
  const get = (name: string) => row[`${prefix}_${name}`];
  return Value.Decode(AnalysisStateSchema, {
    inning: get("inning"),
    half: get("half"),
    halfActive: get("half_active"),
    balls: get("balls"),
    strikes: get("strikes"),
    outs: get("outs"),
    awayScore: get("away_score"),
    homeScore: get("home_score"),
    batterId: get("batter_id"),
    pitcherId: get("pitcher_id"),
    awayPitcherId: get("active_away_pitcher_id"),
    homePitcherId: get("active_home_pitcher_id"),
    paId: get("pa_start_event_id"),
    bases: [1, 2, 3].map((n) =>
      get(`base${n}_runner_id`) === null
        ? null
        : { runnerId: get(`base${n}_runner_id`), pitcherId: get(`base${n}_pitcher_id`) },
    ),
  });
}
/** Selected current revisions are captured by the caller's repeatable-read transaction. */
export async function readAnalysisPlays(
  client: PoolClient,
  gameIds: readonly string[],
  revision?: number,
  includeMovements = true,
): Promise<AnalysisPlay[]> {
  if (gameIds.length === 0) return [];
  const [plays, movements] = await Promise.all([
    client.query<Record<string, unknown>>(
      `SELECT p.game_id AS "gameId",p.revision,to_char(r.game_date,'YYYY-MM-DD') AS "gameDate",p.play_id AS "playId",p.play_sequence AS sequence,p.kind,p.applied,p.inning,p.half,
   ${["before", "after"].flatMap((prefix) => stateColumns.map((c) => `p.${prefix}_${c}`)).join(",")},pa.result,pa.is_bunt AS "isBunt",pf.pitch_id,pf.pitch_call,pf.actual,pf.in_play
   FROM ${revision === undefined ? "analytics.current_plays" : "baseball.play_facts"} p JOIN workbench.game_revisions r USING(game_id,revision)
   LEFT JOIN baseball.plate_appearance_facts pa ON p.kind='plate_result' AND pa.game_id=p.game_id AND pa.revision=p.revision AND pa.start_event_id=p.before_pa_start_event_id AND pa.completed
   LEFT JOIN baseball.play_events pe ON p.kind='pitch' AND pe.game_id=p.game_id AND pe.revision=p.revision AND pe.play_sequence=p.play_sequence AND pe.relay_order=0
   LEFT JOIN baseball.pitch_facts pf ON pf.game_id=pe.game_id AND pf.revision=pe.revision AND pf.pitch_id=pe.event_id
   WHERE r.sealed AND p.game_id=ANY($1::text[]) AND ($2::integer IS NULL OR p.revision=$2) ORDER BY p.game_id COLLATE "C",p.play_sequence`,
      [gameIds, revision ?? null],
    ),
    includeMovements
      ? client.query<Record<string, unknown>>(
          `SELECT m.game_id AS "gameId",m.revision,m.play_sequence AS "playSequence",m.movement_sequence AS sequence,m.runner_id AS "runnerId",m.responsible_pitcher_id AS "pitcherId",m.from_base AS "fromBase",m.to_base AS "toBase",m.outcome,m.reason,m.derived
   FROM baseball.runner_movement_facts m JOIN workbench.game_revisions r ON r.game_id=m.game_id AND r.revision=m.revision
   ${revision === undefined ? "JOIN workbench.games g ON g.game_id=m.game_id AND g.current_revision=m.revision" : ""}
   WHERE r.sealed AND m.game_id=ANY($1::text[]) AND ($2::integer IS NULL OR m.revision=$2) ORDER BY m.game_id COLLATE "C",m.play_sequence,m.movement_sequence`,
          [gameIds, revision ?? null],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const decoded = Value.Decode(movementRowsSchema, movements.rows);
  const grouped = new Map<string, AnalysisPlay["movements"]>();
  for (const row of decoded) {
    const { gameId, revision, playSequence, ...movement } = row,
      id = key({ gameId, revision, sequence: playSequence }),
      group = grouped.get(id) ?? [];
    group.push(movement);
    grouped.set(id, group);
  }
  return plays.rows.map((row) => {
    const identity = Value.Decode(playIdentitySchema, {
      gameId: row.gameId,
      revision: row.revision,
      sequence: row.sequence,
    });
    return Value.Decode(AnalysisPlaySchema, {
      ...identity,
      gameDate: row.gameDate,
      playId: row.playId,
      kind: row.kind,
      applied: row.applied,
      inning: row.inning,
      half: row.half,
      result: row.result,
      isBunt: row.isBunt,
      pitch:
        row.pitch_id === null
          ? null
          : { id: row.pitch_id, call: row.pitch_call, actual: row.actual, inPlay: row.in_play },
      before: state(row, "before"),
      after: state(row, "after"),
      movements: grouped.get(key(identity)) ?? [],
    });
  });
}
