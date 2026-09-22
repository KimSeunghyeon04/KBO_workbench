CREATE SCHEMA reference;
CREATE TABLE reference.competition_datasets (
  dataset_hash TEXT PRIMARY KEY CHECK(dataset_hash ~ '^[0-9a-f]{64}$'),
  season INTEGER NOT NULL CHECK(season >= 1982), parser_version INTEGER NOT NULL CHECK(parser_version=1),
  sealed BOOLEAN NOT NULL DEFAULT FALSE, UNIQUE(dataset_hash,season)
);
CREATE TABLE reference.competition_pages (
  dataset_hash TEXT NOT NULL REFERENCES reference.competition_datasets,
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  competition TEXT NOT NULL CHECK(competition IN ('preseason','regular','postseason')),
  source_url TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  artifact_key TEXT NOT NULL, collected_at TEXT NOT NULL,
  PRIMARY KEY(dataset_hash,month,competition)
);
CREATE TABLE reference.game_competitions (
  dataset_hash TEXT NOT NULL REFERENCES reference.competition_datasets,
  source_game_id TEXT NOT NULL, game_date DATE NOT NULL,
  competition TEXT NOT NULL CHECK(competition IN ('preseason','regular','postseason')),
  page_hash TEXT NOT NULL CHECK(page_hash ~ '^[0-9a-f]{64}$'),
  game_id TEXT NULL REFERENCES workbench.games,
  PRIMARY KEY(dataset_hash,source_game_id), UNIQUE(dataset_hash,game_id)
);
CREATE TABLE reference.current_competition_datasets (
  season INTEGER PRIMARY KEY, dataset_hash TEXT NOT NULL,
  FOREIGN KEY(dataset_hash,season) REFERENCES reference.competition_datasets(dataset_hash,season)
);
CREATE FUNCTION reference.protect_competition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target TEXT; frozen BOOLEAN;
BEGIN
  IF TG_TABLE_NAME='competition_datasets' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.sealed THEN RAISE EXCEPTION 'competition must be sealed after writing'; END IF;
    ELSIF OLD.sealed THEN RAISE EXCEPTION 'sealed competition dataset is immutable';
    ELSIF TG_OP='UPDATE' THEN
      IF NEW.dataset_hash IS DISTINCT FROM OLD.dataset_hash OR NEW.season IS DISTINCT FROM OLD.season
        OR NEW.parser_version IS DISTINCT FROM OLD.parser_version THEN
        RAISE EXCEPTION 'competition dataset identity is immutable';
      END IF;
      IF NEW.sealed THEN
        IF (SELECT count(*) FROM reference.competition_pages WHERE dataset_hash=NEW.dataset_hash)<>36
          OR EXISTS(SELECT 1 FROM reference.game_competitions c WHERE c.dataset_hash=NEW.dataset_hash
            AND (extract(year FROM c.game_date)<>NEW.season OR NOT EXISTS(
              SELECT 1 FROM reference.competition_pages p WHERE p.dataset_hash=c.dataset_hash
                AND p.content_hash=c.page_hash AND p.month=extract(month FROM c.game_date)
                AND p.competition=c.competition))) THEN
          RAISE EXCEPTION 'competition source evidence is incomplete';
        END IF;
      END IF;
    END IF;
  ELSE
    IF TG_OP='DELETE' THEN target=OLD.dataset_hash; ELSE target=NEW.dataset_hash; END IF;
    IF TG_OP='UPDATE' AND NEW.dataset_hash IS DISTINCT FROM OLD.dataset_hash THEN
      RAISE EXCEPTION 'competition dataset identity is immutable';
    END IF;
    SELECT sealed INTO frozen FROM reference.competition_datasets WHERE dataset_hash=target;
    IF frozen THEN RAISE EXCEPTION 'sealed competition entries are immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER competition_dataset_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON reference.competition_datasets FOR EACH ROW EXECUTE FUNCTION reference.protect_competition();
CREATE TRIGGER competition_page_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON reference.competition_pages FOR EACH ROW EXECUTE FUNCTION reference.protect_competition();
CREATE TRIGGER competition_entry_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON reference.game_competitions FOR EACH ROW EXECUTE FUNCTION reference.protect_competition();
CREATE FUNCTION reference.require_sealed_competition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM reference.competition_datasets WHERE dataset_hash=NEW.dataset_hash AND sealed) THEN
    RAISE EXCEPTION 'current competition dataset must be sealed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER competition_current_sealed BEFORE INSERT OR UPDATE
  ON reference.current_competition_datasets FOR EACH ROW EXECUTE FUNCTION reference.require_sealed_competition();
CREATE VIEW analytics.current_analysis_games AS
SELECT r.*, COALESCE(c.competition,'unknown') AS competition, d.dataset_hash AS competition_dataset_hash
FROM analytics.current_game_revisions r
LEFT JOIN reference.current_competition_datasets d ON d.season=r.season
LEFT JOIN reference.game_competitions c ON c.dataset_hash=d.dataset_hash AND c.game_id=r.game_id
  AND c.source_game_id=r.source_game_id AND c.game_date=r.game_date;
