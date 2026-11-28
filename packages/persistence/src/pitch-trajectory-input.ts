import { resolveAnalysisScope, type AnalysisScope } from "@kbo/contracts";
import { Type, type Static } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { PoolClient } from "pg";
import { analysisScopeParameters, scopedAnalysisGamesSql } from "./analysis-scope.js";
import { gamePitchRowsSql, pitchTrackingJoinsSql } from "./analysis-pitch-input.js";

const numberOrNull = Type.Union([Type.Number(), Type.Null()]);
const textOrNull = Type.Union([Type.String(), Type.Null()]);
const rowSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: Type.Integer(),
    pitchId: Type.String(),
    gameDate: Type.String(),
    gameFinal: Type.Optional(Type.Boolean()),
    pitcherId: Type.String(),
    stadium: textOrNull,
    stance: textOrNull,
    balls: Type.Integer({ minimum: 0, maximum: 3 }),
    strikes: Type.Integer({ minimum: 0, maximum: 2 }),
    pitchType: textOrNull,
    speedKph: numberOrNull,
    swing: Type.Boolean(),
    whiff: Type.Boolean(),
    trackingId: textOrNull,
    supported: Type.Boolean(),
    x0: numberOrNull,
    y0: numberOrNull,
    z0: numberOrNull,
    vx0: numberOrNull,
    vy0: numberOrNull,
    vz0: numberOrNull,
    ax: numberOrNull,
    ay: numberOrNull,
    az: numberOrNull,
    crossPlateY: numberOrNull,
  },
  { additionalProperties: false },
);
export type PitchAnalysisRow = Static<typeof rowSchema>;
// A season contains hundreds of thousands of these rows. Compile the same strict
// boundary check once instead of interpreting its schema for every pitch.
const pitchRowValidator = TypeCompiler.Compile(rowSchema);

export function decodePitchAnalysisRow(row: unknown): PitchAnalysisRow {
  if (!pitchRowValidator.Check(row)) throw new Error("Invalid pitch analysis tracking row");
  return row;
}
const trajectoryColumns = ["x0", "y0", "z0", "vx0", "vy0", "vz0", "ax", "ay", "az", "cross_plate_y"]
  .map(
    (column) =>
      `CASE WHEN t.${column} > '-Infinity'::double precision AND t.${column} < 'Infinity'::double precision THEN t.${column} ELSE NULL END AS "${column === "cross_plate_y" ? "crossPlateY" : column}"`,
  )
  .join(",");

export function pitchReferenceScope(scope: AnalysisScope): AnalysisScope {
  return { ...scope, dateFrom: null, dateTo: null };
}

export async function readPitchRows(
  client: PoolClient,
  season: number,
  pitcherId: string | null,
  allPitchTypes = false,
  scope: AnalysisScope = resolveAnalysisScope({ season }),
  finalOnly = false,
): Promise<PitchAnalysisRow[]> {
  const result = await client.query<Record<string, unknown>>(
    `
        WITH selected_games AS MATERIALIZED (
          ${scopedAnalysisGamesSql("r.game_id,r.revision,r.game_date,r.stadium,r.game_status", finalOnly ? "r.game_status='final'" : undefined)}
        ) SELECT pitch.* FROM selected_games r CROSS JOIN LATERAL (
          ${gamePitchRowsSql({
            source: "facts",
            select: `p.game_id AS "gameId",p.revision,p.pitch_id AS "pitchId",p.pitch_sequence AS "pitchSequence",
              to_char(r.game_date,'YYYY-MM-DD') AS "gameDate",(r.game_status='final') AS "gameFinal",p.pitcher_id AS "pitcherId",
              p.pitch_type AS "pitchType",p.speed_kph AS "speedKph",t.tracking_id AS "trackingId",
              r.stadium,t.stance,p.before_balls AS balls,p.before_strikes AS strikes,p.swing,p.whiff,
              COALESCE(t.measurement_profile_id='naver_pts_v1',FALSE) AS supported,${trajectoryColumns}`,
            joins: pitchTrackingJoinsSql(),
            pitchPredicate: `($5::text IS NULL OR p.pitcher_id=$5)${allPitchTypes || pitcherId !== null ? "" : " AND p.pitch_type='직구'"}`,
          })}
        ) pitch
        ORDER BY pitch."gameId" COLLATE "C", pitch."pitchSequence"
      `,
    [...analysisScopeParameters(scope), pitcherId],
  );
  return result.rows.map(({ pitchSequence, ...row }) => {
    void pitchSequence;
    return decodePitchAnalysisRow(row);
  });
}

export function readSeasonPitchReleaseRows(
  client: PoolClient,
  scope: AnalysisScope,
  pitcherId: string | null,
) {
  return readPitchRows(client, scope.season, pitcherId, false, pitchReferenceScope(scope), true);
}
