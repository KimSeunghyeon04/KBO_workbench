import type {
  GameCatalogItem,
  RevisionCatalog,
  StagingGameDocumentV2,
  StagingRelayEvent,
} from "@kbo/contracts";
import { compareCanonicalStrings, parseStagingGameDocumentV2 } from "@kbo/contracts";
import {
  compileStagingGameDocumentV2,
  stagingDocumentHash,
  type BatterLine,
  type BaserunnerLine,
  type CompiledPitchFact,
  type CompiledPlay,
  type Finding,
  type GameState,
  type PitcherLine,
  type PlateAppearanceSummary,
  type ReplayFrame,
  type ReplayResult,
} from "@kbo/game-core";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  buildRelationalProjection,
  hashProjectionTables,
  type ProjectionRow,
  type ProjectionTables,
  type RelationalProjection,
} from "./projection.js";
import { readProjection, writeProjection } from "./projection-repository.js";
import { readDatabaseCatalog } from "./revision-catalog-repository.js";

export type ImportFailurePoint = "after_manifest" | "after_facts" | "before_seal";
export interface ImportOptions {
  readonly failurePoint?: ImportFailurePoint;
}
export interface ImportedRevision {
  readonly gameId: string;
  readonly revision: number;
  readonly documentHash: string;
  readonly projectionHash: string;
}
export interface CurrentRevisionBase {
  readonly revision: number;
  readonly documentHash: string;
  readonly sourceBundleHash: string;
}
export interface StoredReplayRosterPlayer {
  readonly playerId: string;
  readonly name: string;
  readonly battingOrder: number | null;
  readonly starter: boolean;
  readonly positions: readonly string[];
}
export interface StoredReplayRelayEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: StagingRelayEvent["kind"];
  readonly relayText: string | null;
  readonly substitution: Extract<StagingRelayEvent, { kind: "substitution" }>["payload"] | null;
}
export interface StoredReplaySource {
  readonly gameId: string;
  readonly gameDate: string;
  readonly status: StagingGameDocumentV2["metadata"]["status"];
  readonly teams: StagingGameDocumentV2["teams"];
  readonly rosters: Readonly<Record<"away" | "home", readonly StoredReplayRosterPlayer[]>>;
  readonly relayEvents: readonly StoredReplayRelayEvent[];
  readonly trackingCandidates: StagingGameDocumentV2["trackingCandidates"];
}
export interface StoredCompiledRevision extends ImportedRevision {
  readonly replay: ReplayResult;
  readonly source: StoredReplaySource;
}

export class DatabaseContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DatabaseContractError";
  }
}
export class RevisionConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RevisionConflictError";
  }
}
export class GameAlreadyImportedError extends Error {
  public constructor(public readonly gameId: string) {
    super(`이미 DB에 적재된 경기입니다: ${gameId}`);
    this.name = "GameAlreadyImportedError";
  }
}
export class GameRevisionNotFoundError extends Error {
  public constructor(
    public readonly gameId: string,
    public readonly revision: number | null,
  ) {
    super(
      `경기 revision을 찾을 수 없습니다: ${gameId}${revision === null ? "" : ` revision ${String(revision)}`}`,
    );
    this.name = "GameRevisionNotFoundError";
  }
}
export class BlockingImportError extends Error {
  public constructor(
    public readonly gameId: string,
    public readonly blockingCodes: readonly string[],
  ) {
    super(`차단 finding이 있어 적재할 수 없습니다: ${blockingCodes.join(", ")}`);
    this.name = "BlockingImportError";
  }
}
export class PersistenceIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PersistenceIntegrityError";
  }
}
interface ManifestRow extends QueryResultRow {
  readonly game_id: string;
  readonly revision: number;
  readonly schema_version: number;
  readonly provider: "naver";
  readonly source_game_id: string;
  readonly source_bundle_hash: string;
  readonly collected_at_text: string;
  readonly parent_revision: number | null;
  readonly base_document_hash: string | null;
  readonly season: number;
  readonly game_date: string | Date;
  readonly scheduled_at_text: string | null;
  readonly game_status: StagingGameDocumentV2["metadata"]["status"];
  readonly stadium: string | null;
  readonly scheduled_innings: number;
  readonly document_hash: string;
  readonly projection_hash: string;
  readonly projection_version: number;
  readonly sealed: boolean;
  readonly created_at: Date | string;
  readonly sealed_at: Date | string | null;
}

export type ProjectionLedgerManifest = Pick<
  ManifestRow,
  | "game_id"
  | "source_game_id"
  | "source_bundle_hash"
  | "collected_at_text"
  | "parent_revision"
  | "base_document_hash"
  | "season"
  | "game_date"
  | "scheduled_at_text"
  | "game_status"
  | "stadium"
  | "scheduled_innings"
>;

export class GameRevisionStore {
  public constructor(
    private readonly pool: Pool,
    private readonly expectedMigrationVersion: string,
  ) {}

  public async importRevision(
    input: unknown,
    options: ImportOptions = {},
  ): Promise<ImportedRevision> {
    const stagingDocument = parseStagingGameDocumentV2(input);
    const stagingReplay = compileStagingGameDocumentV2(stagingDocument);
    rejectBlocking(stagingDocument.metadata.gameId, stagingReplay);
    const document = stagingDocument;
    const replay = stagingReplay;
    const documentHash = stagingDocumentHash(document);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertDatabaseContract(client, this.expectedMigrationVersion);
      const existing = await client.query<{ readonly current_revision: number | null }>(
        "SELECT current_revision FROM workbench.games WHERE game_id=$1 FOR UPDATE",
        [document.metadata.gameId],
      );
      const currentRevision = existing.rows[0]?.current_revision ?? null;
      let revision: number;
      if ((existing.rowCount ?? 0) === 0) {
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
      const projection = buildRelationalProjection(document, replay, revision);
      await upsertGameCatalog(client, document, replay);
      await insertManifest(client, document, revision, documentHash, projection.projectionHash);
      injectFailure(options, "after_manifest");
      await writeProjection(client, projection.tables);
      injectFailure(options, "after_facts");
      await verifyStoredProjection(client, document.metadata.gameId, revision, projection);
      await verifyRecompile(
        client,
        document.metadata.gameId,
        revision,
        documentHash,
        projection.projectionHash,
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
      const tables = await readProjection(client, gameId, resolvedRevision);
      const projectionHash = hashProjectionTables(tables);
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
      const tables = await readProjection(client, gameId, revision);
      if (hashProjectionTables(tables) !== manifest.projection_hash) {
        throw new PersistenceIntegrityError("DB typed projection hash가 manifest와 다릅니다.");
      }
      const stored = hydrateProjectionLedger(manifest, tables);
      if (stagingDocumentHash(stored) !== manifest.document_hash) {
        throw new PersistenceIntegrityError("DB 원장 fact의 문서 hash가 manifest와 다릅니다.");
      }
      return parseStagingGameDocumentV2({
        ...stored,
        revisionBase: {
          kind: "sealed_revision",
          revision,
          documentHash: manifest.document_hash,
        },
      });
    } finally {
      client.release();
    }
  }

  public async countStoredGames(): Promise<number> {
    const result = await this.pool.query<{ readonly count: string }>(
      "SELECT COUNT(*)::text AS count FROM workbench.games WHERE current_revision IS NOT NULL",
    );
    return Number(result.rows[0]?.count ?? "0");
  }
  public async currentRevisionBase(gameId: string): Promise<CurrentRevisionBase | null> {
    const result = await this.pool.query<{
      readonly revision: number;
      readonly document_hash: string;
      readonly source_bundle_hash: string;
    }>(
      `SELECT r.revision,r.document_hash,r.source_bundle_hash
       FROM workbench.games g
       JOIN workbench.game_revisions r
         ON r.game_id=g.game_id AND r.revision=g.current_revision
       WHERE g.game_id=$1 AND r.sealed`,
      [gameId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          revision: row.revision,
          documentHash: row.document_hash,
          sourceBundleHash: row.source_bundle_hash,
        };
  }
  public async catalog(): Promise<readonly GameCatalogItem[]> {
    return readDatabaseCatalog(this.pool);
  }
  public async revisions(gameId: string): Promise<RevisionCatalog> {
    const result = await this.pool.query<ManifestRow>(
      "SELECT r.* FROM workbench.game_revisions r WHERE r.game_id=$1 ORDER BY r.revision",
      [gameId],
    );
    if (result.rows.length === 0) throw new GameRevisionNotFoundError(gameId, null);
    const current = await this.pool.query<{ readonly current_revision: number | null }>(
      "SELECT current_revision FROM workbench.games WHERE game_id=$1",
      [gameId],
    );
    const currentRevision = current.rows[0]?.current_revision ?? null;
    return {
      gameId,
      currentRevision,
      revisions: result.rows.map((row) => ({
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

async function assertDatabaseContract(
  client: PoolClient,
  expectedMigration: string,
): Promise<void> {
  const major = await client.query<{ readonly major: number }>(
    "SELECT current_setting('server_version_num')::int / 10000 AS major",
  );
  if (major.rows[0]?.major !== 16) throw new DatabaseContractError("PostgreSQL 16만 지원합니다.");
  const migration = await client.query<{ readonly version: string }>(
    "SELECT version FROM workbench.schema_migrations ORDER BY version DESC LIMIT 1",
  );
  if (migration.rows[0]?.version !== expectedMigration)
    throw new DatabaseContractError(
      `migration head 불일치: expected=${expectedMigration}, actual=${migration.rows[0]?.version ?? "없음"}`,
    );
  const contract = await client.query<{
    readonly analytics_contract_version: number;
    readonly projection_version: number;
    readonly registry_contract_version: number;
  }>(
    "SELECT analytics_contract_version, projection_version, registry_contract_version FROM workbench.contract_metadata WHERE singleton",
  );
  if (
    contract.rows[0]?.analytics_contract_version !== 3 ||
    contract.rows[0]?.projection_version !== 3 ||
    contract.rows[0]?.registry_contract_version !== 1
  )
    throw new DatabaseContractError(
      "analytics/projection/registry contract version이 3/3/1이어야 합니다.",
    );
}

async function insertManifest(
  client: PoolClient,
  document: StagingGameDocumentV2,
  revision: number,
  documentHash: string,
  projectionHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO workbench.game_revisions
     (game_id,revision,parent_revision,base_document_hash,schema_version,provider,source_game_id,source_bundle_hash,collected_at_text,season,game_date,scheduled_at_text,game_status,stadium,scheduled_innings,document_hash,projection_hash,projection_version)
     VALUES ($1,$2,$3,$4,2,'naver',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,3)`,
    [
      document.metadata.gameId,
      revision,
      document.revisionBase.kind === "sealed_revision" ? document.revisionBase.revision : null,
      document.revisionBase.kind === "sealed_revision" ? document.revisionBase.documentHash : null,
      document.source.sourceGameId,
      document.source.sourceBundleHash,
      document.source.collectedAt,
      document.metadata.season,
      document.metadata.gameDate,
      document.metadata.scheduledAt ?? null,
      document.metadata.status,
      document.metadata.stadium ?? null,
      document.metadata.scheduledInnings,
      documentHash,
      projectionHash,
    ],
  );
}
async function verifyStoredProjection(
  client: PoolClient,
  gameId: string,
  revision: number,
  projection: RelationalProjection,
): Promise<void> {
  const stored = await readProjection(client, gameId, revision);
  const hash = hashProjectionTables(stored);
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
): Promise<void> {
  const storedManifest = await loadManifest(client, gameId, revision);
  const tables = await readProjection(client, gameId, revision);
  const document = hydrateProjectionLedger(storedManifest, tables);
  if (stagingDocumentHash(document) !== documentHash)
    throw new PersistenceIntegrityError("DB 원장 fact의 문서 hash가 원본 staging 원장과 다릅니다.");
  const replay = compileStagingGameDocumentV2(document);
  if (buildRelationalProjection(document, replay, revision).projectionHash !== projectionHash)
    throw new PersistenceIntegrityError("DB 원장 재compile 결과가 저장 projection과 다릅니다.");
}
async function loadManifest(
  client: PoolClient,
  gameId: string,
  revision: number,
): Promise<ManifestRow> {
  const result = await client.query<ManifestRow>(
    "SELECT * FROM workbench.game_revisions WHERE game_id=$1 AND revision=$2",
    [gameId, revision],
  );
  const row = result.rows[0];
  if (row === undefined) throw new GameRevisionNotFoundError(gameId, revision);
  return row;
}

async function currentRevision(client: PoolClient, gameId: string): Promise<number> {
  const result = await client.query<{ readonly current_revision: number | null }>(
    "SELECT current_revision FROM workbench.games WHERE game_id=$1",
    [gameId],
  );
  const revision = result.rows[0]?.current_revision ?? null;
  if (revision === null) throw new GameRevisionNotFoundError(gameId, null);
  return revision;
}

function replaySourceFromProjection(
  manifest: ManifestRow,
  tables: ProjectionTables,
): StoredReplaySource {
  const teams = Object.fromEntries(
    tables.game_team_snapshots.map((row) => [
      text(row.side),
      {
        teamId: text(row.team_id),
        name: text(row.team_name),
      },
    ]),
  ) as StagingGameDocumentV2["teams"];
  const positions = group(
    tables.game_roster_positions,
    (row) => `${text(row.side)}:${number(row.roster_index)}`,
  );
  const rosters = Object.fromEntries(
    (["away", "home"] as const).map((teamSide) => [
      teamSide,
      tables.game_roster_snapshots
        .filter((row) => row.side === teamSide)
        .map((row) => ({
          playerId: text(row.player_id),
          name: text(row.player_name),
          battingOrder: row.batting_order === null ? null : number(row.batting_order),
          starter: boolean(row.starter),
          positions: (positions.get(`${teamSide}:${number(row.roster_index)}`) ?? []).map((item) =>
            text(item.position),
          ),
        })),
    ]),
  ) as unknown as StoredReplaySource["rosters"];
  const pitchById = new Map(tables.pitch_facts.map((row) => [text(row.pitch_id), row]));
  const trackingById = new Map(
    tables.tracking_observations.map((row) => [text(row.tracking_id), row]),
  );
  const trackingCandidates: StagingGameDocumentV2["trackingCandidates"] =
    tables.pitch_tracking_links.map((link) => {
      const row = trackingById.get(text(link.tracking_id));
      if (row === undefined) {
        throw new PersistenceIntegrityError("tracking link의 원천 관측을 찾을 수 없습니다.");
      }
      const pitch = pitchById.get(text(link.pitch_id));
      if (pitch === undefined) {
        throw new PersistenceIntegrityError("tracking에 대응하는 pitch fact가 없습니다.");
      }
      return {
        trackingId: text(row.tracking_id),
        source: {
          endpoint: text(row.source_endpoint),
          blockIndex: number(row.source_block_index),
          rowIndex: number(row.source_row_index),
        },
        ...(row.source_pitch_id === null ? {} : { sourcePitchId: text(row.source_pitch_id) }),
        sourcePitchOrdinal:
          row.source_pitch_ordinal === null ? null : number(row.source_pitch_ordinal),
        sequence: number(row.tracking_sequence),
        inning: number(pitch.inning),
        half: half(pitch.half),
        ...(pitch.plate_appearance_event_id === null
          ? {}
          : { plateAppearanceEventId: text(pitch.plate_appearance_event_id) }),
        ...(row.pitcher_id === null ? {} : { pitcherId: text(row.pitcher_id) }),
        ...(row.batter_id === null ? {} : { batterId: text(row.batter_id) }),
        ...(row.observed_at === null ? {} : { observedAt: text(row.observed_at) }),
        ...(row.stance === null ? {} : { stance: text(row.stance) as "L" | "R" | "S" }),
        ...trackingNumbersFromRow(row),
        resolution: { kind: "linked", pitchEventId: text(link.pitch_id) },
      };
    });
  return {
    gameId: manifest.game_id,
    gameDate: dateText(manifest.game_date),
    status: manifest.game_status,
    teams,
    rosters,
    trackingCandidates,
    relayEvents: hydrateEvents(tables).map((event) => {
      return {
        eventId: event.identity.eventId,
        sequence: event.sequence,
        kind: event.kind,
        relayText: event.relayText ?? null,
        substitution: event.kind === "substitution" ? event.payload : null,
      };
    }),
  };
}

function replayFromProjection(gameId: string, tables: ProjectionTables): ReplayResult {
  const relayByPlay = group(tables.play_events, (row) => String(number(row.play_sequence)));
  const movementsByPlay = group(tables.runner_movement_facts, (row) =>
    String(number(row.play_sequence)),
  );
  const plateEventsByIndex = group(tables.plate_appearance_events, (row) =>
    String(number(row.plate_appearance_index)),
  );
  const eventsByStart = new Map<
    string,
    readonly { readonly eventId: string; readonly sequence: number }[]
  >();
  for (const row of tables.plate_appearance_facts) {
    eventsByStart.set(
      text(row.start_event_id),
      (plateEventsByIndex.get(String(number(row.plate_appearance_index))) ?? []).map((event) => ({
        eventId: text(event.event_id),
        sequence: number(event.event_sequence),
      })),
    );
  }
  const plays: CompiledPlay[] = tables.play_facts.map((row) => {
    const playSequence = number(row.play_sequence);
    const relayEvents = relayByPlay.get(String(playSequence)) ?? [];
    const firstRelaySequence = Math.min(
      ...relayEvents.map((event) => number(event.event_sequence)),
    );
    const lastRelaySequence = Math.max(...relayEvents.map((event) => number(event.event_sequence)));
    if (!Number.isFinite(firstRelaySequence) || !Number.isFinite(lastRelaySequence)) {
      throw new PersistenceIntegrityError("play에 연결된 원장 event가 없습니다.");
    }
    return {
      playId: text(row.play_id),
      sequence: number(row.source_sequence),
      kind: text(row.kind) as CompiledPlay["kind"],
      inning: number(row.inning),
      half: half(row.half),
      relayEventIds: relayEvents.map((event) => text(event.event_id)),
      relayTexts: relayEvents.flatMap((event) =>
        event.relay_text === null ? [] : [text(event.relay_text)],
      ),
      before: stateFromRow(row, "before", eventsByStart, firstRelaySequence - 1),
      after: stateFromRow(row, "after", eventsByStart, lastRelaySequence),
      applied: boolean(row.applied),
      movements: (movementsByPlay.get(String(playSequence)) ?? []).map((movement) => ({
        movementId: text(movement.movement_id),
        sourceEventId: movement.source_event_id === null ? null : text(movement.source_event_id),
        runnerId: text(movement.runner_id),
        fromBase: number(movement.from_base),
        toBase: number(movement.to_base),
        outcome: text(movement.outcome) as "safe" | "out" | "scored",
        ...(movement.out_kind === null
          ? {}
          : {
              outKind: text(movement.out_kind) as NonNullable<
                CompiledPlay["movements"][number]["outKind"]
              >,
            }),
        ...(movement.supersedes_third_out === null
          ? {}
          : { supersedesThirdOut: boolean(movement.supersedes_third_out) }),
        responsiblePitcherId: text(movement.responsible_pitcher_id),
        reason: text(movement.reason) as CompiledPlay["movements"][number]["reason"],
        derived: boolean(movement.derived),
        sequence: number(movement.source_sequence),
      })),
    };
  });
  const playByEvent = new Map<string, CompiledPlay>();
  for (const play of plays)
    for (const eventId of play.relayEventIds) playByEvent.set(eventId, play);
  const frames: ReplayFrame[] = tables.relay_event_facts.map((event) => {
    const eventId = text(event.event_id);
    const play = playByEvent.get(eventId);
    return {
      eventId,
      sequence: number(event.event_sequence),
      kind: text(event.kind) as ReplayFrame["kind"],
      playId: play?.playId ?? null,
      before: play?.before ?? stateFromNearestPlay(plays, number(event.event_sequence)),
      after: play?.after ?? stateFromNearestPlay(plays, number(event.event_sequence)),
      applied: play?.applied ?? false,
    };
  });
  const plateAppearances: PlateAppearanceSummary[] = tables.plate_appearance_facts.map((row) => ({
    startEventId: text(row.start_event_id),
    endEventId: row.end_event_id === null ? null : text(row.end_event_id),
    inning: number(row.inning),
    half: half(row.half),
    startBatterId: text(row.start_batter_id),
    batterId: text(row.batter_id),
    startPitcherId: text(row.start_pitcher_id),
    pitcherId: text(row.pitcher_id),
    result:
      row.result === null
        ? null
        : (text(row.result) as NonNullable<PlateAppearanceSummary["result"]>),
    completed: boolean(row.completed),
    terminationReason: text(row.termination_reason) as PlateAppearanceSummary["terminationReason"],
    actualPitchCount: number(row.actual_pitch_count),
    eventIds:
      plateEventsByIndex
        .get(String(number(row.plate_appearance_index)))
        ?.map((event) => text(event.event_id)) ?? [],
  }));
  const frameByEventId = new Map(frames.map((frame) => [frame.eventId, frame]));
  const eventSequenceById = new Map(
    tables.relay_event_facts.map((event) => [text(event.event_id), number(event.event_sequence)]),
  );
  const pitchFacts: CompiledPitchFact[] = tables.pitch_facts.map((row) => {
    const pitchId = text(row.pitch_id);
    const frame = frameByEventId.get(pitchId);
    if (frame === undefined) throw new PersistenceIntegrityError("pitch frame이 없습니다.");
    const sourceSequence = eventSequenceById.get(pitchId);
    if (sourceSequence === undefined)
      throw new PersistenceIntegrityError("pitch 원장 sequence가 없습니다.");
    return {
      pitchId,
      sequence: sourceSequence,
      inning: number(row.inning),
      half: half(row.half),
      plateAppearanceEventId:
        row.plate_appearance_event_id === null ? null : text(row.plate_appearance_event_id),
      pitchEventNumber: row.pitch_event_number === null ? null : number(row.pitch_event_number),
      actualPitchNumber: row.actual_pitch_number === null ? null : number(row.actual_pitch_number),
      batterId: row.batter_id === null ? null : text(row.batter_id),
      pitcherId: row.pitcher_id === null ? null : text(row.pitcher_id),
      sourcePitchId: row.source_pitch_id === null ? null : text(row.source_pitch_id),
      call: text(row.pitch_call) as CompiledPitchFact["call"],
      actual: boolean(row.actual),
      ball: boolean(row.ball),
      calledStrike: boolean(row.called_strike),
      swing: boolean(row.swing),
      whiff: boolean(row.whiff),
      foul: boolean(row.foul),
      inPlay: boolean(row.in_play),
      strike: boolean(row.strike),
      csw: boolean(row.csw),
      before: frame.before,
      after: frame.after,
    };
  });
  return {
    gameId,
    finalState: stateFromRow(
      requiredSingle(tables.game_final_states, "game_final_states"),
      "final",
      eventsByStart,
    ),
    frames,
    plays,
    plateAppearances,
    pitchFacts,
    batterLines: tables.batter_game_facts.map(batterLineFromRow),
    pitcherLines: tables.pitcher_game_facts.map(pitcherLineFromRow),
    baserunnerLines: tables.baserunner_game_facts.map(baserunnerLineFromRow),
    findings: findingsFromProjection(gameId, tables),
  };
}

function stateFromNearestPlay(plays: readonly CompiledPlay[], sequence: number): GameState {
  const previous = [...plays].reverse().find((play) => play.sequence < sequence);
  if (previous !== undefined) return previous.after;
  const next = plays.find((play) => play.sequence > sequence);
  if (next !== undefined) return next.before;
  throw new PersistenceIntegrityError(
    `원장 행 ${String(sequence)}에 대응하는 상태 fact가 없습니다.`,
  );
}
function stateFromRow(
  row: ProjectionRow,
  prefix: string,
  eventsByStart: ReadonlyMap<
    string,
    readonly { readonly eventId: string; readonly sequence: number }[]
  >,
  eventSequenceLimit?: number,
): GameState {
  const startEventId = nullableText(row[`${prefix}_pa_start_event_id`]);
  const occupant = (base: number) => {
    const runnerId = nullableText(row[`${prefix}_base${String(base)}_runner_id`]);
    const pitcherId = nullableText(row[`${prefix}_base${String(base)}_pitcher_id`]);
    if (runnerId === null && pitcherId === null) return null;
    if (runnerId === null || pitcherId === null)
      throw new PersistenceIntegrityError("주자와 책임 투수 fact가 불완전합니다.");
    return { runnerId, responsiblePitcherId: pitcherId };
  };
  const activePlateAppearance =
    startEventId === null
      ? null
      : {
          startEventId,
          startBatterId: requiredNullableText(row[`${prefix}_pa_start_batter_id`], "PA 시작 타자"),
          currentBatterId: requiredNullableText(row[`${prefix}_batter_id`], "PA 현재 타자"),
          startPitcherId: requiredNullableText(
            row[`${prefix}_pa_start_pitcher_id`],
            "PA 시작 투수",
          ),
          currentPitcherId: requiredNullableText(row[`${prefix}_pitcher_id`], "PA 현재 투수"),
          walkResponsiblePitcherId: nullableText(row[`${prefix}_pa_walk_responsible_pitcher_id`]),
          strikeoutResponsibleBatterId: nullableText(
            row[`${prefix}_pa_strikeout_responsible_batter_id`],
          ),
          actualPitchCount: requiredNullableNumber(
            row[`${prefix}_pa_actual_pitch_count`],
            "PA 투구 수",
          ),
          eventIds: (eventsByStart.get(startEventId) ?? [])
            .filter(
              (event) => eventSequenceLimit === undefined || event.sequence <= eventSequenceLimit,
            )
            .map((event) => event.eventId),
        };
  return {
    inning: number(row[`${prefix}_inning`]),
    half: half(row[`${prefix}_half`]),
    halfActive: boolean(row[`${prefix}_half_active`]),
    balls: number(row[`${prefix}_balls`]),
    strikes: number(row[`${prefix}_strikes`]),
    outs: number(row[`${prefix}_outs`]),
    bases: [occupant(1), occupant(2), occupant(3)],
    awayScore: number(row[`${prefix}_away_score`]),
    homeScore: number(row[`${prefix}_home_score`]),
    activePlateAppearance,
    activePitchers: {
      away: nullableText(row[`${prefix}_active_away_pitcher_id`]),
      home: nullableText(row[`${prefix}_active_home_pitcher_id`]),
    },
  };
}
function batterLineFromRow(row: ProjectionRow): BatterLine {
  return {
    playerId: text(row.player_id),
    side: side(row.side),
    plateAppearances: number(row.plate_appearances),
    atBats: number(row.at_bats),
    runs: number(row.runs),
    hits: number(row.hits),
    doubles: number(row.doubles),
    triples: number(row.triples),
    homeRuns: number(row.home_runs),
    runsBattedIn: number(row.runs_batted_in),
    walks: number(row.walks),
    intentionalWalks: number(row.intentional_walks),
    hitByPitch: number(row.hit_by_pitch),
    strikeouts: number(row.strikeouts),
    sacrificeBunts: number(row.sacrifice_bunts),
    sacrificeFlies: number(row.sacrifice_flies),
  };
}
function pitcherLineFromRow(row: ProjectionRow): PitcherLine {
  return {
    playerId: text(row.player_id),
    side: side(row.side),
    battersFaced: number(row.batters_faced),
    outsRecorded: number(row.outs_recorded),
    hits: number(row.hits),
    runs: number(row.runs),
    earnedRuns: null,
    walks: number(row.walks),
    intentionalWalks: number(row.intentional_walks),
    hitByPitch: number(row.hit_by_pitch),
    strikeouts: number(row.strikeouts),
    pitches: number(row.pitches),
    strikes: number(row.strikes),
  };
}
function baserunnerLineFromRow(row: ProjectionRow): BaserunnerLine {
  return {
    playerId: text(row.player_id),
    side: side(row.side),
    advances: number(row.advances),
    extraBasesTaken: number(row.extra_bases_taken),
    runs: number(row.runs),
    stolenBases: number(row.stolen_bases),
    caughtStealing: number(row.caught_stealing),
    pickoffs: number(row.pickoffs),
  };
}

const trackingNumberColumns = {
  x0: "x0",
  y0: "y0",
  z0: "z0",
  vx0: "vx0",
  vy0: "vy0",
  vz0: "vz0",
  ax: "ax",
  ay: "ay",
  az: "az",
  crossPlateX: "cross_plate_x",
  crossPlateY: "cross_plate_y",
  topSz: "top_sz",
  bottomSz: "bottom_sz",
} as const;

function trackingNumbersFromRow(
  row: ProjectionRow,
): Partial<
  Pick<StagingGameDocumentV2["trackingCandidates"][number], keyof typeof trackingNumberColumns>
> {
  return Object.fromEntries(
    Object.entries(trackingNumberColumns).flatMap(([field, column]) =>
      row[column] === null ? [] : [[field, number(row[column])]],
    ),
  );
}
function findingsFromProjection(gameId: string, tables: ProjectionTables): Finding[] {
  const details = group(tables.validation_issue_details, (row) => String(number(row.issue_index)));
  return tables.validation_issues.map((row) => ({
    gameId,
    code: text(row.code),
    category: text(row.category) as Finding["category"],
    severity: text(row.severity) as Finding["severity"],
    message: text(row.message),
    ...(row.event_id === null ? {} : { eventId: text(row.event_id) }),
    ...(row.event_sequence === null ? {} : { eventSequence: number(row.event_sequence) }),
    ...(row.record_identity === null ? {} : { recordIdentity: text(row.record_identity) }),
    details: (details.get(String(number(row.issue_index))) ?? []).map((detail) => ({
      field: text(detail.field),
      expected: detailScalar(detail, "expected"),
      actual: detailScalar(detail, "actual"),
    })),
  }));
}
function detailScalar(
  row: ProjectionRow,
  prefix: "expected" | "actual",
): string | number | boolean | null {
  const scalarType = text(row[`${prefix}_type`]);
  if (scalarType === "string") return text(row[`${prefix}_text`]);
  if (scalarType === "number") return number(row[`${prefix}_number`]);
  if (scalarType === "boolean") return boolean(row[`${prefix}_boolean`]);
  if (scalarType === "null") return null;
  throw new PersistenceIntegrityError(`알 수 없는 finding detail type: ${scalarType}`);
}
function requiredSingle(rows: readonly ProjectionRow[], table: string): ProjectionRow {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new PersistenceIntegrityError(`${table}은 정확히 한 행이어야 합니다.`);
  return rows[0];
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function requiredNullableText(value: unknown, label: string): string {
  const result = nullableText(value);
  if (result === null) throw new PersistenceIntegrityError(`${label} fact가 없습니다.`);
  return result;
}
function requiredNullableNumber(value: unknown, label: string): number {
  if (value === null) throw new PersistenceIntegrityError(`${label} fact가 없습니다.`);
  return number(value);
}

export function hydrateProjectionLedger(
  manifest: ProjectionLedgerManifest,
  tables: ProjectionTables,
): StagingGameDocumentV2 {
  const teams = Object.fromEntries(
    tables.game_team_snapshots.map((row) => [
      text(row.side),
      { teamId: text(row.team_id), name: text(row.team_name) },
    ]),
  ) as Record<"away" | "home", { teamId: string; name: string }>;
  const positions = group(
    tables.game_roster_positions,
    (row) => `${text(row.side)}:${number(row.roster_index)}`,
  );
  const rosters = Object.fromEntries(
    (["away", "home"] as const).map((side) => [
      side,
      {
        teamId: teams[side].teamId,
        players: tables.game_roster_snapshots
          .filter((row) => row.side === side)
          .map((row) => ({
            playerId: text(row.player_id),
            name: text(row.player_name),
            ...(row.batting_order === null ? {} : { battingOrder: number(row.batting_order) }),
            starter: boolean(row.starter),
            positions: (positions.get(`${side}:${number(row.roster_index)}`) ?? []).map((item) =>
              text(item.position),
            ),
          })),
      },
    ]),
  ) as StagingGameDocumentV2["rosters"];
  const events = hydrateEvents(tables);
  const trackingCandidates = tables.tracking_observations.map((row) => {
    const resolutionKind = text(row.resolution_kind);
    const resolution =
      resolutionKind === "pending"
        ? ({ kind: "pending" } as const)
        : resolutionKind === "linked"
          ? ({
              kind: "linked",
              pitchEventId: requiredNullableText(row.pitch_event_id, "tracking pitch event"),
            } as const)
          : resolutionKind === "duplicate"
            ? ({
                kind: "duplicate",
                canonicalTrackingId: requiredNullableText(
                  row.canonical_tracking_id,
                  "tracking canonical ID",
                ),
              } as const)
            : resolutionKind === "excluded"
              ? ({
                  kind: "excluded",
                  reason: requiredNullableText(row.exclusion_reason, "tracking 제외 사유") as
                    "not_a_pitch" | "provider_conflict" | "invalid_measurement" | "manual_other",
                  ...(row.exclusion_note === null ? {} : { note: text(row.exclusion_note) }),
                } as const)
              : (() => {
                  throw new PersistenceIntegrityError(
                    `알 수 없는 tracking resolution입니다: ${resolutionKind}`,
                  );
                })();
    return {
      trackingId: text(row.tracking_id),
      source: {
        endpoint: text(row.source_endpoint),
        blockIndex: number(row.source_block_index),
        rowIndex: number(row.source_row_index),
      },
      ...(row.source_pitch_id === null ? {} : { sourcePitchId: text(row.source_pitch_id) }),
      sourcePitchOrdinal:
        row.source_pitch_ordinal === null ? null : number(row.source_pitch_ordinal),
      sequence: number(row.tracking_sequence),
      inning: number(row.inning),
      half: half(row.half),
      ...(row.plate_appearance_event_id === null
        ? {}
        : { plateAppearanceEventId: text(row.plate_appearance_event_id) }),
      ...(row.pitcher_id === null ? {} : { pitcherId: text(row.pitcher_id) }),
      ...(row.batter_id === null ? {} : { batterId: text(row.batter_id) }),
      ...(row.observed_at === null ? {} : { observedAt: text(row.observed_at) }),
      ...(row.stance === null ? {} : { stance: text(row.stance) as "L" | "R" | "S" }),
      ...trackingNumbersFromRow(row),
      resolution,
    };
  });
  return parseStagingGameDocumentV2({
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: manifest.source_game_id,
      collectedAt: manifest.collected_at_text,
      sourceBundleHash: manifest.source_bundle_hash,
    },
    revisionBase:
      manifest.parent_revision === null || manifest.base_document_hash === null
        ? { kind: "new_game" }
        : {
            kind: "sealed_revision",
            revision: manifest.parent_revision,
            documentHash: manifest.base_document_hash,
          },
    metadata: {
      gameId: manifest.game_id,
      season: manifest.season,
      gameDate: dateText(manifest.game_date),
      ...(manifest.scheduled_at_text === null ? {} : { scheduledAt: manifest.scheduled_at_text }),
      status: manifest.game_status,
      ...(manifest.stadium === null ? {} : { stadium: manifest.stadium }),
      scheduledInnings: manifest.scheduled_innings,
    },
    teams,
    rosters,
    events,
    trackingCandidates,
    officialRecords: {
      batters: tables.official_batter_lines.map((row) => ({
        playerId: text(row.player_id),
        side: side(row.side),
        ...(row.plate_appearances === null
          ? {}
          : { plateAppearances: number(row.plate_appearances) }),
        atBats: number(row.at_bats),
        runs: number(row.runs),
        hits: number(row.hits),
        ...(row.doubles === null ? {} : { doubles: number(row.doubles) }),
        ...(row.triples === null ? {} : { triples: number(row.triples) }),
        homeRuns: number(row.home_runs),
        runsBattedIn: number(row.runs_batted_in),
        walks: number(row.walks),
        ...(row.intentional_walks === null
          ? {}
          : { intentionalWalks: number(row.intentional_walks) }),
        ...(row.hit_by_pitch === null ? {} : { hitByPitch: number(row.hit_by_pitch) }),
        strikeouts: number(row.strikeouts),
        ...(row.sacrifice_bunts === null ? {} : { sacrificeBunts: number(row.sacrifice_bunts) }),
        ...(row.sacrifice_flies === null ? {} : { sacrificeFlies: number(row.sacrifice_flies) }),
      })),
      pitchers: tables.official_pitcher_lines.map((row) => ({
        playerId: text(row.player_id),
        side: side(row.side),
        battersFaced: number(row.batters_faced),
        outsRecorded: number(row.outs_recorded),
        hits: number(row.hits),
        runs: number(row.runs),
        earnedRuns: number(row.earned_runs),
        walks: number(row.walks),
        ...(row.intentional_walks === null
          ? {}
          : { intentionalWalks: number(row.intentional_walks) }),
        hitByPitch: number(row.hit_by_pitch),
        strikeouts: number(row.strikeouts),
        ...(row.pitches === null ? {} : { pitches: number(row.pitches) }),
        ...(row.strikes === null ? {} : { strikes: number(row.strikes) }),
      })),
    },
  });
}

const RELAY_SUBTYPE_TABLES = {
  half_inning_start: "relay_half_inning_starts",
  batter_start: "relay_batter_starts",
  pitch: "relay_pitches",
  plate_result: "relay_plate_results",
  runner_advance: "relay_runner_advances",
  substitution: "relay_substitutions",
  review: "relay_reviews",
  administrative: "relay_administrative",
  unresolved: "relay_unresolved",
} as const satisfies Record<StagingRelayEvent["kind"], keyof ProjectionTables>;

function hydrateEvents(tables: ProjectionTables): StagingRelayEvent[] {
  const subtypeByTable = new Map<keyof ProjectionTables, Map<string, ProjectionRow>>();
  for (const table of Object.values(RELAY_SUBTYPE_TABLES)) {
    subtypeByTable.set(
      table,
      new Map(
        tables[table].map((row) => [`${String(row.event_sequence)}:${String(row.event_id)}`, row]),
      ),
    );
  }
  return tables.relay_event_facts.map((header) => {
    const kind = text(header.kind) as StagingRelayEvent["kind"];
    const table = RELAY_SUBTYPE_TABLES[kind];
    if (table === undefined) {
      throw new PersistenceIntegrityError(`알 수 없는 relay kind: ${kind}`);
    }
    const key = `${String(header.event_sequence)}:${String(header.event_id)}`;
    const subtype = subtypeByTable.get(table)?.get(key);
    if (subtype === undefined) {
      throw new PersistenceIntegrityError(`relay subtype이 없습니다: ${kind}:${key}`);
    }
    return hydrateEvent({ ...header, ...subtype });
  });
}

function hydrateEvent(row: ProjectionRow): StagingRelayEvent {
  const identity =
    row.identity_kind === "source"
      ? {
          kind: "source" as const,
          eventId: text(row.event_id),
          endpoint: text(row.source_endpoint),
          blockIndex: number(row.source_block_index),
          eventIndex: number(row.source_event_index),
          ...(row.source_event_id === null ? {} : { sourceEventId: text(row.source_event_id) }),
        }
      : { kind: "manual" as const, eventId: text(row.event_id) };
  const observedStateAfter = hydrateObserved(row);
  const base = {
    identity,
    sequence: number(row.event_sequence),
    inning: number(row.inning),
    half: half(row.half),
    ...(row.relay_text === null ? {} : { relayText: text(row.relay_text) }),
    ...(observedStateAfter === undefined ? {} : { observedStateAfter }),
  };
  switch (row.kind) {
    case "half_inning_start":
      return { ...base, kind: "half_inning_start", payload: {} };
    case "batter_start":
      return {
        ...base,
        kind: "batter_start",
        payload: { batterId: text(row.batter_id), pitcherId: text(row.pitcher_id) },
      };
    case "pitch":
      return {
        ...base,
        kind: "pitch",
        payload: {
          call: text(row.pitch_call) as Extract<
            StagingRelayEvent,
            { kind: "pitch" }
          >["payload"]["call"],
          ...(row.source_pitch_id === null ? {} : { sourcePitchId: text(row.source_pitch_id) }),
          ...(row.batter_id === null ? {} : { batterId: text(row.batter_id) }),
          ...(row.pitcher_id === null ? {} : { pitcherId: text(row.pitcher_id) }),
        },
      };
    case "plate_result":
      return {
        ...base,
        kind: "plate_result",
        payload: {
          result: text(row.plate_result) as Extract<
            StagingRelayEvent,
            { kind: "plate_result" }
          >["payload"]["result"],
          batterId: text(row.batter_id),
          pitcherId: text(row.pitcher_id),
          ...(row.credited_rbi === null ? {} : { creditedRbi: number(row.credited_rbi) }),
          ...(row.outs_recorded === null ? {} : { outsRecorded: number(row.outs_recorded) }),
          ...(row.batter_destination === null
            ? {}
            : { batterDestination: number(row.batter_destination) }),
          ...(row.batted_ball_type === null
            ? {}
            : {
                battedBallType: text(row.batted_ball_type) as
                  "ground_ball" | "fly_ball" | "line_drive" | "popup",
              }),
          ...(row.is_bunt === null ? {} : { isBunt: boolean(row.is_bunt) }),
        },
      };
    case "runner_advance":
      return {
        ...base,
        kind: "runner_advance",
        payload: {
          runnerId: text(row.runner_id),
          fromBase: number(row.from_base),
          toBase: number(row.to_base),
          outcome: text(row.runner_outcome) as "safe" | "out" | "scored",
          ...(row.runner_out_kind === null
            ? {}
            : {
                outKind: text(row.runner_out_kind) as Extract<
                  StagingRelayEvent,
                  { kind: "runner_advance" }
                >["payload"]["outKind"],
              }),
          ...(row.supersedes_third_out === null
            ? {}
            : { supersedesThirdOut: boolean(row.supersedes_third_out) }),
          ...(row.responsible_pitcher_id === null
            ? {}
            : { responsiblePitcherId: text(row.responsible_pitcher_id) }),
          context:
            row.runner_context_kind === "plate_result"
              ? { kind: "plate_result", plateResultEventId: text(row.plate_result_event_id) }
              : {
                  kind: "independent",
                  reason: text(row.runner_reason) as Extract<
                    StagingRelayEvent,
                    { kind: "runner_advance" }
                  >["payload"]["context"] &
                    never,
                },
        },
      } as StagingRelayEvent;
    case "substitution":
      return {
        ...base,
        kind: "substitution",
        payload: {
          side: side(row.substitution_side),
          role: text(row.substitution_role) as "batter" | "runner" | "pitcher" | "fielder",
          incomingPlayerId: text(row.incoming_player_id),
          ...(row.outgoing_player_id === null
            ? {}
            : { outgoingPlayerId: text(row.outgoing_player_id) }),
          ...(row.batting_order === null ? {} : { battingOrder: number(row.batting_order) }),
          ...(row.field_position === null ? {} : { fieldPosition: text(row.field_position) }),
        },
      };
    case "review":
      return {
        ...base,
        kind: "review",
        payload: {
          ...(row.review_decision === null
            ? {}
            : {
                decision: text(row.review_decision) as
                  "requested" | "upheld" | "overturned" | "inconclusive",
              }),
          ...(row.reviewed_event_id === null
            ? {}
            : { reviewedEventId: text(row.reviewed_event_id) }),
        },
      };
    case "administrative":
      return {
        ...base,
        kind: "administrative",
        payload: {
          code: text(row.administrative_code) as
            "announcement" | "mound_visit" | "break" | "footer" | "other",
        },
      };
    case "unresolved":
      return {
        ...base,
        kind: "unresolved",
        payload: {
          sourceType: text(row.unresolved_source_type),
          ...(row.suspected_kind === null
            ? {}
            : {
                suspectedKind: text(row.suspected_kind) as Exclude<
                  StagingRelayEvent["kind"],
                  "unresolved"
                >,
              }),
        },
      };
    default:
      throw new PersistenceIntegrityError(`알 수 없는 relay kind: ${String(row.kind)}`);
  }
}

function hydrateObserved(row: ProjectionRow): StagingRelayEvent["observedStateAfter"] {
  const values = [
    row.observed_balls,
    row.observed_strikes,
    row.observed_outs,
    row.observed_base1,
    row.observed_base2,
    row.observed_base3,
    row.observed_away_score,
    row.observed_home_score,
  ];
  if (values.every((value) => value === null)) return undefined;
  const basesPresent = [row.observed_base1, row.observed_base2, row.observed_base3].some(
    (value) => value !== null,
  );
  return {
    ...(row.observed_balls === null ? {} : { balls: number(row.observed_balls) }),
    ...(row.observed_strikes === null ? {} : { strikes: number(row.observed_strikes) }),
    ...(row.observed_outs === null ? {} : { outs: number(row.observed_outs) }),
    ...(basesPresent
      ? {
          bases: [
            observedBase(row.observed_base1),
            observedBase(row.observed_base2),
            observedBase(row.observed_base3),
          ] as [string | boolean | null, string | boolean | null, string | boolean | null],
        }
      : {}),
    ...(row.observed_away_score === null ? {} : { awayScore: number(row.observed_away_score) }),
    ...(row.observed_home_score === null ? {} : { homeScore: number(row.observed_home_score) }),
  };
}

function group(
  rows: readonly ProjectionRow[],
  key: (row: ProjectionRow) => string,
): Map<string, ProjectionRow[]> {
  const result = new Map<string, ProjectionRow[]>();
  for (const row of rows) {
    const item = result.get(key(row)) ?? [];
    item.push(row);
    result.set(key(row), item);
  }
  return result;
}
function observedBase(value: unknown): string | boolean | null {
  if (value === null) return null;
  if (value === "*") return true;
  if (value === "") return false;
  return text(value);
}
function text(value: unknown): string {
  if (typeof value !== "string")
    throw new PersistenceIntegrityError("DB text 값이 올바르지 않습니다.");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new PersistenceIntegrityError("DB number 값이 올바르지 않습니다.");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new PersistenceIntegrityError("DB boolean 값이 올바르지 않습니다.");
  return value;
}
function side(value: unknown): "away" | "home" {
  const item = text(value);
  if (item !== "away" && item !== "home")
    throw new PersistenceIntegrityError("DB side 값이 올바르지 않습니다.");
  return item;
}
function half(value: unknown): "top" | "bottom" {
  const item = text(value);
  if (item !== "top" && item !== "bottom")
    throw new PersistenceIntegrityError("DB half 값이 올바르지 않습니다.");
  return item;
}
function dateText(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}
function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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
