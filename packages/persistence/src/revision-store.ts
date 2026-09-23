import type {
  DatabaseGamesQuery,
  GameCatalogItem,
  GamePlayerHeightDataset,
  RevisionCatalog,
  StagingGameDocumentV2,
} from "@kbo/contracts";
import { compareCanonicalStrings, parseStagingGameDocumentV2 } from "@kbo/contracts";
import {
  compileStagingGameDocumentV2,
  stagingDocumentHash,
  type ReplayResult,
} from "@kbo/game-core";
import type { Pool, PoolClient } from "pg";
import { PersistenceIntegrityError } from "./errors.js";
import { writeGamePlayerHeights } from "./player-height-repository.js";
import { resolvePlayerHeights } from "./player-height-supplement-repository.js";
import { hydrateProjectionLedger } from "./projection-ledger.js";
import { replayFromProjection, replaySourceFromProjection } from "./projection-replay.js";
import { readProjection, writeProjection } from "./projection-repository.js";
import { text } from "./projection-values.js";
import {
  buildRelationalProjection,
  hashProjectionTables,
  type RelationalProjection,
} from "./projection.js";
import { readDatabaseCatalogPage, readDatabaseSeasons } from "./revision-catalog-page.js";
import { readDatabaseCatalog, readStoredGameIds } from "./revision-catalog-repository.js";
import { rebaseSealedCorrectionDraft } from "./revision-draft-rebase.js";
import {
  assertDatabaseContract,
  currentRevision,
  decodeManifestRow,
  decodeOptionalCurrentRevision,
  hashText,
  insertManifest,
  iso,
  loadManifest,
  requiredDatabaseResultRow,
  safeInteger,
} from "./revision-manifest.js";
import {
  BlockingImportError,
  GameRevisionNotFoundError,
  RevisionConflictError,
  type CurrentRevisionBase,
  type ImportedRevision,
  type ImportFailurePoint,
  type ImportOptions,
  type RevisionProjectionComputation,
  type StoredCompiledRevision,
} from "./revision-types.js";

const inlineProjection: RevisionProjectionComputation = {
  project: async (document, replay, revision, version) =>
    buildRelationalProjection(document, replay, revision, version),
  hash: async (tables, version) => hashProjectionTables(tables, version),
};

export class GameRevisionStore {
  public constructor(
    private readonly pool: Pool,
    private readonly expectedMigrationVersion: string,
    private readonly compile: (document: StagingGameDocumentV2) => Promise<ReplayResult> = async (
      document,
    ) => compileStagingGameDocumentV2(document),
    private readonly projectionComputation: RevisionProjectionComputation = inlineProjection,
    private readonly readPlayerHeights?: (
      document: StagingGameDocumentV2,
    ) => Promise<GamePlayerHeightDataset>,
  ) {}

  public async importRevision(
    input: unknown,
    options: ImportOptions = {},
  ): Promise<ImportedRevision> {
    const stagingDocument = parseStagingGameDocumentV2(input);
    const stagingReplay = await this.compile(stagingDocument);
    rejectBlocking(stagingDocument.metadata.gameId, stagingReplay);
    const document = stagingDocument;
    const replay = stagingReplay;
    const documentHash = stagingDocumentHash(document);
    const heights = await this.readPlayerHeights?.(document);
    if (
      heights !== undefined &&
      (heights.gameId !== document.metadata.gameId ||
        heights.season !== document.metadata.season ||
        heights.sourceBundleHash !== document.source.sourceBundleHash)
    )
      throw new PersistenceIntegrityError("선수 키 원문이 경기 문서의 출처와 다릅니다.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertDatabaseContract(client, this.expectedMigrationVersion);
      if (heights !== undefined) await writeGamePlayerHeights(client, heights);
      const existing = await client.query(
        "SELECT current_revision FROM workbench.games WHERE game_id=$1 FOR UPDATE",
        [document.metadata.gameId],
      );
      const currentRevision = decodeOptionalCurrentRevision(existing, "locked game row");
      let revision: number;
      if (existing.rows.length === 0) {
        if (document.revisionBase.kind !== "new_game") {
          throw new RevisionConflictError("신규 경기는 revisionBase=new_game이어야 합니다.");
        }
        revision = 1;
        await client.query(
          "INSERT INTO workbench.games (game_id, current_revision) VALUES ($1, NULL)",
          [document.metadata.gameId],
        );
      } else {
        if (currentRevision === null || document.revisionBase.kind !== "sealed_revision") {
          throw new RevisionConflictError("기존 경기의 sealed revision base가 없습니다.");
        }
        const current = await loadManifest(client, document.metadata.gameId, currentRevision);
        if (
          document.revisionBase.revision !== currentRevision ||
          document.revisionBase.documentHash !== current.document_hash
        ) {
          throw new RevisionConflictError(
            "현재 revision 또는 base document hash가 변경되었습니다.",
          );
        }
        revision = currentRevision + 1;
      }
      const projection = await this.projectionComputation.project(document, replay, revision, 4);
      await upsertGameCatalog(client, document, replay);
      await insertManifest(client, document, revision, documentHash, projection.projectionHash);
      injectFailure(options, "after_manifest");
      await writeProjection(client, projection.tables);
      injectFailure(options, "after_facts");
      await verifyStoredProjection(
        client,
        document.metadata.gameId,
        revision,
        projection,
        this.projectionComputation,
      );
      await verifyRecompile(
        client,
        document.metadata.gameId,
        revision,
        documentHash,
        projection.projectionHash,
        this.compile,
        this.projectionComputation,
      );
      injectFailure(options, "before_seal");
      await client.query(
        "UPDATE workbench.game_revisions SET sealed=TRUE, sealed_at=CURRENT_TIMESTAMP WHERE game_id=$1 AND revision=$2",
        [document.metadata.gameId, revision],
      );
      await client.query("UPDATE workbench.games SET current_revision=$2 WHERE game_id=$1", [
        document.metadata.gameId,
        revision,
      ]);
      if (heights !== undefined)
        await resolvePlayerHeights(client, document.metadata.season, document.metadata.gameId);
      await client.query("COMMIT");
      return {
        gameId: document.metadata.gameId,
        revision,
        documentHash,
        projectionHash: projection.projectionHash,
      };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async loadCompiled(gameId: string, revision?: number): Promise<StoredCompiledRevision> {
    const client = await this.pool.connect();
    try {
      await assertDatabaseContract(client, this.expectedMigrationVersion);
      const resolvedRevision = revision ?? (await currentRevision(client, gameId));
      const manifest = await loadManifest(client, gameId, resolvedRevision);
      if (!manifest.sealed)
        throw new PersistenceIntegrityError("seal되지 않은 revision은 재생할 수 없습니다.");
      const tables = await readProjection(
        client,
        gameId,
        resolvedRevision,
        manifest.projection_version,
      );
      const projectionHash = hashProjectionTables(tables, manifest.projection_version);
      if (projectionHash !== manifest.projection_hash) {
        throw new PersistenceIntegrityError("DB typed projection hash가 manifest와 다릅니다.");
      }
      return {
        gameId,
        revision: resolvedRevision,
        documentHash: manifest.document_hash,
        projectionHash,
        source: replaySourceFromProjection(manifest, tables),
        replay: replayFromProjection(gameId, tables),
      };
    } finally {
      client.release();
    }
  }

  public async loadCorrectionDraft(
    gameId: string,
    revision: number,
  ): Promise<StagingGameDocumentV2> {
    const client = await this.pool.connect();
    try {
      await assertDatabaseContract(client, this.expectedMigrationVersion);
      const resolvedCurrentRevision = await currentRevision(client, gameId);
      if (revision !== resolvedCurrentRevision) {
        throw new RevisionConflictError(
          `current revision만 교정 초안으로 열 수 있습니다: current=${String(resolvedCurrentRevision)}`,
        );
      }
      const manifest = await loadManifest(client, gameId, revision);
      if (!manifest.sealed) {
        throw new PersistenceIntegrityError(
          "seal되지 않은 revision은 교정 초안으로 열 수 없습니다.",
        );
      }
      const tables = await readProjection(client, gameId, revision, manifest.projection_version);
      if (hashProjectionTables(tables, manifest.projection_version) !== manifest.projection_hash) {
        throw new PersistenceIntegrityError("DB typed projection hash가 manifest와 다릅니다.");
      }
      const stored = hydrateProjectionLedger(manifest, tables);
      if (stagingDocumentHash(stored) !== manifest.document_hash) {
        throw new PersistenceIntegrityError("DB 원장 fact의 문서 hash가 manifest와 다릅니다.");
      }
      return rebaseSealedCorrectionDraft(stored, revision, manifest.document_hash);
    } finally {
      client.release();
    }
  }

  public async countStoredGames(): Promise<number> {
    const result = await this.pool.query(
      "SELECT COUNT(*)::text AS count FROM workbench.games WHERE current_revision IS NOT NULL",
    );
    const row = requiredDatabaseResultRow(result, ["count"], "stored game count");
    const count = text(row.count);
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) {
      throw new PersistenceIntegrityError("stored game count가 safe integer가 아닙니다.");
    }
    return Number(count);
  }
  public async currentRevisionBase(gameId: string): Promise<CurrentRevisionBase | null> {
    const result = await this.pool.query(
      `SELECT r.revision,r.document_hash,r.source_bundle_hash
       FROM workbench.games g
       JOIN workbench.game_revisions r
         ON r.game_id=g.game_id AND r.revision=g.current_revision
       WHERE g.game_id=$1 AND r.sealed`,
      [gameId],
    );
    if (result.rows.length === 0) {
      if (result.rowCount !== 0) {
        throw new PersistenceIntegrityError("current revision base rowCount가 올바르지 않습니다.");
      }
      return null;
    }
    const row = requiredDatabaseResultRow(
      result,
      ["revision", "document_hash", "source_bundle_hash"],
      "current revision base",
    );
    return {
      revision: safeInteger(row.revision, "current revision"),
      documentHash: hashText(row.document_hash, "current document_hash"),
      sourceBundleHash: hashText(row.source_bundle_hash, "current source_bundle_hash"),
    };
  }
  public async catalog(gameIds?: readonly string[]): Promise<readonly GameCatalogItem[]> {
    return readDatabaseCatalog(this.pool, gameIds);
  }
  public storedGameIds(): Promise<string[]> {
    return readStoredGameIds(this.pool);
  }
  public catalogPage(query: DatabaseGamesQuery) {
    return readDatabaseCatalogPage(this.pool, query);
  }
  public catalogSeasons() {
    return readDatabaseSeasons(this.pool);
  }
  public async revisions(gameId: string): Promise<RevisionCatalog> {
    const result = await this.pool.query(
      "SELECT r.* FROM workbench.game_revisions r WHERE r.game_id=$1 ORDER BY r.revision",
      [gameId],
    );
    if (result.rows.length === 0) throw new GameRevisionNotFoundError(gameId, null);
    if (result.rowCount !== result.rows.length) {
      throw new PersistenceIntegrityError("revision catalog rowCount가 실제 행 수와 다릅니다.");
    }
    const rows = result.rows.map((row) => decodeManifestRow(row, gameId));
    if (new Set(rows.map((row) => row.revision)).size !== rows.length) {
      throw new PersistenceIntegrityError("revision catalog에 중복 revision이 있습니다.");
    }
    const current = await this.pool.query(
      "SELECT current_revision FROM workbench.games WHERE game_id=$1",
      [gameId],
    );
    const currentRevision = decodeOptionalCurrentRevision(current, "revision catalog current row");
    return {
      gameId,
      currentRevision,
      revisions: rows.map((row) => ({
        revision: row.revision,
        documentHash: row.document_hash,
        projectionHash: row.projection_hash,
        sealed: row.sealed,
        createdAt: iso(row.created_at),
        sealedAt: row.sealed_at === null ? null : iso(row.sealed_at),
        original: row.revision === 1,
        current: row.revision === currentRevision,
      })),
    };
  }
}

async function upsertGameCatalog(
  client: PoolClient,
  document: StagingGameDocumentV2,
  replay: ReplayResult,
): Promise<void> {
  await client.query(
    `INSERT INTO catalog.seasons (competition_id, season)
     VALUES ('kbo', $1) ON CONFLICT DO NOTHING`,
    [document.metadata.season],
  );
  for (const side of ["away", "home"] as const) {
    const team = document.teams[side];
    const teamIdentityKey = `naver:${team.teamId}`;
    await client.query(
      `INSERT INTO catalog.teams (team_id, provisional) VALUES ($1, TRUE)
       ON CONFLICT DO NOTHING`,
      [teamIdentityKey],
    );
    await client.query(
      `INSERT INTO catalog.team_identities
         (identity_key,provider,external_team_id,team_id)
       VALUES ($1,'naver',$2,$1)
       ON CONFLICT (identity_key) DO NOTHING`,
      [teamIdentityKey, team.teamId],
    );
    await client.query(
      `INSERT INTO catalog.team_name_observations
         (identity_key,observed_on,display_name,source_ref)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [teamIdentityKey, document.metadata.gameDate, team.name, document.metadata.gameId],
    );
    await client.query(
      `INSERT INTO catalog.team_seasons (competition_id,season,team_id)
       VALUES ('kbo',$1,$2) ON CONFLICT DO NOTHING`,
      [document.metadata.season, teamIdentityKey],
    );
  }

  const names = new Map<string, string>();
  for (const side of ["away", "home"] as const) {
    for (const player of document.rosters[side].players) names.set(player.playerId, player.name);
  }
  for (const line of document.officialRecords.batters) {
    if (!names.has(line.playerId)) names.set(line.playerId, line.playerId);
  }
  for (const line of document.officialRecords.pitchers) {
    if (!names.has(line.playerId)) names.set(line.playerId, line.playerId);
  }
  for (const observation of document.trackingCandidates) {
    if (observation.batterId !== undefined && !names.has(observation.batterId))
      names.set(observation.batterId, observation.batterId);
    if (observation.pitcherId !== undefined && !names.has(observation.pitcherId))
      names.set(observation.pitcherId, observation.pitcherId);
  }
  for (const pitch of replay.pitchFacts) {
    if (pitch.batterId !== null && !names.has(pitch.batterId))
      names.set(pitch.batterId, pitch.batterId);
    if (pitch.pitcherId !== null && !names.has(pitch.pitcherId))
      names.set(pitch.pitcherId, pitch.pitcherId);
  }
  for (const play of replay.plays) {
    for (const movement of play.movements) {
      if (!names.has(movement.runnerId)) names.set(movement.runnerId, movement.runnerId);
      if (!names.has(movement.responsiblePitcherId))
        names.set(movement.responsiblePitcherId, movement.responsiblePitcherId);
    }
  }
  for (const appearance of replay.plateAppearances) {
    for (const playerId of [
      appearance.startBatterId,
      appearance.batterId,
      appearance.startPitcherId,
      appearance.pitcherId,
    ]) {
      if (!names.has(playerId)) names.set(playerId, playerId);
    }
  }
  for (const [externalPlayerId, displayName] of [...names].sort(([left], [right]) =>
    compareCanonicalStrings(left, right),
  )) {
    const identityKey = `naver:${externalPlayerId}`;
    await client.query(
      `INSERT INTO catalog.players (player_id,provisional) VALUES ($1,TRUE)
       ON CONFLICT DO NOTHING`,
      [identityKey],
    );
    await client.query(
      `INSERT INTO catalog.player_identities
         (identity_key,provider,external_player_id,player_id,resolution_kind)
       VALUES ($1,'naver',$2,$1,'provisional')
       ON CONFLICT (identity_key) DO NOTHING`,
      [identityKey, externalPlayerId],
    );
    await client.query(
      `INSERT INTO catalog.player_name_observations
         (identity_key,observed_on,display_name,source_ref)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [identityKey, document.metadata.gameDate, displayName, document.metadata.gameId],
    );
  }
}

async function verifyStoredProjection(
  client: PoolClient,
  gameId: string,
  revision: number,
  projection: RelationalProjection,
  computation: RevisionProjectionComputation,
): Promise<void> {
  const stored = await readProjection(client, gameId, revision, projection.version);
  const hash = await computation.hash(stored, projection.version);
  if (hash !== projection.projectionHash)
    throw new PersistenceIntegrityError(
      `DB projection hash 검증 실패: expected=${projection.projectionHash}, actual=${hash}`,
    );
}

async function verifyRecompile(
  client: PoolClient,
  gameId: string,
  revision: number,
  documentHash: string,
  projectionHash: string,
  compile: (document: StagingGameDocumentV2) => Promise<ReplayResult>,
  computation: RevisionProjectionComputation,
): Promise<void> {
  const storedManifest = await loadManifest(client, gameId, revision);
  const tables = await readProjection(client, gameId, revision, storedManifest.projection_version);
  const document = hydrateProjectionLedger(storedManifest, tables);
  if (stagingDocumentHash(document) !== documentHash)
    throw new PersistenceIntegrityError("DB 원장 fact의 문서 hash가 원본 staging 원장과 다릅니다.");
  const replay = await compile(document);
  if (
    (await computation.project(document, replay, revision, storedManifest.projection_version))
      .projectionHash !== projectionHash
  )
    throw new PersistenceIntegrityError("DB 원장 재compile 결과가 저장 projection과 다릅니다.");
}

function rejectBlocking(gameId: string, replay: ReplayResult): void {
  const codes = replay.findings
    .filter((finding) => finding.severity === "blocking")
    .map((finding) => finding.code);
  if (codes.length > 0) throw new BlockingImportError(gameId, codes);
}

function injectFailure(options: ImportOptions, point: ImportFailurePoint): void {
  if (options.failurePoint === point) throw new Error(`injected import failure: ${point}`);
}

export { PersistenceIntegrityError } from "./errors.js";
export { hydrateProjectionLedger } from "./projection-ledger.js";
export {
  BlockingImportError,
  DatabaseContractError,
  GameAlreadyImportedError,
  GameRevisionNotFoundError,
  RevisionConflictError,
} from "./revision-types.js";
export type {
  CurrentRevisionBase,
  ImportedRevision,
  ImportFailurePoint,
  ImportOptions,
  ProjectionLedgerManifest,
  RevisionProjectionComputation,
  StoredCompiledRevision,
  StoredReplayRelayEvent,
  StoredReplayRosterPlayer,
  StoredReplaySource,
} from "./revision-types.js";
