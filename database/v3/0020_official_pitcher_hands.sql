-- Reviewed KBO evidence applies only to the identified pitcher and game source.
CREATE TABLE registry.official_pitcher_hands (
  game_id TEXT NOT NULL REFERENCES workbench.games(game_id),
  source_bundle_hash TEXT NOT NULL CHECK (source_bundle_hash ~ '^[0-9a-f]{64}$'),
  pitcher_id TEXT NOT NULL CHECK (pitcher_id ~ '^[0-9]+$'),
  pitcher_name TEXT NOT NULL CHECK (length(btrim(pitcher_name))>0),
  pitcher_hand TEXT NOT NULL CHECK (pitcher_hand IN ('L','R')),
  reported_hand TEXT NOT NULL CHECK (length(btrim(reported_hand))>0),
  source_url TEXT NOT NULL CHECK (source_url LIKE 'https://www.koreabaseball.com/%'),
  checked_on DATE NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (game_id,source_bundle_hash,pitcher_id)
);

CREATE FUNCTION registry.guard_official_pitcher_hand() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Official pitcher hand evidence is immutable';
END;
$$;
CREATE TRIGGER guard_official_pitcher_hand BEFORE UPDATE OR DELETE
  ON registry.official_pitcher_hands FOR EACH ROW EXECUTE FUNCTION registry.guard_official_pitcher_hand();
