import { scopedAnalysisGamesSql } from "./analysis-scope.js";

const gamePitchKeySql = "p.game_id=r.game_id AND p.revision=r.revision";
const actualGamePitchSql = `${gamePitchKeySql} AND p.actual`;

export function gamePitchRowsSql(
  options: {
    source?: "facts";
    select?: string;
    joins?: string;
    pitchPredicate?: string;
    includeNonActual?: true;
  } = {},
): string {
  const source = options.source === "facts" ? "baseball.pitch_facts" : "analytics.current_pitches";
  // Keep enrichment of the pitch view bounded to one selected game and revision.
  return `SELECT ${options.select ?? "p.*"} FROM ${source} p
    ${options.joins ?? ""}
    WHERE ${options.includeNonActual ? gamePitchKeySql : actualGamePitchSql}
    ${options.pitchPredicate === undefined ? "" : `AND (${options.pitchPredicate})`}
    OFFSET 0`;
}

export function analysisPitchCatalogSql(role: "pitcher" | "batter"): string {
  const [topSide, bottomSide] = role === "pitcher" ? ["home", "away"] : ["away", "home"];
  const name =
    role === "batter" ? "COALESCE(min(roster.player_name),b.player_id)" : "min(roster.player_name)";
  const actor = `p.${role}_id`;
  return `WITH selected_games AS MATERIALIZED (${scopedAnalysisGamesSql()})
    SELECT b.player_id AS "${role}Id",${name} AS name,sum(b.pitches)::integer AS pitches
    FROM selected_games r
    JOIN workbench.game_team_snapshots away
      ON away.game_id=r.game_id AND away.revision=r.revision AND away.side='away'
    JOIN workbench.game_team_snapshots home
      ON home.game_id=r.game_id AND home.revision=r.revision AND home.side='home'
    CROSS JOIN LATERAL (
      SELECT ${actor} AS player_id,
        CASE WHEN p.half='top' THEN '${topSide}' ELSE '${bottomSide}' END AS side,count(*) AS pitches
      FROM baseball.pitch_facts p
      WHERE ${actualGamePitchSql}
        ${role === "batter" ? "AND p.batter_id IS NOT NULL" : ""}
      GROUP BY 1,2
    ) b
    LEFT JOIN workbench.game_roster_snapshots roster
      ON roster.game_id=r.game_id AND roster.revision=r.revision
      AND roster.side=b.side AND roster.player_id=b.player_id
    GROUP BY b.player_id ORDER BY sum(b.pitches) DESC,b.player_id COLLATE "C"`;
}

// Callers select current game revisions first. These joins expose only the canonical
// linked observation; player/height/zone joins belong to consumers that use them.
export function pitchTrackingJoinsSql(pitch: "p" | "q" = "p"): string {
  return `LEFT JOIN baseball.pitch_tracking_links l
    ON l.game_id=${pitch}.game_id AND l.revision=${pitch}.revision AND l.pitch_id=${pitch}.pitch_id
   LEFT JOIN workbench.tracking_observations t
    ON t.game_id=l.game_id AND t.revision=l.revision AND t.tracking_id=l.tracking_id`;
}

export function gameBattingProfileJoinSql(pitch: "p" | "q"): string {
  // Keep the key predicates inside the profile aggregation instead of joining all profiles first.
  return `LEFT JOIN LATERAL (
    SELECT bp.batting_side FROM analytics.game_batter_profiles bp
    WHERE bp.game_id=${pitch}.game_id AND bp.revision=${pitch}.revision
      AND bp.player_id=${pitch}.batter_id
    OFFSET 0
  ) profile ON TRUE`;
}

export const effectiveBattingSideSql = "COALESCE(t.stance,profile.batting_side)";

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

export const pitchPlateAppearanceJoinSql = `LEFT JOIN baseball.plate_appearance_facts pa
  ON pa.game_id=p.game_id AND pa.revision=p.revision AND pa.start_event_id=p.plate_appearance_event_id`;

export const pitchViewObservationJoinSql = `LEFT JOIN workbench.tracking_observations t
  ON t.game_id=p.game_id AND t.revision=p.revision AND t.tracking_id=p.tracking_id`;

export function scopedTrackedPitchRowsSql(options: {
  select: string;
  pitchPredicate: string;
  joins?: string;
  gameColumns?: string;
  gamePredicate?: string;
  orderByPitchId?: true;
}): string {
  return `WITH selected_games AS MATERIALIZED (
    ${scopedAnalysisGamesSql(options.gameColumns, options.gamePredicate)}
  ) SELECT p.game_id AS "gameId",p.revision,p.pitch_id AS "pitchId",
    to_char(p.game_date,'YYYY-MM-DD') AS "gameDate",p.batter_id AS "batterId",p.pitch_type AS "pitchType",
    p.before_balls AS balls,p.before_strikes AS strikes,p.swing,p.whiff,
    p.season,p.batter_height_cm AS "batterHeightCm",p.tracking_id AS "trackingId",p.in_zone AS "inZone",
    ${options.select},
    ${pitchEligibilitySql} AS eligible,
    COALESCE(t.measurement_profile_id='naver_pts_v1',FALSE) AS supported,
    ${pitchGeometrySql}
  FROM selected_games r CROSS JOIN LATERAL (
    ${gamePitchRowsSql({ pitchPredicate: options.pitchPredicate })}
  ) p
  ${pitchViewObservationJoinSql}
  ${options.joins ?? ""}
  ${pitchPlateAppearanceJoinSql}
  ORDER BY p.game_id COLLATE "C",${options.orderByPitchId ? 'p.pitch_id COLLATE "C"' : "p.pitch_sequence"}`;
}

export const lastPitchesCteSql = `last_pitches AS (
  SELECT DISTINCT ON (q.game_id,q.revision,q.plate_appearance_event_id) q.*
  FROM baseball.pitch_facts q JOIN selected_pas s ON s.game_id=q.game_id AND s.revision=q.revision AND s.pa_id=q.plate_appearance_event_id
  WHERE q.pitch_call<>'no_pitch'
  ORDER BY q.game_id,q.revision,q.plate_appearance_event_id,q.pitch_sequence DESC
)`;
