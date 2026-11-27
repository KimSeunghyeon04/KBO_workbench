import { createHash } from "node:crypto";
import type {
  DatabaseGamesQuery,
  GameCatalogItem,
  GamePlayerHeightDataset,
  GamePlayerBattingProfileDataset,
  ImportTarget,
  RevisionCatalog,
  StagingGameDocumentV2,
} from "@kbo/contracts";
import {
  canonicalStringify,
  compareCanonicalStrings,
  parseStagingGameDocumentV2,
} from "@kbo/contracts";
import {
  compileStagingGameDocumentV2,
  stagingDocumentHash,
  type ReplayResult,
} from "@kbo/game-core";
import type { Pool, PoolClient } from "pg";
import { PersistenceIntegrityError } from "./errors.js";
import { writeGamePlayerHeights } from "./player-height-repository.js";
import { writeGamePlayerBattingProfiles } from "./player-batting-profile-repository.js";
import { resolvePlayerHeights } from "./player-height-supplement-repository.js";
import { hydrateProjectionLedger } from "./projection-ledger.js";
import { replayFromProjection, replaySourceFromProjection } from "./projection-replay.js";
import { readProjection, writeProjection } from "./projection-repository.js";
import { advanceMatchupGenerations, lockMatchupPublication } from "./record-correction-matchups.js";
import { validateCorrectionPublication } from "./record-correction-publication.js";
import { text } from "./projection-values.js";
import {
  buildRelationalProjection,
  hashProjectionTables,
  type RelationalProjection,
} from "./projection.js";
import {
  readDatabaseCatalog,
  readDatabaseCatalogPage,
  readDatabaseSeasons,
  readStoredGameIds,
  readStoredGameCounts,
} from "./revision-catalog-repository.js";
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

async function readVerifiedSealedProjection(
  client: PoolClient,
  gameId: string,
  revision: number,
  purpose: "replay" | "correction",
) {
  const manifest = await loadManifest(client, gameId, revision);
  if (!manifest.sealed) {
    throw new PersistenceIntegrityError(
      purpose === "replay"
        ? "seal되지 않은 revision은 재생할 수 없습니다."
        : "seal되지 않은 revision은 교정 초안으로 열 수 없습니다.",
    );
  }
  const tables = await readProjection(client, gameId, revision, manifest.projection_version);
  const projectionHash = hashProjectionTables(tables, manifest.projection_version);
  if (projectionHash !== manifest.projection_hash) {
    throw new PersistenceIntegrityError("DB typed projection hash가 manifest와 다릅니다.");
  }
  return { manifest, tables, projectionHash };
}

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
    private readonly readPlayerBattingProfiles?: (
      document: StagingGameDocumentV2,
    ) => Promise<GamePlayerBattingProfileDataset>,
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
    const battingProfiles = await this.readPlayerBattingProfiles?.(document);
    if (
      battingProfiles !== undefined &&
      (battingProfiles.gameId !== document.metadata.gameId ||
        battingProfiles.season !== document.metadata.season ||
        battingProfiles.sourceBundleHash !== document.source.sourceBundleHash)
    )
      throw new PersistenceIntegrityError("선수 타석 프로필 원문이 경기 문서의 출처와 다릅니다.");
    if (
      heights !== undefined &&
      (heights.gameId !== document.metadata.gameId ||
        heights.season !== document.metadata.season ||
        heights.sourceBundleHash !== document.source.sourceBundleHash)
    )
      throw new PersistenceIntegrityError("선수 키 원문이 경기 문서의 출처와 다릅니다.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await assertDatabaseContract(client, this.expectedMigrationVersion);
      const publication = options.publication;
      if (publication !== undefined) {
        const target = publication.target;
        if (
          target.artifact === undefined ||
          target.gameId !== document.metadata.gameId ||
          target.documentHash !== documentHash ||
          target.season !== document.metadata.season ||
          target.revision !==
            (document.revisionBase.kind === "new_game" ? 1 : document.revisionBase.revision + 1) ||
          canonicalStringify(target.recordCorrection?.approvals ?? []) !==
            canonicalStringify(options.recordCorrectionApprovals ?? []) ||
          (target.recordCorrection?.fromSealedDraft === true) !==
            (options.fromIndependentSealedDraft === true)
        ) {
          throw new RevisionConflictError("적재 요청과 봉인할 작업본이 다릅니다.");
        }
        await lockImportPublication(client, publication.jobId);
        const committed = await readImportPublication(client, publication.jobId, target);
        if (committed !== null) {
          await client.query("COMMIT");
          return committed;
        }
      }
      if (heights !== undefined) await writeGamePlayerHeights(client, heights);
      if (battingProfiles !== undefined)
        await writeGamePlayerBattingProfiles(client, battingProfiles);
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
      const matchups = await lockMatchupPublication(
        client,
        document.metadata.gameId,
        currentRevision,
        revision,
      );
      await validateCorrectionPublication(
        client,
        document.metadata.gameId,
        currentRevision,
        documentHash,
        matchups,
        options.recordCorrectionApprovals ?? [],
        options.fromIndependentSealedDraft === true,
        options.verifiedMatchupGeneration,
      );
      await advanceMatchupGenerations(client, matchups);
      await client.query("UPDATE workbench.games SET current_revision=$2 WHERE game_id=$1", [
        document.metadata.gameId,
        revision,
      ]);
      if (publication !== undefined) {
        await client.query(
          `INSERT INTO workbench.import_publications (job_id, game_id, revision, target_hash)
           VALUES ($1,$2,$3,$4)`,
          [
            publication.jobId,
            document.metadata.gameId,
            revision,
            importTargetHash(publication.target),
          ],
        );
      }
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

  public async importPublication(
    jobId: string,
    target: ImportTarget,
  ): Promise<ImportedRevision | null> {
    if (target.artifact === undefined) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      await lockImportPublication(client, jobId);
      // A prior owner may have committed while we waited. Read in a fresh statement.
      const committed = await readImportPublication(client, jobId, target);
      await client.query("COMMIT");
      return committed;
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
      const { manifest, tables, projectionHash } = await readVerifiedSealedProjection(
        client,
        gameId,
        resolvedRevision,
        "replay",
      );
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
      const { manifest, tables } = await readVerifiedSealedProjection(
        client,
        gameId,
        revision,
        "correction",
      );
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
  public async withCurrentRevisionBase<T>(
    gameId: string,
    expected: Pick<CurrentRevisionBase, "revision" | "documentHash">,
    publish: () => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let connectionError: Error | undefined;
    // The checked-out client can lose its connection while the callback performs file I/O.
    const connectionLost = (error: Error) => {
      connectionError ??= error;
    };
    client.on("error", connectionLost);
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SELECT game_id FROM workbench.games WHERE game_id=$1 FOR SHARE", [
        gameId,
      ]);
      const current = await this.readCurrentRevisionBase(client, gameId);
      if (current?.revision !== expected.revision || current.documentHash !== expected.documentHash)
        throw new RevisionConflictError("작업본을 여는 동안 현재 DB revision이 변경되었습니다.");
      if (connectionError !== undefined) throw connectionError;
      const result = await publish();
      if (connectionError !== undefined) throw connectionError;
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      if (connectionError === undefined) await client.query("ROLLBACK").catch(() => undefined);
      throw connectionError ?? error;
    } finally {
      client.release(connectionError);
      client.off("error", connectionLost);
    }
  }

  public currentRevisionBase(gameId: string): Promise<CurrentRevisionBase | null> {
    return this.readCurrentRevisionBase(this.pool, gameId);
  }

  private async readCurrentRevisionBase(
    executor: Pool | PoolClient,
    gameId: string,
  ): Promise<CurrentRevisionBase | null> {
    const result = await executor.query(
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
  public storedGameCounts(candidates: readonly string[]) {
    return readStoredGameCounts(this.pool, candidates);
  }
  public catalogPage(query: DatabaseGamesQuery) {
    return readDatabaseCatalogPage(this.pool, query);
  }
  public catalogSeasons() {
    return readDatabaseSeasons(this.pool);
  }
  public async revisions(gameId: string): Promise<RevisionCatalog> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT r.*,g.current_revision FROM workbench.game_revisions r
       JOIN workbench.games g ON g.game_id=r.game_id
       WHERE r.game_id=$1 ORDER BY r.revision`,
      [gameId],
    );
    const first = result.rows[0];
    if (first === undefined) throw new GameRevisionNotFoundError(gameId, null);
    if (result.rowCount !== result.rows.length) {
      throw new PersistenceIntegrityError("revision catalog rowCount가 실제 행 수와 다릅니다.");
    }
    const rows = result.rows.map(({ current_revision, ...manifest }) => {
      void current_revision;
      return decodeManifestRow(manifest, gameId);
    });
    if (new Set(rows.map((row) => row.revision)).size !== rows.length) {
      throw new PersistenceIntegrityError("revision catalog에 중복 revision이 있습니다.");
    }
    const currentRevision =
      first.current_revision === null
        ? null
        : safeInteger(first.current_revision, "revision catalog current row.current_revision");
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

function importTargetHash(target: ImportTarget): string {
  return createHash("sha256").update(canonicalStringify(target)).digest("hex");
}

async function lockImportPublication(client: PoolClient, jobId: string): Promise<void> {
  // The two-int advisory key space is separate from the matchup locks.
  const key = createHash("sha256")
    .update("import-publication:" + jobId)
    .digest();
  await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)", [
    key.readInt32BE(0),
    key.readInt32BE(4),
  ]);
}

async function readImportPublication(
  client: PoolClient,
  jobId: string,
  target: ImportTarget,
): Promise<ImportedRevision | null> {
  const rows = await client.query<{
    game_id: string;
    revision: number;
    document_hash: string;
    projection_hash: string;
    target_hash: string;
  }>(
    `SELECT p.game_id,p.revision,p.target_hash,r.document_hash,r.projection_hash
     FROM workbench.import_publications p
     JOIN workbench.game_revisions r USING (game_id,revision)
     WHERE p.job_id=$1 AND r.sealed`,
    [jobId],
  );
  const row = rows.rows[0];
  if (row === undefined) return null;
  if (
    row.target_hash !== importTargetHash(target) ||
    row.game_id !== target.gameId ||
    row.document_hash !== target.documentHash ||
    row.revision !== target.revision
  ) {
    throw new RevisionConflictError("적재 작업이 이미 다른 작업본의 봉인과 연결됐습니다.");
  }
  return {
    gameId: row.game_id,
    revision: row.revision,
    documentHash: row.document_hash,
    projectionHash: row.projection_hash,
  };
}
