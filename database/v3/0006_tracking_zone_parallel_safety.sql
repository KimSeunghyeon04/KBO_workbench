-- The exception handler starts a subtransaction, which PostgreSQL disallows during
-- parallel execution, including in the leader. Preserve formula 2 and sealed facts.
ALTER FUNCTION analytics.tracking_in_zone(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  DOUBLE PRECISION, DOUBLE PRECISION
) PARALLEL UNSAFE;
