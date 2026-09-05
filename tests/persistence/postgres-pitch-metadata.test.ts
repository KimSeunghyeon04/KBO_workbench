import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { parseStagingGameDocumentV2, type StagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import {
  buildRelationalProjection,
  GameRevisionStore,
  hashProjectionTables,
  replaySemanticHash,
} from "@kbo/persistence";
import { buildReplayBundle } from "@kbo/replay";

import {
  readProjection,
  writeProjection,
} from "../../packages/persistence/src/projection-repository.js";

const dsn = process.env.KBO_TEST_POSTGRES_DSN;

(dsn === undefined ? describe.skip : describe)("V3 → V4 투구 metadata migration", () => {
  it("V3 봉인·hash·재생은 보존하고 V4만 append하며 변조와 rollback을 검증한다", async () => {
    const admin = new Pool({ connectionString: dsn });
    const database = `pitch_${randomUUID().replaceAll("-", "")}`;
    if (dsn === undefined) throw new Error("격리 test DSN 필요");
    const url = new URL(dsn);
    url.pathname = `/${database}`;
    const pool = new Pool({ connectionString: url.toString() });
    await admin.query(`CREATE DATABASE ${database}`);
    try {
      for (const migration of [
        "0001_v3_initial",
        "0002_record_corrections",
        "0003_record_correction_scope_classification",
      ])
        await migrate(pool, migration);
      const document = parseStagingGameDocumentV2(
        JSON.parse(
          await readFile("tests/fixtures/game-document-v2.golden.json", "utf8"),
        ) as unknown,
      );
      const replay = compileStagingGameDocumentV2(document);
      const projection = buildRelationalProjection(document, replay, 1, 3);
      const client = await pool.connect();
      try {
        await seedV3(client, document, projection.projectionHash);
        await writeProjection(client, projection.tables, 3);
        expect(
          hashProjectionTables(await readProjection(client, document.metadata.gameId, 1, 3), 3),
        ).toBe(projection.projectionHash);
        await client.query(
          "UPDATE workbench.game_revisions SET sealed=TRUE,sealed_at=CURRENT_TIMESTAMP",
        );
        await client.query("UPDATE workbench.games SET current_revision=1");
      } finally {
        client.release();
      }
      const oldManifest = (await pool.query("SELECT * FROM workbench.game_revisions")).rows;
      await migrate(pool, "0004_pitch_metadata");
      expect((await pool.query("SELECT * FROM workbench.game_revisions")).rows).toEqual(
        oldManifest,
      );
      const store = new GameRevisionStore(pool, "0004_pitch_metadata");
      const old = await store.loadCompiled(document.metadata.gameId, 1);
      expect(old.projectionHash).toBe(projection.projectionHash);
      expect(replaySemanticHash(old.replay)).toBe(replaySemanticHash(replay));
      const oldFrames = buildReplayBundle({
        source: old.source,
        compiled: old.replay,
        revision: 1,
        documentHash: old.documentHash,
        projectionHash: old.projectionHash,
      });
      const draft = await store.loadCorrectionDraft(document.metadata.gameId, 1);
      const enriched = parseStagingGameDocumentV2({
        ...draft,
        events: draft.events.map((event) =>
          event.kind === "pitch"
            ? { ...event, payload: { ...event.payload, speedKph: 144.5, pitchType: "직구" } }
            : event,
        ),
      });
      await expect(store.importRevision(enriched, { failurePoint: "after_facts" })).rejects.toThrow(
        /injected/,
      );
      expect((await pool.query("SELECT * FROM workbench.game_revisions")).rows).toEqual(
        oldManifest,
      );
      const imported = await store.importRevision(enriched);
      expect(imported.revision).toBe(2);
      expect(
        (
          await pool.query(
            "SELECT projection_version FROM workbench.game_revisions ORDER BY revision",
          )
        ).rows,
      ).toEqual([{ projection_version: 3 }, { projection_version: 4 }]);
      const current = await store.loadCompiled(document.metadata.gameId);
      expect(
        current.replay.pitchFacts.every(
          (pitch) => pitch.speedKph === 144.5 && pitch.pitchType === "직구",
        ),
      ).toBe(true);
      const after = await store.loadCompiled(document.metadata.gameId, 1);
      expect(
        buildReplayBundle({
          source: after.source,
          compiled: after.replay,
          revision: 1,
          documentHash: after.documentHash,
          projectionHash: after.projectionHash,
        }),
      ).toEqual(oldFrames);
      expect(
        (await pool.query("SELECT * FROM workbench.game_revisions WHERE revision=1")).rows,
      ).toEqual(oldManifest);
      expect(
        (await pool.query("SELECT DISTINCT speed_kph,pitch_type FROM analytics.current_pitches"))
          .rows,
      ).toEqual([{ speed_kph: 144.5, pitch_type: "직구" }]);
      expect(
        (
          await pool.query(
            "SELECT DISTINCT speed_kph,pitch_type FROM analytics.all_revision_pitches WHERE revision=1",
          )
        ).rows,
      ).toEqual([{ speed_kph: null, pitch_type: null }]);
      for (const table of ["workbench.relay_pitches", "baseball.pitch_facts"])
        await expect(
          pool.query(`UPDATE ${table} SET speed_kph=145 WHERE revision=2`),
        ).rejects.toThrow(/sealed/);
      await expect(store.importRevision(enriched)).rejects.toThrow(/base|current|revision/i);
      const v4 = buildRelationalProjection(enriched, compileStagingGameDocumentV2(enriched), 2);
      for (const table of ["relay_pitches", "pitch_facts"] as const)
        for (const field of ["speed_kph", "pitch_type"] as const) {
          const corrupted = {
            ...v4.tables,
            [table]: v4.tables[table].map((row, index) =>
              index === 0 ? { ...row, [field]: field === "speed_kph" ? 145 : "투심" } : row,
            ),
          };
          expect(hashProjectionTables(corrupted)).not.toBe(v4.projectionHash);
        }
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  }, 60_000);
});

async function migrate(pool: Pool, version: string) {
  const sql = await readFile(`database/v3/${version}.sql`, "utf8");
  await pool.query(sql);
  await pool.query(
    "CREATE TABLE IF NOT EXISTS workbench.schema_migrations (version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)",
  );
  await pool.query("INSERT INTO workbench.schema_migrations(version,checksum) VALUES($1,$2)", [
    version,
    createHash("sha256").update(sql).digest("hex"),
  ]);
}

// Seed the frozen V3 column contract before migration; production only imports V4.
async function seedV3(client: PoolClient, document: StagingGameDocumentV2, projectionHash: string) {
  await client.query("INSERT INTO catalog.seasons VALUES('kbo',$1)", [document.metadata.season]);
  for (const side of ["away", "home"] as const) {
    const team = document.teams[side];
    await client.query("INSERT INTO catalog.teams(team_id,provisional) VALUES($1,TRUE)", [
      `naver:${team.teamId}`,
    ]);
    await client.query(
      "INSERT INTO catalog.team_identities(identity_key,provider,external_team_id,team_id) VALUES($1,'naver',$2,$1)",
      [`naver:${team.teamId}`, team.teamId],
    );
    for (const player of document.rosters[side].players) {
      await client.query("INSERT INTO catalog.players(player_id,provisional) VALUES($1,TRUE)", [
        `naver:${player.playerId}`,
      ]);
      await client.query(
        "INSERT INTO catalog.player_identities(identity_key,provider,external_player_id,player_id,resolution_kind) VALUES($1,'naver',$2,$1,'provisional')",
        [`naver:${player.playerId}`, player.playerId],
      );
    }
  }
  await client.query("INSERT INTO workbench.games(game_id) VALUES($1)", [document.metadata.gameId]);
  await client.query(
    `INSERT INTO workbench.game_revisions(game_id,revision,schema_version,provider,source_game_id,source_bundle_hash,collected_at_text,season,game_date,scheduled_at_text,game_status,stadium,scheduled_innings,document_hash,projection_hash,projection_version)
    VALUES($1,1,2,'naver',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,3)`,
    [
      document.metadata.gameId,
      document.source.sourceGameId,
      document.source.sourceBundleHash,
      document.source.collectedAt,
      document.metadata.season,
      document.metadata.gameDate,
      document.metadata.scheduledAt ?? null,
      document.metadata.status,
      document.metadata.stadium ?? null,
      document.metadata.scheduledInnings,
      stagingDocumentHash(document),
      projectionHash,
    ],
  );
}
