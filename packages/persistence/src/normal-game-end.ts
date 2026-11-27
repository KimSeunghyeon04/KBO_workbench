// r is the game revision and f is its final-state row.
export const normalGameEndSql = `(r.game_status='final' AND r.scheduled_innings=9 AND f.final_inning>=9
  AND NOT EXISTS (
    SELECT 1 FROM workbench.relay_administrative a
    WHERE a.game_id=r.game_id AND a.revision=r.revision
      AND a.administrative_code IN ('called_game','forfeit')
  )
  AND NOT EXISTS (
    SELECT 1 FROM baseball.plate_appearance_facts pa
    WHERE pa.game_id=r.game_id AND pa.revision=r.revision
      AND pa.termination_reason IN ('called_game','forfeit')
  ))`;
