-- Add immutable, source-bound player heights without rewriting sealed game facts.
CREATE TABLE registry.game_height_bundles (
  game_id TEXT NOT NULL,
  source_bundle_hash TEXT NOT NULL CHECK (source_bundle_hash ~ '^[0-9a-f]{64}$'),
  season INTEGER NOT NULL CHECK (season BETWEEN 1982 AND 9999),
  dataset_hash TEXT NOT NULL CHECK (dataset_hash ~ '^[0-9a-f]{64}$'),
  observation_count INTEGER NOT NULL CHECK (observation_count>=0),
  sealed BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (game_id,source_bundle_hash)
);
CREATE TABLE registry.game_player_height_observations (
  game_id TEXT NOT NULL,
  source_bundle_hash TEXT NOT NULL,
  observation_sequence INTEGER NOT NULL CHECK (observation_sequence>=0),
  player_id TEXT NOT NULL CHECK (length(player_id)>0),
  height_cm INTEGER CHECK (height_cm BETWEEN 100 AND 250),
  raw_height TEXT,
  endpoint TEXT NOT NULL CHECK (length(endpoint)>0),
  source_path TEXT NOT NULL CHECK (length(source_path)>0),
  PRIMARY KEY (game_id,source_bundle_hash,observation_sequence),
  FOREIGN KEY (game_id,source_bundle_hash) REFERENCES registry.game_height_bundles
);
CREATE FUNCTION registry.guard_game_height_bundle() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.sealed THEN RAISE EXCEPTION 'Height bundle must be inserted unsealed'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND NOT OLD.sealed AND NEW.sealed
     AND (OLD.game_id,OLD.source_bundle_hash,OLD.season,OLD.dataset_hash,OLD.observation_count)
       IS NOT DISTINCT FROM (NEW.game_id,NEW.source_bundle_hash,NEW.season,NEW.dataset_hash,NEW.observation_count)
     AND NEW.observation_count=(SELECT count(*) FROM registry.game_player_height_observations
          WHERE game_id=NEW.game_id AND source_bundle_hash=NEW.source_bundle_hash) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Height bundles are immutable';
END;
$$;
CREATE TRIGGER guard_game_height_bundle BEFORE INSERT OR UPDATE OR DELETE
  ON registry.game_height_bundles FOR EACH ROW EXECUTE FUNCTION registry.guard_game_height_bundle();
CREATE FUNCTION registry.guard_game_height_observation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM registry.game_height_bundles
      WHERE game_id=NEW.game_id AND source_bundle_hash=NEW.source_bundle_hash AND NOT sealed FOR UPDATE;
    IF FOUND THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Sealed height observations are immutable';
END;
$$;
CREATE TRIGGER guard_game_height_observation BEFORE INSERT OR UPDATE OR DELETE
  ON registry.game_player_height_observations FOR EACH ROW EXECUTE FUNCTION registry.guard_game_height_observation();

-- A pitch uses its own game's source bundle and provider player ID, never another season/name.
-- Missing or invalid observations do not override valid ones. Conflicting valid values yield NULL.
CREATE VIEW analytics.game_batter_heights AS
SELECT r.game_id,r.revision,h.player_id,
  CASE WHEN min(h.height_cm)=max(h.height_cm) THEN min(h.height_cm) ELSE NULL END AS height_cm
FROM workbench.game_revisions r
JOIN registry.game_height_bundles b ON b.game_id=r.game_id AND b.source_bundle_hash=r.source_bundle_hash
  AND b.season=r.season AND b.sealed
JOIN registry.game_player_height_observations h ON h.game_id=b.game_id AND h.source_bundle_hash=b.source_bundle_hash
WHERE r.sealed
GROUP BY r.game_id,r.revision,h.player_id;

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
       t.cross_plate_x,t.cross_plate_y,NULL::float8 AS top_sz,NULL::float8 AS bottom_sz,
       zone.in_zone, CASE WHEN p.swing THEN NOT zone.in_zone ELSE NULL END AS chase,
       p.speed_kph, p.pitch_type, height.height_cm AS batter_height_cm
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
  ON measurement_profile.measurement_profile_id=t.measurement_profile_id
LEFT JOIN analytics.game_batter_heights height
  ON height.game_id=p.game_id AND height.revision=p.revision AND height.player_id=p.batter_id
LEFT JOIN LATERAL (
  SELECT CASE WHEN measurement_profile.supports_zone IS TRUE
    THEN analytics.tracking_in_zone(t.cross_plate_x,t.cross_plate_y,t.y0,t.z0,
                                   t.vy0,t.vz0,t.ay,t.az,
      analytics.batter_zone_bottom(r.season,height.height_cm),
      analytics.batter_zone_top(r.season,height.height_cm))
    ELSE NULL END AS in_zone
) zone ON TRUE;

UPDATE catalog.tracking_measurement_profiles SET zone_formula_version=4 WHERE measurement_profile_id='naver_pts_v1';
