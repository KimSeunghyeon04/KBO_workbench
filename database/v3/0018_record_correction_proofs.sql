ALTER TABLE record_correction.review_actions
  ADD COLUMN verified_matchup_generation INTEGER CHECK (verified_matchup_generation >= 0);

CREATE TABLE workbench.import_publications (
  job_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  target_hash TEXT NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (game_id, revision),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions (game_id, revision)
);

CREATE OR REPLACE VIEW record_correction.active_review_actions AS
SELECT r.* FROM record_correction.review_actions r
JOIN record_correction.match_assessments a ON a.notice_id=r.notice_id AND a.active
WHERE r.notice_publication=a.publication OR (
  r.notice_publication IS NULL AND a.publication=1
  AND r.created_at > a.legacy_publication_started_at
);

CREATE OR REPLACE VIEW record_correction.active_proposal_approvals AS
SELECT r.notice_id,r.action_sequence,r.document_hash,r.proposal_hash,
       COALESCE(r.target_decision_sequence,l.decision_sequence) AS target_decision_sequence,
       COALESCE(r.target_game_id,l.game_id) AS target_game_id,
       COALESCE(r.target_game_revision,l.base_revision) AS target_game_revision,
       COALESCE(r.target_document_hash,l.base_document_hash) AS target_document_hash,
       COALESCE(r.target_event_id,l.event_id) AS target_event_id,
       r.verified_matchup_generation
FROM record_correction.active_review_actions r
JOIN record_correction.match_assessments a ON a.notice_id=r.notice_id
LEFT JOIN record_correction.legacy_approval_targets l ON (l.notice_id,l.action_sequence)=(r.notice_id,r.action_sequence)
WHERE r.action_kind='proposal_applied' AND (r.notice_publication IS NOT NULL OR l.publication=a.publication);

CREATE FUNCTION workbench.reject_import_publication_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'import publication is append-only';
END;
$$;
CREATE TRIGGER reject_import_publication_mutation
BEFORE UPDATE OR DELETE ON workbench.import_publications
FOR EACH ROW EXECUTE FUNCTION workbench.reject_import_publication_mutation();
