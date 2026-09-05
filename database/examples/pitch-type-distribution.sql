-- 실제 투구 기준. 구속 미제공은 평균에서 제외하고 표본 수를 함께 표시한다.
SELECT season, pitcher_id, pitcher_name, pitch_type,
       COUNT(*) AS pitches,
       COUNT(speed_kph) AS speed_samples,
       AVG(speed_kph) AS average_speed_kph,
       COUNT(*) FILTER (WHERE swing) AS swings,
       COUNT(*) FILTER (WHERE whiff) AS whiffs,
       COUNT(*) FILTER (WHERE whiff)::DOUBLE PRECISION
         / NULLIF(COUNT(*) FILTER (WHERE swing), 0) AS whiff_rate
FROM analytics.current_pitches
WHERE actual
GROUP BY season, pitcher_id, pitcher_name, pitch_type
ORDER BY season, pitcher_id, pitches DESC, pitch_type;
