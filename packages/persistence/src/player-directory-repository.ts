import {
  PlayerDirectorySchema,
  type OfficialPlayerBirthYear,
  type OfficialPlayerCareerRecord,
} from "@kbo/contracts";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";
import { withAnalysisSnapshot } from "./analysis-snapshot.js";

const directorySql = `WITH appearances AS (
  SELECT game_id,revision,side,player_id,player_identity_key,plate_appearances,0 AS pitches
  FROM baseball.batter_game_facts WHERE plate_appearances>0
  UNION ALL
  SELECT game_id,revision,side,player_id,player_identity_key,0,pitches
  FROM baseball.pitcher_game_facts WHERE pitches>0
), details AS (
  SELECT i.player_id AS identity,f.player_id,f.game_id,f.revision,f.side,
    f.plate_appearances AS pa,f.pitches,
    r.season,r.game_date,t.team_name,s.player_name,s.roster_index
  FROM appearances f
  JOIN analytics.current_game_revisions r USING(game_id,revision)
  JOIN catalog.player_identities i ON i.identity_key=f.player_identity_key
  JOIN workbench.game_team_snapshots t
    ON t.game_id=f.game_id AND t.revision=f.revision AND t.side=f.side
  LEFT JOIN workbench.game_roster_snapshots s
    ON s.game_id=f.game_id AND s.revision=f.revision AND s.side=f.side AND s.player_id=f.player_id
), positions AS (
  SELECT d.identity,d.game_id,p.position
  FROM details d JOIN workbench.game_roster_positions p USING(game_id,revision,side,roster_index)
  WHERE p.position IN ('포수','1루수','2루수','3루수','유격수','좌익수','중견수','우익수','지명타자')
  UNION ALL
  SELECT identity,game_id,'투수' FROM details WHERE pitches>0
), ranked_positions AS (
  SELECT identity,position,rank() OVER (PARTITION BY identity ORDER BY count(DISTINCT game_id) DESC)
    AS position_rank
  FROM positions GROUP BY identity,position
), primary_positions AS (
  SELECT identity,CASE WHEN count(*)=1 THEN min(position) END AS position
  FROM ranked_positions WHERE position_rank=1 GROUP BY identity
), allstar_games AS MATERIALIZED (
  SELECT game_id,revision FROM analytics.current_analysis_games WHERE competition='allstar'
), team_changes AS (
  SELECT identity,team_name,game_date,game_id,side,
    lag(team_name) OVER (PARTITION BY identity ORDER BY game_date,game_id COLLATE "C",side) AS previous_team
  FROM details d
  WHERE NOT EXISTS (
    SELECT 1 FROM allstar_games a WHERE a.game_id=d.game_id AND a.revision=d.revision
  )
), team_histories AS (
  SELECT identity,array_agg(team_name ORDER BY game_date,game_id COLLATE "C",side) AS teams
  FROM team_changes
  WHERE team_name IS DISTINCT FROM previous_team
  GROUP BY identity
), player_seasons AS (
  SELECT identity,player_id,season,
    (array_agg(player_name ORDER BY game_date DESC,game_id COLLATE "C" DESC,side)
      FILTER (WHERE player_name IS NOT NULL))[1] AS name,
    max(game_date) AS last_date,
    sum(pa)::integer AS pa,sum(pitches)::integer AS pitches
  FROM details
  GROUP BY identity,player_id,season
)
SELECT s.identity,s.player_id AS "sourceId",s.season,s.name,coalesce(h.teams,'{}') AS teams,
  s.pa,s.pitches,p.position AS "primaryPosition"
FROM player_seasons s LEFT JOIN team_histories h USING(identity) LEFT JOIN primary_positions p USING(identity)
ORDER BY s.last_date DESC,s.identity COLLATE "C",s.player_id COLLATE "C"`;

const rowSchema = Type.Object(
  {
    identity: Type.String(),
    sourceId: Type.String(),
    season: Type.Integer(),
    name: Type.Union([Type.String(), Type.Null()]),
    teams: Type.Array(Type.String()),
    pa: Type.Integer({ minimum: 0 }),
    pitches: Type.Integer({ minimum: 0 }),
    primaryPosition: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
type DirectoryRow = Static<typeof rowSchema>;

export class PlayerDirectoryRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly readCareers: () => Promise<
      readonly OfficialPlayerCareerRecord[]
    > = async () => [],
    private readonly readBirthYears: () => Promise<
      readonly OfficialPlayerBirthYear[]
    > = async () => [],
  ) {}

  public async list() {
    const [rows, verified, births] = await Promise.all([
      withAnalysisSnapshot(this.pool, async (client) => {
        return (await client.query<Record<string, unknown>>(directorySql)).rows;
      }),
      this.readCareers(),
      this.readBirthYears(),
    ]);
    const byId = new Map(verified.map((record) => [record.playerId, record]));
    const birthByIdentity = new Map(
      births.map(({ playerId, name, birthYear }) => [`${playerId}\u0000${name}`, birthYear]),
    );
    const players = new Map<string, DirectoryRow[]>();
    for (const row of Value.Decode(Type.Array(rowSchema), rows)) {
      const previous = players.get(row.identity);
      if (previous) previous.push(row);
      else players.set(row.identity, [row]);
    }
    return Value.Decode(
      PlayerDirectorySchema,
      [...players].map(([identity, records]) => {
        const seasonRecords = new Map<number, DirectoryRow[]>();
        for (const row of records) {
          const previous = seasonRecords.get(row.season);
          if (previous) previous.push(row);
          else seasonRecords.set(row.season, [row]);
        }
        const name = records.find((row) => row.name !== null)?.name ?? "이름 미확인";
        const sourceIds = [...new Set(records.map((row) => row.sourceId))];
        const seasons = [...seasonRecords]
          .sort(([a], [b]) => b - a)
          .map(([season, selected]) => ({
            season,
            battingPlayerId: selectSourceId(selected, "pa"),
            pitchingPlayerId: selectSourceId(selected, "pitches"),
          }));
        const candidates = sourceIds.flatMap((id) => {
          const entry = byId.get(id);
          return entry?.name === name.normalize("NFC") &&
            seasons.every(
              ({ season }) =>
                season >= entry.career.firstSeason && season <= entry.career.lastSeason,
            )
            ? [entry.career]
            : [];
        });
        const career = candidates.length === 1 ? candidates[0] : undefined;
        const normalizedName = name.trim().normalize("NFC");
        const years = new Set(
          sourceIds
            .map((id) => birthByIdentity.get(`${id}\u0000${normalizedName}`))
            .filter((year) => year !== undefined),
        );
        const birthYear = years.size === 1 ? years.values().next().value : undefined;
        return {
          identity,
          name,
          primaryPosition: records[0]?.primaryPosition ?? null,
          teams: records[0]?.teams ?? [],
          sourceIds,
          seasons,
          ...(career === undefined ? {} : { career }),
          ...(birthYear === undefined ? {} : { birthYear }),
        };
      }),
    );
  }
}

// Feature APIs take provider IDs. Pick the observed ID with the most records in this season and role.
function selectSourceId(rows: readonly DirectoryRow[], measure: "pa" | "pitches"): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.sourceId, (counts.get(row.sourceId) ?? 0) + row[measure]);
  let selected: string | null = null;
  let maximum = 0;
  for (const [id, count] of counts) {
    if (count <= maximum) continue;
    maximum = count;
    selected = id;
  }
  return selected;
}
