-- Extraction 1 remains sealed with its original dataset hash. Extraction 2 also reads
-- relay batterRecord/pitcherRecord. Neither game facts nor old observations are rewritten.
ALTER TABLE registry.game_height_bundles ADD COLUMN extraction_version INTEGER NOT NULL DEFAULT 1 CHECK (extraction_version IN (1,2));
ALTER TABLE registry.game_player_height_observations ADD COLUMN extraction_version INTEGER NOT NULL DEFAULT 1 CHECK (extraction_version IN (1,2));
ALTER TABLE registry.game_player_height_observations DROP CONSTRAINT game_player_height_observations_game_id_source_bundle_hash_fkey;
ALTER TABLE registry.game_player_height_observations DROP CONSTRAINT game_player_height_observations_pkey;
ALTER TABLE registry.game_height_bundles DROP CONSTRAINT game_height_bundles_pkey;
ALTER TABLE registry.game_height_bundles ADD PRIMARY KEY (game_id,source_bundle_hash,extraction_version);
ALTER TABLE registry.game_player_height_observations ADD PRIMARY KEY (game_id,source_bundle_hash,extraction_version,observation_sequence);
ALTER TABLE registry.game_player_height_observations ADD FOREIGN KEY (game_id,source_bundle_hash,extraction_version) REFERENCES registry.game_height_bundles;
CREATE INDEX game_player_height_by_player ON registry.game_player_height_observations (player_id,extraction_version) WHERE height_cm IS NOT NULL;

CREATE OR REPLACE FUNCTION registry.guard_game_height_bundle() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.sealed THEN RAISE EXCEPTION 'Height bundle must be inserted unsealed'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND NOT OLD.sealed AND NEW.sealed
     AND (OLD.game_id,OLD.source_bundle_hash,OLD.extraction_version,OLD.season,OLD.dataset_hash,OLD.observation_count)
       IS NOT DISTINCT FROM (NEW.game_id,NEW.source_bundle_hash,NEW.extraction_version,NEW.season,NEW.dataset_hash,NEW.observation_count)
     AND NEW.observation_count=(SELECT count(*) FROM registry.game_player_height_observations
          WHERE game_id=NEW.game_id AND source_bundle_hash=NEW.source_bundle_hash AND extraction_version=NEW.extraction_version) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Height bundles are immutable';
END;
$$;
CREATE OR REPLACE FUNCTION registry.guard_game_height_observation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM registry.game_height_bundles
      WHERE game_id=NEW.game_id AND source_bundle_hash=NEW.source_bundle_hash
        AND extraction_version=NEW.extraction_version AND NOT sealed FOR UPDATE;
    IF FOUND THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Sealed height observations are immutable';
END;
$$;

CREATE TABLE registry.official_player_heights (
  season INTEGER NOT NULL CHECK (season BETWEEN 1982 AND 9999),
  player_id TEXT NOT NULL CHECK (length(player_id)>0),
  player_name TEXT NOT NULL CHECK (length(player_name)>0),
  birth_date DATE NOT NULL,
  height_cm INTEGER NOT NULL CHECK (height_cm BETWEEN 100 AND 250),
  reported_value DOUBLE PRECISION NOT NULL CHECK (reported_value BETWEEN 1 AND 250),
  reported_unit TEXT NOT NULL CHECK (reported_unit IN ('cm','inch')),
  source_url TEXT NOT NULL CHECK (source_url LIKE 'https://%'),
  source_player_id TEXT NOT NULL CHECK (length(source_player_id)>0),
  checked_on DATE NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (season,player_id),
  CHECK (height_cm=round((reported_value * CASE WHEN reported_unit='inch' THEN 2.54 ELSE 1 END)::numeric))
);
CREATE TABLE registry.game_player_height_choices (
  game_id TEXT NOT NULL,
  source_bundle_hash TEXT NOT NULL,
  extraction_version INTEGER NOT NULL DEFAULT 2 CHECK (extraction_version=2),
  player_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  height_cm INTEGER NOT NULL CHECK (height_cm BETWEEN 100 AND 250),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('same_game','same_season','official_profile')),
  evidence_game_id TEXT,
  evidence_bundle_hash TEXT,
  evidence_extraction_version INTEGER,
  evidence_sequence INTEGER,
  official_season INTEGER,
  official_player_id TEXT,
  PRIMARY KEY (game_id,source_bundle_hash,player_id),
  FOREIGN KEY (game_id,source_bundle_hash,extraction_version) REFERENCES registry.game_height_bundles,
  FOREIGN KEY (evidence_game_id,evidence_bundle_hash,evidence_extraction_version,evidence_sequence)
    REFERENCES registry.game_player_height_observations MATCH FULL,
  FOREIGN KEY (official_season,official_player_id) REFERENCES registry.official_player_heights MATCH FULL,
  CHECK ((source_kind='official_profile' AND official_season IS NOT NULL AND evidence_game_id IS NULL)
    OR (source_kind<>'official_profile' AND official_season IS NULL AND evidence_game_id IS NOT NULL))
);
CREATE FUNCTION registry.guard_height_choice() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Height choices are immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM registry.game_height_bundles
      WHERE game_id=NEW.game_id AND source_bundle_hash=NEW.source_bundle_hash
        AND season=NEW.season AND extraction_version=2 AND sealed) THEN
    RAISE EXCEPTION 'Height choice requires verified extraction 2 of its own source';
  END IF;
  IF NEW.source_kind='official_profile' THEN
    IF NEW.official_season<>NEW.season OR NEW.official_player_id<>NEW.player_id
       OR NOT EXISTS (SELECT 1 FROM registry.official_player_heights
          WHERE season=NEW.season AND player_id=NEW.player_id AND height_cm=NEW.height_cm) THEN
      RAISE EXCEPTION 'Official height evidence does not match player, season or height';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM registry.game_player_height_observations o
      JOIN registry.game_height_bundles b USING(game_id,source_bundle_hash,extraction_version)
      WHERE o.game_id=NEW.evidence_game_id AND o.source_bundle_hash=NEW.evidence_bundle_hash
        AND o.extraction_version=NEW.evidence_extraction_version AND o.observation_sequence=NEW.evidence_sequence
        AND o.player_id=NEW.player_id AND o.height_cm=NEW.height_cm AND b.season=NEW.season AND b.sealed) THEN
      RAISE EXCEPTION 'Local height evidence does not match player, season or height';
    END IF;
    IF (NEW.source_kind='same_game') IS DISTINCT FROM
       (NEW.game_id=NEW.evidence_game_id AND NEW.source_bundle_hash=NEW.evidence_bundle_hash) THEN
      RAISE EXCEPTION 'Height evidence scope does not match its source kind';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_height_choice BEFORE INSERT OR UPDATE OR DELETE
  ON registry.game_player_height_choices FOR EACH ROW EXECUTE FUNCTION registry.guard_height_choice();
CREATE FUNCTION registry.guard_official_height() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Official height evidence is immutable';
END;
$$;
CREATE TRIGGER guard_official_height BEFORE UPDATE OR DELETE
  ON registry.official_player_heights FOR EACH ROW EXECUTE FUNCTION registry.guard_official_height();

-- Explicit choices win permanently. Unresolved games retain their source-only behavior
-- until a verified extraction and explicit resolution run; no read-time cross-game fallback.
CREATE OR REPLACE VIEW analytics.game_batter_heights AS
WITH observed AS (
  SELECT b.game_id,b.source_bundle_hash,b.season,o.player_id,
    CASE WHEN min(o.height_cm)=max(o.height_cm) THEN min(o.height_cm) ELSE NULL END AS height_cm
  FROM registry.game_height_bundles b
  JOIN registry.game_player_height_observations o USING(game_id,source_bundle_hash,extraction_version)
  WHERE b.sealed AND (b.extraction_version=2 OR NOT EXISTS (
    SELECT 1 FROM registry.game_height_bundles newer WHERE newer.game_id=b.game_id
      AND newer.source_bundle_hash=b.source_bundle_hash AND newer.extraction_version=2 AND newer.sealed))
  GROUP BY b.game_id,b.source_bundle_hash,b.season,o.player_id
), effective AS (
  SELECT c.game_id,c.source_bundle_hash,c.season,c.player_id,c.height_cm FROM registry.game_player_height_choices c
  UNION ALL
  SELECT o.game_id,o.source_bundle_hash,o.season,o.player_id,o.height_cm FROM observed o
  WHERE NOT EXISTS (SELECT 1 FROM registry.game_player_height_choices c
    WHERE c.game_id=o.game_id AND c.source_bundle_hash=o.source_bundle_hash AND c.player_id=o.player_id)
)
SELECT r.game_id,r.revision,e.player_id,e.height_cm FROM workbench.game_revisions r
JOIN effective e ON e.game_id=r.game_id AND e.source_bundle_hash=r.source_bundle_hash AND e.season=r.season
WHERE r.sealed;

UPDATE catalog.tracking_measurement_profiles SET zone_formula_version=5 WHERE measurement_profile_id='naver_pts_v1';
