-- Fresh PostgreSQL 16 baseline for KBO Workbench database contract V3.
-- Apply only to an empty database; this is not an in-place V2 migration.
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS registry;
CREATE SCHEMA IF NOT EXISTS workbench;
CREATE SCHEMA IF NOT EXISTS baseball;
CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE workbench.contract_metadata (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  analytics_contract_version INTEGER NOT NULL CHECK (analytics_contract_version = 3),
  projection_version INTEGER NOT NULL CHECK (projection_version = 3),
  registry_contract_version INTEGER NOT NULL CHECK (registry_contract_version = 1)
);
INSERT INTO workbench.contract_metadata VALUES (TRUE, 3, 3, 1);

CREATE TABLE catalog.competitions (
  competition_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);
INSERT INTO catalog.competitions (competition_id,display_name) VALUES ('kbo','KBO 리그');

CREATE TABLE catalog.seasons (
  competition_id TEXT NOT NULL REFERENCES catalog.competitions,
  season INTEGER NOT NULL CHECK (season >= 1982),
  PRIMARY KEY (competition_id,season)
);
CREATE TABLE catalog.teams (
  team_id TEXT PRIMARY KEY,
  provisional BOOLEAN NOT NULL,
  merged_into_team_id TEXT NULL REFERENCES catalog.teams(team_id),
  CHECK (merged_into_team_id IS NULL OR merged_into_team_id <> team_id)
);
CREATE TABLE catalog.team_identities (
  identity_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('naver','kbo')),
  external_team_id TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES catalog.teams(team_id),
  UNIQUE (provider,external_team_id)
);
CREATE TABLE catalog.team_name_observations (
  identity_key TEXT NOT NULL REFERENCES catalog.team_identities(identity_key),
  observed_on DATE NOT NULL,
  display_name TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  PRIMARY KEY (identity_key,observed_on,display_name,source_ref)
);
CREATE TABLE catalog.team_seasons (
  competition_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  team_id TEXT NOT NULL REFERENCES catalog.teams(team_id),
  PRIMARY KEY (competition_id,season,team_id),
  FOREIGN KEY (competition_id,season) REFERENCES catalog.seasons
);
CREATE TABLE catalog.players (
  player_id TEXT PRIMARY KEY,
  provisional BOOLEAN NOT NULL,
  merged_into_player_id TEXT NULL REFERENCES catalog.players(player_id),
  CHECK (merged_into_player_id IS NULL OR merged_into_player_id <> player_id)
);
CREATE TABLE catalog.player_identities (
  identity_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('naver','kbo')),
  external_player_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES catalog.players(player_id),
  resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('official','exact_external_and_name','unique_context','provisional')),
  UNIQUE (provider,external_player_id)
);
CREATE TABLE catalog.player_name_observations (
  identity_key TEXT NOT NULL REFERENCES catalog.player_identities(identity_key),
  observed_on DATE NOT NULL,
  display_name TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  PRIMARY KEY (identity_key,observed_on,display_name,source_ref)
);
CREATE TABLE catalog.venues (
  venue_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  valid_from DATE NULL,
  valid_to DATE NULL,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_from < valid_to)
);
CREATE TABLE catalog.tracking_measurement_profiles (
  measurement_profile_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  valid_from DATE NULL,
  valid_to DATE NULL,
  horizontal_unit TEXT NOT NULL,
  vertical_unit TEXT NOT NULL,
  velocity_unit TEXT NOT NULL,
  acceleration_unit TEXT NOT NULL,
  plate_reference TEXT NOT NULL,
  zone_formula_version INTEGER NULL,
  supports_zone BOOLEAN NOT NULL,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_from < valid_to),
  CHECK ((supports_zone AND zone_formula_version IS NOT NULL)
      OR (NOT supports_zone AND zone_formula_version IS NULL))
);
INSERT INTO catalog.tracking_measurement_profiles
  (measurement_profile_id,provider,valid_from,valid_to,horizontal_unit,vertical_unit,
   velocity_unit,acceleration_unit,plate_reference,zone_formula_version,supports_zone)
VALUES
  ('naver_pts_v1','naver',NULL,NULL,'foot','foot','foot_per_second',
   'foot_per_second_squared','provider_cross_plate',1,TRUE);

CREATE TABLE workbench.games (
  game_id TEXT PRIMARY KEY,
  current_revision INTEGER NULL
);

CREATE TABLE workbench.game_revisions (
  game_id TEXT NOT NULL REFERENCES workbench.games(game_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  parent_revision INTEGER NULL,
  base_document_hash TEXT NULL CHECK (base_document_hash IS NULL OR base_document_hash ~ '^[0-9a-f]{64}$'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
  provider TEXT NOT NULL CHECK (provider = 'naver'),
  source_game_id TEXT NOT NULL,
  source_bundle_hash TEXT NOT NULL CHECK (source_bundle_hash ~ '^[0-9a-f]{64}$'),
  collected_at_text TEXT NOT NULL,
  season INTEGER NOT NULL CHECK (season >= 1982),
  game_date DATE NOT NULL,
  scheduled_at_text TEXT NULL,
  game_status TEXT NOT NULL CHECK (game_status IN ('scheduled','in_progress','final','suspended','cancelled')),
  stadium TEXT NULL,
  scheduled_innings INTEGER NOT NULL CHECK (scheduled_innings > 0),
  document_hash TEXT NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  projection_hash TEXT NOT NULL CHECK (projection_hash ~ '^[0-9a-f]{64}$'),
  projection_version INTEGER NOT NULL CHECK (projection_version = 3),
  sealed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sealed_at TIMESTAMPTZ NULL,
  PRIMARY KEY (game_id, revision),
  FOREIGN KEY (game_id, parent_revision)
    REFERENCES workbench.game_revisions(game_id, revision) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((revision = 1 AND parent_revision IS NULL AND base_document_hash IS NULL)
      OR (revision > 1 AND parent_revision = revision - 1 AND base_document_hash IS NOT NULL))
);
ALTER TABLE workbench.games ADD CONSTRAINT games_current_revision_fk
  FOREIGN KEY (game_id, current_revision)
  REFERENCES workbench.game_revisions(game_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE workbench.game_team_snapshots (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, side TEXT NOT NULL CHECK (side IN ('away','home')),
  team_id TEXT NOT NULL,
  team_identity_key TEXT GENERATED ALWAYS AS ('naver:' || team_id) STORED,
  team_name TEXT NOT NULL,
  PRIMARY KEY (game_id, revision, side),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE,
  FOREIGN KEY (team_identity_key) REFERENCES catalog.team_identities(identity_key)
);
CREATE TABLE workbench.game_roster_snapshots (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, side TEXT NOT NULL CHECK (side IN ('away','home')),
  roster_index INTEGER NOT NULL CHECK (roster_index >= 0), player_id TEXT NOT NULL,
  player_identity_key TEXT GENERATED ALWAYS AS ('naver:' || player_id) STORED,
  player_name TEXT NOT NULL,
  batting_order INTEGER NULL CHECK (batting_order BETWEEN 1 AND 9), starter BOOLEAN NOT NULL,
  PRIMARY KEY (game_id, revision, side, roster_index),
  UNIQUE (game_id, revision, side, player_id),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE,
  FOREIGN KEY (player_identity_key) REFERENCES catalog.player_identities(identity_key)
);
CREATE TABLE workbench.game_roster_positions (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, side TEXT NOT NULL,
  roster_index INTEGER NOT NULL, position_index INTEGER NOT NULL CHECK (position_index >= 0),
  position TEXT NOT NULL,
  PRIMARY KEY (game_id, revision, side, roster_index, position_index),
  FOREIGN KEY (game_id, revision, side, roster_index)
    REFERENCES workbench.game_roster_snapshots ON DELETE CASCADE
);

CREATE TABLE workbench.relay_event_facts (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL,
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0), event_id TEXT NOT NULL,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('source','manual')),
  source_endpoint TEXT NULL, source_block_index INTEGER NULL, source_event_index INTEGER NULL,
  source_event_id TEXT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('half_inning_start','batter_start','pitch','plate_result','runner_advance','substitution','review','administrative','unresolved')),
  inning INTEGER NOT NULL CHECK (inning > 0), half TEXT NOT NULL CHECK (half IN ('top','bottom')),
  relay_text TEXT NULL,
  observed_balls INTEGER NULL, observed_strikes INTEGER NULL, observed_outs INTEGER NULL,
  observed_base1 TEXT NULL, observed_base2 TEXT NULL, observed_base3 TEXT NULL,
  observed_away_score INTEGER NULL, observed_home_score INTEGER NULL,
  PRIMARY KEY (game_id, revision, event_sequence),
  UNIQUE (game_id, revision, event_id),
  UNIQUE (game_id, revision, event_sequence, event_id),
  UNIQUE (game_id, revision, event_sequence, event_id, kind),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE,
  CHECK ((identity_kind='source' AND source_endpoint IS NOT NULL AND source_block_index IS NOT NULL AND source_event_index IS NOT NULL)
      OR (identity_kind='manual' AND source_endpoint IS NULL AND source_block_index IS NULL AND source_event_index IS NULL AND source_event_id IS NULL))
);

CREATE TABLE workbench.relay_half_inning_starts (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'half_inning_start' CHECK (kind='half_inning_start'),
  PRIMARY KEY (game_id, revision, event_sequence),
  FOREIGN KEY (game_id, revision, event_sequence, event_id, kind)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id, kind) ON DELETE CASCADE
);
CREATE TABLE workbench.relay_batter_starts (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'batter_start' CHECK (kind='batter_start'),
  batter_id TEXT NOT NULL, pitcher_id TEXT NOT NULL,
  PRIMARY KEY (game_id, revision, event_sequence),
  FOREIGN KEY (game_id, revision, event_sequence, event_id, kind)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id, kind) ON DELETE CASCADE
);
CREATE TABLE workbench.relay_pitches (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'pitch' CHECK (kind='pitch'),
  source_pitch_id TEXT NULL, pitch_call TEXT NOT NULL, batter_id TEXT NULL, pitcher_id TEXT NULL,
  PRIMARY KEY (game_id, revision, event_sequence),
  FOREIGN KEY (game_id, revision, event_sequence, event_id, kind)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id, kind) ON DELETE CASCADE
);
CREATE TABLE workbench.relay_plate_results (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'plate_result' CHECK (kind='plate_result'),
  plate_result TEXT NOT NULL, batter_id TEXT NOT NULL, pitcher_id TEXT NOT NULL,
  credited_rbi INTEGER NULL, outs_recorded INTEGER NULL, batter_destination INTEGER NULL,
  batted_ball_type TEXT NULL, is_bunt BOOLEAN NULL,
  PRIMARY KEY (game_id, revision, event_sequence),
  FOREIGN KEY (game_id, revision, event_sequence, event_id, kind)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id, kind) ON DELETE CASCADE
);
CREATE TABLE workbench.relay_runner_advances (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'runner_advance' CHECK (kind='runner_advance'),
  runner_id TEXT NOT NULL, from_base INTEGER NOT NULL, to_base INTEGER NOT NULL,
  runner_outcome TEXT NOT NULL, runner_out_kind TEXT NULL, supersedes_third_out BOOLEAN NULL,
  responsible_pitcher_id TEXT NULL, runner_context_kind TEXT NOT NULL,
  plate_result_event_id TEXT NULL, runner_reason TEXT NULL,
  PRIMARY KEY (game_id, revision, event_sequence),
  FOREIGN KEY (game_id, revision, event_sequence, event_id, kind)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id, kind) ON DELETE CASCADE,
  FOREIGN KEY (game_id, revision, plate_result_event_id)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((runner_context_kind='plate_result' AND plate_result_event_id IS NOT NULL AND runner_reason IS NULL)
      OR (runner_context_kind='independent' AND plate_result_event_id IS NULL AND runner_reason IS NOT NULL))
);
CREATE TABLE workbench.relay_substitutions (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'substitution' CHECK (kind='substitution'),
  substitution_side TEXT NOT NULL, substitution_role TEXT NOT NULL, incoming_player_id TEXT NOT NULL,
  outgoing_player_id TEXT NULL, batting_order INTEGER NULL, field_position TEXT NULL,
  PRIMARY KEY (game_id, revision, event_sequence),
  FOREIGN KEY (game_id, revision, event_sequence, event_id, kind)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id, kind) ON DELETE CASCADE
);
CREATE TABLE workbench.relay_reviews (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'review' CHECK (kind='review'),
  review_decision TEXT NULL, reviewed_event_id TEXT NULL,
  PRIMARY KEY (game_id, revision, event_sequence),
  FOREIGN KEY (game_id, revision, event_sequence, event_id, kind)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id, kind) ON DELETE CASCADE,
  FOREIGN KEY (game_id, revision, reviewed_event_id)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE workbench.relay_administrative (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'administrative' CHECK (kind='administrative'),
  administrative_code TEXT NOT NULL,
  PRIMARY KEY (game_id, revision, event_sequence),
  FOREIGN KEY (game_id, revision, event_sequence, event_id, kind)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id, kind) ON DELETE CASCADE
);
CREATE TABLE workbench.relay_unresolved (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'unresolved' CHECK (kind='unresolved'),
  unresolved_source_type TEXT NOT NULL, suspected_kind TEXT NULL,
  PRIMARY KEY (game_id, revision, event_sequence),
  FOREIGN KEY (game_id, revision, event_sequence, event_id, kind)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id, kind) ON DELETE CASCADE
);

CREATE TABLE workbench.tracking_observations (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL,
  tracking_sequence INTEGER NOT NULL CHECK (tracking_sequence >= 0), tracking_id TEXT NOT NULL,
  measurement_profile_id TEXT NOT NULL REFERENCES catalog.tracking_measurement_profiles,
  source_pitch_id TEXT NULL, source_pitch_ordinal INTEGER NULL CHECK (source_pitch_ordinal >= 1),
  source_endpoint TEXT NOT NULL, source_block_index INTEGER NOT NULL CHECK (source_block_index >= 0),
  source_row_index INTEGER NOT NULL CHECK (source_row_index >= 0),
  inning INTEGER NOT NULL CHECK (inning > 0), half TEXT NOT NULL CHECK (half IN ('top','bottom')),
  plate_appearance_event_id TEXT NULL, pitcher_id TEXT NULL, batter_id TEXT NULL,
  observed_at TEXT NULL, stance TEXT NULL CHECK (stance IN ('L','R','S')),
  x0 DOUBLE PRECISION NULL, y0 DOUBLE PRECISION NULL, z0 DOUBLE PRECISION NULL,
  vx0 DOUBLE PRECISION NULL, vy0 DOUBLE PRECISION NULL, vz0 DOUBLE PRECISION NULL,
  ax DOUBLE PRECISION NULL, ay DOUBLE PRECISION NULL, az DOUBLE PRECISION NULL,
  cross_plate_x DOUBLE PRECISION NULL, cross_plate_y DOUBLE PRECISION NULL,
  top_sz DOUBLE PRECISION NULL, bottom_sz DOUBLE PRECISION NULL,
  resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('pending','linked','duplicate','excluded')),
  pitch_event_id TEXT NULL, canonical_tracking_id TEXT NULL,
  exclusion_reason TEXT NULL CHECK (exclusion_reason IN ('not_a_pitch','provider_conflict','invalid_measurement','manual_other')),
  exclusion_note TEXT NULL,
  PRIMARY KEY (game_id, revision, tracking_sequence),
  UNIQUE (game_id, revision, tracking_id),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE,
  FOREIGN KEY (game_id, revision, pitch_event_id)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (game_id, revision, canonical_tracking_id)
    REFERENCES workbench.tracking_observations(game_id, revision, tracking_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (bottom_sz IS NULL OR top_sz IS NULL OR bottom_sz < top_sz),
  CHECK (
    (resolution_kind='pending' AND pitch_event_id IS NULL AND canonical_tracking_id IS NULL AND exclusion_reason IS NULL AND exclusion_note IS NULL)
    OR (resolution_kind='linked' AND pitch_event_id IS NOT NULL AND canonical_tracking_id IS NULL AND exclusion_reason IS NULL AND exclusion_note IS NULL)
    OR (resolution_kind='duplicate' AND pitch_event_id IS NULL AND canonical_tracking_id IS NOT NULL AND exclusion_reason IS NULL AND exclusion_note IS NULL)
    OR (resolution_kind='excluded' AND pitch_event_id IS NULL AND canonical_tracking_id IS NULL AND exclusion_reason IS NOT NULL)
  )
);

CREATE TABLE workbench.official_batter_lines (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, record_index INTEGER NOT NULL,
  player_id TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('away','home')),
  plate_appearances INTEGER NULL, at_bats INTEGER NOT NULL, runs INTEGER NOT NULL,
  hits INTEGER NOT NULL, doubles INTEGER NULL, triples INTEGER NULL, home_runs INTEGER NOT NULL,
  runs_batted_in INTEGER NOT NULL, walks INTEGER NOT NULL, intentional_walks INTEGER NULL,
  hit_by_pitch INTEGER NULL, strikeouts INTEGER NOT NULL, sacrifice_bunts INTEGER NULL,
  sacrifice_flies INTEGER NULL,
  PRIMARY KEY (game_id, revision, record_index),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE
);
CREATE TABLE workbench.official_pitcher_lines (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, record_index INTEGER NOT NULL,
  player_id TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('away','home')),
  batters_faced INTEGER NOT NULL, outs_recorded INTEGER NOT NULL, hits INTEGER NOT NULL,
  runs INTEGER NOT NULL, earned_runs INTEGER NOT NULL, walks INTEGER NOT NULL,
  intentional_walks INTEGER NULL, hit_by_pitch INTEGER NOT NULL, strikeouts INTEGER NOT NULL,
  pitches INTEGER NULL, strikes INTEGER NULL,
  PRIMARY KEY (game_id, revision, record_index),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE
);

CREATE TABLE baseball.play_facts (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, play_sequence INTEGER NOT NULL,
  play_id TEXT NOT NULL, source_sequence INTEGER NOT NULL, kind TEXT NOT NULL,
  inning INTEGER NOT NULL, half TEXT NOT NULL CHECK (half IN ('top','bottom')), applied BOOLEAN NOT NULL,
  before_inning INTEGER NOT NULL, before_half TEXT NOT NULL, before_half_active BOOLEAN NOT NULL,
  before_balls INTEGER NOT NULL, before_strikes INTEGER NOT NULL, before_outs INTEGER NOT NULL,
  before_base1_runner_id TEXT NULL, before_base1_pitcher_id TEXT NULL,
  before_base2_runner_id TEXT NULL, before_base2_pitcher_id TEXT NULL,
  before_base3_runner_id TEXT NULL, before_base3_pitcher_id TEXT NULL,
  before_away_score INTEGER NOT NULL, before_home_score INTEGER NOT NULL,
  before_batter_id TEXT NULL, before_pitcher_id TEXT NULL,
  before_active_away_pitcher_id TEXT NULL, before_active_home_pitcher_id TEXT NULL,
  before_pa_start_event_id TEXT NULL, before_pa_start_batter_id TEXT NULL,
  before_pa_start_pitcher_id TEXT NULL, before_pa_walk_responsible_pitcher_id TEXT NULL,
  before_pa_strikeout_responsible_batter_id TEXT NULL, before_pa_actual_pitch_count INTEGER NULL,
  after_inning INTEGER NOT NULL, after_half TEXT NOT NULL, after_half_active BOOLEAN NOT NULL,
  after_balls INTEGER NOT NULL, after_strikes INTEGER NOT NULL, after_outs INTEGER NOT NULL,
  after_base1_runner_id TEXT NULL, after_base1_pitcher_id TEXT NULL,
  after_base2_runner_id TEXT NULL, after_base2_pitcher_id TEXT NULL,
  after_base3_runner_id TEXT NULL, after_base3_pitcher_id TEXT NULL,
  after_away_score INTEGER NOT NULL, after_home_score INTEGER NOT NULL,
  after_batter_id TEXT NULL, after_pitcher_id TEXT NULL,
  after_active_away_pitcher_id TEXT NULL, after_active_home_pitcher_id TEXT NULL,
  after_pa_start_event_id TEXT NULL, after_pa_start_batter_id TEXT NULL,
  after_pa_start_pitcher_id TEXT NULL, after_pa_walk_responsible_pitcher_id TEXT NULL,
  after_pa_strikeout_responsible_batter_id TEXT NULL, after_pa_actual_pitch_count INTEGER NULL,
  PRIMARY KEY (game_id, revision, play_sequence), UNIQUE (game_id, revision, play_id),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE
);
CREATE TABLE baseball.play_events (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, play_sequence INTEGER NOT NULL,
  relay_order INTEGER NOT NULL, event_sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
  relay_text TEXT NULL,
  PRIMARY KEY (game_id, revision, play_sequence, relay_order),
  FOREIGN KEY (game_id, revision, play_sequence) REFERENCES baseball.play_facts ON DELETE CASCADE,
  FOREIGN KEY (game_id, revision, event_sequence, event_id)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id)
);
CREATE TABLE baseball.runner_movement_facts (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, play_sequence INTEGER NOT NULL,
  movement_sequence INTEGER NOT NULL, movement_id TEXT NOT NULL, source_event_id TEXT NULL,
  source_sequence INTEGER NOT NULL, runner_id TEXT NOT NULL, from_base INTEGER NOT NULL,
  to_base INTEGER NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('safe','out','scored')),
  out_kind TEXT NULL, supersedes_third_out BOOLEAN NULL, responsible_pitcher_id TEXT NOT NULL,
  reason TEXT NOT NULL, derived BOOLEAN NOT NULL,
  PRIMARY KEY (game_id, revision, play_sequence, movement_sequence),
  UNIQUE (game_id, revision, movement_id),
  FOREIGN KEY (game_id, revision, play_sequence) REFERENCES baseball.play_facts ON DELETE CASCADE,
  FOREIGN KEY (game_id, revision, source_event_id)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_id)
);

CREATE TABLE baseball.plate_appearance_facts (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, plate_appearance_index INTEGER NOT NULL,
  start_event_id TEXT NOT NULL, end_event_id TEXT NULL, inning INTEGER NOT NULL,
  half TEXT NOT NULL CHECK (half IN ('top','bottom')),
  start_batter_id TEXT NOT NULL, batter_id TEXT NOT NULL,
  start_pitcher_id TEXT NOT NULL, pitcher_id TEXT NOT NULL,
  result TEXT NULL, batted_ball_type TEXT NULL, is_bunt BOOLEAN NULL,
  completed BOOLEAN NOT NULL, termination_reason TEXT NOT NULL, actual_pitch_count INTEGER NOT NULL,
  counts_as_plate_appearance BOOLEAN NOT NULL, counts_as_at_bat BOOLEAN NOT NULL,
  counts_as_batter_faced BOOLEAN NOT NULL,
  PRIMARY KEY (game_id, revision, plate_appearance_index),
  UNIQUE (game_id, revision, start_event_id),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE
);
CREATE TABLE baseball.plate_appearance_events (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, plate_appearance_index INTEGER NOT NULL,
  event_number INTEGER NOT NULL, event_id TEXT NOT NULL, event_sequence INTEGER NOT NULL,
  pitch_event_number INTEGER NULL, pitch_number INTEGER NULL,
  PRIMARY KEY (game_id, revision, plate_appearance_index, event_number),
  FOREIGN KEY (game_id, revision, plate_appearance_index)
    REFERENCES baseball.plate_appearance_facts ON DELETE CASCADE,
  FOREIGN KEY (game_id, revision, event_sequence, event_id)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_sequence, event_id)
);

CREATE TABLE baseball.pitch_facts (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, pitch_sequence INTEGER NOT NULL,
  pitch_id TEXT NOT NULL, plate_appearance_event_id TEXT NULL,
  pitch_event_number INTEGER NULL, actual_pitch_number INTEGER NULL,
  inning INTEGER NOT NULL, half TEXT NOT NULL CHECK (half IN ('top','bottom')),
  batter_id TEXT NULL, pitcher_id TEXT NULL, source_pitch_id TEXT NULL, pitch_call TEXT NOT NULL,
  actual BOOLEAN NOT NULL, ball BOOLEAN NOT NULL, called_strike BOOLEAN NOT NULL,
  swing BOOLEAN NOT NULL, whiff BOOLEAN NOT NULL, foul BOOLEAN NOT NULL,
  in_play BOOLEAN NOT NULL, strike BOOLEAN NOT NULL, csw BOOLEAN NOT NULL,
  before_balls INTEGER NOT NULL, before_strikes INTEGER NOT NULL, before_outs INTEGER NOT NULL,
  before_base1_runner_id TEXT NULL, before_base2_runner_id TEXT NULL, before_base3_runner_id TEXT NULL,
  before_away_score INTEGER NOT NULL, before_home_score INTEGER NOT NULL,
  after_balls INTEGER NOT NULL, after_strikes INTEGER NOT NULL, after_outs INTEGER NOT NULL,
  after_base1_runner_id TEXT NULL, after_base2_runner_id TEXT NULL, after_base3_runner_id TEXT NULL,
  after_away_score INTEGER NOT NULL, after_home_score INTEGER NOT NULL,
  PRIMARY KEY (game_id, revision, pitch_sequence), UNIQUE (game_id, revision, pitch_id),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE,
  FOREIGN KEY (game_id, revision, pitch_id)
    REFERENCES workbench.relay_event_facts(game_id, revision, event_id)
);
CREATE TABLE baseball.pitch_tracking_links (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, tracking_sequence INTEGER NOT NULL,
  pitch_id TEXT NOT NULL, tracking_id TEXT NOT NULL,
  PRIMARY KEY (game_id,revision,pitch_id),
  UNIQUE (game_id,revision,tracking_id),
  UNIQUE (game_id,revision,tracking_sequence),
  FOREIGN KEY (game_id,revision,pitch_id)
    REFERENCES baseball.pitch_facts(game_id,revision,pitch_id) ON DELETE CASCADE,
  FOREIGN KEY (game_id,revision,tracking_id)
    REFERENCES workbench.tracking_observations(game_id,revision,tracking_id) ON DELETE CASCADE
);

CREATE TABLE baseball.game_final_states (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL,
  final_inning INTEGER NOT NULL, final_half TEXT NOT NULL, final_half_active BOOLEAN NOT NULL,
  final_balls INTEGER NOT NULL, final_strikes INTEGER NOT NULL, final_outs INTEGER NOT NULL,
  final_base1_runner_id TEXT NULL, final_base1_pitcher_id TEXT NULL,
  final_base2_runner_id TEXT NULL, final_base2_pitcher_id TEXT NULL,
  final_base3_runner_id TEXT NULL, final_base3_pitcher_id TEXT NULL,
  final_away_score INTEGER NOT NULL, final_home_score INTEGER NOT NULL,
  final_batter_id TEXT NULL, final_pitcher_id TEXT NULL,
  final_active_away_pitcher_id TEXT NULL, final_active_home_pitcher_id TEXT NULL,
  final_pa_start_event_id TEXT NULL, final_pa_start_batter_id TEXT NULL,
  final_pa_start_pitcher_id TEXT NULL, final_pa_walk_responsible_pitcher_id TEXT NULL,
  final_pa_strikeout_responsible_batter_id TEXT NULL, final_pa_actual_pitch_count INTEGER NULL,
  PRIMARY KEY (game_id, revision),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE
);

CREATE TABLE baseball.batter_game_facts (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, line_index INTEGER NOT NULL,
  player_id TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('away','home')),
  plate_appearances INTEGER NOT NULL, at_bats INTEGER NOT NULL, runs INTEGER NOT NULL,
  hits INTEGER NOT NULL, doubles INTEGER NOT NULL, triples INTEGER NOT NULL, home_runs INTEGER NOT NULL,
  runs_batted_in INTEGER NOT NULL, walks INTEGER NOT NULL, intentional_walks INTEGER NOT NULL,
  hit_by_pitch INTEGER NOT NULL, strikeouts INTEGER NOT NULL, sacrifice_bunts INTEGER NOT NULL,
  sacrifice_flies INTEGER NOT NULL,
  PRIMARY KEY (game_id, revision, line_index),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE
);
CREATE TABLE baseball.pitcher_game_facts (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, line_index INTEGER NOT NULL,
  player_id TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('away','home')),
  batters_faced INTEGER NOT NULL, outs_recorded INTEGER NOT NULL, hits INTEGER NOT NULL,
  runs INTEGER NOT NULL, official_earned_runs INTEGER NULL, walks INTEGER NOT NULL,
  intentional_walks INTEGER NOT NULL, hit_by_pitch INTEGER NOT NULL, strikeouts INTEGER NOT NULL,
  pitches INTEGER NOT NULL, strikes INTEGER NOT NULL,
  PRIMARY KEY (game_id, revision, line_index),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE
);
CREATE TABLE baseball.baserunner_game_facts (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, line_index INTEGER NOT NULL,
  player_id TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('away','home')),
  advances INTEGER NOT NULL, extra_bases_taken INTEGER NOT NULL, runs INTEGER NOT NULL,
  stolen_bases INTEGER NOT NULL, caught_stealing INTEGER NOT NULL, pickoffs INTEGER NOT NULL,
  PRIMARY KEY (game_id, revision, line_index),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE
);

ALTER TABLE workbench.tracking_observations
  ADD COLUMN pitcher_identity_key TEXT GENERATED ALWAYS AS
    (CASE WHEN pitcher_id IS NULL THEN NULL ELSE 'naver:' || pitcher_id END) STORED,
  ADD COLUMN batter_identity_key TEXT GENERATED ALWAYS AS
    (CASE WHEN batter_id IS NULL THEN NULL ELSE 'naver:' || batter_id END) STORED,
  ADD FOREIGN KEY (pitcher_identity_key) REFERENCES catalog.player_identities(identity_key),
  ADD FOREIGN KEY (batter_identity_key) REFERENCES catalog.player_identities(identity_key);
ALTER TABLE baseball.pitch_facts
  ADD COLUMN batter_identity_key TEXT GENERATED ALWAYS AS
    (CASE WHEN batter_id IS NULL THEN NULL ELSE 'naver:' || batter_id END) STORED,
  ADD COLUMN pitcher_identity_key TEXT GENERATED ALWAYS AS
    (CASE WHEN pitcher_id IS NULL THEN NULL ELSE 'naver:' || pitcher_id END) STORED,
  ADD FOREIGN KEY (batter_identity_key) REFERENCES catalog.player_identities(identity_key),
  ADD FOREIGN KEY (pitcher_identity_key) REFERENCES catalog.player_identities(identity_key);
ALTER TABLE baseball.plate_appearance_facts
  ADD COLUMN start_batter_identity_key TEXT GENERATED ALWAYS AS ('naver:' || start_batter_id) STORED,
  ADD COLUMN batter_identity_key TEXT GENERATED ALWAYS AS ('naver:' || batter_id) STORED,
  ADD COLUMN start_pitcher_identity_key TEXT GENERATED ALWAYS AS ('naver:' || start_pitcher_id) STORED,
  ADD COLUMN pitcher_identity_key TEXT GENERATED ALWAYS AS ('naver:' || pitcher_id) STORED,
  ADD FOREIGN KEY (start_batter_identity_key) REFERENCES catalog.player_identities(identity_key),
  ADD FOREIGN KEY (batter_identity_key) REFERENCES catalog.player_identities(identity_key),
  ADD FOREIGN KEY (start_pitcher_identity_key) REFERENCES catalog.player_identities(identity_key),
  ADD FOREIGN KEY (pitcher_identity_key) REFERENCES catalog.player_identities(identity_key);
ALTER TABLE baseball.runner_movement_facts
  ADD COLUMN runner_identity_key TEXT GENERATED ALWAYS AS ('naver:' || runner_id) STORED,
  ADD COLUMN responsible_pitcher_identity_key TEXT GENERATED ALWAYS AS
    ('naver:' || responsible_pitcher_id) STORED,
  ADD FOREIGN KEY (runner_identity_key) REFERENCES catalog.player_identities(identity_key),
  ADD FOREIGN KEY (responsible_pitcher_identity_key) REFERENCES catalog.player_identities(identity_key);
ALTER TABLE baseball.batter_game_facts
  ADD COLUMN player_identity_key TEXT GENERATED ALWAYS AS ('naver:' || player_id) STORED,
  ADD FOREIGN KEY (player_identity_key) REFERENCES catalog.player_identities(identity_key);
ALTER TABLE baseball.pitcher_game_facts
  ADD COLUMN player_identity_key TEXT GENERATED ALWAYS AS ('naver:' || player_id) STORED,
  ADD FOREIGN KEY (player_identity_key) REFERENCES catalog.player_identities(identity_key);
ALTER TABLE baseball.baserunner_game_facts
  ADD COLUMN player_identity_key TEXT GENERATED ALWAYS AS ('naver:' || player_id) STORED,
  ADD FOREIGN KEY (player_identity_key) REFERENCES catalog.player_identities(identity_key);

CREATE TABLE workbench.validation_runs (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, blocking_count INTEGER NOT NULL,
  warning_count INTEGER NOT NULL, issue_count INTEGER NOT NULL,
  PRIMARY KEY (game_id, revision),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.game_revisions ON DELETE CASCADE
);
CREATE TABLE workbench.validation_issues (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, issue_index INTEGER NOT NULL,
  code TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL,
  event_id TEXT NULL, event_sequence INTEGER NULL, record_identity TEXT NULL,
  PRIMARY KEY (game_id, revision, issue_index),
  FOREIGN KEY (game_id, revision) REFERENCES workbench.validation_runs ON DELETE CASCADE
);
CREATE TABLE workbench.validation_issue_details (
  game_id TEXT NOT NULL, revision INTEGER NOT NULL, issue_index INTEGER NOT NULL,
  detail_index INTEGER NOT NULL, field TEXT NOT NULL,
  expected_type TEXT NOT NULL, expected_text TEXT NULL, expected_number DOUBLE PRECISION NULL,
  expected_boolean BOOLEAN NULL, actual_type TEXT NOT NULL, actual_text TEXT NULL,
  actual_number DOUBLE PRECISION NULL, actual_boolean BOOLEAN NULL,
  PRIMARY KEY (game_id, revision, issue_index, detail_index),
  FOREIGN KEY (game_id, revision, issue_index) REFERENCES workbench.validation_issues ON DELETE CASCADE
);

CREATE INDEX pitch_pitcher_date_idx ON baseball.pitch_facts (pitcher_id, game_id, revision, pitch_call);
CREATE INDEX pitch_batter_date_idx ON baseball.pitch_facts (batter_id, game_id, revision, pitch_call);
CREATE INDEX pitch_source_id_idx ON baseball.pitch_facts (source_pitch_id, game_id, revision);
CREATE INDEX pa_batter_result_idx ON baseball.plate_appearance_facts (batter_id, result, game_id, revision);
CREATE INDEX pa_pitcher_result_idx ON baseball.plate_appearance_facts (pitcher_id, result, game_id, revision);
CREATE INDEX movement_runner_idx ON baseball.runner_movement_facts (runner_id, reason, game_id, revision);


CREATE TABLE registry.collection_runs (
  run_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL CHECK (season >= 2017),
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting','parsed','sealed','failed')),
  dry_run BOOLEAN NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NULL,
  source_bundle_hash TEXT NULL CHECK (source_bundle_hash IS NULL OR source_bundle_hash ~ '^[0-9a-f]{64}$'),
  error_message TEXT NULL,
  CHECK (date_from <= date_to)
);
CREATE TABLE registry.season_current_revisions (
  season INTEGER PRIMARY KEY,
  current_revision INTEGER NULL
);
CREATE TABLE registry.season_revisions (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  run_id TEXT NOT NULL UNIQUE REFERENCES registry.collection_runs(run_id),
  source_bundle_hash TEXT NOT NULL CHECK (source_bundle_hash ~ '^[0-9a-f]{64}$'),
  blocking_count INTEGER NOT NULL CHECK (blocking_count >= 0),
  warning_count INTEGER NOT NULL CHECK (warning_count >= 0),
  sealed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sealed_at TIMESTAMPTZ NULL,
  PRIMARY KEY (season,revision),
  FOREIGN KEY (season) REFERENCES registry.season_current_revisions(season)
);
ALTER TABLE registry.season_current_revisions
  ADD CONSTRAINT registry_current_revision_fk
  FOREIGN KEY (season,current_revision) REFERENCES registry.season_revisions(season,revision)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE registry.source_pages (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  page_sequence INTEGER NOT NULL,
  page_kind TEXT NOT NULL CHECK (page_kind IN ('register','trade')),
  request_key TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  collected_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (season,revision,page_sequence),
  UNIQUE (season,revision,page_kind,request_key),
  FOREIGN KEY (season,revision) REFERENCES registry.season_revisions ON DELETE CASCADE
);
CREATE TABLE registry.registration_snapshots (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  snapshot_date DATE NOT NULL,
  team_identity_key TEXT NOT NULL REFERENCES catalog.team_identities(identity_key),
  source_page_sequence INTEGER NOT NULL,
  complete BOOLEAN NOT NULL,
  PRIMARY KEY (season,revision,snapshot_date,team_identity_key),
  FOREIGN KEY (season,revision,source_page_sequence)
    REFERENCES registry.source_pages(season,revision,page_sequence)
);
CREATE TABLE registry.registration_snapshot_players (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  snapshot_date DATE NOT NULL,
  team_identity_key TEXT NOT NULL,
  player_order INTEGER NOT NULL,
  player_identity_key TEXT NOT NULL REFERENCES catalog.player_identities(identity_key),
  roster_category TEXT NOT NULL,
  uniform_number TEXT NULL,
  position_text TEXT NOT NULL,
  throws_bats TEXT NULL,
  birth_date DATE NULL,
  height_cm INTEGER NULL,
  weight_kg INTEGER NULL,
  PRIMARY KEY (season,revision,snapshot_date,team_identity_key,player_order),
  UNIQUE (season,revision,snapshot_date,team_identity_key,player_identity_key,roster_category),
  FOREIGN KEY (season,revision,snapshot_date,team_identity_key)
    REFERENCES registry.registration_snapshots ON DELETE CASCADE
);
CREATE TABLE registry.status_events (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  event_sequence INTEGER NOT NULL,
  effective_date DATE NOT NULL,
  raw_category TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN
    ('name_change','military_hold','affiliation_add','number_change','waiver',
     'voluntary_retirement','voluntary_return','free_agent_release','trade',
     'free_agent_contract','free_agent_eligibility','draft','compensation',
     'injured_list','leave','rehabilitation','suspension','unknown')),
  affiliation_effect TEXT NOT NULL CHECK (affiliation_effect IN
    ('start','end','transfer','none','unknown')),
  team_identity_key TEXT NULL REFERENCES catalog.team_identities(identity_key),
  raw_player_name TEXT NOT NULL,
  raw_position TEXT NULL,
  raw_note TEXT NULL,
  player_identity_key TEXT NULL REFERENCES catalog.player_identities(identity_key),
  resolution_kind TEXT NOT NULL CHECK (resolution_kind IN
    ('official','exact_external_and_name','unique_context','unresolved')),
  source_page_sequence INTEGER NOT NULL,
  source_row_index INTEGER NOT NULL,
  PRIMARY KEY (season,revision,event_sequence),
  FOREIGN KEY (season,revision,source_page_sequence)
    REFERENCES registry.source_pages(season,revision,page_sequence)
);
CREATE TABLE registry.identity_resolution_issues (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  issue_sequence INTEGER NOT NULL,
  status_event_sequence INTEGER NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning','blocking')),
  message TEXT NOT NULL,
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  PRIMARY KEY (season,revision,issue_sequence),
  FOREIGN KEY (season,revision,status_event_sequence)
    REFERENCES registry.status_events(season,revision,event_sequence)
);
CREATE TABLE registry.player_team_stints (
  season INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  stint_sequence INTEGER NOT NULL,
  stint_kind TEXT NOT NULL CHECK (stint_kind IN
    ('first_team_registration','organization_affiliation')),
  player_identity_key TEXT NOT NULL REFERENCES catalog.player_identities(identity_key),
  team_identity_key TEXT NOT NULL REFERENCES catalog.team_identities(identity_key),
  valid_from DATE NULL,
  valid_to DATE NULL,
  left_censored BOOLEAN NOT NULL,
  right_censored BOOLEAN NOT NULL,
  start_status_event_sequence INTEGER NULL,
  end_status_event_sequence INTEGER NULL,
  PRIMARY KEY (season,revision,stint_sequence),
  FOREIGN KEY (season,revision) REFERENCES registry.season_revisions ON DELETE CASCADE,
  FOREIGN KEY (season,revision,start_status_event_sequence)
    REFERENCES registry.status_events(season,revision,event_sequence),
  FOREIGN KEY (season,revision,end_status_event_sequence)
    REFERENCES registry.status_events(season,revision,event_sequence),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_from < valid_to)
);

CREATE VIEW analytics.current_game_revisions AS
SELECT r.* FROM workbench.game_revisions r
JOIN workbench.games g ON g.game_id=r.game_id AND g.current_revision=r.revision;
CREATE VIEW analytics.current_plays AS
SELECT f.* FROM baseball.play_facts f
JOIN workbench.games g ON g.game_id=f.game_id AND g.current_revision=f.revision;
CREATE VIEW analytics.current_play_events AS
SELECT e.* FROM baseball.play_events e
JOIN workbench.games g ON g.game_id=e.game_id AND g.current_revision=e.revision;
CREATE VIEW analytics.current_runner_movements AS
SELECT f.* FROM baseball.runner_movement_facts f
JOIN workbench.games g ON g.game_id=f.game_id AND g.current_revision=f.revision;
CREATE VIEW analytics.current_plate_appearances AS
SELECT f.* FROM baseball.plate_appearance_facts f
JOIN workbench.games g ON g.game_id=f.game_id AND g.current_revision=f.revision;
CREATE VIEW analytics.current_batted_balls AS
SELECT p.* FROM analytics.current_plate_appearances p
WHERE p.completed AND p.result IN ('single','double','triple','home_run','field_out','sacrifice_bunt','sacrifice_fly','fielder_choice','reached_on_error','double_play','triple_play');
CREATE VIEW analytics.current_pitches AS
SELECT p.*, r.season, r.game_date,
       CASE WHEN p.half='top' THEN away_team.team_id ELSE home_team.team_id END AS batting_team_id,
       CASE WHEN p.half='top' THEN away_team.team_name ELSE home_team.team_name END AS batting_team_name,
       CASE WHEN p.half='top' THEN home_team.team_id ELSE away_team.team_id END AS pitching_team_id,
       CASE WHEN p.half='top' THEN home_team.team_name ELSE away_team.team_name END AS pitching_team_name,
       CASE WHEN p.half='top' THEN away_team.team_identity_key ELSE home_team.team_identity_key END AS batting_team_identity_key,
       CASE WHEN p.half='top' THEN home_team.team_identity_key ELSE away_team.team_identity_key END AS pitching_team_identity_key,
       batting_team_identity.team_id AS canonical_batting_team_id,
       pitching_team_identity.team_id AS canonical_pitching_team_id,
       batter.player_name AS batter_name, pitcher.player_name AS pitcher_name,
       batter_identity.player_id AS canonical_batter_id,
       pitcher_identity.player_id AS canonical_pitcher_id,
       t.tracking_id, t.source_pitch_ordinal, t.stance,
       t.x0,t.y0,t.z0,t.vx0,t.vy0,t.vz0,t.ax,t.ay,t.az,
       t.cross_plate_x,t.cross_plate_y,t.top_sz,t.bottom_sz,
       CASE WHEN measurement_profile.supports_zone IS DISTINCT FROM TRUE OR t.cross_plate_x IS NULL OR t.cross_plate_y IS NULL OR t.top_sz IS NULL OR t.bottom_sz IS NULL
            THEN NULL ELSE abs(t.cross_plate_x) <= 0.82917
              AND t.cross_plate_y BETWEEN t.bottom_sz AND t.top_sz END AS in_zone,
       CASE WHEN measurement_profile.supports_zone IS DISTINCT FROM TRUE OR NOT p.swing OR t.cross_plate_x IS NULL OR t.cross_plate_y IS NULL OR t.top_sz IS NULL OR t.bottom_sz IS NULL
            THEN NULL ELSE NOT (abs(t.cross_plate_x) <= 0.82917
              AND t.cross_plate_y BETWEEN t.bottom_sz AND t.top_sz) END AS chase
FROM baseball.pitch_facts p
JOIN analytics.current_game_revisions r USING (game_id,revision)
JOIN workbench.game_team_snapshots away_team
  ON away_team.game_id=p.game_id AND away_team.revision=p.revision AND away_team.side='away'
JOIN workbench.game_team_snapshots home_team
  ON home_team.game_id=p.game_id AND home_team.revision=p.revision AND home_team.side='home'
LEFT JOIN workbench.game_roster_snapshots batter
  ON batter.game_id=p.game_id AND batter.revision=p.revision AND batter.player_id=p.batter_id
 AND batter.side=CASE WHEN p.half='top' THEN 'away' ELSE 'home' END
LEFT JOIN workbench.game_roster_snapshots pitcher
  ON pitcher.game_id=p.game_id AND pitcher.revision=p.revision AND pitcher.player_id=p.pitcher_id
 AND pitcher.side=CASE WHEN p.half='top' THEN 'home' ELSE 'away' END
LEFT JOIN catalog.team_identities batting_team_identity
  ON batting_team_identity.identity_key=CASE WHEN p.half='top'
    THEN away_team.team_identity_key ELSE home_team.team_identity_key END
LEFT JOIN catalog.team_identities pitching_team_identity
  ON pitching_team_identity.identity_key=CASE WHEN p.half='top'
    THEN home_team.team_identity_key ELSE away_team.team_identity_key END
LEFT JOIN catalog.player_identities batter_identity
  ON batter_identity.identity_key=p.batter_identity_key
LEFT JOIN catalog.player_identities pitcher_identity
  ON pitcher_identity.identity_key=p.pitcher_identity_key
LEFT JOIN baseball.pitch_tracking_links tracking_link
  ON tracking_link.game_id=p.game_id AND tracking_link.revision=p.revision
 AND tracking_link.pitch_id=p.pitch_id
LEFT JOIN workbench.tracking_observations t
  ON t.game_id=tracking_link.game_id AND t.revision=tracking_link.revision
 AND t.tracking_id=tracking_link.tracking_id
LEFT JOIN catalog.tracking_measurement_profiles measurement_profile
  ON measurement_profile.measurement_profile_id=t.measurement_profile_id;
CREATE VIEW analytics.current_player_game_batting AS
SELECT f.* FROM baseball.batter_game_facts f
JOIN workbench.games g ON g.game_id=f.game_id AND g.current_revision=f.revision;
CREATE VIEW analytics.current_player_game_pitching AS
SELECT f.* FROM baseball.pitcher_game_facts f
JOIN workbench.games g ON g.game_id=f.game_id AND g.current_revision=f.revision;
CREATE VIEW analytics.current_player_game_baserunning AS
SELECT f.* FROM baseball.baserunner_game_facts f
JOIN workbench.games g ON g.game_id=f.game_id AND g.current_revision=f.revision;
CREATE VIEW analytics.all_revision_pitches AS SELECT * FROM baseball.pitch_facts;
CREATE VIEW analytics.all_revision_plate_appearances AS SELECT * FROM baseball.plate_appearance_facts;
CREATE VIEW analytics.all_revision_plays AS SELECT * FROM baseball.play_facts;
CREATE VIEW analytics.all_revision_runner_movements AS SELECT * FROM baseball.runner_movement_facts;
CREATE VIEW analytics.all_revision_player_game_batting AS SELECT * FROM baseball.batter_game_facts;
CREATE VIEW analytics.all_revision_player_game_pitching AS SELECT * FROM baseball.pitcher_game_facts;
CREATE VIEW analytics.all_revision_player_game_baserunning AS SELECT * FROM baseball.baserunner_game_facts;

CREATE VIEW analytics.current_player_season_batting AS
SELECT r.season, f.player_id, f.player_identity_key,
       identity.player_id AS canonical_player_id,
       SUM(f.plate_appearances)::BIGINT plate_appearances, SUM(f.at_bats)::BIGINT at_bats,
       SUM(f.hits)::BIGINT hits, SUM(f.doubles)::BIGINT doubles, SUM(f.triples)::BIGINT triples,
       SUM(f.home_runs)::BIGINT home_runs, SUM(f.walks)::BIGINT walks,
       SUM(f.hit_by_pitch)::BIGINT hit_by_pitch, SUM(f.strikeouts)::BIGINT strikeouts,
       SUM(f.sacrifice_flies)::BIGINT sacrifice_flies,
       SUM(f.hits)::BIGINT AS avg_numerator,
       SUM(f.at_bats)::BIGINT AS avg_denominator,
       SUM(f.hits)::DOUBLE PRECISION / NULLIF(SUM(f.at_bats),0) AS avg,
       (SUM(f.hits)+SUM(f.walks)+SUM(f.hit_by_pitch))::BIGINT AS obp_numerator,
       (SUM(f.at_bats)+SUM(f.walks)+SUM(f.hit_by_pitch)+SUM(f.sacrifice_flies))::BIGINT AS obp_denominator,
       (SUM(f.hits)+SUM(f.walks)+SUM(f.hit_by_pitch))::DOUBLE PRECISION /
         NULLIF(SUM(f.at_bats)+SUM(f.walks)+SUM(f.hit_by_pitch)+SUM(f.sacrifice_flies),0) AS obp,
       (SUM(f.hits)+SUM(f.doubles)+2*SUM(f.triples)+3*SUM(f.home_runs))::BIGINT AS total_bases,
       SUM(f.at_bats)::BIGINT AS slg_denominator,
       (SUM(f.hits)+SUM(f.doubles)+2*SUM(f.triples)+3*SUM(f.home_runs))::DOUBLE PRECISION /
         NULLIF(SUM(f.at_bats),0) AS slg,
       SUM(f.strikeouts)::BIGINT AS strikeout_rate_numerator,
       SUM(f.plate_appearances)::BIGINT AS strikeout_rate_denominator,
       SUM(f.strikeouts)::DOUBLE PRECISION / NULLIF(SUM(f.plate_appearances),0) AS strikeout_rate,
       SUM(f.walks)::BIGINT AS walk_rate_numerator,
       SUM(f.plate_appearances)::BIGINT AS walk_rate_denominator,
       SUM(f.walks)::DOUBLE PRECISION / NULLIF(SUM(f.plate_appearances),0) AS walk_rate,
       (SUM(f.hits)-SUM(f.home_runs))::BIGINT AS babip_numerator,
       (SUM(f.at_bats)-SUM(f.strikeouts)-SUM(f.home_runs)+SUM(f.sacrifice_flies))::BIGINT AS babip_denominator,
       (SUM(f.hits)-SUM(f.home_runs))::DOUBLE PRECISION /
         NULLIF(SUM(f.at_bats)-SUM(f.strikeouts)-SUM(f.home_runs)+SUM(f.sacrifice_flies),0) AS babip,
       (SUM(f.hits)+SUM(f.walks)+SUM(f.hit_by_pitch))::DOUBLE PRECISION /
          NULLIF(SUM(f.at_bats)+SUM(f.walks)+SUM(f.hit_by_pitch)+SUM(f.sacrifice_flies),0)
         +(SUM(f.hits)+SUM(f.doubles)+2*SUM(f.triples)+3*SUM(f.home_runs))::DOUBLE PRECISION /
          NULLIF(SUM(f.at_bats),0) AS ops
FROM analytics.current_player_game_batting f
JOIN analytics.current_game_revisions r USING (game_id,revision)
LEFT JOIN catalog.player_identities identity ON identity.identity_key=f.player_identity_key
GROUP BY r.season,f.player_id,f.player_identity_key,identity.player_id;
CREATE VIEW analytics.current_player_season_pitching AS
WITH game_lines AS (
  SELECT r.season, f.player_id, f.player_identity_key,
         identity.player_id AS canonical_player_id,
         SUM(f.batters_faced)::BIGINT batters_faced,
         SUM(f.outs_recorded)::BIGINT outs_recorded, SUM(f.strikeouts)::BIGINT strikeouts,
         SUM(f.walks)::BIGINT walks, SUM(f.official_earned_runs)::BIGINT official_earned_runs
  FROM analytics.current_player_game_pitching f
  JOIN analytics.current_game_revisions r USING (game_id,revision)
  LEFT JOIN catalog.player_identities identity ON identity.identity_key=f.player_identity_key
  GROUP BY r.season,f.player_id,f.player_identity_key,identity.player_id
), pitch_lines AS (
  SELECT p.season, p.pitcher_id AS player_id,
         p.pitcher_identity_key AS player_identity_key,
         p.canonical_pitcher_id AS canonical_player_id,
         COUNT(*) FILTER (WHERE p.actual)::BIGINT actual_pitches,
         COUNT(*) FILTER (WHERE p.actual AND p.strike)::BIGINT strikes,
         COUNT(*) FILTER (WHERE p.actual AND p.swing)::BIGINT swings,
         COUNT(*) FILTER (WHERE p.actual AND p.whiff)::BIGINT whiffs,
         COUNT(*) FILTER (WHERE p.actual AND p.csw)::BIGINT csw,
         COUNT(*) FILTER (WHERE p.actual AND p.in_zone IS NOT NULL)::BIGINT zone_opportunities,
         COUNT(*) FILTER (WHERE p.actual AND p.in_zone)::BIGINT pitches_in_zone,
         COUNT(*) FILTER (WHERE p.actual AND p.swing AND p.in_zone=FALSE)::BIGINT chases,
         COUNT(*) FILTER (WHERE p.actual AND p.in_zone=FALSE)::BIGINT chase_opportunities,
         COUNT(*) FILTER (WHERE p.actual AND p.swing AND NOT p.whiff)::BIGINT contacts
  FROM analytics.current_pitches p
  WHERE p.pitcher_id IS NOT NULL
  GROUP BY p.season,p.pitcher_id,p.pitcher_identity_key,p.canonical_pitcher_id
)
SELECT g.season,g.player_id,g.player_identity_key,g.canonical_player_id,
       g.batters_faced,g.outs_recorded,g.strikeouts,g.walks,
       g.official_earned_runs,
       p.actual_pitches,p.strikes,p.swings,p.whiffs,p.csw,p.zone_opportunities,p.pitches_in_zone,
       p.chases,p.chase_opportunities,p.contacts,
       p.strikes::DOUBLE PRECISION / NULLIF(p.actual_pitches,0) AS strike_rate,
       p.swings::DOUBLE PRECISION / NULLIF(p.actual_pitches,0) AS swing_rate,
       p.whiffs::DOUBLE PRECISION / NULLIF(p.swings,0) AS whiff_rate,
       p.csw::DOUBLE PRECISION / NULLIF(p.actual_pitches,0) AS csw_rate,
       p.pitches_in_zone::DOUBLE PRECISION / NULLIF(p.zone_opportunities,0) AS zone_rate,
       p.chases::DOUBLE PRECISION / NULLIF(p.chase_opportunities,0) AS chase_rate,
       p.contacts::DOUBLE PRECISION / NULLIF(p.swings,0) AS contact_rate,
       g.official_earned_runs::DOUBLE PRECISION * 27 / NULLIF(g.outs_recorded,0) AS official_era,
       g.strikeouts::DOUBLE PRECISION / NULLIF(g.batters_faced,0) AS strikeout_rate,
       g.walks::DOUBLE PRECISION / NULLIF(g.batters_faced,0) AS walk_rate
FROM game_lines g LEFT JOIN pitch_lines p USING (season,player_id,player_identity_key);
CREATE VIEW analytics.current_player_season_baserunning AS
SELECT r.season, f.player_id, f.player_identity_key,
       identity.player_id AS canonical_player_id,
       SUM(f.advances)::BIGINT advances,
       SUM(f.extra_bases_taken)::BIGINT extra_bases_taken, SUM(f.runs)::BIGINT runs,
       SUM(f.stolen_bases)::BIGINT stolen_bases, SUM(f.caught_stealing)::BIGINT caught_stealing,
       SUM(f.pickoffs)::BIGINT pickoffs
FROM analytics.current_player_game_baserunning f
JOIN analytics.current_game_revisions r USING (game_id,revision)
LEFT JOIN catalog.player_identities identity ON identity.identity_key=f.player_identity_key
GROUP BY r.season,f.player_id,f.player_identity_key,identity.player_id;

CREATE OR REPLACE FUNCTION workbench.reject_sealed_revision_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workbench.game_revisions r
    WHERE r.game_id=COALESCE(NEW.game_id,OLD.game_id)
      AND r.revision=COALESCE(NEW.revision,OLD.revision) AND r.sealed
  ) THEN RAISE EXCEPTION 'sealed revision facts are immutable'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE OR REPLACE FUNCTION registry.reject_sealed_revision_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM registry.season_revisions r
    WHERE r.season=COALESCE(NEW.season,OLD.season)
      AND r.revision=COALESCE(NEW.revision,OLD.revision) AND r.sealed
  ) THEN RAISE EXCEPTION 'sealed registry revision facts are immutable'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE OR REPLACE FUNCTION registry.reject_sealed_manifest_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed THEN RAISE EXCEPTION 'sealed registry revision is immutable'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE TRIGGER reject_sealed_registry_manifest_write
BEFORE UPDATE OR DELETE ON registry.season_revisions
FOR EACH ROW EXECUTE FUNCTION registry.reject_sealed_manifest_write();

DO $$
DECLARE table_ref TEXT;
BEGIN
  FOREACH table_ref IN ARRAY ARRAY[
    'registry.source_pages','registry.registration_snapshots',
    'registry.registration_snapshot_players','registry.status_events',
    'registry.identity_resolution_issues','registry.player_team_stints'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER reject_sealed_registry_write BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION registry.reject_sealed_revision_write()',
      table_ref
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION workbench.reject_sealed_manifest_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed THEN RAISE EXCEPTION 'sealed revision manifest is immutable'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE TRIGGER reject_sealed_manifest_write
BEFORE UPDATE OR DELETE ON workbench.game_revisions
FOR EACH ROW EXECUTE FUNCTION workbench.reject_sealed_manifest_write();

DO $$
DECLARE table_ref TEXT;
BEGIN
  FOREACH table_ref IN ARRAY ARRAY[
    'workbench.game_team_snapshots','workbench.game_roster_snapshots','workbench.game_roster_positions',
    'workbench.relay_event_facts','workbench.relay_half_inning_starts',
    'workbench.relay_batter_starts','workbench.relay_pitches',
    'workbench.relay_plate_results','workbench.relay_runner_advances',
    'workbench.relay_substitutions','workbench.relay_reviews',
    'workbench.relay_administrative','workbench.relay_unresolved',
    'workbench.tracking_observations',
    'workbench.official_batter_lines','workbench.official_pitcher_lines',
    'workbench.validation_runs','workbench.validation_issues','workbench.validation_issue_details',
    'baseball.play_facts','baseball.play_events','baseball.runner_movement_facts',
    'baseball.plate_appearance_facts','baseball.plate_appearance_events','baseball.pitch_facts',
    'baseball.pitch_tracking_links','baseball.game_final_states','baseball.batter_game_facts',
    'baseball.pitcher_game_facts','baseball.baserunner_game_facts'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER reject_sealed_write BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION workbench.reject_sealed_revision_write()',
      table_ref
    );
  END LOOP;
END $$;
