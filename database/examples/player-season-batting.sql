-- AVG/OBP/SLG/OPS/BABIP/K%/BB%와 각 분모를 함께 조회한다.
SELECT
  season,
  player_id,
  plate_appearances,
  at_bats,
  hits,
  home_runs,
  avg_numerator,
  avg_denominator,
  avg,
  obp_numerator,
  obp_denominator,
  obp,
  total_bases,
  slg_denominator,
  slg,
  ops,
  babip_numerator,
  babip_denominator,
  babip,
  strikeout_rate_numerator,
  strikeout_rate_denominator,
  strikeout_rate,
  walk_rate_numerator,
  walk_rate_denominator,
  walk_rate
FROM analytics.current_player_season_batting
ORDER BY season, plate_appearances DESC, player_id;
