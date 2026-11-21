-- Exact dated provider identities remain usable when the game arrives after schedule adoption.
-- Previously sealed datasets and game facts are unchanged.
CREATE OR REPLACE VIEW analytics.current_analysis_games AS
SELECT r.*, COALESCE(c.competition,'unknown') AS competition, d.dataset_hash AS competition_dataset_hash
FROM analytics.current_game_revisions r
LEFT JOIN reference.current_competition_datasets d ON d.season=r.season
LEFT JOIN (reference.game_competitions c
  LEFT JOIN reference.competition_game_links l ON l.dataset_hash=c.dataset_hash AND l.source_game_id=c.source_game_id)
  ON c.dataset_hash=d.dataset_hash AND (c.game_id=r.game_id OR c.game_id IS NULL)
  AND c.game_date=r.game_date
  AND COALESCE(l.matched_source_game_id,c.source_game_id)=r.source_game_id;
