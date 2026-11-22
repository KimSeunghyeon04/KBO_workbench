import { createHash } from "node:crypto";
import type { RecordCorrectionNotice } from "@kbo/contracts";
import type { Pool, PoolClient } from "pg";
import { PersistenceIntegrityError } from "./errors.js";
import type { RecordCorrectionGameCandidate } from "./record-correction-types.js";

export type Matchup = readonly [
  season: number,
  gameDate: string,
  awayTeamName: string,
  homeTeamName: string,
];

interface MatchupRow {
  readonly season: number;
  readonly game_date: string;
  readonly away_team_name: string;
  readonly home_team_name: string;
}

const matchupColumns = `r.season,to_char(r.game_date,'YYYY-MM-DD') AS game_date,
  away_team.team_name AS away_team_name,home_team.team_name AS home_team_name`;
const matchupTeams = `JOIN workbench.game_team_snapshots away_team
  ON away_team.game_id=r.game_id AND away_team.revision=r.revision AND away_team.side='away'
  JOIN workbench.game_team_snapshots home_team
  ON home_team.game_id=r.game_id AND home_team.revision=r.revision AND home_team.side='home'`;

export function noticeMatchup(
  notice: Pick<RecordCorrectionNotice, "gameDate" | "awayTeamName" | "homeTeamName">,
): Matchup {
  return [
    Number(notice.gameDate.slice(0, 4)),
    notice.gameDate,
    notice.awayTeamName,
    notice.homeTeamName,
  ];
}

export async function readMatchupCandidates(
  executor: Pool | PoolClient,
  matchup: Matchup,
): Promise<RecordCorrectionGameCandidate[]> {
  const result = await executor.query<
    MatchupRow & {
      readonly game_id: string;
      readonly revision: number;
      readonly document_hash: string;
      readonly source_game_id: string;
      readonly stadium: string | null;
    }
  >(
    `SELECT r.game_id,r.revision,r.document_hash,r.source_game_id,r.stadium,${matchupColumns}
     FROM workbench.games g
     JOIN workbench.game_revisions r
       ON r.game_id=g.game_id AND r.revision=g.current_revision AND r.sealed
     ${matchupTeams}
     WHERE r.season=$1 AND r.game_date=$2 AND away_team.team_name=$3 AND home_team.team_name=$4
     ORDER BY r.source_game_id,r.game_id`,
    [...matchup],
  );
  return result.rows.map((row) => ({
    gameId: row.game_id,
    revision: row.revision,
    documentHash: row.document_hash,
    sourceGameId: row.source_game_id,
    gameDate: row.game_date,
    stadium: row.stadium,
    awayTeamName: row.away_team_name,
    homeTeamName: row.home_team_name,
  }));
}

export async function lockMatchupPublication(
  client: PoolClient,
  gameId: string,
  previousRevision: number | null,
  nextRevision: number,
): Promise<Matchup[]> {
  const matchups = await readRevisionMatchups(client, gameId, nextRevision);
  if (matchups.length !== (previousRevision === null ? 1 : 2)) {
    throw new PersistenceIntegrityError("봉인할 경기의 기록정정 대진을 찾을 수 없습니다.");
  }
  // A correction can change a game's date or teams, affecting both candidate sets.
  return lockMatchupChanges(client, matchups);
}

export async function lockMatchupChanges(
  client: PoolClient,
  matchups: readonly Matchup[],
): Promise<Matchup[]> {
  const keys = new Map(matchups.map((matchup) => [matchupLockKey(matchup), matchup]));
  for (const key of [...keys.keys()].sort()) {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
  }
  return [...keys.values()];
}

export async function readMatchupGeneration(client: PoolClient, matchup: Matchup): Promise<number> {
  const result = await client.query<{ generation: number }>(
    `SELECT generation FROM record_correction.matchup_generations
     WHERE (season,game_date,away_team_name,home_team_name)=($1,$2,$3,$4)`,
    [...matchup],
  );
  return result.rows[0]?.generation ?? 0;
}

export async function readRevisionMatchups(
  executor: Pool | PoolClient,
  gameId: string,
  revision: number,
): Promise<Matchup[]> {
  const result = await executor.query<MatchupRow>(
    `SELECT ${matchupColumns}
     FROM workbench.game_revisions imported
     JOIN workbench.game_revisions r ON r.game_id=imported.game_id
       AND r.revision IN (imported.revision,imported.parent_revision) AND r.sealed
     ${matchupTeams}
     WHERE imported.game_id=$1 AND imported.revision=$2 AND imported.sealed`,
    [gameId, revision],
  );
  return result.rows.map((row) => [
    row.season,
    row.game_date,
    row.away_team_name,
    row.home_team_name,
  ]);
}

export async function lockMatchupAssessment(client: PoolClient, matchup: Matchup): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock_shared($1::bigint)", [matchupLockKey(matchup)]);
}

function matchupLockKey(matchup: Matchup): string {
  return createHash("sha256")
    .update("record-correction-matchup:")
    .update(JSON.stringify(matchup))
    .digest()
    .readBigInt64BE()
    .toString();
}

export async function advanceMatchupGenerations(
  client: PoolClient,
  matchups: readonly Matchup[],
): Promise<void> {
  for (const matchup of matchups) {
    await client.query(
      `INSERT INTO record_correction.matchup_generations AS m
       (season,game_date,away_team_name,home_team_name,generation) VALUES ($1,$2,$3,$4,1)
       ON CONFLICT (season,game_date,away_team_name,home_team_name)
       DO UPDATE SET generation=m.generation+1`,
      [...matchup],
    );
  }
}

export function matchesRecordCorrectionDoubleheader(
  sourceGameId: string,
  doubleheaderNumber: number | null,
): boolean {
  return (
    doubleheaderNumber === null || sourceDoubleheaderNumber(sourceGameId) === doubleheaderNumber
  );
}

function sourceDoubleheaderNumber(sourceGameId: string): number | null {
  const explicit = /(?:DH|_)([12])(?:_|$)/i.exec(sourceGameId)?.[1];
  if (explicit !== undefined) return Number(explicit);
  const naverGameNumber = /([12])\d{4}$/.exec(sourceGameId)?.[1];
  return naverGameNumber === undefined ? null : Number(naverGameNumber);
}
