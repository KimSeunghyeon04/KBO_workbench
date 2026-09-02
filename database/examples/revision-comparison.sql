-- Analyst 권한만으로 :game_id의 두 revision grain별 행 수를 비교한다.
-- :old_revision과 :new_revision을 SQL client parameter로 바인딩한다.
WITH selected_revisions(revision) AS (
  VALUES (:old_revision), (:new_revision)
), pitch_counts AS (
  SELECT revision, COUNT(*) AS pitches
  FROM analytics.all_revision_pitches
  WHERE game_id = :game_id AND revision IN (:old_revision, :new_revision)
  GROUP BY revision
), pa_counts AS (
  SELECT revision, COUNT(*) AS plate_appearances
  FROM analytics.all_revision_plate_appearances
  WHERE game_id = :game_id AND revision IN (:old_revision, :new_revision)
  GROUP BY revision
), play_counts AS (
  SELECT revision, COUNT(*) AS plays
  FROM analytics.all_revision_plays
  WHERE game_id = :game_id AND revision IN (:old_revision, :new_revision)
  GROUP BY revision
), movement_counts AS (
  SELECT revision, COUNT(*) AS runner_movements
  FROM analytics.all_revision_runner_movements
  WHERE game_id = :game_id AND revision IN (:old_revision, :new_revision)
  GROUP BY revision
)
SELECT
  r.revision,
  COALESCE(p.pitches, 0) AS pitches,
  COALESCE(pa.plate_appearances, 0) AS plate_appearances,
  COALESCE(pl.plays, 0) AS plays,
  COALESCE(m.runner_movements, 0) AS runner_movements
FROM selected_revisions r
LEFT JOIN pitch_counts p USING (revision)
LEFT JOIN pa_counts pa USING (revision)
LEFT JOIN play_counts pl USING (revision)
LEFT JOIN movement_counts m USING (revision)
ORDER BY r.revision;
