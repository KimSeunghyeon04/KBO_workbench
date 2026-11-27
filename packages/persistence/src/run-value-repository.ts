import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  RunTrainingGameSchema,
  RunValueResponseSchema,
  canonicalStringify,
  type AnalysisPlay,
  type RunObservation,
  type RunExpectancyModel,
  type CountRunObservation,
  type CountRunModel,
  CountRunValueResponseSchema,
  type WinObservation,
  type WinModel,
  WinProbabilityResponseSchema,
} from "@kbo/contracts";
import {
  collectRunObservations,
  evaluateRunValues,
  collectCountRunObservations,
  evaluateCountRunValues,
  collectWinObservations,
  evaluateWinValues,
  winInningLimit,
} from "@kbo/game-core";
import { readAnalysisPlays } from "./analysis-plays.js";
import { normalGameEndSql } from "./normal-game-end.js";
import { readRegularModelScopeHashes, type RegularModelScopeHash } from "./analysis-scope.js";
const gameColumns = `r.game_id AS "gameId",r.revision,r.season,to_char(r.game_date,'YYYY-MM-DD') AS "gameDate",r.scheduled_innings AS "scheduledInnings",r.game_status AS status,r.document_hash AS "documentHash",
 ${normalGameEndSql} AS "normalEnd"`;
const replayGameRows = Type.Array(
  Type.Object(
    {
      ...RunTrainingGameSchema.properties,
      regular: Type.Boolean(),
      projectionHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    },
    { additionalProperties: false },
  ),
);
interface ReplayPlaysCache {
  get(key: string): Promise<readonly AnalysisPlay[]> | undefined;
  load(key: string, read: () => Promise<readonly AnalysisPlay[]>): Promise<readonly AnalysisPlay[]>;
}
export class RunValueRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly replayPlays?: ReplayPlaysCache,
  ) {}
  public async training(
    through: number,
    signal?: AbortSignal,
    kind: "all" | "re24" | "count" | "win" = "all",
  ) {
    if (!Number.isInteger(through) || through < 2020 || through > 2199)
      throw new Error("훈련 마지막 시즌은 2020–2199여야 합니다.");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const manifest = await readRunManifest(client, through),
        games = manifest.games.filter(
          (g) =>
            g.normalEnd &&
            g.status === "final" &&
            g.scheduledInnings === 9 &&
            (kind !== "win" || winInningLimit(g.season) !== null),
        );
      const observations: RunObservation[] = [];
      const countObservations: CountRunObservation[] = [];
      const winObservations: WinObservation[] = [];
      for (let offset = 0; offset < games.length; offset += 32) {
        signal?.throwIfAborted();
        const batch = games.slice(offset, offset + 32),
          plays = await readAnalysisPlays(
            client,
            batch.map((g) => g.gameId),
            undefined,
            false,
          );
        const byGame = new Map<string, typeof plays>();
        for (const p of plays) {
          const group = byGame.get(p.gameId) ?? [];
          group.push(p);
          byGame.set(p.gameId, group);
        }
        for (const game of batch) {
          if (kind !== "win")
            observations.push(...collectRunObservations(game, byGame.get(game.gameId) ?? []));
          if (kind === "all" || kind === "count")
            countObservations.push(
              ...collectCountRunObservations(game, byGame.get(game.gameId) ?? []),
            );
          if (kind === "all" || kind === "win")
            winObservations.push(
              ...collectWinObservations(
                game,
                byGame.get(game.gameId) ?? [],
                winInningLimit(through + 1),
              ),
            );
        }
      }
      await release();
      return { observations, countObservations, winObservations, manifest };
    });
  }
  public async game(
    gameId: string,
    revision: number,
    model: RunExpectancyModel | null,
    modelHash: string | null,
    expectedSeason?: number,
  ) {
    const input = await this.readGame(gameId, revision, model, expectedSeason);
    if (input === null) return null;
    return Value.Decode(
      RunValueResponseSchema,
      evaluateRunValues(
        input.game,
        input.plays,
        input.modelCurrent ? model : null,
        input.modelCurrent ? modelHash : null,
      ),
    );
  }
  public async countGame(
    gameId: string,
    revision: number,
    model: CountRunModel | null,
    modelHash: string | null,
    expectedSeason?: number,
  ) {
    const input = await this.readGame(gameId, revision, model, expectedSeason);
    if (input === null) return null;
    return Value.Decode(
      CountRunValueResponseSchema,
      evaluateCountRunValues(
        input.game,
        input.plays,
        input.modelCurrent ? model : null,
        input.modelCurrent ? modelHash : null,
      ),
    );
  }
  public async winGame(
    gameId: string,
    revision: number,
    model: WinModel | null,
    modelHash: string | null,
    expectedSeason?: number,
  ) {
    const input = await this.readGame(gameId, revision, model, expectedSeason);
    if (input === null) return null;
    return Value.Decode(
      WinProbabilityResponseSchema,
      evaluateWinValues(
        input.game,
        input.plays,
        input.modelCurrent ? model : null,
        input.modelCurrent ? modelHash : null,
      ),
    );
  }
  private async readGame(
    gameId: string,
    revision: number,
    model: { sourceHash: string; trainedThrough: number } | null,
    expectedSeason?: number,
  ) {
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT ${gameColumns},r.projection_hash AS "projectionHash",
          COALESCE((SELECT c.competition='regular' FROM analytics.current_analysis_games c
            WHERE c.game_id=r.game_id LIMIT 1),FALSE) AS regular
        FROM workbench.game_revisions r JOIN baseball.game_final_states f USING(game_id,revision)
        WHERE r.game_id=$1 AND r.revision=$2 AND r.sealed`,
        [gameId, revision],
      );
      const row = Value.Decode(replayGameRows, rows)[0];
      if (row === undefined || (expectedSeason !== undefined && row.season !== expectedSeason)) {
        await release();
        return null;
      }
      const { regular, projectionHash, ...game } = row;
      const modelCurrent =
        regular &&
        model !== null &&
        model.sourceHash === runTrainingHash(await readRunManifest(client, model.trainedThrough));
      const readPlays = async () => {
        const plays = await readAnalysisPlays(client, [gameId], revision);
        await release();
        return plays;
      };
      // Only the sealed inputs can outlive this snapshot. Competition and model validity stay live.
      const key = JSON.stringify([gameId, revision, game.documentHash, projectionHash]);
      const cached = this.replayPlays?.get(key);
      if (cached !== undefined) await release();
      const plays = await (cached ?? this.replayPlays?.load(key, readPlays) ?? readPlays());
      return { game, plays, modelCurrent };
    });
  }
}
export function runTrainingHash(
  manifest: Awaited<ReturnType<RunValueRepository["training"]>>["manifest"],
) {
  return createHash("sha256").update(canonicalStringify(manifest)).digest("hex");
}

export async function readRunManifest(
  client: PoolClient,
  through: number,
  sharedScopeHashes?: RegularModelScopeHash[],
) {
  const games = Value.Decode(
    Type.Array(RunTrainingGameSchema),
    (
      await client.query<Record<string, unknown>>(
        `SELECT ${gameColumns} FROM analytics.current_analysis_games r JOIN baseball.game_final_states f USING(game_id,revision) WHERE r.competition='regular' AND r.season BETWEEN 2020 AND $1 ORDER BY r.game_id COLLATE "C"`,
        [through + 1],
      )
    ).rows,
  );
  const scopeHashes = sharedScopeHashes ?? (await readRegularModelScopeHashes(client, through));
  return { version: 1 as const, through, games, scopeHashes };
}
