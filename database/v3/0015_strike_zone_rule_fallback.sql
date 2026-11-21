-- Keep each rule in force from its effective season until the next explicit rule.
-- Match game-core's strike-zone.ts. The 1982 start preserves the pre-ABS analysis policy.
CREATE FUNCTION analytics.batter_zone_boundary(season INTEGER, height_cm INTEGER, upper_boundary BOOLEAN)
RETURNS DOUBLE PRECISION LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT height_cm * CASE
    WHEN season NOT BETWEEN 1982 AND 9999 OR height_cm NOT BETWEEN 100 AND 250 THEN NULL
    WHEN season >= 2025 THEN CASE WHEN upper_boundary THEN 0.5575::float8 ELSE 0.2704::float8 END
    ELSE CASE WHEN upper_boundary THEN 0.5635::float8 ELSE 0.2764::float8 END
  END / 30.48
$$;

CREATE OR REPLACE FUNCTION analytics.batter_zone_top(season INTEGER, height_cm INTEGER)
RETURNS DOUBLE PRECISION LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT analytics.batter_zone_boundary(season, height_cm, TRUE)
$$;

CREATE OR REPLACE FUNCTION analytics.batter_zone_bottom(season INTEGER, height_cm INTEGER)
RETURNS DOUBLE PRECISION LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT analytics.batter_zone_boundary(season, height_cm, FALSE)
$$;
