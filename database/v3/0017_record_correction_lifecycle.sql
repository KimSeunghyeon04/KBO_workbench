CREATE TABLE record_correction.matchup_generations (
  season INTEGER NOT NULL,
  game_date DATE NOT NULL,
  away_team_name TEXT NOT NULL,
  home_team_name TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  PRIMARY KEY (season,game_date,away_team_name,home_team_name)
);

ALTER TABLE record_correction.match_assessments
  ADD COLUMN publication INTEGER NOT NULL DEFAULT 1 CHECK (publication >= 1),
  ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN legacy_publication_started_at TIMESTAMPTZ,
  ADD COLUMN decision_sequence INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN checked_decision_sequence INTEGER,
  ADD COLUMN checked_matchup_generation INTEGER;

-- Legacy reviews are usable only inside the uninterrupted publication visible at migration.
UPDATE record_correction.match_assessments a
SET active=c.current_revision=a.source_revision,
    legacy_publication_started_at=(
      SELECT MIN(r.sealed_at)
      FROM record_correction.season_revisions r
      WHERE r.season=a.season AND r.sealed AND r.revision <= a.source_revision
        AND r.revision > COALESCE((
          SELECT MAX(previous.revision)
          FROM record_correction.season_revisions previous
          WHERE previous.season=a.season AND previous.sealed
            AND previous.revision < a.source_revision AND NOT EXISTS (
              SELECT 1 FROM record_correction.notices n
              WHERE n.season=a.season AND n.revision=previous.revision
                AND n.notice_id=a.notice_id AND n.notice_hash=current_notice.notice_hash
            )
        ),0)
    )
FROM record_correction.season_current_revisions c, record_correction.notices current_notice
WHERE c.season=a.season AND current_notice.season=a.season
  AND current_notice.revision=a.source_revision AND current_notice.notice_sequence=a.notice_sequence;

ALTER TABLE record_correction.review_actions
  ADD COLUMN notice_publication INTEGER,
  ADD COLUMN target_decision_sequence INTEGER,
  ADD COLUMN target_game_id TEXT,
  ADD COLUMN target_game_revision INTEGER,
  ADD COLUMN target_document_hash TEXT,
  ADD COLUMN target_event_id TEXT,
  ADD CONSTRAINT record_correction_review_target_fk
    FOREIGN KEY (target_game_id,target_game_revision)
    REFERENCES workbench.game_revisions(game_id,revision);

CREATE VIEW record_correction.active_review_actions AS
SELECT r.* FROM record_correction.review_actions r
JOIN record_correction.match_assessments a ON a.notice_id=r.notice_id AND a.active
WHERE r.notice_publication=a.publication OR (
  r.notice_publication IS NULL AND a.publication=1
  AND r.created_at > a.legacy_publication_started_at
);

UPDATE record_correction.match_assessments a
SET decision_sequence=COALESCE((
  SELECT MAX(r.action_sequence) FROM record_correction.active_review_actions r
  WHERE r.notice_id=a.notice_id AND r.action_kind IN ('select_candidate','dismiss','reopen')
),0);

CREATE VIEW record_correction.active_assessments AS
SELECT a.*,n.notice_hash,n.doubleheader_number,
       COALESCE(m.generation,0) AS matchup_generation,
       a.checked_matchup_generation IS NOT DISTINCT FROM COALESCE(m.generation,0)
         AND a.checked_decision_sequence IS NOT DISTINCT FROM a.decision_sequence AS assessment_current,
       CASE WHEN a.status='dismissed' OR (
         a.checked_matchup_generation IS NOT DISTINCT FROM COALESCE(m.generation,0)
         AND a.checked_decision_sequence IS NOT DISTINCT FROM a.decision_sequence
       ) THEN a.status ELSE 'manual_review' END AS effective_status
FROM record_correction.match_assessments a
JOIN record_correction.notices n ON (n.season,n.revision,n.notice_sequence)=
  (a.season,a.source_revision,a.notice_sequence)
LEFT JOIN record_correction.matchup_generations m ON (m.season,m.game_date,m.away_team_name,m.home_team_name)=
  (EXTRACT(YEAR FROM n.game_date)::integer,n.game_date,n.away_team_name,n.home_team_name)
WHERE a.active;

-- Existing approvals without an exact provable target stay in the audit. The import guard
-- treats affected unsealed work from the old writer as requiring explicit review.
CREATE TABLE record_correction.legacy_approval_targets (
  notice_id TEXT NOT NULL,
  action_sequence INTEGER NOT NULL,
  publication INTEGER NOT NULL,
  decision_sequence INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  base_document_hash TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (notice_id,action_sequence),
  FOREIGN KEY (notice_id,action_sequence)
    REFERENCES record_correction.review_actions(notice_id,action_sequence),
  FOREIGN KEY (game_id,base_revision) REFERENCES workbench.game_revisions(game_id,revision)
);
INSERT INTO record_correction.legacy_approval_targets
  (notice_id,action_sequence,publication,decision_sequence,game_id,base_revision,base_document_hash,event_id)
SELECT a.notice_id,r.action_sequence,a.publication,a.decision_sequence,a.game_id,a.game_revision,a.document_hash,a.event_id
FROM record_correction.match_assessments a
JOIN workbench.games g ON g.game_id=a.game_id AND g.current_revision=a.game_revision
JOIN workbench.game_revisions base ON base.game_id=g.game_id AND base.revision=g.current_revision
  AND base.sealed AND base.document_hash=a.document_hash
JOIN LATERAL (
  SELECT action.* FROM record_correction.active_review_actions action
  WHERE action.notice_id=a.notice_id ORDER BY action_sequence DESC LIMIT 1
) r ON r.action_kind='proposal_applied' AND r.case_version=a.case_version
  AND r.action_sequence > a.decision_sequence AND r.document_hash IS NOT NULL
WHERE a.active AND a.status NOT IN ('dismissed','resolved') AND a.event_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM record_correction.match_candidates c
    WHERE c.notice_id=a.notice_id AND c.case_version=a.case_version AND c.game_id=a.game_id
      AND c.game_revision=a.game_revision AND c.event_id=a.event_id AND c.document_hash=a.document_hash
  );

CREATE VIEW record_correction.active_proposal_approvals AS
SELECT r.notice_id,r.action_sequence,r.document_hash,r.proposal_hash,
       COALESCE(r.target_decision_sequence,l.decision_sequence) AS target_decision_sequence,
       COALESCE(r.target_game_id,l.game_id) AS target_game_id,
       COALESCE(r.target_game_revision,l.base_revision) AS target_game_revision,
       COALESCE(r.target_document_hash,l.base_document_hash) AS target_document_hash,
       COALESCE(r.target_event_id,l.event_id) AS target_event_id
FROM record_correction.active_review_actions r
JOIN record_correction.match_assessments a ON a.notice_id=r.notice_id
LEFT JOIN record_correction.legacy_approval_targets l ON (l.notice_id,l.action_sequence)=(r.notice_id,r.action_sequence)
WHERE r.action_kind='proposal_applied' AND (r.notice_publication IS NOT NULL OR l.publication=a.publication);

CREATE TABLE record_correction.legacy_unverified_games (
  game_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  PRIMARY KEY (game_id,base_revision),
  FOREIGN KEY (game_id,base_revision) REFERENCES workbench.game_revisions(game_id,revision)
);

INSERT INTO record_correction.legacy_unverified_games (game_id,base_revision)
SELECT DISTINCT g.game_id,g.current_revision
FROM record_correction.review_actions r
JOIN record_correction.match_candidates c ON c.notice_id=r.notice_id AND c.case_version=r.case_version
JOIN workbench.games g ON g.game_id=c.game_id AND g.current_revision=c.game_revision
WHERE r.action_kind='proposal_applied' AND r.notice_publication IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM workbench.game_revisions sealed
    WHERE sealed.game_id=g.game_id AND sealed.sealed AND sealed.document_hash=r.document_hash
  );

CREATE INDEX record_correction_review_document_idx
  ON record_correction.review_actions (document_hash) WHERE action_kind='proposal_applied';

UPDATE record_correction.match_assessments a
SET status='manual_review',reason_code='awaiting_assessment',
    reason_message='현재 공지 발행의 검토 근거를 확인합니다.'
WHERE a.active AND a.status='dismissed' AND NOT EXISTS (
  SELECT 1 FROM record_correction.active_review_actions r WHERE r.notice_id=a.notice_id
    AND r.action_kind='dismiss' AND r.action_sequence=a.decision_sequence
);
