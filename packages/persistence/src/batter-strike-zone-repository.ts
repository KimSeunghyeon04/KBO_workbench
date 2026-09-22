import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";
import type { BatterStrikeZone } from "@kbo/contracts";
import { resolveBatterStrikeZone } from "@kbo/game-core";

const rowSchema = Type.Object(
  {
    pitchId: Type.String(),
    season: Type.Integer(),
    heightCm: Type.Union([Type.Integer({ minimum: 100, maximum: 250 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export class BatterStrikeZoneRepository {
  public constructor(private readonly pool: Pool) {}

  public async forGame(
    gameId: string,
    revision: number,
  ): Promise<ReadonlyMap<string, BatterStrikeZone>> {
    const result = await this.pool.query<Record<string, unknown>>(
      `
      SELECT p.pitch_id AS "pitchId", r.season, h.height_cm AS "heightCm"
      FROM baseball.pitch_facts p
      JOIN workbench.game_revisions r USING (game_id,revision)
      LEFT JOIN analytics.game_batter_heights h ON h.game_id=p.game_id AND h.revision=p.revision AND h.player_id=p.batter_id
      WHERE p.game_id=$1 AND p.revision=$2 AND r.sealed AND p.actual
      ORDER BY p.pitch_sequence`,
      [gameId, revision],
    );
    const zones = new Map<string, BatterStrikeZone>();
    for (const raw of result.rows) {
      const row = Value.Decode(rowSchema, raw);
      const zone = resolveBatterStrikeZone(row.season, row.heightCm);
      if (zone !== null) zones.set(row.pitchId, zone);
    }
    return zones;
  }
}
