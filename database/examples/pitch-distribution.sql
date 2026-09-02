-- Current revision 투구 분포. 비율과 numerator/denominator를 함께 확인한다.
SELECT
  season,
  pitcher_id,
  pitcher_name,
  pitch_call,
  COUNT(*) FILTER (WHERE actual) AS actual_pitches,
  COUNT(*) FILTER (WHERE actual AND strike) AS strikes,
  COUNT(*) FILTER (WHERE actual AND swing) AS swings,
  COUNT(*) FILTER (WHERE actual AND whiff) AS whiffs,
  COUNT(*) FILTER (WHERE actual AND csw) AS csw,
  COUNT(*) FILTER (WHERE actual AND in_zone IS NOT NULL) AS zone_opportunities,
  COUNT(*) FILTER (WHERE actual AND in_zone) AS pitches_in_zone,
  COUNT(*) FILTER (WHERE actual AND chase) AS chases,
  COUNT(*) FILTER (WHERE actual AND in_zone = FALSE) AS chase_opportunities,
  COUNT(*) FILTER (WHERE actual AND strike)::DOUBLE PRECISION
    / NULLIF(COUNT(*) FILTER (WHERE actual), 0) AS strike_rate,
  COUNT(*) FILTER (WHERE actual AND whiff)::DOUBLE PRECISION
    / NULLIF(COUNT(*) FILTER (WHERE actual AND swing), 0) AS whiff_rate,
  COUNT(*) FILTER (WHERE actual AND csw)::DOUBLE PRECISION
    / NULLIF(COUNT(*) FILTER (WHERE actual), 0) AS csw_rate,
  COUNT(*) FILTER (WHERE actual AND in_zone)::DOUBLE PRECISION
    / NULLIF(COUNT(*) FILTER (WHERE actual AND in_zone IS NOT NULL), 0) AS zone_rate,
  COUNT(*) FILTER (WHERE actual AND chase)::DOUBLE PRECISION
    / NULLIF(COUNT(*) FILTER (WHERE actual AND in_zone = FALSE), 0) AS chase_rate
FROM analytics.current_pitches
GROUP BY season, pitcher_id, pitcher_name, pitch_call
ORDER BY season, pitcher_name, pitch_call;
