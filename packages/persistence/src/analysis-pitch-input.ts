// Callers select current game revisions first. These joins expose only the canonical
// linked observation; player/height/zone joins belong to consumers that use them.
export const pitchTrackingJoinsSql = `LEFT JOIN baseball.pitch_tracking_links l
  ON l.game_id=p.game_id AND l.revision=p.revision AND l.pitch_id=p.pitch_id
 LEFT JOIN workbench.tracking_observations t
  ON t.game_id=l.game_id AND t.revision=l.revision AND t.tracking_id=l.tracking_id`;

export const pitchGeometrySql = [
  "x0",
  "y0",
  "z0",
  "vx0",
  "vy0",
  "vz0",
  "ax",
  "ay",
  "az",
  "cross_plate_x",
  "cross_plate_y",
  "speed_kph",
]
  .map(
    (c) =>
      `CASE WHEN p.${c} > '-Infinity'::float8 AND p.${c} < 'Infinity'::float8 THEN p.${c} ELSE NULL END AS "${c.replace(/_([a-z])/gu, (_, s: string) => s.toUpperCase())}"`,
  )
  .join(",");

export const pitchEligibilitySql =
  "(p.pitch_call NOT IN ('hit_by_pitch','foul_bunt') AND NOT COALESCE(pa.is_bunt,FALSE) AND pa.result IS DISTINCT FROM 'intentional_walk')";
