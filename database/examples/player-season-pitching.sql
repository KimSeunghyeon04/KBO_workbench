-- 투구 지표와 공식 ER 기반 ERA. 위치가 없으면 zone/chase 분모와 비율이 NULL/0일 수 있다.
SELECT
  season,
  player_id,
  batters_faced,
  actual_pitches,
  strikes,
  swings,
  whiffs,
  csw,
  zone_opportunities,
  pitches_in_zone,
  chases,
  chase_opportunities,
  contacts,
  strike_rate,
  swing_rate,
  whiff_rate,
  csw_rate,
  zone_rate,
  chase_rate,
  contact_rate,
  official_earned_runs,
  official_era
FROM analytics.current_player_season_pitching
ORDER BY season, batters_faced DESC, player_id;
