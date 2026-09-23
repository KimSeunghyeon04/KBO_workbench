import type { StagingGameDocumentV2, StagingRelayEvent } from "@kbo/contracts";
import type { ReplayResult } from "@kbo/game-core";
import type { ProjectionTables, ProjectionVersion, RelationalProjection } from "./projection.js";

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

export interface ManifestRow {
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
  readonly projection_version: ProjectionVersion;
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

export interface RevisionProjectionComputation {
  project(
    document: StagingGameDocumentV2,
    replay: ReplayResult,
    revision: number,
    version: ProjectionVersion,
  ): Promise<RelationalProjection>;
  hash(tables: ProjectionTables, version: ProjectionVersion): Promise<string>;
}
