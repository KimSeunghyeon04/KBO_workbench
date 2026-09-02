-- KBO official record-correction monitoring and review contract V1.
CREATE SCHEMA IF NOT EXISTS record_correction;

ALTER TABLE workbench.contract_metadata
  ADD COLUMN record_correction_contract_version INTEGER NOT NULL DEFAULT 1
  CHECK (record_correction_contract_version = 1);

CREATE TABLE record_correction.collection_runs (
  run_id TEXT PRIMARY KEY,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','scheduled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','cancelling','cancelled','succeeded','failed','no_change')),
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error_category TEXT NULL CHECK (error_category IN ('source','domain','persistence')),
  error_message TEXT NULL
);

CREATE TABLE record_correction.collection_run_seasons (
  run_id TEXT NOT NULL REFERENCES record_correction.collection_runs(run_id) ON DELETE CASCADE,
  season INTEGER NOT NULL CHECK (season >= 1982),
  season_order INTEGER NOT NULL CHECK (season_order >= 0),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','no_change')),
  source_bundle_hash TEXT NULL CHECK (
    source_bundle_hash IS NULL OR source_bundle_hash ~ '^[0-9a-f]{64}$'),
  imported_revision INTEGER NULL CHECK (imported_revision >= 1),
  notice_count INTEGER NOT NULL DEFAULT 0 CHECK (notice_count >= 0),
  PRIMARY KEY (run_id,season),
  UNIQUE (run_id,season_order)
);

CREATE TABLE record_correction.season_current_revisions (
  season INTEGER PRIMARY KEY CHECK (season >= 1982),
  current_revision INTEGER NULL
);

CREATE TABLE record_correction.season_revisions (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  run_id TEXT NOT NULL REFERENCES record_correction.collection_runs(run_id),
  source_bundle_hash TEXT NOT NULL CHECK (source_bundle_hash ~ '^[0-9a-f]{64}$'),
  source_page_count INTEGER NOT NULL CHECK (source_page_count > 0),
  notice_count INTEGER NOT NULL CHECK (notice_count >= 0),
  sealed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sealed_at TIMESTAMPTZ NULL,
  PRIMARY KEY (season,revision),
  UNIQUE (run_id,season),
  FOREIGN KEY (season) REFERENCES record_correction.season_current_revisions(season)
);

ALTER TABLE record_correction.season_current_revisions
  ADD CONSTRAINT record_correction_current_revision_fk
  FOREIGN KEY (season,current_revision)
  REFERENCES record_correction.season_revisions(season,revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE record_correction.source_pages (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  page_sequence INTEGER NOT NULL CHECK (page_sequence >= 0),
  page_kind TEXT NOT NULL CHECK (page_kind IN ('landing','control','records')),
  request_key TEXT NOT NULL,
  series_id INTEGER NULL CHECK (series_id >= 0),
  page_number INTEGER NULL CHECK (page_number >= 1),
  artifact_key TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  collected_at TIMESTAMPTZ NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  total_count INTEGER NULL CHECK (total_count >= 0),
  PRIMARY KEY (season,revision,page_sequence),
  UNIQUE (season,revision,request_key),
  FOREIGN KEY (season,revision)
    REFERENCES record_correction.season_revisions ON DELETE CASCADE
);

CREATE TABLE record_correction.notices (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  notice_sequence INTEGER NOT NULL CHECK (notice_sequence >= 0),
  notice_id TEXT NOT NULL,
  notice_hash TEXT NOT NULL CHECK (notice_hash ~ '^[0-9a-f]{64}$'),
  source_page_sequence INTEGER NOT NULL,
  source_row_index INTEGER NOT NULL CHECK (source_row_index >= 0),
  series_id INTEGER NOT NULL CHECK (series_id >= 0),
  series_name TEXT NOT NULL,
  record_number INTEGER NOT NULL CHECK (record_number >= 1),
  game_date DATE NOT NULL,
  weekday_text TEXT NOT NULL,
  away_team_name TEXT NOT NULL,
  home_team_name TEXT NOT NULL,
  doubleheader_number INTEGER NULL CHECK (doubleheader_number BETWEEN 1 AND 2),
  venue_name TEXT NOT NULL,
  inning INTEGER NOT NULL CHECK (inning >= 1),
  half TEXT NOT NULL CHECK (half IN ('top','bottom')),
  batting_order INTEGER NOT NULL CHECK (batting_order BETWEEN 1 AND 9),
  decision_before TEXT NOT NULL CHECK (decision_before IN ('hit','error','fielder_choice','unknown')),
  decision_after TEXT NOT NULL CHECK (decision_after IN ('hit','error','fielder_choice','unknown')),
  before_record_text TEXT NOT NULL,
  after_record_text TEXT NOT NULL,
  content_text TEXT NOT NULL,
  correction_date_text TEXT NOT NULL,
  PRIMARY KEY (season,revision,notice_sequence),
  UNIQUE (season,revision,notice_id),
  FOREIGN KEY (season,revision,source_page_sequence)
    REFERENCES record_correction.source_pages(season,revision,page_sequence)
);

CREATE TABLE record_correction.notice_participants (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  notice_sequence INTEGER NOT NULL,
  participant_index INTEGER NOT NULL CHECK (participant_index >= 0),
  raw_team_name TEXT NULL,
  raw_player_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('batter','pitcher','fielder','unknown')),
  parenthesized BOOLEAN NOT NULL,
  PRIMARY KEY (season,revision,notice_sequence,participant_index),
  FOREIGN KEY (season,revision,notice_sequence)
    REFERENCES record_correction.notices ON DELETE CASCADE
);

CREATE TABLE record_correction.notice_stat_changes (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  notice_sequence INTEGER NOT NULL,
  stat_index INTEGER NOT NULL CHECK (stat_index >= 0),
  participant_index INTEGER NULL,
  raw_stat_name TEXT NOT NULL,
  stat_code TEXT NOT NULL CHECK (stat_code IN
    ('plate_appearances','at_bats','runs','hits','doubles','triples','home_runs',
     'runs_batted_in','walks','intentional_walks','hit_by_pitch','strikeouts',
     'sacrifice_bunts','sacrifice_flies','batters_faced','outs_pitched',
     'hits_allowed','runs_allowed','earned_runs','walks_allowed',
     'intentional_walks_allowed','hit_batters','strikeouts_pitched','pitches',
     'strikes','total_bases','fielding_errors','pitcher_at_bats',
     'pitcher_sacrifice_bunts','unknown')),
  scope TEXT NOT NULL CHECK (scope IN ('batter','pitcher','fielder','unknown')),
  before_value INTEGER NOT NULL CHECK (before_value >= 0),
  after_value INTEGER NOT NULL CHECK (after_value >= 0),
  support_kind TEXT NOT NULL CHECK (support_kind IN
    ('direct','derived','evidence_only','unknown')),
  PRIMARY KEY (season,revision,notice_sequence,stat_index),
  FOREIGN KEY (season,revision,notice_sequence)
    REFERENCES record_correction.notices ON DELETE CASCADE,
  FOREIGN KEY (season,revision,notice_sequence,participant_index)
    REFERENCES record_correction.notice_participants
);

CREATE TABLE record_correction.match_assessments (
  notice_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  notice_sequence INTEGER NOT NULL,
  case_version INTEGER NOT NULL CHECK (case_version >= 1),
  status TEXT NOT NULL CHECK (status IN
    ('action_required','already_applied','manual_review','unmatched','resolved','dismissed')),
  game_id TEXT NULL,
  game_revision INTEGER NULL,
  document_hash TEXT NULL CHECK (document_hash IS NULL OR document_hash ~ '^[0-9a-f]{64}$'),
  event_id TEXT NULL,
  batter_player_id TEXT NULL,
  pitcher_player_id TEXT NULL,
  reason_code TEXT NOT NULL,
  reason_message TEXT NOT NULL,
  proposal_hash TEXT NULL CHECK (proposal_hash IS NULL OR proposal_hash ~ '^[0-9a-f]{64}$'),
  approved_document_hash TEXT NULL CHECK (
    approved_document_hash IS NULL OR approved_document_hash ~ '^[0-9a-f]{64}$'),
  applied_revision INTEGER NULL CHECK (applied_revision >= 1),
  assessed_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (season,source_revision,notice_sequence)
    REFERENCES record_correction.notices(season,revision,notice_sequence),
  FOREIGN KEY (game_id,game_revision)
    REFERENCES workbench.game_revisions(game_id,revision)
);

CREATE TABLE record_correction.match_candidates (
  notice_id TEXT NOT NULL REFERENCES record_correction.match_assessments ON DELETE CASCADE,
  case_version INTEGER NOT NULL CHECK (case_version >= 1),
  candidate_id TEXT NOT NULL,
  candidate_order INTEGER NOT NULL CHECK (candidate_order >= 0),
  game_id TEXT NOT NULL,
  game_revision INTEGER NOT NULL,
  document_hash TEXT NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  event_id TEXT NULL,
  batter_player_id TEXT NULL,
  pitcher_player_id TEXT NULL,
  label TEXT NOT NULL,
  confidence_reason TEXT NOT NULL,
  PRIMARY KEY (notice_id,case_version,candidate_id),
  UNIQUE (notice_id,case_version,candidate_order),
  FOREIGN KEY (game_id,game_revision)
    REFERENCES workbench.game_revisions(game_id,revision)
);

CREATE TABLE record_correction.review_actions (
  notice_id TEXT NOT NULL,
  action_sequence INTEGER NOT NULL CHECK (action_sequence >= 1),
  case_version INTEGER NOT NULL CHECK (case_version >= 1),
  action_kind TEXT NOT NULL CHECK (action_kind IN
    ('select_candidate','dismiss','reopen','proposal_applied','resolved')),
  candidate_id TEXT NULL,
  reason TEXT NULL,
  session_id TEXT NULL,
  proposal_hash TEXT NULL CHECK (proposal_hash IS NULL OR proposal_hash ~ '^[0-9a-f]{64}$'),
  document_hash TEXT NULL CHECK (document_hash IS NULL OR document_hash ~ '^[0-9a-f]{64}$'),
  applied_revision INTEGER NULL CHECK (applied_revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notice_id,action_sequence),
  FOREIGN KEY (notice_id) REFERENCES record_correction.match_assessments,
  FOREIGN KEY (notice_id,case_version,candidate_id)
    REFERENCES record_correction.match_candidates(notice_id,case_version,candidate_id)
);

CREATE INDEX record_correction_assessment_status_idx
  ON record_correction.match_assessments(status,season,assessed_at DESC);
CREATE INDEX record_correction_assessment_game_idx
  ON record_correction.match_assessments(game_id,game_revision);
CREATE INDEX record_correction_notice_date_idx
  ON record_correction.notices(season,game_date,away_team_name,home_team_name);

CREATE OR REPLACE FUNCTION record_correction.reject_sealed_revision_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM record_correction.season_revisions r
    WHERE r.season=COALESCE(NEW.season,OLD.season)
      AND r.revision=COALESCE(NEW.revision,OLD.revision) AND r.sealed
  ) THEN RAISE EXCEPTION 'sealed record correction revision facts are immutable'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE OR REPLACE FUNCTION record_correction.reject_sealed_manifest_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed THEN RAISE EXCEPTION 'sealed record correction revision is immutable'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE OR REPLACE FUNCTION record_correction.reject_append_only_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'record correction review actions are append-only';
END $$;

CREATE TRIGGER reject_sealed_record_correction_manifest_write
BEFORE UPDATE OR DELETE ON record_correction.season_revisions
FOR EACH ROW EXECUTE FUNCTION record_correction.reject_sealed_manifest_write();

DO $$
DECLARE table_ref TEXT;
BEGIN
  FOREACH table_ref IN ARRAY ARRAY[
    'record_correction.source_pages','record_correction.notices',
    'record_correction.notice_participants','record_correction.notice_stat_changes'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER reject_sealed_record_correction_write BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION record_correction.reject_sealed_revision_write()',
      table_ref
    );
  END LOOP;
END $$;

CREATE TRIGGER reject_record_correction_review_action_mutation
BEFORE UPDATE OR DELETE ON record_correction.review_actions
FOR EACH ROW EXECUTE FUNCTION record_correction.reject_append_only_write();

REVOKE ALL ON SCHEMA record_correction FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA record_correction FROM PUBLIC;
