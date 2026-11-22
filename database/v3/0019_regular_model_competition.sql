-- Keep the legacy model fingerprint until the effective regular-season game set changes.
ALTER TABLE reference.current_competition_datasets
  ADD COLUMN regular_model_dataset_hash TEXT,
  ADD FOREIGN KEY(regular_model_dataset_hash,season)
    REFERENCES reference.competition_datasets(dataset_hash,season);

CREATE OR REPLACE FUNCTION reference.require_sealed_competition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM reference.competition_datasets WHERE dataset_hash=NEW.dataset_hash AND sealed) THEN
    RAISE EXCEPTION 'current competition dataset must be sealed';
  END IF;
  IF NEW.regular_model_dataset_hash IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM reference.competition_datasets WHERE dataset_hash=NEW.regular_model_dataset_hash AND sealed
  ) THEN
    RAISE EXCEPTION 'regular model competition dataset must be sealed';
  END IF;
  RETURN NEW;
END $$;

UPDATE reference.current_competition_datasets SET regular_model_dataset_hash=dataset_hash;
