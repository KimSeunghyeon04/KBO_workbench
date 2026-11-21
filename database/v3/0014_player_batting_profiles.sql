-- Source-bound supplements leave projection contract 4 and sealed game hashes intact.
CREATE TABLE registry.game_batting_profile_bundles (
  game_id TEXT NOT NULL,
  source_bundle_hash TEXT NOT NULL CHECK (source_bundle_hash ~ '^[0-9a-f]{64}$'),
  season INTEGER NOT NULL CHECK (season BETWEEN 1982 AND 9999),
  dataset_hash TEXT NOT NULL CHECK (dataset_hash ~ '^[0-9a-f]{64}$'),
  observation_count INTEGER NOT NULL CHECK (observation_count>=0),
  sealed BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (game_id,source_bundle_hash)
);
CREATE TABLE registry.game_player_batting_profile_observations (
  game_id TEXT NOT NULL,
  source_bundle_hash TEXT NOT NULL,
  observation_sequence INTEGER NOT NULL CHECK (observation_sequence>=0),
  player_id TEXT NOT NULL CHECK (length(player_id)>0),
  batting_side TEXT CHECK (batting_side IN ('L','R','S')),
  raw_value TEXT NOT NULL,
  endpoint TEXT NOT NULL CHECK (length(endpoint)>0),
  source_path TEXT NOT NULL CHECK (length(source_path)>0),
  PRIMARY KEY (game_id,source_bundle_hash,observation_sequence),
  FOREIGN KEY (game_id,source_bundle_hash) REFERENCES registry.game_batting_profile_bundles
);
CREATE FUNCTION registry.guard_game_batting_profile_bundle() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.sealed THEN RAISE EXCEPTION 'Batting profile bundle must be inserted unsealed'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND NOT OLD.sealed AND NEW.sealed
     AND (OLD.game_id,OLD.source_bundle_hash,OLD.season,OLD.dataset_hash,OLD.observation_count)
       IS NOT DISTINCT FROM (NEW.game_id,NEW.source_bundle_hash,NEW.season,NEW.dataset_hash,NEW.observation_count)
     AND NEW.observation_count=(SELECT count(*) FROM registry.game_player_batting_profile_observations
          WHERE game_id=NEW.game_id AND source_bundle_hash=NEW.source_bundle_hash) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Batting profile bundles are immutable';
END;
$$;
CREATE TRIGGER guard_game_batting_profile_bundle BEFORE INSERT OR UPDATE OR DELETE
  ON registry.game_batting_profile_bundles FOR EACH ROW EXECUTE FUNCTION registry.guard_game_batting_profile_bundle();
CREATE FUNCTION registry.guard_game_batting_profile_observation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM registry.game_batting_profile_bundles
      WHERE game_id=NEW.game_id AND source_bundle_hash=NEW.source_bundle_hash AND NOT sealed FOR UPDATE;
    IF FOUND THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Sealed batting profile observations are immutable';
END;
$$;
CREATE TRIGGER guard_game_batting_profile_observation BEFORE INSERT OR UPDATE OR DELETE
  ON registry.game_player_batting_profile_observations FOR EACH ROW EXECUTE FUNCTION registry.guard_game_batting_profile_observation();

-- Never infer a side from names, another game or a switch hitter's opposing pitcher.
-- Conflicting valid declarations (including S versus L/R) remain unknown.
CREATE VIEW analytics.game_batter_profiles AS
SELECT r.game_id,r.revision,o.player_id,
  CASE WHEN min(o.batting_side)=max(o.batting_side) THEN min(o.batting_side) ELSE NULL END AS batting_side
FROM workbench.game_revisions r
JOIN registry.game_batting_profile_bundles b ON b.game_id=r.game_id
  AND b.source_bundle_hash=r.source_bundle_hash AND b.season=r.season AND b.sealed
JOIN registry.game_player_batting_profile_observations o
  ON o.game_id=b.game_id AND o.source_bundle_hash=b.source_bundle_hash
WHERE r.sealed
GROUP BY r.game_id,r.revision,o.player_id;
