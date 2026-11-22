-- Preserve sealed monthly datasets and allow dated supplemental evidence in new datasets.
ALTER TABLE reference.competition_datasets
  DROP CONSTRAINT competition_datasets_parser_version_check,
  ADD CHECK(parser_version IN (1,2));
ALTER TABLE reference.competition_pages
  DROP CONSTRAINT competition_pages_competition_check,
  DROP CONSTRAINT competition_pages_pkey,
  ADD COLUMN day_of_month INTEGER NOT NULL DEFAULT 0 CHECK(day_of_month BETWEEN 0 AND 31),
  ADD PRIMARY KEY(dataset_hash,month,competition,day_of_month),
  ADD CHECK((day_of_month=0 AND competition IN ('preseason','regular','postseason'))
         OR (day_of_month>0 AND competition IN ('allstar','postseason')));
ALTER TABLE reference.game_competitions
  DROP CONSTRAINT game_competitions_competition_check,
  ADD CHECK(competition IN ('preseason','regular','postseason','allstar'));

CREATE OR REPLACE FUNCTION reference.protect_competition() RETURNS trigger LANGUAGE plpgsql AS $$
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
        IF (SELECT count(*) FROM reference.competition_pages
            WHERE dataset_hash=NEW.dataset_hash AND day_of_month=0)<>36
          OR EXISTS(SELECT 1 FROM reference.competition_pages p WHERE p.dataset_hash=NEW.dataset_hash
            AND p.day_of_month>0 AND (NEW.parser_version=1
              OR p.day_of_month > EXTRACT(day FROM make_date(NEW.season,p.month,1) + INTERVAL '1 month - 1 day')))
          OR EXISTS(SELECT 1 FROM reference.game_competitions c WHERE c.dataset_hash=NEW.dataset_hash
            AND (extract(year FROM c.game_date)<>NEW.season OR NOT EXISTS(
              SELECT 1 FROM reference.competition_pages p WHERE p.dataset_hash=c.dataset_hash
                AND p.content_hash=c.page_hash AND p.month=extract(month FROM c.game_date)
                AND p.competition=c.competition
                AND (p.day_of_month=0 OR p.day_of_month=extract(day FROM c.game_date))))) THEN
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
