-- Current revision 기준 선수 시즌 주루 합계.
SELECT
  season,
  player_id,
  advances,
  extra_bases_taken,
  runs,
  stolen_bases,
  caught_stealing,
  pickoffs
FROM analytics.current_player_season_baserunning
ORDER BY season, runs DESC, player_id;
