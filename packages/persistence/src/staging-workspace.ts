import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { AnalysisCoverageWorkspace } from "./analysis-coverage-workspace.js";
import { AnalysisModelJobWorkspace } from "./analysis-model-job-workspace.js";
import { readImmutableSourceBundle } from "./source-bundle-reader.js";
import { saveImmutableSourceBundle, type ImmutableSourceBundle } from "./source-bundle-store.js";
import { WorkspaceCurrentStore, snapshotContentHash } from "./workspace-current-store.js";
import { StaleStagingDocumentError, WorkspacePersistenceBlockedError } from "./workspace-errors.js";
import { findingEnvelope, readFindingEnvelope, readFindings } from "./workspace-findings.js";
import { assertNoUnmigratedCurrentFiles, assertWorkspaceIntegrity } from "./workspace-integrity.js";
import { WorkspaceJournalStore } from "./workspace-journal-store.js";
import { WorkspaceOriginalStore } from "./workspace-original-store.js";
export {
  StaleStagingDocumentError,
  WorkspaceMigrationRequiredError,
  WorkspacePersistenceBlockedError,
} from "./workspace-errors.js";

import {
  canonicalStringify,
  compareCanonicalStrings,
  parseSourceFailureRecord,
  parseStagingCorrectionCommit,
  parseStagingGameDocumentV2,
  parseStoredFindings,
  type CollectionJob,
  type CorrectionGameCatalog,
  type CorrectionJournal,
  type CurrentWorkspaceEntry,
  type GameCatalog,
  type GameCatalogItem,
  type ImportTarget,
  type StagingCorrectionCommit,
  type StagingGameDocumentV2,
  type StoredFinding,
  type WriterLockOwner,
} from "@kbo/contracts";
import {
  compileStagingGameDocumentV2,
  stagingDocumentHash,
  type ReplayResult,
} from "@kbo/game-core";

import { CollectionWorkspace } from "./collection-workspace.js";
import { CompetitionSourceWorkspace } from "./competition-source-workspace.js";
import { ImportWorkspace } from "./import-workspace.js";
import { MatchupModelWorkspace } from "./matchup-model-workspace.js";
import { ParkEnvironmentWorkspace } from "./park-environment-workspace.js";
import { PitchCalibrationWorkspace } from "./pitch-calibration-workspace.js";
import { PitchQualityWorkspace } from "./pitch-quality-workspace.js";
import { PitchReferenceWorkspace } from "./pitch-reference-workspace.js";
import { RunExpectancyWorkspace } from "./run-expectancy-workspace.js";
import { WorkspaceCatalog, workspaceCatalogItem } from "./workspace-catalog.js";
import {
  acquireWriterLock,
  atomicWrite,
  isMissing,
  readDirectoryIfPresent,
  readWriterLock,
  removeIfPresent,
  removeTemporaryFiles,
} from "./workspace-files.js";
import { assertGameId, assertSeason } from "./workspace-path-policy.js";
import {
  readVerifiedDocument,
  readVerifiedFindings,
  verifiedImportTarget,
} from "./workspace-validation.js";

export type { ImmutableSourceBundle } from "./source-bundle-store.js";

export interface SupersededDocumentSnapshot {
  readonly snapshotId: string;
  readonly document: StagingGameDocumentV2;
  readonly findings: readonly StoredFinding[];
  readonly currentContentHash: string | null;
}

export interface CurrentDocumentSnapshot {
  readonly authority: "staging" | "quarantine";
  readonly season: number;
  readonly document: StagingGameDocumentV2;
  readonly findings: readonly StoredFinding[];
}

export class StagingWorkspace {
  private readonly currentStorage: WorkspaceCurrentStore;
  private readonly originalStorage: WorkspaceOriginalStore;
  private readonly journals: WorkspaceJournalStore;
  public readonly analysisModelJobs: AnalysisModelJobWorkspace;
  public readonly collection: CollectionWorkspace;
  public readonly imports: ImportWorkspace;
  public readonly pitchReferences: PitchReferenceWorkspace;
  public readonly analysisCoverage: AnalysisCoverageWorkspace;
  public readonly pitchCalibrations: PitchCalibrationWorkspace;
  public readonly runExpectancy: RunExpectancyWorkspace;
  public readonly pitchQuality: PitchQualityWorkspace;
  public readonly matchupModels: MatchupModelWorkspace;
  public readonly parkEnvironment: ParkEnvironmentWorkspace;
  public readonly competitionSources: CompetitionSourceWorkspace;
  private readonly currentTransitions = new Map<string, Promise<void>>();
  private readonly gameOperations = new Map<string, Promise<unknown>>();
  private readonly catalogIndex: WorkspaceCatalog;
  private readonly verifiedTargets = new Map<string, { manifest: string; target: ImportTarget }>();
  private readonly root: string;
  private readonly lockPath: string;
  private closed = false;

  private constructor(
    root: string,
    private readonly owner: WriterLockOwner,
    private readonly now: () => Date,
    private readonly compile: (document: StagingGameDocumentV2) => Promise<ReplayResult>,
  ) {
    this.root = path.resolve(root);
    this.originalStorage = new WorkspaceOriginalStore(this.root);
    this.journals = new WorkspaceJournalStore(this.root, this.now);
    this.currentStorage = new WorkspaceCurrentStore(
      this.root,
      this.now,
      () => this.verifyLock(),
      (current) => this.readCurrentFindings(current),
    );
    this.lockPath = path.join(this.root, ".writer.lock");
    this.analysisModelJobs = new AnalysisModelJobWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
    this.catalogIndex = new WorkspaceCatalog((gameId) => this.readCatalogItem(gameId));
    this.collection = new CollectionWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
    this.imports = new ImportWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
    this.pitchReferences = new PitchReferenceWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
    this.analysisCoverage = new AnalysisCoverageWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
    this.pitchCalibrations = new PitchCalibrationWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
    this.runExpectancy = new RunExpectancyWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
    this.pitchQuality = new PitchQualityWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
    this.matchupModels = new MatchupModelWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
    this.parkEnvironment = new ParkEnvironmentWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
    this.competitionSources = new CompetitionSourceWorkspace(this.root, async () => {
      this.assertOpen();
      await this.verifyLock();
    });
  }

  public static async open(
    root: string,
    now: () => Date = () => new Date(),
    compile: (document: StagingGameDocumentV2) => Promise<ReplayResult> = async (document) =>
      compileStagingGameDocumentV2(document),
  ): Promise<StagingWorkspace> {
    const resolved = path.resolve(root);
    await mkdir(resolved, { recursive: true });
    await access(resolved, fsConstants.R_OK | fsConstants.W_OK);
    const owner: WriterLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: now().toISOString(),
    };
    await acquireWriterLock(path.join(resolved, ".writer.lock"), owner);
    const workspace = new StagingWorkspace(resolved, owner, now, compile);
    try {
      await workspace.initializeDirectories();
      await workspace.recoverTemporaryFiles();
      await workspace.currentStorage.recoverManifestUpgradeJournals();
      await workspace.currentStorage.recoverWorkspaceTransitions();
      await assertNoUnmigratedCurrentFiles(workspace.root);
      await workspace.recoverCorrectionJournals();
      await workspace.assertWorkspaceIntegrity();
      return workspace;
    } catch (error: unknown) {
      await workspace.close();
      throw error;
    }
  }

  public async saveReady(
    document: StagingGameDocumentV2,
    findings: readonly StoredFinding[],
    expectedToken?: string | null,
  ): Promise<void> {
    const parsed = parseStagingGameDocumentV2(document);
    const storedFindings = parseStoredFindings(findings);
    const compiled = await this.compile(parsed);
    if (
      storedFindings.some((finding) => finding.severity === "blocking") ||
      compiled.findings.some((finding) => finding.severity === "blocking")
    ) {
      throw new Error("staging에는 차단 finding이 있는 문서를 저장할 수 없습니다.");
    }
    await this.saveOriginalIfAbsent(parsed, storedFindings);
    await this.transitionDocument("staging", parsed, storedFindings, false, expectedToken);
  }

  public async saveQuarantine(
    document: StagingGameDocumentV2,
    findings: readonly StoredFinding[],
    expectedToken?: string | null,
  ): Promise<void> {
    const parsed = parseStagingGameDocumentV2(document);
    const storedFindings = parseStoredFindings(findings);
    const compiled = await this.compile(parsed);
    if (
      !storedFindings.some((finding) => finding.severity === "blocking") &&
      !compiled.findings.some((finding) => finding.severity === "blocking")
    ) {
      throw new Error("quarantine에는 차단 finding이 최소 하나 필요합니다.");
    }
    await this.saveOriginalIfAbsent(parsed, storedFindings);
    await this.transitionDocument("quarantine", parsed, storedFindings, false, expectedToken);
  }

  /** Compile once before publishing a reopened sealed revision as a correction draft. */
  public async saveCorrectionDraft(document: StagingGameDocumentV2): Promise<void> {
    const parsed = parseStagingGameDocumentV2(document);
    const compiled = await this.compile(parsed);
    const findings = parseStoredFindings(
      compiled.findings.map((finding) => ({
        producer: "compiler",
        lifecycle: "recomputed",
        code: finding.code,
        category: finding.category,
        severity: finding.severity,
        message: finding.message,
        ...(finding.eventId === undefined ? {} : { eventId: finding.eventId }),
        ...(finding.eventSequence === undefined ? {} : { eventSequence: finding.eventSequence }),
        ...(finding.recordIdentity === undefined ? {} : { recordIdentity: finding.recordIdentity }),
        ...(finding.details.length === 0 ? {} : { details: finding.details }),
      })),
    );
    const authority = findings.some((finding) => finding.severity === "blocking")
      ? "quarantine"
      : "staging";
    await this.saveOriginalIfAbsent(parsed, findings);
    await this.transitionDocument(authority, parsed, findings);
  }

  /** Resume a saved correction without replacing its edits, findings or sealed base. */
  public async ensureCorrectionDraft(
    document: StagingGameDocumentV2,
    findings: readonly StoredFinding[],
  ): Promise<CurrentDocumentSnapshot> {
    const existing = await this.readCurrentDocumentSnapshot(document.metadata.gameId);
    if (existing !== null) return existing;
    const parsed = parseStagingGameDocumentV2(document);
    const storedFindings = parseStoredFindings(findings);
    const compiled = await this.compile(parsed);
    const authority = [...storedFindings, ...compiled.findings].some(
      (finding) => finding.severity === "blocking",
    )
      ? "quarantine"
      : "staging";
    await this.saveOriginalIfAbsent(parsed, storedFindings);
    await this.transitionDocument(authority, parsed, storedFindings, true);
    const current = await this.readCurrentDocumentSnapshot(parsed.metadata.gameId);
    if (current === null)
      throw new StaleStagingDocumentError("교정 초안을 여는 동안 current 원장이 변경되었습니다.");
    return current;
  }

  public async saveSourceFailure(
    gameId: string,
    findings: readonly StoredFinding[],
    season: number | null = null,
    expectedToken?: string | null,
  ): Promise<void> {
    this.assertOpen();
    assertGameId(gameId);
    if (season !== null) assertSeason(season);
    await this.verifyLock();
    const previous = await this.currentStorage.readCurrentEntry(gameId);
    this.assertCollectionToken(previous, expectedToken);
    const generation = await this.currentStorage.nextGeneration(gameId, previous);
    const record = parseSourceFailureRecord({
      gameId,
      season,
      recordedAt: this.now().toISOString(),
      findingEnvelope: findingEnvelope(findings),
    });
    const canonical = canonicalStringify(record);
    const contentHash = sha256(canonical);
    const artifactPath = this.currentStorage.activeArtifactPath(
      gameId,
      `${String(generation)}-${contentHash}.failure.json`,
    );
    await atomicWrite(this.currentStorage.absoluteArtifactPath(artifactPath), `${canonical}\n`);
    await this.transitionCurrent(previous, {
      schemaVersion: 2,
      gameId,
      season,
      authority: "source_failure",
      generation,
      updatedAt: record.recordedAt,
      artifactPath,
      contentHash,
      documentHash: null,
      displaySummary: null,
    });
  }

  public async saveSourceBundle(bundle: ImmutableSourceBundle): Promise<void> {
    this.assertOpen();
    assertGameId(bundle.gameId);
    assertSeason(bundle.season);
    await this.verifyLock();
    await saveImmutableSourceBundle(this.root, bundle);
  }

  public async readSourceBundle(
    season: number,
    gameId: string,
    sourceBundleHash: string,
  ): Promise<ImmutableSourceBundle> {
    this.assertOpen();
    return readImmutableSourceBundle(this.root, season, gameId, sourceBundleHash);
  }

  public async saveCollectionJobJournal(job: CollectionJob): Promise<void> {
    this.assertOpen();
    await this.verifyLock();
    await this.journals.saveCollectionJob(job);
  }

  public async removeCollectionJobJournal(jobId: string): Promise<void> {
    this.assertOpen();
    await this.verifyLock();
    await this.journals.removeCollectionJob(jobId);
  }

  public async recoverInterruptedCollectionJobs(): Promise<readonly CollectionJob[]> {
    this.assertOpen();
    await this.verifyLock();
    return this.journals.recoverInterruptedCollectionJobs();
  }

  public async catalog(gameIds?: readonly string[]): Promise<GameCatalog> {
    this.assertOpen();
    return this.catalogIndex.snapshot(gameIds);
  }

  public async correctionGameCatalog(): Promise<CorrectionGameCatalog> {
    this.assertOpen();
    const games = (await this.catalog()).games.flatMap((game) =>
      (game.authority === "staging" || game.authority === "quarantine") && game.season !== null
        ? [
            {
              gameId: game.gameId,
              season: game.season,
              authority: game.authority,
              updatedAt: game.updatedAt,
              gameDate: game.gameDate,
              teams: game.teams,
            },
          ]
        : [],
    );
    games.sort(
      (left, right) =>
        Number(right.authority === "quarantine") - Number(left.authority === "quarantine") ||
        compareCanonicalStrings(right.updatedAt, left.updatedAt) ||
        compareCanonicalStrings(left.gameId, right.gameId),
    );
    return { games };
  }

  public async readCurrentDocumentSnapshot(
    gameId: string,
  ): Promise<CurrentDocumentSnapshot | null> {
    this.assertOpen();
    assertGameId(gameId);
    const current = await this.currentStorage.readCurrentEntry(gameId);
    if (current === null || current.authority === "source_failure") return null;
    if (current.season === null) {
      throw new Error(`원장 current manifest에 season이 없습니다: ${gameId}`);
    }
    const document = await this.readCurrentDocument(current);
    const findings = await this.readDocumentFindings(current, document);
    return {
      authority: current.authority === "ready" ? "staging" : "quarantine",
      season: current.season,
      document,
      findings,
    };
  }

  public async readDocument(
    authority: "staging" | "quarantine",
    season: number,
    gameId: string,
  ): Promise<StagingGameDocumentV2> {
    this.assertOpen();
    const current = await this.currentStorage.requiredCurrentEntry(gameId);
    if (current.authority !== currentDocumentAuthority(authority) || current.season !== season) {
      throw new Error(`요청한 current 원장 권위가 다릅니다: ${gameId}`);
    }
    if (current.documentHash === null) {
      throw new Error(`source failure에는 원장 문서가 없습니다: ${gameId}`);
    }
    const document = await this.readCurrentDocument(current);
    await this.readDocumentFindings(current, document);
    return document;
  }

  /** Capture target identities from live manifests; import still verifies the complete document. */
  public async readImportTargets(gameIds: readonly string[]): Promise<ImportTarget[]> {
    this.assertOpen();
    const targets: ImportTarget[] = [];
    for (let offset = 0; offset < gameIds.length; offset += 16) {
      const results = await Promise.allSettled(
        gameIds.slice(offset, offset + 16).map(async (gameId) => {
          assertGameId(gameId);
          await this.currentTransitions.get(gameId)?.catch(() => undefined);
          const current = await this.currentStorage.requiredCurrentEntry(gameId);
          if (current.authority !== "ready" || current.season === null) {
            throw new StaleStagingDocumentError(
              `대상 확정 중 적재 가능 상태가 변경되었습니다: ${gameId}`,
            );
          }
          let verified = this.verifiedTargets.get(gameId);
          const manifest = canonicalStringify(current);
          if (verified?.manifest !== manifest) {
            await this.readCurrentFindings(current);
            verified = this.verifiedTargets.get(gameId);
          }
          if (verified?.manifest !== manifest) {
            throw new StaleStagingDocumentError(`대상 확정 중 문서가 변경되었습니다: ${gameId}`);
          }
          return { ...verified.target };
        }),
      );
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        targets.push(result.value);
      }
    }
    return targets;
  }

  public async readFindings(
    authority: "staging" | "quarantine",
    season: number,
    gameId: string,
  ): Promise<readonly StoredFinding[]> {
    this.assertOpen();
    const current = await this.currentStorage.requiredCurrentEntry(gameId);
    if (current.authority !== currentDocumentAuthority(authority) || current.season !== season) {
      throw new Error(`요청한 current finding 권위가 다릅니다: ${gameId}`);
    }
    return this.readCurrentFindings(current);
  }

  public async readSupersededSnapshot(
    gameId: string,
    snapshotId: string,
  ): Promise<SupersededDocumentSnapshot> {
    this.assertOpen();
    assertGameId(gameId);
    const expectedContentHash = snapshotContentHash(snapshotId);
    const documentPath = this.currentStorage.supersededArtifactPath(gameId, snapshotId);
    const document = parseStagingGameDocumentV2(
      JSON.parse(await readFile(documentPath, "utf8")) as unknown,
    );
    if (document.metadata.gameId !== gameId) {
      throw new Error(`superseded snapshot이 다른 경기를 가리킵니다: ${gameId}`);
    }
    const findingsPath = documentPath.replace(/\.document\.json$/, ".findings.json");
    const envelope = await readFindingEnvelope(findingsPath);
    const actualContentHash = sha256(canonicalStringify({ document, findingEnvelope: envelope }));
    if (actualContentHash !== expectedContentHash) {
      throw new Error(`superseded snapshot content hash 검증에 실패했습니다: ${snapshotId}`);
    }
    const current = await this.currentStorage.readCurrentEntry(gameId);
    if (current !== null) await this.readCurrentFindings(current);
    return {
      snapshotId,
      document,
      findings: envelope.findings,
      currentContentHash: current?.contentHash ?? null,
    };
  }

  public async readOriginal(season: number, gameId: string): Promise<StagingGameDocumentV2> {
    this.assertOpen();
    return this.originalStorage.readDocument(season, gameId);
  }

  public async removeImportedStaging(
    season: number,
    gameId: string,
    expectedDocumentHash: string,
  ): Promise<void> {
    this.assertOpen();
    assertSeason(season);
    assertGameId(gameId);
    await this.verifyLock();
    const document = await this.readDocument("staging", season, gameId);
    const actualHash = stagingDocumentHash(document);
    if (actualHash !== expectedDocumentHash) {
      throw new StaleStagingDocumentError(
        `적재 후 staging 정리 중 문서 hash가 변경되었습니다: expected=${expectedDocumentHash}, actual=${actualHash}`,
      );
    }
    const current = await this.currentStorage.requiredCurrentEntry(gameId);
    if (current.authority !== "ready" || current.season !== season) {
      throw new StaleStagingDocumentError(`현재 staging 권위가 아닙니다: ${gameId}`);
    }
    await this.transitionCurrent(current, null);
  }

  public async readOriginalFindings(
    season: number,
    gameId: string,
  ): Promise<readonly StoredFinding[]> {
    this.assertOpen();
    return this.originalStorage.readFindings(season, gameId);
  }

  public async commitCorrection(
    input: StagingCorrectionCommit,
    failurePoint?: "after_journal" | "after_current",
  ): Promise<"staging" | "quarantine"> {
    this.assertOpen();
    await this.verifyLock();
    const parsedInput = parseStagingCorrectionCommit(input);
    let snapshot: SupersededDocumentSnapshot | null = null;
    let current: StagingGameDocumentV2;
    let currentFindings: readonly StoredFinding[];
    if (parsedInput.baseAuthority === "superseded") {
      snapshot = await this.readSupersededSnapshot(
        parsedInput.document.metadata.gameId,
        parsedInput.baseSnapshotId,
      );
      current = snapshot.document;
      currentFindings = snapshot.findings;
    } else {
      current = await this.readDocument(
        parsedInput.baseAuthority,
        parsedInput.document.metadata.season,
        parsedInput.document.metadata.gameId,
      );
      currentFindings = await this.readFindings(
        parsedInput.baseAuthority,
        parsedInput.document.metadata.season,
        parsedInput.document.metadata.gameId,
      );
    }
    const currentHash = stagingDocumentHash(current);
    if (currentHash !== parsedInput.baseDocumentHash) {
      throw new StaleStagingDocumentError(
        `stale staging hash: expected=${parsedInput.baseDocumentHash}, current=${currentHash}`,
      );
    }
    if (
      parsedInput.baseAuthority === "superseded" &&
      snapshot?.currentContentHash !== parsedInput.baseCurrentContentHash
    ) {
      throw new StaleStagingDocumentError(
        `superseded 복구 중 current 권위가 변경되었습니다: ${parsedInput.document.metadata.gameId}`,
      );
    }
    await this.saveOriginalIfAbsent(current, currentFindings);
    return this.journals.commitCorrection(
      parsedInput,
      current,
      (journal) => this.rollForwardCorrection(journal),
      failurePoint,
    );
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const current = await readWriterLock(this.lockPath);
      if (current?.token === this.owner.token) await unlink(this.lockPath);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
  }

  private async transitionDocument(
    authority: "staging" | "quarantine",
    document: StagingGameDocumentV2,
    findings: readonly StoredFinding[],
    preserveCurrentDocument = false,
    expectedToken?: string | null,
  ): Promise<void> {
    this.assertOpen();
    assertSeason(document.metadata.season);
    assertGameId(document.metadata.gameId);
    await this.verifyLock();
    const previous = await this.currentStorage.readCurrentEntry(document.metadata.gameId);
    this.assertCollectionToken(previous, expectedToken);
    if (preserveCurrentDocument && previous !== null && previous.authority !== "source_failure")
      return;
    const documentHash = stagingDocumentHash(document);
    const envelope = findingEnvelope(findings);
    const contentHash = sha256(canonicalStringify({ document, findingEnvelope: envelope }));
    if (
      previous?.authority === currentDocumentAuthority(authority) &&
      previous.documentHash === documentHash &&
      previous.contentHash === contentHash
    ) {
      return;
    }
    const reusable = await this.reusableActiveDocument(document.metadata.gameId, contentHash);
    const generation =
      reusable?.generation ??
      (await this.currentStorage.nextGeneration(document.metadata.gameId, previous));
    const artifactPath =
      reusable?.artifactPath ??
      this.currentStorage.activeArtifactPath(
        document.metadata.gameId,
        `${String(generation)}-${contentHash}.document.json`,
      );
    if (reusable === null) {
      await atomicWrite(
        this.currentStorage.absoluteArtifactPath(artifactPath),
        `${canonicalStringify(document)}\n`,
      );
      const findingsPath = this.currentStorage.findingsArtifactPath(artifactPath);
      if (findings.length === 0) {
        await removeIfPresent(findingsPath);
      } else {
        await atomicWrite(findingsPath, `${canonicalStringify(envelope)}\n`);
      }
    }
    await this.transitionCurrent(previous, {
      schemaVersion: 2,
      gameId: document.metadata.gameId,
      season: document.metadata.season,
      authority: currentDocumentAuthority(authority),
      generation,
      updatedAt: this.now().toISOString(),
      artifactPath,
      contentHash,
      documentHash,
      displaySummary: workspaceDisplaySummary(document),
    });
  }

  private async initializeDirectories(): Promise<void> {
    for (const directory of [
      "staging",
      "quarantine",
      "original",
      "source",
      "active",
      "current",
      "superseded",
      path.join("quarantine", "source-failures"),
      "journals",
      "exports",
      "logs",
    ]) {
      await mkdir(path.join(this.root, directory), { recursive: true });
    }
  }

  private async recoverTemporaryFiles(): Promise<void> {
    for (const directory of [
      path.join(this.root, "staging"),
      path.join(this.root, "quarantine"),
      path.join(this.root, "original"),
      path.join(this.root, "source"),
      path.join(this.root, "active"),
      path.join(this.root, "current"),
      path.join(this.root, "superseded"),
      path.join(this.root, "quarantine", "source-failures"),
    ]) {
      await removeTemporaryFiles(directory);
    }
  }

  private async recoverCorrectionJournals(): Promise<void> {
    await this.journals.recoverCorrections(async (journal) => {
      await this.saveOriginalIfAbsent(journal.beforeDocument, []);
      await this.rollForwardCorrection(journal);
    });
  }

  private async readCurrentDocument(
    current: CurrentWorkspaceEntry,
  ): Promise<StagingGameDocumentV2> {
    return readVerifiedDocument(this.root, current);
  }

  private async readCurrentFindings(
    current: CurrentWorkspaceEntry,
  ): Promise<readonly StoredFinding[]> {
    if (current.authority === "source_failure") {
      const record = parseSourceFailureRecord(
        JSON.parse(
          await readFile(this.currentStorage.absoluteArtifactPath(current.artifactPath), "utf8"),
        ) as unknown,
      );
      if (
        record.gameId !== current.gameId ||
        record.season !== current.season ||
        sha256(canonicalStringify(record)) !== current.contentHash
      ) {
        throw new Error(
          `current source failure artifact 무결성 검증에 실패했습니다: ${current.gameId}`,
        );
      }
      return record.findingEnvelope.findings;
    }
    const document = await this.readCurrentDocument(current);
    return this.readDocumentFindings(current, document);
  }

  private async readCatalogFindings(
    current: CurrentWorkspaceEntry,
  ): Promise<readonly StoredFinding[]> {
    if (current.authority === "source_failure") return this.readCurrentFindings(current);
    return readFindings(this.currentStorage.findingsArtifactPath(current.artifactPath));
  }

  private async readCatalogItem(gameId: string): Promise<GameCatalogItem | null> {
    await this.currentTransitions.get(gameId)?.catch(() => undefined);
    const current = await this.currentStorage.readCurrentEntry(gameId);
    if (current === null) return null;
    const [findings, supersededCount] = await Promise.all([
      this.readCatalogFindings(current),
      this.currentStorage.supersededCount(gameId),
    ]);
    return workspaceCatalogItem(current, findings, supersededCount);
  }

  private async readDocumentFindings(
    current: CurrentWorkspaceEntry,
    document: StagingGameDocumentV2,
  ): Promise<readonly StoredFinding[]> {
    const findings = await readVerifiedFindings(this.root, current, document);
    this.verifiedTargets.set(current.gameId, {
      manifest: canonicalStringify(current),
      target: verifiedImportTarget(current, document),
    });
    return findings;
  }

  private async transitionCurrent(
    previous: CurrentWorkspaceEntry | null,
    target: CurrentWorkspaceEntry | null,
  ): Promise<void> {
    const gameId = target?.gameId ?? previous?.gameId;
    if (gameId === undefined) throw new Error("빈 workspace transition은 허용되지 않습니다.");
    const pending = this.currentTransitions.get(gameId) ?? Promise.resolve();
    const next = pending
      .catch(() => undefined)
      .then(() => this.currentStorage.performCurrentTransition(previous, target));
    this.currentTransitions.set(gameId, next);
    this.catalogIndex.invalidate(gameId);
    try {
      await next;
    } finally {
      // A failed transition can still have committed its current pointer before archive cleanup.
      this.catalogIndex.invalidate(gameId);
      if (target === null || target.authority === "source_failure")
        this.verifiedTargets.delete(gameId);
      if (this.currentTransitions.get(gameId) === next) this.currentTransitions.delete(gameId);
    }
  }

  public async collectionToken(gameId: string): Promise<string | null> {
    this.assertOpen();
    assertGameId(gameId);
    const current = await this.currentStorage.readCurrentEntry(gameId);
    return current === null ? null : sha256(canonicalStringify(current));
  }

  /** Serialize the file/DB boundary with imports; source HTTP requests stay outside this gate. */
  public async withGameOperation<T>(gameId: string, operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    assertGameId(gameId);
    const previous = this.gameOperations.get(gameId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.gameOperations.set(gameId, next);
    try {
      return await next;
    } finally {
      if (this.gameOperations.get(gameId) === next) this.gameOperations.delete(gameId);
    }
  }

  private assertCollectionToken(
    current: CurrentWorkspaceEntry | null,
    expected: string | null | undefined,
  ): void {
    if (
      expected !== undefined &&
      (current === null ? null : sha256(canonicalStringify(current))) !== expected
    )
      throw new StaleStagingDocumentError("수집 중 현재 작업본이 변경되어 저장을 건너뜁니다.");
  }

  private async assertWorkspaceIntegrity(): Promise<void> {
    await assertWorkspaceIntegrity(
      this.root,
      this.currentStorage,
      (current, result, supersededCount) => {
        this.catalogIndex.seed({
          ...workspaceCatalogItem(current, [], supersededCount),
          blockingFindings: result.blockingFindings,
          warningFindings: result.warningFindings,
        });
        if (result.target !== null)
          this.verifiedTargets.set(current.gameId, {
            manifest: canonicalStringify(current),
            target: result.target,
          });
      },
    );
  }

  private async reusableActiveDocument(
    gameId: string,
    contentHash: string,
  ): Promise<{ readonly generation: number; readonly artifactPath: string } | null> {
    const matches = (await readDirectoryIfPresent(path.join(this.root, "active", gameId)))
      .filter((entry) => entry.isFile() && entry.name.endsWith(`-${contentHash}.document.json`))
      .sort((left, right) => compareCanonicalStrings(left.name, right.name));
    if (matches.length === 0) return null;
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new WorkspacePersistenceBlockedError(
        `동일 content hash의 active 원장 artifact가 중복되었습니다: ${gameId}`,
      );
    }
    const generationText = matches[0].name.split("-", 1)[0];
    const generation = Number(generationText);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new WorkspacePersistenceBlockedError(
        `active 원장 generation이 올바르지 않습니다: ${matches[0].name}`,
      );
    }
    const artifactPath = this.currentStorage.activeArtifactPath(gameId, matches[0].name);
    const storedDocument = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile(this.currentStorage.absoluteArtifactPath(artifactPath), "utf8"),
      ) as unknown,
    );
    const storedEnvelope = await readFindingEnvelope(
      this.currentStorage.findingsArtifactPath(artifactPath),
    );
    if (
      storedDocument.metadata.gameId !== gameId ||
      sha256(canonicalStringify({ document: storedDocument, findingEnvelope: storedEnvelope })) !==
        contentHash
    ) {
      throw new WorkspacePersistenceBlockedError(
        `재사용할 active 원장 artifact 무결성 검증에 실패했습니다: ${artifactPath}`,
      );
    }
    return { generation, artifactPath };
  }

  private async saveOriginalIfAbsent(
    document: StagingGameDocumentV2,
    findings: readonly StoredFinding[],
  ): Promise<void> {
    this.assertOpen();
    assertSeason(document.metadata.season);
    assertGameId(document.metadata.gameId);
    await this.verifyLock();
    await this.originalStorage.saveIfAbsent(document, findings);
  }

  private async rollForwardCorrection(journal: CorrectionJournal): Promise<void> {
    if (journal.targetAuthority === "staging") {
      await this.saveReady(journal.document, journal.findingEnvelope.findings);
    } else {
      await this.saveQuarantine(journal.document, journal.findingEnvelope.findings);
    }
  }

  private async verifyLock(): Promise<void> {
    const current = await readWriterLock(this.lockPath);
    if (current?.token !== this.owner.token) {
      throw new Error("Workspace writer lock 소유권을 잃었습니다.");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("닫힌 workspace는 사용할 수 없습니다.");
  }
}

function workspaceDisplaySummary(document: StagingGameDocumentV2) {
  return {
    gameDate: document.metadata.gameDate,
    teams: {
      away: { teamId: document.teams.away.teamId, name: document.teams.away.name },
      home: { teamId: document.teams.home.teamId, name: document.teams.home.name },
    },
  };
}

function currentDocumentAuthority(authority: "staging" | "quarantine"): "ready" | "quarantine" {
  return authority === "staging" ? "ready" : "quarantine";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
