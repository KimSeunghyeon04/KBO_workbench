-- Keep both official KBO and collected provider identities; existing sealed datasets stay untouched.
CREATE TABLE reference.competition_game_links (
  dataset_hash TEXT NOT NULL,
  source_game_id TEXT NOT NULL,
  matched_source_game_id TEXT NOT NULL,
  PRIMARY KEY(dataset_hash,source_game_id),
  UNIQUE(dataset_hash,matched_source_game_id),
  FOREIGN KEY(dataset_hash,source_game_id) REFERENCES reference.game_competitions(dataset_hash,source_game_id)
);
CREATE TRIGGER competition_link_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON reference.competition_game_links FOR EACH ROW EXECUTE FUNCTION reference.protect_competition();
CREATE OR REPLACE VIEW analytics.current_analysis_games AS
SELECT r.*, COALESCE(c.competition,'unknown') AS competition, d.dataset_hash AS competition_dataset_hash
FROM analytics.current_game_revisions r
LEFT JOIN reference.current_competition_datasets d ON d.season=r.season
LEFT JOIN (reference.game_competitions c
  LEFT JOIN reference.competition_game_links l ON l.dataset_hash=c.dataset_hash AND l.source_game_id=c.source_game_id)
  ON c.dataset_hash=d.dataset_hash AND c.game_id=r.game_id AND c.game_date=r.game_date
  AND COALESCE(l.matched_source_game_id,c.source_game_id)=r.source_game_id;
