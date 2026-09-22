import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";
import {
  canonicalStringify,
  parseGameCompetitionDataset,
  CompetitionEntrySchema,
  CompetitionPageSchema,
  CompetitionGameLinkSchema,
  type CompetitionGameLink,
} from "@kbo/contracts";

const gameSchema = Type.Object(
  { gameId: Type.String(), sourceGameId: Type.String(), gameDate: Type.String() },
  { additionalProperties: false },
);
const hashSchema = Type.Object({ hash: Type.String() }, { additionalProperties: false });
const storedEntrySchema = Type.Object(
  { ...CompetitionEntrySchema.properties, gameId: Type.Union([Type.String(), Type.Null()]) },
  { additionalProperties: false },
);
export class GameCompetitionRepository {
  public constructor(private readonly pool: Pool) {}
  public async games(season: number) {
    return Value.Decode(
      Type.Array(gameSchema),
      (
        await this.pool.query<Record<string, unknown>>(
          `SELECT game_id AS "gameId",source_game_id AS "sourceGameId",to_char(game_date,'YYYY-MM-DD') AS "gameDate"
       FROM analytics.current_game_revisions WHERE season=$1 ORDER BY game_id COLLATE "C"`,
          [season],
        )
      ).rows,
    );
  }
  public async adopt(
    input: unknown,
    dryRun = false,
    inputLinks: readonly CompetitionGameLink[] = [],
  ) {
    const dataset = parseGameCompetitionDataset(input);
    const links = Value.Decode(Type.Array(CompetitionGameLinkSchema), inputLinks).sort((a, b) =>
      a.sourceGameId < b.sourceGameId ? -1 : a.sourceGameId > b.sourceGameId ? 1 : 0,
    );
    const linkMap = new Map(links.map((l) => [l.sourceGameId, l]));
    if (
      linkMap.size !== links.length ||
      new Set(links.map((l) => l.matchedSourceGameId)).size !== links.length ||
      links.some(
        (l) =>
          !dataset.entries.some(
            (e) => e.sourceGameId === l.sourceGameId && e.gameDate === l.gameDate,
          ),
      )
    )
      throw new Error("경기 ID 연결의 중복 또는 출처 불일치");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('analysis-competition'),$1)", [
        dataset.season,
      ]);
      const games = Value.Decode(
        Type.Array(gameSchema),
        (
          await client.query<Record<string, unknown>>(
            `
        SELECT game_id AS "gameId",source_game_id AS "sourceGameId",to_char(game_date,'YYYY-MM-DD') AS "gameDate"
        FROM analytics.current_game_revisions WHERE season=$1 ORDER BY game_id COLLATE "C"`,
            [dataset.season],
          )
        ).rows,
      );
      if (games.length > 0 && dataset.entries.length === 0)
        throw new Error("저장 경기가 있는데 공식 일정이 모두 비어 있습니다.");
      const gamesBySource = new Map<string, typeof games>();
      for (const game of games) {
        const values = gamesBySource.get(game.sourceGameId) ?? [];
        values.push(game);
        gamesBySource.set(game.sourceGameId, values);
      }
      const rows = dataset.entries.map((entry) => {
        const link = linkMap.get(entry.sourceGameId);
        const candidates = gamesBySource.get(link?.matchedSourceGameId ?? entry.sourceGameId) ?? [];
        if (
          link !== undefined &&
          (candidates.length !== 1 ||
            (gamesBySource
              .get(entry.sourceGameId)
              ?.some((g) => g.sourceGameId !== link.matchedSourceGameId) ??
              false))
        )
          throw new Error("경기 ID 연결 대상이 사라졌거나 직접 연결과 충돌합니다.");
        if (candidates.length > 1 || candidates.some((g) => g.gameDate !== entry.gameDate))
          throw new Error(`경기 분류의 ID/날짜 연결이 모호합니다: ${entry.sourceGameId}`);
        return { ...entry, gameId: candidates[0]?.gameId ?? null };
      });
      const matched = rows.filter((r) => r.gameId !== null);
      if (games.length > 0 && matched.length === 0)
        throw new Error("공식 일정과 연결된 저장 경기가 없습니다.");
      const datasetHash = createHash("sha256")
        .update(
          canonicalStringify({
            version: dataset.version,
            season: dataset.season,
            pages: dataset.pages.map(({ month, competition, sourceUrl, contentHash }) => ({
              month,
              competition,
              sourceUrl,
              contentHash,
            })),
            rows,
            ...(links.length === 0 ? {} : { links }),
          }),
        )
        .digest("hex");
      const previous = Value.Decode(
        Type.Array(hashSchema),
        (
          await client.query<Record<string, unknown>>(
            "SELECT dataset_hash AS hash FROM reference.current_competition_datasets WHERE season=$1",
            [dataset.season],
          )
        ).rows,
      )[0]?.hash;
      const removed = await client.query<Record<string, unknown>>(
        `
        SELECT c.game_id AS "gameId" FROM reference.game_competitions c
        JOIN reference.current_competition_datasets d USING(dataset_hash)
        WHERE d.season=$1 AND c.game_id IS NOT NULL`,
        [dataset.season],
      );
      const newIds = new Set(matched.map((row) => row.gameId));
      const previousGames = Value.Decode(
        Type.Array(Type.Object({ gameId: Type.String() }, { additionalProperties: false })),
        removed.rows,
      );
      if (previousGames.some((row) => !newIds.has(row.gameId)))
        throw new Error("기존에 분류한 경기의 공식 일정이 누락되어 새 자료를 채택하지 않습니다.");
      const result = {
        datasetHash,
        matched: matched.length,
        unmatched: rows.length - matched.length,
        unclassified: games.length - matched.length,
        changed: previous !== datasetHash,
        dryRun,
      };
      if (!dryRun && previous !== datasetHash) {
        const exists = await client.query(
          "SELECT 1 FROM reference.competition_datasets WHERE dataset_hash=$1 AND sealed",
          [datasetHash],
        );
        if (exists.rowCount === 0) {
          await client.query(
            "INSERT INTO reference.competition_datasets(dataset_hash,season,parser_version) VALUES($1,$2,1)",
            [datasetHash, dataset.season],
          );
          for (const page of dataset.pages)
            await client.query(
              `
            INSERT INTO reference.competition_pages
              (dataset_hash,month,competition,source_url,content_hash,artifact_key,collected_at)
            VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [
                datasetHash,
                page.month,
                page.competition,
                page.sourceUrl,
                page.contentHash,
                page.artifactKey,
                page.collectedAt,
              ],
            );
          for (const row of rows)
            await client.query(
              `INSERT INTO reference.game_competitions
            (dataset_hash,source_game_id,game_date,competition,page_hash,game_id) VALUES($1,$2,$3,$4,$5,$6)`,
              [
                datasetHash,
                row.sourceGameId,
                row.gameDate,
                row.competition,
                row.pageHash,
                row.gameId,
              ],
            );
          for (const link of links)
            await client.query(
              `INSERT INTO reference.competition_game_links(dataset_hash,source_game_id,matched_source_game_id) VALUES($1,$2,$3)`,
              [datasetHash, link.sourceGameId, link.matchedSourceGameId],
            );
          const storedLinks = await client.query<Record<string, unknown>>(
            `SELECT l.source_game_id AS "sourceGameId",l.matched_source_game_id AS "matchedSourceGameId",to_char(c.game_date,'YYYY-MM-DD') AS "gameDate"
             FROM reference.competition_game_links l JOIN reference.game_competitions c USING(dataset_hash,source_game_id)
             WHERE l.dataset_hash=$1 ORDER BY l.source_game_id COLLATE "C"`,
            [datasetHash],
          );
          if (
            canonicalStringify(
              Value.Decode(Type.Array(CompetitionGameLinkSchema), storedLinks.rows),
            ) !== canonicalStringify(links)
          )
            throw new Error("경기 ID 연결 저장 무결성 오류");
          const stored = await client.query<Record<string, unknown>>(
            `SELECT source_game_id AS "sourceGameId",
            to_char(game_date,'YYYY-MM-DD') AS "gameDate",competition,page_hash AS "pageHash",game_id AS "gameId"
            FROM reference.game_competitions WHERE dataset_hash=$1 ORDER BY source_game_id COLLATE "C"`,
            [datasetHash],
          );
          const storedPages = await client.query<Record<string, unknown>>(
            `SELECT month,competition,
            source_url AS "sourceUrl",content_hash AS "contentHash",artifact_key AS "artifactKey",collected_at AS "collectedAt"
            FROM reference.competition_pages WHERE dataset_hash=$1 ORDER BY month,competition COLLATE "C"`,
            [datasetHash],
          );
          if (
            canonicalStringify(Value.Decode(Type.Array(storedEntrySchema), stored.rows)) !==
              canonicalStringify(rows) ||
            canonicalStringify(
              Value.Decode(Type.Array(CompetitionPageSchema), storedPages.rows),
            ) !== canonicalStringify(dataset.pages)
          )
            throw new Error("경기 분류 저장 무결성 오류");
          await client.query(
            "UPDATE reference.competition_datasets SET sealed=TRUE WHERE dataset_hash=$1",
            [datasetHash],
          );
        }
        await client.query(
          `INSERT INTO reference.current_competition_datasets(season,dataset_hash) VALUES($1,$2)
          ON CONFLICT(season) DO UPDATE SET dataset_hash=EXCLUDED.dataset_hash`,
          [dataset.season, datasetHash],
        );
      }
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
