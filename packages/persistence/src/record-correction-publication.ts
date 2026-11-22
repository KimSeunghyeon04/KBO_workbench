import type { RecordCorrectionApprovalReference } from "@kbo/contracts";
import type { Pool, PoolClient } from "pg";
import {
  readMatchupCandidates,
  recordCorrectionEligibleGames,
  type Matchup,
} from "./record-correction-matchups.js";
import type {
  RecordCorrectionApprovalEvidence,
  RecordCorrectionApprovalHistory,
  RecordCorrectionGameCandidate,
} from "./record-correction-types.js";
import { RevisionConflictError } from "./revision-types.js";

interface VerifiedApproval extends RecordCorrectionApprovalEvidence {
  readonly matchupGeneration: number;
  readonly verifiedGeneration: number;
  readonly doubleheaderNumber: number | null;
  readonly hasSelection: boolean;
  readonly selectedGameId: string | null;
  readonly selectedEventId: string | null;
  readonly season: number;
  readonly gameDate: string;
  readonly awayTeamName: string;
  readonly homeTeamName: string;
}

export function currentRecordCorrectionSelectionSql(noticeId: "$1" | "a.notice_id"): string {
  return `SELECT case_version,candidate_id,action_sequence
    FROM record_correction.active_review_actions
    WHERE notice_id=${noticeId} AND action_kind='select_candidate'
    ORDER BY action_sequence DESC LIMIT 1`;
}

export async function readApprovalEvidence(
  client: Pool | PoolClient,
  references: readonly RecordCorrectionApprovalReference[],
): Promise<VerifiedApproval[]> {
  const result = await client.query<VerifiedApproval>(
    `SELECT r.notice_id AS "noticeId",r.action_sequence AS "actionSequence",
       r.target_game_id AS "gameId",r.target_game_revision AS revision,
       r.target_document_hash AS "baseHash",r.target_event_id AS "eventId",
       r.document_hash AS "documentHash",r.proposal_hash AS "proposalHash",
       a.matchup_generation AS "matchupGeneration",r.verified_matchup_generation AS "verifiedGeneration",
       n.doubleheader_number AS "doubleheaderNumber",a.season,
       to_char(n.game_date,'YYYY-MM-DD') AS "gameDate",
       n.away_team_name AS "awayTeamName",n.home_team_name AS "homeTeamName",
       decision.action_sequence IS NOT NULL AS "hasSelection",
       candidate.game_id AS "selectedGameId",candidate.event_id AS "selectedEventId"
     FROM unnest($1::text[],$2::integer[]) WITH ORDINALITY AS refs(notice_id,action_sequence,ord)
     JOIN record_correction.active_proposal_approvals r USING (notice_id,action_sequence)
     JOIN record_correction.active_assessments a ON a.notice_id=r.notice_id
       AND a.decision_sequence=r.target_decision_sequence
     JOIN record_correction.notices n ON (n.season,n.revision,n.notice_sequence)=
       (a.season,a.source_revision,a.notice_sequence)
     LEFT JOIN LATERAL (${currentRecordCorrectionSelectionSql("a.notice_id")}) decision ON true
     LEFT JOIN record_correction.match_candidates candidate
       ON (candidate.notice_id,candidate.case_version,candidate.candidate_id)=
          (a.notice_id,decision.case_version,decision.candidate_id)
     WHERE r.verified_matchup_generation IS NOT NULL AND a.status <> 'dismissed'
     ORDER BY refs.ord`,
    [references.map((ref) => ref.noticeId), references.map((ref) => ref.actionSequence)],
  );
  return result.rows;
}

export async function readApprovalHistory(
  client: Pool | PoolClient,
  references: readonly RecordCorrectionApprovalReference[],
  scope: Pick<RecordCorrectionApprovalEvidence, "gameId" | "revision" | "baseHash">,
  matchup: Matchup,
): Promise<RecordCorrectionApprovalHistory> {
  if (references.length === 0) return { active: [], recorded: [], unknown: false };
  const evidence = await readApprovalEvidence(client, references);
  const games = evidence.length > 0 ? await readMatchupCandidates(client, matchup) : [];
  const active: VerifiedApproval[] = [];
  let unknown = false;
  for (const proof of evidence) {
    const target = sameMatchup(proof, matchup) ? approvalTarget(proof, games) : "unknown";
    if (target === "current") active.push(proof);
    if (target === "unknown") unknown = true;
  }
  if (active.length === references.length) return { active, recorded: references, unknown };

  const recorded = await client.query<RecordCorrectionApprovalReference>(
    `SELECT r.notice_id AS "noticeId", r.action_sequence AS "actionSequence"
     FROM unnest($1::text[],$2::integer[]) WITH ORDINALITY AS refs(notice_id,action_sequence,ord)
     JOIN record_correction.review_actions r USING (notice_id,action_sequence)
     WHERE r.action_kind='proposal_applied' AND r.verified_matchup_generation IS NOT NULL
       AND r.target_game_id=$3 AND r.target_game_revision=$4 AND r.target_document_hash=$5
     ORDER BY refs.ord`,
    [
      references.map((ref) => ref.noticeId),
      references.map((ref) => ref.actionSequence),
      scope.gameId,
      scope.revision,
      scope.baseHash,
    ],
  );
  return { active, recorded: recorded.rows, unknown };
}

/** Called with the game and its publication matchups already locked. */
export async function validateCorrectionPublication(
  client: PoolClient,
  gameId: string,
  baseRevision: number | null,
  documentHash: string,
  matchups: readonly Matchup[],
  approvals: readonly RecordCorrectionApprovalReference[],
  fromIndependentSealedDraft: boolean,
  verifiedMatchupGeneration: number | undefined,
): Promise<void> {
  if (approvals.length === 0 && (baseRevision === null || fromIndependentSealedDraft)) return;
  if (approvals.length === 0) {
    const known = await client.query(
      `SELECT 1 FROM record_correction.review_actions
       WHERE document_hash=$1 AND action_kind='proposal_applied'
       UNION ALL SELECT 1 FROM record_correction.legacy_unverified_games
       WHERE game_id=$2 AND base_revision=$3 LIMIT 1`,
      [documentHash, gameId, baseRevision],
    );
    if (known.rows.length > 0) throw staleApproval();
    return;
  }
  const noticeIds = [...new Set(approvals.map((receipt) => receipt.noticeId))].sort();
  if (noticeIds.length !== approvals.length) throw staleApproval();
  await client.query(
    `SELECT notice_id FROM record_correction.match_assessments
     WHERE notice_id=ANY($1::text[]) ORDER BY notice_id COLLATE "C" FOR UPDATE`,
    [noticeIds],
  );
  const evidence = await readApprovalEvidence(client, approvals);
  if (evidence.length !== approvals.length) throw staleApproval();
  const candidates = new Map<Matchup, readonly RecordCorrectionGameCandidate[]>();
  for (const row of evidence) {
    if (
      row.matchupGeneration !== (verifiedMatchupGeneration ?? row.verifiedGeneration) ||
      row.gameId !== gameId ||
      row.revision !== baseRevision ||
      row.documentHash !== documentHash
    ) {
      throw staleApproval();
    }
    const matchup = matchups.find((scope) => sameMatchup(row, scope));
    if (matchup === undefined) throw staleApproval();
    let list = candidates.get(matchup);
    if (list === undefined) {
      list = await readMatchupCandidates(client, matchup);
      candidates.set(matchup, list);
    }
    if (approvalTarget(row, list) !== "current") throw staleApproval();
  }
}

function sameMatchup(row: VerifiedApproval, matchup: Matchup): boolean {
  return (
    matchup[0] === row.season &&
    matchup[1] === row.gameDate &&
    matchup[2] === row.awayTeamName &&
    matchup[3] === row.homeTeamName
  );
}

function approvalTarget(
  row: VerifiedApproval,
  games: readonly RecordCorrectionGameCandidate[],
): "current" | "expired" | "unknown" {
  if (row.hasSelection && (row.selectedGameId === null || row.selectedEventId === null))
    return "unknown";
  if (
    row.hasSelection &&
    (row.selectedGameId !== row.gameId || row.selectedEventId !== row.eventId)
  )
    return "expired";
  const candidates = recordCorrectionEligibleGames(
    games,
    row.doubleheaderNumber,
    row.selectedGameId,
  );
  if (
    !candidates.some(
      (game) =>
        game.gameId === row.gameId &&
        game.revision === row.revision &&
        game.documentHash === row.baseHash,
    )
  )
    return "unknown";
  return candidates.length === 1 ? "current" : "expired";
}

function staleApproval(): RevisionConflictError {
  return new RevisionConflictError(
    "현재 작업 사본의 KBO 기록정정 승인을 확인할 수 없습니다. 저장한 정정 내용과 공지를 다시 검토하세요.",
  );
}
