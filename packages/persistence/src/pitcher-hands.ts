import { PitcherHandSchema, type PitcherHand } from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { PoolClient } from "pg";

export type ResolvePitcherHand = (declarations: readonly string[]) => PitcherHand | null;
interface PitcherInGame {
  readonly gameId: string;
  readonly revision: number;
  readonly pitcherId: string | null;
}
const key = ({ gameId, revision, pitcherId }: PitcherInGame) =>
  JSON.stringify([gameId, revision, pitcherId]);
const evidenceSchema = Type.Array(
  Type.Object(
    {
      gameId: Type.String({ minLength: 1 }),
      revision: Type.Integer({ minimum: 1 }),
      pitcherId: Type.String({ minLength: 1 }),
      declaration: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      officialHand: Type.Union([PitcherHandSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
);

export async function readGamePitcherHands(
  client: PoolClient,
  targets: readonly PitcherInGame[],
  resolve: ResolvePitcherHand,
) {
  const wanted = [
    ...new Map(
      targets.flatMap((row) => (row.pitcherId === null ? [] : ([[key(row), row]] as const))),
    ).values(),
  ];
  const hands = new Map<string, PitcherHand | null>();
  if (wanted.length > 0) {
    const result = await client.query(
      `SELECT r.game_id AS "gameId",r.revision,target.pitcher_id AS "pitcherId",
         o.raw_value AS declaration,f.pitcher_hand AS "officialHand"
       FROM unnest($1::text[],$2::integer[],$3::text[]) AS target(game_id,revision,pitcher_id)
       JOIN workbench.game_revisions r USING(game_id,revision)
       LEFT JOIN registry.game_batting_profile_bundles b
         ON b.game_id=r.game_id AND b.source_bundle_hash=r.source_bundle_hash
         AND b.season=r.season AND b.sealed
       LEFT JOIN registry.game_player_batting_profile_observations o
         ON o.game_id=b.game_id AND o.source_bundle_hash=b.source_bundle_hash
         AND o.player_id=target.pitcher_id
       LEFT JOIN registry.official_pitcher_hands f
         ON f.game_id=r.game_id AND f.source_bundle_hash=r.source_bundle_hash
         AND f.pitcher_id=target.pitcher_id AND EXISTS (
           SELECT 1 FROM workbench.game_roster_snapshots roster
           WHERE roster.game_id=r.game_id AND roster.revision=r.revision
             AND roster.player_id=f.pitcher_id AND roster.player_name=f.pitcher_name
         )
       WHERE r.sealed`,
      [
        wanted.map((row) => row.gameId),
        wanted.map((row) => row.revision),
        wanted.map((row) => row.pitcherId),
      ],
    );
    const observations = new Map<
      string,
      { declarations: string[]; officialHand: PitcherHand | null }
    >();
    for (const row of Value.Decode(evidenceSchema, result.rows)) {
      const id = key(row);
      const observed = observations.get(id) ?? { declarations: [], officialHand: row.officialHand };
      if (row.declaration !== null) observed.declarations.push(row.declaration);
      observations.set(id, observed);
    }
    for (const [id, { declarations, officialHand }] of observations) {
      const hand = resolve(declarations);
      // An explicit but conflicting game declaration remains unresolved.
      const fallback =
        officialHand !== null && declarations.every((value) => resolve([value]) === null);
      hands.set(id, hand ?? (fallback ? officialHand : null));
    }
  }
  return (pitch: PitcherInGame) => hands.get(key(pitch)) ?? null;
}
