-- Provider zone bounds are retired evidence, never a validation or calculation input.
-- Sealed rows/hashes remain unchanged. New collection does not create these fields.
ALTER TABLE workbench.tracking_observations DROP CONSTRAINT tracking_observations_check;

CREATE FUNCTION analytics.batter_zone_top(season INTEGER, height_cm INTEGER)
RETURNS DOUBLE PRECISION LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN season BETWEEN 1982 AND 2026 AND height_cm BETWEEN 100 AND 250
    THEN height_cm * CASE WHEN season<=2024 THEN 0.5635::float8 ELSE 0.5575::float8 END / 30.48
    ELSE NULL END
$$;
CREATE FUNCTION analytics.batter_zone_bottom(season INTEGER, height_cm INTEGER)
RETURNS DOUBLE PRECISION LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN season BETWEEN 1982 AND 2026 AND height_cm BETWEEN 100 AND 250
    THEN height_cm * CASE WHEN season<=2024 THEN 0.2764::float8 ELSE 0.2704::float8 END / 30.48
    ELSE NULL END
$$;

-- Latest observed valid height in the same season, through resolved player identity.
-- Equally recent conflicting heights are unavailable; no tracking/other-season fallback.
CREATE VIEW analytics.current_batter_heights AS
SELECT season,player_id,CASE WHEN minimum_height=maximum_height THEN minimum_height ELSE NULL END AS height_cm
FROM (
  SELECT p.season,i.player_id,p.snapshot_date,min(p.height_cm) AS minimum_height,
    max(p.height_cm) AS maximum_height,
    row_number() OVER (PARTITION BY p.season,i.player_id ORDER BY p.snapshot_date DESC) AS recency
  FROM registry.registration_snapshot_players p
  JOIN registry.season_current_revisions c ON c.season=p.season AND c.current_revision=p.revision
  JOIN registry.season_revisions r ON r.season=p.season AND r.revision=p.revision AND r.sealed
  JOIN catalog.player_identities i ON i.identity_key=p.player_identity_key
  WHERE p.height_cm BETWEEN 100 AND 250
  GROUP BY p.season,i.player_id,p.snapshot_date
) heights WHERE recency=1;

CREATE OR REPLACE FUNCTION analytics.tracking_in_zone(
  cross_plate_x DOUBLE PRECISION, cross_plate_y DOUBLE PRECISION,
  y0 DOUBLE PRECISION, z0 DOUBLE PRECISION,
  vy0 DOUBLE PRECISION, vz0 DOUBLE PRECISION,
  ay DOUBLE PRECISION, az DOUBLE PRECISION,
  bottom_sz DOUBLE PRECISION, top_sz DOUBLE PRECISION
) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  a DOUBLE PRECISION;
  b DOUBLE PRECISION;
  c DOUBLE PRECISION;
  discriminant DOUBLE PRECISION;
  root_a DOUBLE PRECISION;
  root_b DOUBLE PRECISION;
  crossing_time DOUBLE PRECISION;
  height DOUBLE PRECISION;
BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES (cross_plate_x),(cross_plate_y),(y0),(z0),(vy0),(vz0),
                         (ay),(az),(bottom_sz),(top_sz)) AS inputs(value)
    WHERE NOT (value > '-Infinity'::DOUBLE PRECISION AND value < 'Infinity'::DOUBLE PRECISION)
  ) OR bottom_sz < 0 OR top_sz <= bottom_sz THEN
    RETURN NULL;
  END IF;

  a := ay / 2;
  b := vy0;
  c := y0 - cross_plate_y;
  IF abs(a) < 1e-9 THEN
    IF abs(b) < 1e-9 THEN
      IF abs(c) >= 1e-9 THEN RETURN NULL; END IF;
      crossing_time := 0;
    ELSE
      crossing_time := -c / b;
    END IF;
  ELSE
    discriminant := b * b - 4 * a * c;
    IF discriminant < 0 OR discriminant >= 'Infinity'::DOUBLE PRECISION THEN
      RETURN NULL;
    END IF;
    root_a := (-b - sqrt(discriminant)) / (2 * a);
    root_b := (-b + sqrt(discriminant)) / (2 * a);
    IF root_a >= 0 AND root_b >= 0 THEN
      crossing_time := least(root_a, root_b);
    ELSIF root_a >= 0 THEN
      crossing_time := root_a;
    ELSE
      crossing_time := root_b;
    END IF;
  END IF;

  IF crossing_time < 0 OR crossing_time >= 'Infinity'::DOUBLE PRECISION THEN
    RETURN NULL;
  END IF;
  height := z0 + vz0 * crossing_time + (az * crossing_time * crossing_time) / 2;
  IF NOT (height >= 0 AND height < 'Infinity'::DOUBLE PRECISION) THEN RETURN NULL; END IF;
  RETURN abs(cross_plate_x) <= (47.18 / 2 / 30.48) AND height BETWEEN bottom_sz AND top_sz;
EXCEPTION WHEN numeric_value_out_of_range THEN
  RETURN NULL;
END;
$$;

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
LEFT JOIN analytics.current_batter_heights height
  ON height.season=r.season AND height.player_id=batter_identity.player_id
LEFT JOIN LATERAL (
  SELECT CASE WHEN measurement_profile.supports_zone IS TRUE
    THEN analytics.tracking_in_zone(t.cross_plate_x,t.cross_plate_y,t.y0,t.z0,
                                   t.vy0,t.vz0,t.ay,t.az,
      analytics.batter_zone_bottom(r.season,height.height_cm),
      analytics.batter_zone_top(r.season,height.height_cm))
    ELSE NULL END AS in_zone
) zone ON TRUE;

UPDATE catalog.tracking_measurement_profiles SET zone_formula_version=3 WHERE measurement_profile_id='naver_pts_v1';
