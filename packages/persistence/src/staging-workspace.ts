import { AnalysisCoverageWorkspace } from "./analysis-coverage-workspace.js";
import { readImmutableSourceBundle } from "./source-bundle-reader.js";
import { AnalysisModelJobWorkspace } from "./analysis-model-job-workspace.js";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

import {
  canonicalStringify,
  compareCanonicalStrings,
  type CollectionJob,
  type CorrectionGameCatalog,
  type CorrectionJournal,
  type CurrentWorkspaceEntry,
  type GameCatalog,
  type GameCatalogItem,
  type ImportTarget,
  type SourceBundleManifest,
  type StagingCorrectionCommit,
  type StagingGameDocumentV2,
  type StoredFinding,
  type StoredFindingEnvelopeV2,
  type WriterLockOwner,
  type WorkspaceTransitionJournal,
  type WorkspaceManifestUpgradeJournal,
  parseCurrentWorkspaceEntry,
  parseCorrectionJournal,
  parseSourceBundleManifest,
  parseSourceFailureRecord,
  parseStagingCorrectionCommit,
  parseStagingGameDocumentV2,
  parseCollectionJob,
  parseStoredFindings,
  parseStoredFindingEnvelopeV2,
  parseWorkspaceTransitionJournal,
  parseWorkspaceManifestUpgradeJournal,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";

import {
  acquireWriterLock,
  atomicWrite,
  isMissing,
  readDirectoryIfPresent,
  readWriterLock,
  removeTemporaryFiles,
} from "./workspace-files.js";
import { assertGameId, assertJobId, assertSeason, isGameId } from "./workspace-path-policy.js";
import { CollectionWorkspace } from "./collection-workspace.js";
import { ImportWorkspace } from "./import-workspace.js";
import { PitchReferenceWorkspace } from "./pitch-reference-workspace.js";
import { PitchCalibrationWorkspace } from "./pitch-calibration-workspace.js";
import { RunExpectancyWorkspace } from "./run-expectancy-workspace.js";
import { PitchQualityWorkspace } from "./pitch-quality-workspace.js";
import { MatchupModelWorkspace } from "./matchup-model-workspace.js";
import { ParkEnvironmentWorkspace } from "./park-environment-workspace.js";
import { CompetitionSourceWorkspace } from "./competition-source-workspace.js";
import { WorkspaceCatalog, workspaceCatalogItem } from "./workspace-catalog.js";
import { WorkspaceValidationPool } from "./workspace-validation-pool.js";
import {
  readVerifiedDocument,
  readVerifiedFindings,
  verifiedImportTarget,
} from "./workspace-validation.js";

export interface ImmutableSourceBundle {
  readonly gameId: string;
  readonly season: number;
  readonly collectedAt: string;
  readonly sourceBundleHash: string;
  readonly payloads: Readonly<Record<string, unknown>>;
  readonly missingEndpoints: readonly string[];
}

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

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class StaleStagingDocumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StaleStagingDocumentError";
  }
}

export class WorkspaceMigrationRequiredError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspaceMigrationRequiredError";
  }
}

export class WorkspacePersistenceBlockedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspacePersistenceBlockedError";
  }
}

export class StagingWorkspace {
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
  ) {
    this.root = path.resolve(root);
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
    const workspace = new StagingWorkspace(resolved, owner, now);
    try {
      await workspace.initializeDirectories();
      await workspace.recoverTemporaryFiles();
      await workspace.recoverManifestUpgradeJournals();
      await workspace.recoverWorkspaceTransitions();
      await workspace.assertNoUnmigratedCurrentFiles();
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
    const compiled = compileStagingGameDocumentV2(parsed);
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
    const compiled = compileStagingGameDocumentV2(parsed);
    if (
      !storedFindings.some((finding) => finding.severity === "blocking") &&
      !compiled.findings.some((finding) => finding.severity === "blocking")
    ) {
      throw new Error("quarantine에는 차단 finding이 최소 하나 필요합니다.");
    }
    await this.saveOriginalIfAbsent(parsed, storedFindings);
    await this.transitionDocument("quarantine", parsed, storedFindings, false, expectedToken);
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
    const compiled = compileStagingGameDocumentV2(parsed);
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
    const previous = await this.readCurrentEntry(gameId);
    this.assertCollectionToken(previous, expectedToken);
    const generation = await this.nextGeneration(gameId, previous);
    const record = parseSourceFailureRecord({
      gameId,
      season,
      recordedAt: this.now().toISOString(),
      findingEnvelope: findingEnvelope(findings),
    });
    const canonical = canonicalStringify(record);
    const contentHash = sha256(canonical);
    const artifactPath = this.activeArtifactPath(
      gameId,
      `${String(generation)}-${contentHash}.failure.json`,
    );
    await atomicWrite(this.absoluteArtifactPath(artifactPath), `${canonical}\n`);
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
    const calculated = createHash("sha256")
      .update(
        canonicalStringify({
          gameId: bundle.gameId,
          missingEndpoints: [...bundle.missingEndpoints].sort(compareText),
          payloads: bundle.payloads,
        }),
        "utf8",
      )
      .digest("hex");
    if (calculated !== bundle.sourceBundleHash) {
      throw new Error(`source bundle hash가 mapper 결과와 다릅니다: ${bundle.gameId}`);
    }
    const directory = path.join(
      this.root,
      "source",
      String(bundle.season),
      bundle.gameId,
      bundle.sourceBundleHash,
    );
    await mkdir(directory, { recursive: true });
    const endpoints: Array<{ readonly name: string; readonly hash: string }> = [];
    for (const [name, payload] of Object.entries(bundle.payloads).sort(([left], [right]) =>
      compareText(left, right),
    )) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) {
        throw new Error(`source endpoint 이름이 올바르지 않습니다: ${name}`);
      }
      const canonical = canonicalStringify(payload);
      const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
      endpoints.push({ name, hash });
      const target = path.join(directory, `${name}.json.gz`);
      try {
        const existing = await readFile(target);
        const existingCanonical = (await gunzipAsync(existing)).toString("utf8");
        if (existingCanonical !== canonical)
          throw new Error(`immutable source가 다릅니다: ${target}`);
      } catch (error: unknown) {
        if (!isMissing(error)) throw error;
        await atomicWrite(target, await gzipAsync(Buffer.from(canonical, "utf8"), { level: 9 }));
      }
    }
    const manifest: SourceBundleManifest = {
      gameId: bundle.gameId,
      season: bundle.season,
      collectedAt: new Date(bundle.collectedAt).toISOString(),
      sourceBundleHash: bundle.sourceBundleHash,
      missingEndpoints: [...bundle.missingEndpoints].sort(compareText),
      endpoints,
    };
    const manifestPath = path.join(directory, "manifest.json");
    try {
      const existing = await readFile(manifestPath, "utf8");
      const parsed = parseSourceBundleManifest(JSON.parse(existing) as unknown);
      if (
        existing !== `${canonicalStringify({ ...manifest, collectedAt: parsed.collectedAt })}\n`
      ) {
        throw new Error(`immutable source manifest가 다릅니다: ${bundle.gameId}`);
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      await atomicWrite(manifestPath, `${canonicalStringify(manifest)}\n`);
    }
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
    await atomicWrite(this.collectionJobJournalPath(job.jobId), `${canonicalStringify(job)}\n`);
  }

  public async removeCollectionJobJournal(jobId: string): Promise<void> {
    this.assertOpen();
    await this.verifyLock();
    await this.removeIfPresent(this.collectionJobJournalPath(jobId));
  }

  public async recoverInterruptedCollectionJobs(): Promise<readonly CollectionJob[]> {
    this.assertOpen();
    await this.verifyLock();
    const directory = path.join(this.root, "journals");
    const recovered: CollectionJob[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith("collection-") || !entry.name.endsWith(".json"))
        continue;
      const journalPath = path.join(directory, entry.name);
      const job = parseCollectionJob(JSON.parse(await readFile(journalPath, "utf8")) as unknown);
      recovered.push({
        ...job,
        status: "failed",
        currentGameId: null,
        finishedAt: this.now().toISOString(),
        error: "API 재시작으로 수집 작업이 중단됐습니다.",
        errorCategory: "persistence",
      });
      await unlink(journalPath);
    }
    return recovered.sort((left, right) => compareText(right.createdAt, left.createdAt));
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
    const current = await this.readCurrentEntry(gameId);
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
    const current = await this.requiredCurrentEntry(gameId);
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
          const current = await this.requiredCurrentEntry(gameId);
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
    const current = await this.requiredCurrentEntry(gameId);
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
    const documentPath = this.supersededArtifactPath(gameId, snapshotId);
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
    const current = await this.readCurrentEntry(gameId);
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
    return parseStagingGameDocumentV2(
      JSON.parse(await readFile(this.originalDocumentPath(season, gameId), "utf8")) as unknown,
    );
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
    const current = await this.requiredCurrentEntry(gameId);
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
    return readFindings(this.originalFindingsPath(season, gameId));
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
    const createdAt = this.now().toISOString();
    const journalId = `${createdAt.replaceAll(":", "-")}-${parsedInput.baseDocumentHash.slice(0, 12)}`;
    const journal: CorrectionJournal = {
      ...parsedInput,
      journalId,
      beforeDocument: current,
      createdAt,
    };
    const journalPath = this.correctionJournalPath(parsedInput.document.metadata.gameId, journalId);
    await atomicWrite(journalPath, `${canonicalStringify(journal)}\n`);
    if (failurePoint === "after_journal")
      throw new Error("injected correction failure: after_journal");
    await this.rollForwardCorrection(journal);
    if (failurePoint === "after_current")
      throw new Error("injected correction failure: after_current");
    await unlink(journalPath);
    return parsedInput.targetAuthority;
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
    const previous = await this.readCurrentEntry(document.metadata.gameId);
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
      reusable?.generation ?? (await this.nextGeneration(document.metadata.gameId, previous));
    const artifactPath =
      reusable?.artifactPath ??
      this.activeArtifactPath(
        document.metadata.gameId,
        `${String(generation)}-${contentHash}.document.json`,
      );
    if (reusable === null) {
      await atomicWrite(
        this.absoluteArtifactPath(artifactPath),
        `${canonicalStringify(document)}\n`,
      );
      const findingsPath = this.findingsArtifactPath(artifactPath);
      if (findings.length === 0) {
        await this.removeIfPresent(findingsPath);
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
    const directory = path.join(this.root, "journals");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith("correction-") || !entry.name.endsWith(".json"))
        continue;
      const journalPath = path.join(directory, entry.name);
      const journal = parseCorrectionJournal(
        JSON.parse(await readFile(journalPath, "utf8")) as unknown,
      );
      await this.saveOriginalIfAbsent(journal.beforeDocument, []);
      await this.rollForwardCorrection(journal);
      await unlink(journalPath);
    }
  }

  private activeArtifactPath(gameId: string, fileName: string): string {
    assertGameId(gameId);
    if (!/^[A-Za-z0-9_.-]{1,300}$/.test(fileName)) {
      throw new Error("허용되지 않은 workspace artifact 이름입니다.");
    }
    return path.posix.join("active", gameId, fileName);
  }

  private absoluteArtifactPath(artifactPath: string): string {
    if (!/^active\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(artifactPath)) {
      throw new Error("허용되지 않은 workspace artifact 경로입니다.");
    }
    const absolute = path.resolve(this.root, ...artifactPath.split("/"));
    if (!absolute.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("workspace artifact가 root 밖을 가리킵니다.");
    }
    return absolute;
  }

  private findingsArtifactPath(artifactPath: string): string {
    if (!artifactPath.endsWith(".document.json")) {
      throw new Error("원장 artifact만 finding sidecar를 가질 수 있습니다.");
    }
    return this.absoluteArtifactPath(
      `${artifactPath.slice(0, -".document.json".length)}.findings.json`,
    );
  }

  private supersededArtifactPath(gameId: string, snapshotId: string): string {
    assertGameId(gameId);
    snapshotContentHash(snapshotId);
    const directory = path.resolve(this.root, "superseded", gameId);
    const absolute = path.resolve(directory, snapshotId);
    if (!absolute.startsWith(`${directory}${path.sep}`)) {
      throw new Error("superseded snapshot이 경기 디렉터리 밖을 가리킵니다.");
    }
    return absolute;
  }

  private currentEntryPath(gameId: string): string {
    assertGameId(gameId);
    return path.join(this.root, "current", `${gameId}.json`);
  }

  private transitionJournalPath(gameId: string, transitionId: string): string {
    assertGameId(gameId);
    if (!/^[A-Za-z0-9-]{1,200}$/.test(transitionId)) {
      throw new Error("허용되지 않은 workspace transition ID입니다.");
    }
    return path.join(this.root, "journals", `workspace-${gameId}-${transitionId}.json`);
  }

  private async readCurrentEntry(gameId: string): Promise<CurrentWorkspaceEntry | null> {
    assertGameId(gameId);
    try {
      const value = JSON.parse(await readFile(this.currentEntryPath(gameId), "utf8")) as unknown;
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "schemaVersion" in value &&
        value.schemaVersion === 1
      ) {
        throw new WorkspaceMigrationRequiredError(
          `current manifest V1이 남아 있습니다: ${gameId}. pnpm workspace:migrate -- --dry-run으로 먼저 검증하세요.`,
        );
      }
      const current = parseCurrentWorkspaceEntry(value);
      this.assertCurrentEntryContext(current, gameId);
      return current;
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async requiredCurrentEntry(gameId: string): Promise<CurrentWorkspaceEntry> {
    const current = await this.readCurrentEntry(gameId);
    if (current === null) throw new Error(`현재 workspace 권위가 없습니다: ${gameId}`);
    return current;
  }

  private assertCurrentEntryContext(current: CurrentWorkspaceEntry, gameId: string): void {
    if (current.gameId !== gameId) {
      throw new Error(`current manifest gameId가 파일 문맥과 다릅니다: ${gameId}`);
    }
    const segments = current.artifactPath.split("/");
    if (segments[1] !== gameId) {
      throw new Error(`current manifest artifact 경로가 다른 경기를 가리킵니다: ${gameId}`);
    }
    if (current.authority === "source_failure") {
      if (current.documentHash !== null || !current.artifactPath.endsWith(".failure.json")) {
        throw new Error(`source failure current manifest 형식이 올바르지 않습니다: ${gameId}`);
      }
    } else if (
      current.season === null ||
      current.documentHash === null ||
      !current.artifactPath.endsWith(".document.json")
    ) {
      throw new Error(`원장 current manifest 형식이 올바르지 않습니다: ${gameId}`);
    }
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
          await readFile(this.absoluteArtifactPath(current.artifactPath), "utf8"),
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
    return readFindings(this.findingsArtifactPath(current.artifactPath));
  }

  private async readCatalogItem(gameId: string): Promise<GameCatalogItem | null> {
    await this.currentTransitions.get(gameId)?.catch(() => undefined);
    const current = await this.readCurrentEntry(gameId);
    if (current === null) return null;
    const [findings, supersededCount] = await Promise.all([
      this.readCatalogFindings(current),
      this.supersededCount(gameId),
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
      .then(() => this.performCurrentTransition(previous, target));
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
    const current = await this.readCurrentEntry(gameId);
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

  private async performCurrentTransition(
    previous: CurrentWorkspaceEntry | null,
    target: CurrentWorkspaceEntry | null,
  ): Promise<void> {
    await this.verifyLock();
    const gameId = target?.gameId ?? previous?.gameId;
    if (gameId === undefined) throw new Error("빈 workspace transition은 허용되지 않습니다.");
    const actual = await this.readCurrentEntry(gameId);
    if (!sameCurrentEntry(actual, previous)) {
      throw new StaleStagingDocumentError(`workspace current manifest가 변경되었습니다: ${gameId}`);
    }
    if (target !== null) {
      this.assertCurrentEntryContext(target, gameId);
      await this.readCurrentFindings(target);
    }
    const transitionId = randomUUID();
    const journal: WorkspaceTransitionJournal = {
      schemaVersion: 1,
      transitionId,
      gameId,
      previous,
      target,
      createdAt: this.now().toISOString(),
    };
    const journalPath = this.transitionJournalPath(gameId, transitionId);
    await atomicWrite(journalPath, `${canonicalStringify(journal)}\n`);
    await this.rollForwardWorkspaceTransition(journal);
    await unlink(journalPath);
  }

  private async rollForwardWorkspaceTransition(journal: WorkspaceTransitionJournal): Promise<void> {
    this.assertWorkspaceTransitionContext(journal);
    if (journal.target !== null) await this.readCurrentFindings(journal.target);
    await this.writeCurrentEntry(journal.gameId, journal.target);
    if (
      journal.previous !== null &&
      journal.previous.artifactPath !== journal.target?.artifactPath
    ) {
      await this.archiveCurrentArtifact(journal.previous);
    }
  }

  private assertWorkspaceTransitionContext(journal: WorkspaceTransitionJournal): void {
    if (journal.previous === null && journal.target === null) {
      throw new Error("빈 workspace transition journal은 허용되지 않습니다.");
    }
    for (const entry of [journal.previous, journal.target]) {
      if (entry !== null) this.assertCurrentEntryContext(entry, journal.gameId);
    }
  }

  private async writeCurrentEntry(
    gameId: string,
    target: CurrentWorkspaceEntry | null,
  ): Promise<void> {
    if (target === null) {
      await this.removeIfPresent(this.currentEntryPath(gameId));
      await syncDirectory(path.join(this.root, "current"));
      return;
    }
    await atomicWrite(this.currentEntryPath(gameId), `${canonicalStringify(target)}\n`);
  }

  private async archiveCurrentArtifact(current: CurrentWorkspaceEntry): Promise<void> {
    const source = this.absoluteArtifactPath(current.artifactPath);
    const destinationDirectory = path.join(this.root, "superseded", current.gameId);
    await mkdir(destinationDirectory, { recursive: true });
    await moveArtifactForRecovery(source, path.join(destinationDirectory, path.basename(source)));
    if (current.authority !== "source_failure") {
      const findingsSource = this.findingsArtifactPath(current.artifactPath);
      const findingsDestination = path.join(destinationDirectory, path.basename(findingsSource));
      await moveOptionalArtifactForRecovery(findingsSource, findingsDestination);
    }
    await syncDirectory(path.dirname(source));
    await syncDirectory(destinationDirectory);
  }

  private async recoverWorkspaceTransitions(): Promise<void> {
    const directory = path.join(this.root, "journals");
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith("workspace-") && entry.name.endsWith(".json"),
      )
      .sort((left, right) => compareCanonicalStrings(left.name, right.name));
    for (const entry of entries) {
      const journalPath = path.join(directory, entry.name);
      const journal = parseWorkspaceTransitionJournal(
        JSON.parse(await readFile(journalPath, "utf8")) as unknown,
      );
      await this.rollForwardWorkspaceTransition(journal);
      await unlink(journalPath);
    }
  }

  private async recoverManifestUpgradeJournals(): Promise<void> {
    const directory = path.join(this.root, "journals");
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith("manifest-upgrade-") &&
          entry.name.endsWith(".json"),
      )
      .sort((left, right) => compareCanonicalStrings(left.name, right.name));
    for (const entry of entries) {
      const journalPath = path.join(directory, entry.name);
      const journal = parseWorkspaceManifestUpgradeJournal(
        JSON.parse(await readFile(journalPath, "utf8")) as unknown,
      );
      await this.rollForwardManifestUpgrade(journal);
      await unlink(journalPath);
    }
  }

  private async rollForwardManifestUpgrade(
    journal: WorkspaceManifestUpgradeJournal,
  ): Promise<void> {
    this.assertCurrentEntryContext(journal.target, journal.gameId);
    const raw = JSON.parse(
      await readFile(this.currentEntryPath(journal.gameId), "utf8"),
    ) as unknown;
    const canonical = canonicalStringify(raw);
    if (
      canonical !== canonicalStringify(journal.previous) &&
      canonical !== canonicalStringify(journal.target)
    ) {
      throw new WorkspacePersistenceBlockedError(
        `manifest upgrade 중 current가 변경되었습니다: ${journal.gameId}`,
      );
    }
    await this.readCurrentFindings(journal.target);
    await this.writeCurrentEntry(journal.gameId, journal.target);
  }

  private async supersededCount(gameId: string): Promise<number> {
    assertGameId(gameId);
    return (await readDirectoryIfPresent(path.join(this.root, "superseded", gameId))).filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".document.json") || entry.name.endsWith(".failure.json")),
    ).length;
  }

  private async nextGeneration(
    gameId: string,
    current: CurrentWorkspaceEntry | null,
  ): Promise<number> {
    let maximum = current?.generation ?? 0;
    for (const directory of ["active", "superseded"]) {
      for (const entry of await readDirectoryIfPresent(path.join(this.root, directory, gameId))) {
        if (!entry.isFile()) continue;
        const match = /^(\d+)-/.exec(entry.name);
        if (match?.[1] === undefined) continue;
        const generation = Number(match[1]);
        if (Number.isSafeInteger(generation)) maximum = Math.max(maximum, generation);
      }
    }
    return maximum + 1;
  }

  private async assertNoUnmigratedCurrentFiles(): Promise<void> {
    let legacyCount = 0;
    for (const authority of ["staging", "quarantine"] as const) {
      const root = path.join(this.root, authority);
      for (const entry of await readDirectoryIfPresent(root)) {
        if (!entry.isDirectory()) continue;
        if (authority === "quarantine" && entry.name === "source-failures") continue;
        for (const file of await readDirectoryIfPresent(path.join(root, entry.name))) {
          if (
            file.isFile() &&
            file.name.endsWith(".json") &&
            !file.name.endsWith(".findings.json")
          ) {
            legacyCount += 1;
          }
        }
      }
    }
    for (const file of await readDirectoryIfPresent(
      path.join(this.root, "quarantine", "source-failures"),
    )) {
      if (file.isFile() && file.name.endsWith(".json")) legacyCount += 1;
    }
    if (legacyCount > 0) {
      throw new WorkspaceMigrationRequiredError(
        `versioned current manifest가 없는 legacy current artifact ${String(legacyCount)}개가 있습니다. workspace:migrate를 먼저 실행하세요.`,
      );
    }
  }

  private async assertWorkspaceIntegrity(): Promise<void> {
    const referenced = new Set<string>();
    const files = (await readDirectoryIfPresent(path.join(this.root, "current")))
      .filter((file) => file.isFile() && file.name.endsWith(".json"))
      .sort((a, b) => compareCanonicalStrings(a.name, b.name));
    const validation = new WorkspaceValidationPool(files.length >= 64);
    const validate = async (file: (typeof files)[number]) => {
      const gameId = file.name.slice(0, -5);
      if (!isGameId(gameId)) {
        throw new WorkspacePersistenceBlockedError(
          `current manifest 파일 이름이 올바르지 않습니다: ${file.name}`,
        );
      }
      try {
        const current = await this.requiredCurrentEntry(gameId);
        const [result, supersededCount] = await Promise.all([
          validation.validate(this.root, current),
          this.supersededCount(gameId),
        ]);
        this.catalogIndex.seed({
          ...workspaceCatalogItem(current, [], supersededCount),
          blockingFindings: result.blockingFindings,
          warningFindings: result.warningFindings,
        });
        if (result.target !== null)
          this.verifiedTargets.set(gameId, {
            manifest: canonicalStringify(current),
            target: result.target,
          });
        referenced.add(current.artifactPath);
      } catch (error: unknown) {
        throw new WorkspacePersistenceBlockedError(
          `current manifest 무결성 검증에 실패했습니다: ${gameId}: ${errorMessage(error)}`,
        );
      }
    };
    try {
      for (let offset = 0; offset < files.length; offset += 16) {
        const results = await Promise.allSettled(files.slice(offset, offset + 16).map(validate));
        for (const result of results) if (result.status === "rejected") throw result.reason;
      }
    } finally {
      await validation.close();
    }
    for (const gameDirectory of await readDirectoryIfPresent(path.join(this.root, "active"))) {
      if (!gameDirectory.isDirectory() || !isGameId(gameDirectory.name)) continue;
      for (const artifact of await readDirectoryIfPresent(
        path.join(this.root, "active", gameDirectory.name),
      )) {
        if (
          !artifact.isFile() ||
          (!artifact.name.endsWith(".document.json") && !artifact.name.endsWith(".failure.json"))
        )
          continue;
        const artifactPath = path.posix.join("active", gameDirectory.name, artifact.name);
        if (!referenced.has(artifactPath)) {
          throw new WorkspacePersistenceBlockedError(
            `journal 없이 current가 아닌 active artifact가 발견되었습니다: ${artifactPath}`,
          );
        }
      }
    }
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
    const artifactPath = this.activeArtifactPath(gameId, matches[0].name);
    const storedDocument = parseStagingGameDocumentV2(
      JSON.parse(await readFile(this.absoluteArtifactPath(artifactPath), "utf8")) as unknown,
    );
    const storedEnvelope = await readFindingEnvelope(this.findingsArtifactPath(artifactPath));
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
    const target = this.originalDocumentPath(document.metadata.season, document.metadata.gameId);
    try {
      const existing = parseStagingGameDocumentV2(
        JSON.parse(await readFile(target, "utf8")) as unknown,
      );
      if (existing.metadata.gameId !== document.metadata.gameId) {
        throw new Error(`원본 gameId가 현재 경기와 다릅니다: ${document.metadata.gameId}`);
      }
      return;
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    const findingsTarget = this.originalFindingsPath(
      document.metadata.season,
      document.metadata.gameId,
    );
    if (findings.length === 0) {
      await this.removeIfPresent(findingsTarget);
    } else {
      await atomicWrite(findingsTarget, `${canonicalStringify(findingEnvelope(findings))}\n`);
    }
    await atomicWrite(target, `${canonicalStringify(document)}\n`);
    const stored = parseStagingGameDocumentV2(
      JSON.parse(await readFile(target, "utf8")) as unknown,
    );
    if (stagingDocumentHash(stored) !== stagingDocumentHash(document)) {
      throw new Error(`원본 문서 hash 검증에 실패했습니다: ${document.metadata.gameId}`);
    }
  }

  private async rollForwardCorrection(journal: CorrectionJournal): Promise<void> {
    if (journal.targetAuthority === "staging") {
      await this.saveReady(journal.document, journal.findingEnvelope.findings);
    } else {
      await this.saveQuarantine(journal.document, journal.findingEnvelope.findings);
    }
  }

  private originalDocumentPath(season: number, gameId: string): string {
    assertSeason(season);
    assertGameId(gameId);
    return path.join(this.root, "original", String(season), `${gameId}.json`);
  }

  private originalFindingsPath(season: number, gameId: string): string {
    assertSeason(season);
    assertGameId(gameId);
    return path.join(this.root, "original", String(season), `${gameId}.findings.json`);
  }

  private collectionJobJournalPath(jobId: string): string {
    assertJobId(jobId);
    return path.join(this.root, "journals", `collection-${jobId}.json`);
  }

  private correctionJournalPath(gameId: string, historyId: string): string {
    assertGameId(gameId);
    if (!/^[A-Za-z0-9_.+-]{1,200}$/.test(historyId)) {
      throw new Error("유효하지 않은 correction history ID입니다.");
    }
    return path.join(this.root, "journals", `correction-${gameId}-${historyId}.json`);
  }

  private async verifyLock(): Promise<void> {
    const current = await readWriterLock(this.lockPath);
    if (current?.token !== this.owner.token) {
      throw new Error("Workspace writer lock 소유권을 잃었습니다.");
    }
  }

  private async removeIfPresent(target: string): Promise<void> {
    try {
      await unlink(target);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("닫힌 workspace는 사용할 수 없습니다.");
  }
}

async function readFindings(target: string): Promise<readonly StoredFinding[]> {
  return (await readFindingEnvelope(target)).findings;
}

async function readFindingEnvelope(target: string): Promise<StoredFindingEnvelopeV2> {
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as unknown;
    return parseStoredFindingEnvelopeV2(value);
  } catch (error: unknown) {
    if (isMissing(error)) return findingEnvelope([]);
    throw error;
  }
}

function findingEnvelope(findings: readonly StoredFinding[]): StoredFindingEnvelopeV2 {
  return parseStoredFindingEnvelopeV2({ schemaVersion: 2, findings });
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function currentDocumentAuthority(authority: "staging" | "quarantine"): "ready" | "quarantine" {
  return authority === "staging" ? "ready" : "quarantine";
}

function sameCurrentEntry(
  left: CurrentWorkspaceEntry | null,
  right: CurrentWorkspaceEntry | null,
): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshotContentHash(snapshotId: string): string {
  const match = /^(\d+)-([0-9a-f]{64})\.document\.json$/.exec(snapshotId);
  if (match?.[2] === undefined) {
    throw new Error(`허용되지 않은 superseded snapshot ID입니다: ${snapshotId}`);
  }
  return match[2];
}

async function moveArtifactForRecovery(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    await access(destination, fsConstants.R_OK);
  }
}

async function moveOptionalArtifactForRecovery(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    try {
      await access(destination, fsConstants.R_OK);
    } catch (destinationError: unknown) {
      if (!isMissing(destinationError)) throw destinationError;
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows와 일부 파일시스템은 디렉터리 fsync를 지원하지 않는다.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
