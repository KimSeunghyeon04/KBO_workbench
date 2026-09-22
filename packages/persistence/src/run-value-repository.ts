import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  RunTrainingGameSchema,
  RunValueResponseSchema,
  canonicalStringify,
  resolveAnalysisScope,
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
import { analysisSourceHash } from "./analysis-scope.js";
const gameColumns = `r.game_id AS "gameId",r.revision,r.season,to_char(r.game_date,'YYYY-MM-DD') AS "gameDate",r.scheduled_innings AS "scheduledInnings",r.game_status AS status,r.document_hash AS "documentHash",
 (r.game_status='final' AND r.scheduled_innings=9 AND f.final_inning>=9
  AND NOT EXISTS(SELECT 1 FROM workbench.relay_administrative a WHERE a.game_id=r.game_id AND a.revision=r.revision AND a.administrative_code IN ('called_game','forfeit'))
  AND NOT EXISTS(SELECT 1 FROM baseball.plate_appearance_facts pa WHERE pa.game_id=r.game_id AND pa.revision=r.revision AND pa.termination_reason IN ('called_game','forfeit'))) AS "normalEnd"`;
export class RunValueRepository {
  public constructor(private readonly pool: Pool) {}
  public async training(
    through: number,
    signal?: AbortSignal,
    kind: "all" | "re24" | "count" | "win" = "all",
  ) {
    if (!Number.isInteger(through) || through < 2020 || through > 2024)
      throw new Error("훈련 마지막 시즌은 2020–2024여야 합니다.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
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
      await client.query("COMMIT");
      return { observations, countObservations, winObservations, manifest };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
    const client = await this.pool.connect();
    let released = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const games = Value.Decode(
          Type.Array(RunTrainingGameSchema),
          (
            await client.query<Record<string, unknown>>(
              `SELECT ${gameColumns} FROM workbench.game_revisions r JOIN baseball.game_final_states f USING(game_id,revision) WHERE r.game_id=$1 AND r.revision=$2 AND r.sealed`,
              [gameId, revision],
            )
          ).rows,
        ),
        game = games[0];
      if (game === undefined || (expectedSeason !== undefined && game.season !== expectedSeason)) {
        await client.query("COMMIT");
        return null;
      }
      const confirmed = await client.query<{ regular: boolean }>(
        `SELECT competition='regular' AS regular FROM analytics.current_analysis_games WHERE game_id=$1`,
        [gameId],
      );
      const modelCurrent =
        confirmed.rows[0]?.regular === true &&
        model !== null &&
        model.sourceHash === runTrainingHash(await readRunManifest(client, model.trainedThrough));
      const plays = await readAnalysisPlays(client, [gameId], revision);
      await client.query("COMMIT");
      client.release();
      released = true;
      return { game, plays, modelCurrent };
    } catch (error) {
      if (!released) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!released) client.release();
    }
  }
}
export function runTrainingHash(
  manifest: Awaited<ReturnType<RunValueRepository["training"]>>["manifest"],
) {
  return createHash("sha256").update(canonicalStringify(manifest)).digest("hex");
}

export async function readRunManifest(client: PoolClient, through: number) {
  const games = Value.Decode(
    Type.Array(RunTrainingGameSchema),
    (
      await client.query<Record<string, unknown>>(
        `SELECT ${gameColumns} FROM analytics.current_analysis_games r JOIN baseball.game_final_states f USING(game_id,revision) WHERE r.competition='regular' AND r.season BETWEEN 2020 AND $1 ORDER BY r.game_id COLLATE "C"`,
        [through + 1],
      )
    ).rows,
  );
  const scopeHashes: { season: number; hash: string }[] = [];
  for (let season = 2020; season <= through + 1; season++)
    scopeHashes.push({
      season,
      hash: await analysisSourceHash(
        client,
        resolveAnalysisScope({ season, competition: "regular" }),
      ),
    });
  return { version: 1 as const, through, games, scopeHashes };
}
