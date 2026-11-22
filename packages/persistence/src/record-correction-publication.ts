import type { RecordCorrectionApprovalReference } from "@kbo/contracts";
import type { Pool, PoolClient } from "pg";
import {
  readMatchupCandidates,
  matchesRecordCorrectionDoubleheader,
  type Matchup,
} from "./record-correction-matchups.js";
import type { RecordCorrectionApprovalEvidence } from "./record-correction-types.js";
import { RevisionConflictError } from "./revision-types.js";

interface VerifiedApproval extends RecordCorrectionApprovalEvidence {
  readonly matchupGeneration: number;
  readonly verifiedGeneration: number;
  readonly doubleheaderNumber: number | null;
  readonly explicitlySelected: boolean;
  readonly season: number;
  readonly gameDate: string;
  readonly awayTeamName: string;
  readonly homeTeamName: string;
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
       EXISTS (
         SELECT 1 FROM record_correction.active_review_actions decision
         JOIN record_correction.match_candidates candidate
           ON (candidate.notice_id,candidate.case_version,candidate.candidate_id)=
              (decision.notice_id,decision.case_version,decision.candidate_id)
         WHERE decision.notice_id=a.notice_id AND decision.action_kind='select_candidate'
           AND candidate.game_id=r.target_game_id AND candidate.event_id=r.target_event_id
       ) AS "explicitlySelected"
     FROM unnest($1::text[],$2::integer[]) WITH ORDINALITY AS refs(notice_id,action_sequence,ord)
     JOIN record_correction.active_proposal_approvals r USING (notice_id,action_sequence)
     JOIN record_correction.active_assessments a ON a.notice_id=r.notice_id
       AND a.decision_sequence=r.target_decision_sequence
     JOIN record_correction.notices n ON (n.season,n.revision,n.notice_sequence)=
       (a.season,a.source_revision,a.notice_sequence)
     WHERE r.verified_matchup_generation IS NOT NULL AND a.status <> 'dismissed'
     ORDER BY refs.ord`,
    [references.map((ref) => ref.noticeId), references.map((ref) => ref.actionSequence)],
  );
  return result.rows;
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
  for (const row of evidence) {
    if (
      row.matchupGeneration !== (verifiedMatchupGeneration ?? row.verifiedGeneration) ||
      row.gameId !== gameId ||
      row.revision !== baseRevision ||
      row.documentHash !== documentHash
    ) {
      throw staleApproval();
    }
    const matchup = matchups.find(
      (scope) =>
        scope[0] === row.season &&
        scope[1] === row.gameDate &&
        scope[2] === row.awayTeamName &&
        scope[3] === row.homeTeamName,
    );
    if (matchup === undefined) throw staleApproval();
    const games = (await readMatchupCandidates(client, matchup)).filter((game) =>
      matchesRecordCorrectionDoubleheader(game.sourceGameId, row.doubleheaderNumber),
    );
    if (
      (!row.explicitlySelected && games.length !== 1) ||
      !games.some(
        (game) =>
          game.gameId === gameId &&
          game.revision === baseRevision &&
          game.documentHash === row.baseHash,
      )
    ) {
      throw staleApproval();
    }
  }
}

function staleApproval(): RevisionConflictError {
  return new RevisionConflictError(
    "현재 작업 사본의 KBO 기록정정 승인을 확인할 수 없습니다. 저장한 정정 내용과 공지를 다시 검토하세요.",
  );
}
