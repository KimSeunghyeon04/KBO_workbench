
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='180s';
\echo __MANIFEST__
COPY (SELECT game_id,revision,season,game_date,stadium,document_hash,projection_hash
 FROM analytics.current_game_revisions WHERE season BETWEEN 2020 AND 2025
 ORDER BY game_id COLLATE "C") TO STDOUT CSV HEADER;
\echo __PITCHES__
COPY (SELECT p.game_id,p.revision,p.pitch_sequence,p.pitcher_id,p.half,p.pitch_type,
 p.speed_kph,p.stance,p.tracking_id,t.measurement_profile_id,
 p.x0,p.y0,p.z0,p.vx0,p.vy0,p.vz0,p.ax,p.ay,p.az,p.cross_plate_x,p.cross_plate_y,
 p.before_balls,p.before_strikes
 FROM analytics.current_pitches p
 LEFT JOIN workbench.tracking_observations t
 ON t.game_id=p.game_id AND t.revision=p.revision AND t.tracking_id=p.tracking_id
 WHERE p.actual AND p.season BETWEEN 2020 AND 2025
 ORDER BY p.game_id COLLATE "C",p.pitch_sequence) TO STDOUT CSV HEADER;
\echo __END__
COMMIT;
