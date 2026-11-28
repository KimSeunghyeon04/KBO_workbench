import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  MatchupQuerySchema,
  MatchupOpponentsQuerySchema,
  MatchupOpponentsResponseSchema,
  DirectMatchupResponseSchema,
  MatchupResponseSchema,
  MatchupConditionCountsSchema,
  resolveAnalysisScope,
  canonicalStringify,
  type AnalysisScope,
  type MatchupQuery,
  type MatchupOpponentsQuery,
} from "@kbo/contracts";
import { analyzeMatchup, summarizeDirectMatchup } from "@kbo/game-core";
import {
  analysisScopeParameters,
  analysisSourceHash,
  scopedAnalysisGamesSql,
} from "./analysis-scope.js";
import { readPitchOutcomeCohort, type PitchOutcomeCohort } from "./pitch-outcomes.js";
import { readPitchOutcomeSources } from "./pitch-outcome-sources.js";
import {
  effectiveBattingSideSql,
  gameBattingProfileJoinSql,
  gamePitchRowsSql,
  pitchEligibilitySql,
  pitchPlateAppearanceJoinSql,
  pitchTrackingJoinsSql,
} from "./analysis-pitch-input.js";
interface MatchupCohortCache {
  hasPrefix(prefix: string): boolean;
  get(key: string): Promise<PitchOutcomeCohort> | undefined;
  load(key: string, read: () => Promise<PitchOutcomeCohort>): Promise<PitchOutcomeCohort>;
}
const opponentSchema = MatchupOpponentsResponseSchema.properties.players.items;
const rosterSchema = Type.Array(Type.Pick(opponentSchema, ["id", "name", "teams"]));
const countsSchema = Type.Array(Type.Pick(opponentSchema, ["id", "pitches", "plateAppearances"]));
type Roster = typeof rosterSchema.static;
interface SeasonRosterCache {
  load(key: string, read: () => Promise<Roster>): Promise<Roster>;
}

async function readSeasonRoster(client: PoolClient, season: number): Promise<Roster> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT s.player_id AS id,coalesce(min(s.player_name COLLATE "C"),s.player_id) AS name,
      array_agg(DISTINCT t.team_name COLLATE "C" ORDER BY t.team_name COLLATE "C") AS teams
    FROM analytics.current_analysis_games r
    JOIN workbench.game_roster_snapshots s USING (game_id,revision)
    JOIN workbench.game_team_snapshots t ON (t.game_id,t.revision,t.side)=(s.game_id,s.revision,s.side)
    WHERE r.season=$1 AND r.competition<>'allstar'
    GROUP BY s.player_id`,
    [season],
  );
  return Value.Decode(rosterSchema, rows);
}

async function seasonRosterKey(client: PoolClient, season: number): Promise<string> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT encode(sha256(convert_to(coalesce(string_agg(
      ROW(game_id,revision,document_hash)::text,',' ORDER BY game_id COLLATE "C"
    ),''),'UTF8')),'hex') AS fingerprint
    FROM analytics.current_analysis_games WHERE season=$1 AND competition<>'allstar'`,
    [season],
  );
  const { fingerprint } = Value.Decode(
    Type.Object({ fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
    rows[0],
  );
  return `${season}:${fingerprint}`;
}

export class MatchupRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly directCohorts?: MatchupCohortCache,
    private readonly seasonRosters?: SeasonRosterCache,
  ) {}
  public async opponents(input: MatchupOpponentsQuery) {
    const query = Value.Decode(MatchupOpponentsQuerySchema, input);
    const { role, playerId, ...scopeQuery } = query;
    const scope = resolveAnalysisScope(scopeQuery, "regular");
    const actor = role === "pitcher" ? "pitcher_id" : "batter_id";
    const opponent = role === "pitcher" ? "batter_id" : "pitcher_id";
    const { observations, roster } = await withAnalysisSnapshot(this.pool, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `WITH selected_games AS MATERIALIZED (
          ${scopedAnalysisGamesSql()}
        ), observations AS (
          SELECT p.${opponent} AS id, count(*) AS pitches, 0 AS pa
          FROM selected_games r JOIN baseball.pitch_facts p USING (game_id, revision)
          WHERE p.actual AND p.${actor}=$5 AND p.${opponent} IS NOT NULL
          GROUP BY p.${opponent}
          UNION ALL
          SELECT f.${opponent} AS id, 0 AS pitches, count(*) AS pa
          FROM selected_games r JOIN baseball.plate_appearance_facts f USING (game_id, revision)
          WHERE f.completed AND f.counts_as_plate_appearance
            AND f.${actor}=$5 AND f.${opponent} IS NOT NULL
          GROUP BY f.${opponent}
        )
        SELECT id,sum(pitches)::integer AS pitches,sum(pa)::integer AS "plateAppearances"
        FROM observations GROUP BY id`,
        [...analysisScopeParameters(scope), playerId],
      );
      const observations = Value.Decode(countsSchema, rows);
      const roster =
        this.seasonRosters === undefined
          ? await readSeasonRoster(client, scope.season)
          : await this.seasonRosters.load(await seasonRosterKey(client, scope.season), () =>
              readSeasonRoster(client, scope.season),
            );
      return { observations, roster };
    });
    const players = new Map<string, typeof opponentSchema.static>(
      roster.map(
        ({ id, name, teams }) =>
          [id, { id, name, teams: [...teams], pitches: 0, plateAppearances: 0 }] as const,
      ),
    );
    for (const { id, pitches, plateAppearances } of observations) {
      const identity = players.get(id) ?? { id, name: id, teams: [] };
      players.set(id, { ...identity, pitches, plateAppearances });
    }
    const ordered = [...players.values()].map((value) => ({ value, order: Buffer.from(value.id) }));
    ordered.sort(
      (a, b) =>
        b.value.plateAppearances - a.value.plateAppearances ||
        b.value.pitches - a.value.pitches ||
        Buffer.compare(a.order, b.order),
    );
    return Value.Decode(MatchupOpponentsResponseSchema, {
      query,
      scope,
      players: ordered.map(({ value }) => value),
    });
  }
  public async direct(input: MatchupQuery) {
    const query = Value.Decode(MatchupQuerySchema, input);
    const { pitcherId, batterId, ...scopeQuery } = query;
    const scope = resolveAnalysisScope(scopeQuery, "regular");
    const { rows, appearances } = await withAnalysisSnapshot(this.pool, async (client, release) => {
      const read = async () => {
        const cohort = await readPitchOutcomeCohort(client, scope, batterId, "batter", pitcherId);
        await release();
        return cohort;
      };
      const cache = this.directCohorts;
      if (cache === undefined) return read();
      const { key } = await readDirectSource(client, scope, batterId, pitcherId);
      const cached = cache.get(key);
      if (cached !== undefined) await release();
      return cached ?? cache.load(key, read);
    });
    return Value.Decode(
      DirectMatchupResponseSchema,
      summarizeDirectMatchup(
        query,
        scope,
        rows,
        appearances.map(({ row }) => row),
      ),
    );
  }
  public async analyze(input: MatchupQuery) {
    const query = Value.Decode(MatchupQuerySchema, input),
      { pitcherId, batterId, ...scopeQuery } = query,
      scope = resolveAnalysisScope(scopeQuery, "regular");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const prefix = directCohortPrefix(scope, batterId, pitcherId);
      const source =
        this.directCohorts?.hasPrefix(prefix) === true
          ? await readDirectSource(client, scope, batterId, pitcherId)
          : { manifest: await analysisSourceHash(client, scope), key: undefined };
      const covered =
        source.key === undefined ? undefined : await this.directCohorts?.get(source.key);
      const overlap =
        covered !== undefined && (covered.rows.length > 0 || covered.appearances.length > 0)
          ? covered
          : undefined;
      const { rows, appearances } = await readPitchOutcomeCohort(
        client,
        scope,
        batterId,
        "batter",
        overlap === undefined ? undefined : pitcherId,
        overlap,
      );
      const plateAppearances = appearances.map(({ row }) => row);
      // Aggregate conditions in SQL instead of transporting the full league's tracking trajectories.
      const groups = await client.query<Record<string, unknown>>(
        `WITH selected_games AS MATERIALIZED (
    ${scopedAnalysisGamesSql()}
   ), eligible AS (
    SELECT eligible.* FROM selected_games r CROSS JOIN LATERAL (
      ${gamePitchRowsSql({
        source: "facts",
        select: `p.pitch_type AS "pitchType",p.before_balls AS balls,p.before_strikes AS strikes,
          ${effectiveBattingSideSql} AS stance,floor(p.speed_kph/5)::integer AS "speedBand",
          p.pitcher_id,p.batter_id,p.swing,p.whiff,p.called_strike`,
        joins: `${pitchTrackingJoinsSql()} ${gameBattingProfileJoinSql("p")} ${pitchPlateAppearanceJoinSql}`,
        pitchPredicate: `p.pitch_type IS NOT NULL AND p.speed_kph>0 AND p.speed_kph<500
          AND ${effectiveBattingSideSql} IS NOT NULL AND ${pitchEligibilitySql}`,
      })}
    ) eligible
   ), targets AS (SELECT DISTINCT "pitchType",balls,strikes,stance,"speedBand" FROM eligible WHERE pitcher_id=$5)
   SELECT 'pitcher' AS kind,"pitchType",balls,strikes,stance,"speedBand",count(*)::integer AS pitches,count(*) FILTER(WHERE swing)::integer AS swings,count(*) FILTER(WHERE whiff)::integer AS whiffs,count(*) FILTER(WHERE called_strike)::integer AS "calledStrikes"
   FROM eligible WHERE pitcher_id=$5 GROUP BY "pitchType",balls,strikes,stance,"speedBand"
   UNION ALL
   SELECT 'league' AS kind,e."pitchType",e.balls,e.strikes,e.stance,e."speedBand",count(*)::integer AS pitches,count(*) FILTER(WHERE e.swing)::integer AS swings,count(*) FILTER(WHERE e.whiff)::integer AS whiffs,count(*) FILTER(WHERE e.called_strike)::integer AS "calledStrikes"
   FROM eligible e JOIN targets t USING("pitchType",balls,strikes,stance,"speedBand") WHERE e.batter_id<>$6 GROUP BY e."pitchType",e.balls,e.strikes,e.stance,e."speedBand"
   ORDER BY kind,"pitchType",balls,strikes,stance,"speedBand"`,
        [...analysisScopeParameters(scope), pitcherId, batterId],
      );
      await release();
      const decoded = Value.Decode(
        Type.Array(
          Type.Object(
            {
              ...MatchupConditionCountsSchema.properties,
              kind: Type.Union([Type.Literal("pitcher"), Type.Literal("league")]),
            },
            { additionalProperties: false },
          ),
        ),
        groups.rows,
      );
      decoded.sort((a, b) => {
        const left = canonicalStringify(a),
          right = canonicalStringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      const target = decoded
          .filter((g) => g.kind === "pitcher")
          .map(({ kind, ...g }) => {
            void kind;
            return g;
          }),
        league = decoded
          .filter((g) => g.kind === "league")
          .map(({ kind, ...g }) => {
            void kind;
            return g;
          });
      const sourceHash = createHash("sha256")
        .update(
          canonicalStringify({
            version: 1,
            manifest: source.manifest,
            rows,
            plateAppearances,
            target,
            league,
          }),
        )
        .digest("hex");
      return Value.Decode(
        MatchupResponseSchema,
        analyzeMatchup(query, scope, sourceHash, rows, plateAppearances, target, league),
      );
    });
  }
}

function directCohortPrefix(scope: AnalysisScope, batterId: string, pitcherId: string): string {
  // PostgreSQL matches IDs as stored, including distinct Unicode normalization forms.
  return (
    JSON.stringify([
      scope.season,
      scope.competition,
      scope.dateFrom,
      scope.dateTo,
      batterId,
      pitcherId,
    ]) + ":"
  );
}

async function readDirectSource(
  client: PoolClient,
  scope: AnalysisScope,
  batterId: string,
  pitcherId: string,
) {
  const { manifest, supplements } = await readPitchOutcomeSources(client, scope, {
    batterId,
    pitcherId,
  });
  return {
    manifest,
    key: directCohortPrefix(scope, batterId, pitcherId) + JSON.stringify([manifest, supplements]),
  };
}
