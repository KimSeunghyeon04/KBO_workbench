-- Preserve V3 sealed revisions; new writes and analytics use projection contract 4.
ALTER TABLE workbench.contract_metadata DROP CONSTRAINT contract_metadata_analytics_contract_version_check;
ALTER TABLE workbench.contract_metadata DROP CONSTRAINT contract_metadata_projection_version_check;
UPDATE workbench.contract_metadata SET analytics_contract_version=4, projection_version=4 WHERE singleton;
ALTER TABLE workbench.contract_metadata ADD CHECK (analytics_contract_version=4), ADD CHECK (projection_version=4);
ALTER TABLE workbench.game_revisions DROP CONSTRAINT game_revisions_projection_version_check;
ALTER TABLE workbench.game_revisions ADD CHECK (projection_version IN (3,4));

ALTER TABLE workbench.relay_pitches
  ADD COLUMN speed_kph DOUBLE PRECISION NULL CHECK (speed_kph > 0 AND speed_kph < 'Infinity'::DOUBLE PRECISION),
  ADD COLUMN pitch_type TEXT NULL CHECK (length(pitch_type) BETWEEN 1 AND 100 AND pitch_type ~ '[^[:space:]]');

ALTER TABLE baseball.pitch_facts
  ADD COLUMN speed_kph DOUBLE PRECISION NULL CHECK (speed_kph > 0 AND speed_kph < 'Infinity'::DOUBLE PRECISION),
  ADD COLUMN pitch_type TEXT NULL CHECK (length(pitch_type) BETWEEN 1 AND 100 AND pitch_type ~ '[^[:space:]]');

CREATE OR REPLACE VIEW analytics.current_pitches AS
SELECT p.game_id, p.revision, p.pitch_sequence, p.pitch_id, p.plate_appearance_event_id, p.pitch_event_number, p.actual_pitch_number, p.inning, p.half, p.batter_id, p.pitcher_id, p.source_pitch_id, p.pitch_call, p.actual, p.ball, p.called_strike, p.swing, p.whiff, p.foul, p.in_play, p.strike, p.csw, p.before_balls, p.before_strikes, p.before_outs, p.before_base1_runner_id, p.before_base2_runner_id, p.before_base3_runner_id, p.before_away_score, p.before_home_score, p.after_balls, p.after_strikes, p.after_outs, p.after_base1_runner_id, p.after_base2_runner_id, p.after_base3_runner_id, p.after_away_score, p.after_home_score, p.batter_identity_key, p.pitcher_identity_key, r.season, r.game_date,
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
              AND t.cross_plate_y BETWEEN t.bottom_sz AND t.top_sz) END AS chase, p.speed_kph, p.pitch_type
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

CREATE OR REPLACE VIEW analytics.all_revision_pitches AS SELECT * FROM baseball.pitch_facts;
