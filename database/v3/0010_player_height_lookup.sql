-- Keep one row per actual batter/revision and use the choice's unique key. The UNION
-- over every source observation underestimated its output as one row, causing a
-- season query to repeatedly scan all players. Only unchosen batters need raw evidence.
CREATE OR REPLACE VIEW analytics.game_batter_heights AS
WITH batters AS (
  SELECT DISTINCT game_id,revision,batter_id AS player_id FROM baseball.pitch_facts
  WHERE actual AND batter_id IS NOT NULL
)
SELECT p.game_id,p.revision,p.player_id,COALESCE(c.height_cm,observed.height_cm) AS height_cm
FROM batters p
JOIN workbench.game_revisions r USING(game_id,revision)
LEFT JOIN registry.game_player_height_choices c
  ON c.game_id=r.game_id AND c.source_bundle_hash=r.source_bundle_hash AND c.player_id=p.player_id
LEFT JOIN LATERAL (
  SELECT CASE WHEN min(o.height_cm)=max(o.height_cm) THEN min(o.height_cm) ELSE NULL END AS height_cm
  FROM registry.game_player_height_observations o
  JOIN registry.game_height_bundles b USING(game_id,source_bundle_hash,extraction_version)
  WHERE c.player_id IS NULL AND o.game_id=r.game_id AND o.source_bundle_hash=r.source_bundle_hash
    AND o.player_id=p.player_id AND b.season=r.season AND b.sealed
    AND (b.extraction_version=2 OR NOT EXISTS (
      SELECT 1 FROM registry.game_height_bundles newer WHERE newer.game_id=b.game_id
        AND newer.source_bundle_hash=b.source_bundle_hash AND newer.extraction_version=2 AND newer.sealed))
) observed ON TRUE
WHERE r.sealed;
