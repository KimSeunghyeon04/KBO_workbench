import path from "node:path";

import {
  GameRevisionStore,
  replayCompilerHash,
  replaySemanticHash,
  stagingSourceContentHash,
  V3TransferWorkspace,
  type V3TransferGameArtifact,
  type V3TransferGameManifest,
} from "@kbo/persistence";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import { Pool } from "pg";

const V3_MIGRATION = "0003_record_correction_scope_classification";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const transfer = new V3TransferWorkspace(options.inputDirectory);
  const manifest = await transfer.readManifest();
  const pool = new Pool({ connectionString: options.targetDsn, max: 4 });
  const store = new GameRevisionStore(pool, V3_MIGRATION);
  try {
    await assertTargetScope(
      pool,
      manifest.games.map((game) => game.gameId),
    );
    let processed = 0;
    for (const entry of manifest.games) {
      const artifact = await transfer.readGame(entry);
      verifyArtifact(entry, artifact);
      const existing = await store.currentRevisionBase(entry.gameId);
      if (existing === null) {
        if (options.verifyOnly) throw new Error(`V3 target에 경기가 없습니다: ${entry.gameId}`);
        const normalized = normalize(artifact.document);
        const imported = await store.importRevision(normalized);
        if (imported.revision !== 1 || imported.documentHash !== artifact.normalizedDocumentHash) {
          throw new Error(`V3 revision 1 import 결과가 다릅니다: ${entry.gameId}`);
        }
      }
      await verifyStoredGame(store, entry, artifact);
      processed += 1;
      if (processed % 50 === 0)
        process.stdout.write(
          `V3 ${options.verifyOnly ? "verify" : "load"} ${String(processed)} games\n`,
        );
    }
    await assertAcceptance(pool, manifest.gameCount);
    process.stdout.write(
      `V3 ${options.verifyOnly ? "검증" : "적재/검증"} 완료: ${String(processed)} sealed current revision 1 games\n`,
    );
  } finally {
    await pool.end();
  }
}

async function verifyStoredGame(
  store: GameRevisionStore,
  entry: V3TransferGameManifest,
  artifact: V3TransferGameArtifact,
): Promise<void> {
  const base = await store.currentRevisionBase(entry.gameId);
  if (
    base?.revision !== 1 ||
    base.sourceBundleHash !== entry.sourceBundleHash ||
    base.documentHash !== entry.normalizedDocumentHash
  ) {
    throw new Error(`V3 current manifest가 export와 다릅니다: ${entry.gameId}`);
  }
  const hydrated = await store.loadCorrectionDraft(entry.gameId, 1);
  if (stagingDocumentHash(normalize(hydrated)) !== artifact.normalizedDocumentHash) {
    throw new Error(`V3 hydrated 원장이 export와 다릅니다: ${entry.gameId}`);
  }
  const stored = await store.loadCompiled(entry.gameId, 1);
  if (replaySemanticHash(stored.replay) !== artifact.replaySemanticHash) {
    throw new Error(`V3 replay 의미가 V2 current와 다릅니다: ${entry.gameId}`);
  }
}

function verifyArtifact(entry: V3TransferGameManifest, artifact: V3TransferGameArtifact): void {
  if (
    stagingDocumentHash(artifact.document) !== entry.sourceDocumentHash ||
    artifact.document.source.sourceBundleHash !== entry.sourceBundleHash ||
    stagingSourceContentHash(artifact.document) !== entry.sourceContentHash
  ) {
    throw new Error(`V2 export 원장 증거 hash가 다릅니다: ${entry.gameId}`);
  }
  const replay = compileStagingGameDocumentV2(artifact.document);
  if (
    replay.findings.some((finding) => finding.severity === "blocking") ||
    replayCompilerHash(replay) !== entry.compilerHash ||
    replaySemanticHash(replay) !== entry.replaySemanticHash ||
    stagingDocumentHash(normalize(artifact.document)) !== entry.normalizedDocumentHash
  ) {
    throw new Error(`V2 export compiler 결과가 manifest와 다릅니다: ${entry.gameId}`);
  }
}

function normalize(document: V3TransferGameArtifact["document"]) {
  return parseStagingGameDocumentV2({ ...document, revisionBase: { kind: "new_game" } });
}

async function assertTargetScope(pool: Pool, expectedGameIds: readonly string[]): Promise<void> {
  const existing = await pool.query<{ readonly game_id: string }>(
    "SELECT game_id FROM workbench.games ORDER BY game_id",
  );
  const expected = new Set(expectedGameIds);
  const unexpected = existing.rows.filter((row) => !expected.has(row.game_id));
  if (unexpected.length > 0) {
    throw new Error(
      `V3 target에 export 밖 경기가 있습니다: ${unexpected[0]?.game_id ?? "unknown"}`,
    );
  }
}

async function assertAcceptance(pool: Pool, expectedCount: number): Promise<void> {
  const result = await pool.query<{
    readonly game_count: string;
    readonly revision_count: string;
    readonly invalid_count: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM workbench.games WHERE current_revision IS NOT NULL) AS game_count,
       (SELECT COUNT(*)::text FROM workbench.game_revisions) AS revision_count,
       (SELECT COUNT(*)::text FROM workbench.game_revisions r
          JOIN workbench.games g ON g.game_id=r.game_id
         WHERE NOT r.sealed OR r.revision<>1 OR g.current_revision<>1) AS invalid_count`,
  );
  const row = result.rows[0];
  if (
    Number(row?.game_count ?? "-1") !== expectedCount ||
    Number(row?.revision_count ?? "-1") !== expectedCount ||
    Number(row?.invalid_count ?? "-1") !== 0
  ) {
    throw new Error("V3 acceptance count/seal/current revision 1 검증에 실패했습니다.");
  }
}

interface Options {
  readonly targetDsn: string;
  readonly inputDirectory: string;
  readonly verifyOnly: boolean;
}

function parseOptions(args: readonly string[]): Options {
  let targetDsn = process.env.V3_DATABASE_URL;
  let inputDirectory: string | undefined;
  let verifyOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--verify-only") {
      verifyOnly = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) usage();
    if (name === "--target-dsn") targetDsn = value;
    else if (name === "--input") inputDirectory = value;
    else usage();
    index += 1;
  }
  if (targetDsn === undefined || inputDirectory === undefined) usage();
  return { targetDsn, inputDirectory: path.resolve(inputDirectory), verifyOnly };
}

function usage(): never {
  throw new Error(
    "사용법: db:v3:load-current -- --target-dsn <V3 DSN> --input <export dir> [--verify-only]",
  );
}

await main();
