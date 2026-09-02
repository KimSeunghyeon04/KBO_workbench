import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

import {
  canonicalStringify,
  type CollectionJob,
  type CorrectionJournal,
  type GameCatalog,
  type GameCatalogItem,
  type SourceBundleManifest,
  type SourceFailureRecord,
  type StagingCorrectionCommit,
  type StagingGameDocumentV2,
  type StoredFinding,
  type WriterLockOwner,
  parseCorrectionJournal,
  parseSourceBundleManifest,
  parseSourceFailureRecord,
  parseStagingGameDocumentV2,
  parseCollectionJob,
  parseStoredFindings,
} from "@kbo/contracts";
import { stagingDocumentHash } from "@kbo/game-core";

import {
  acquireWriterLock,
  atomicWrite,
  isMissing,
  readDirectoryIfPresent,
  readWriterLock,
  removeTemporaryFiles,
} from "./workspace-files.js";
import { assertGameId, assertJobId, assertSeason, isGameId } from "./workspace-path-policy.js";

export interface ImmutableSourceBundle {
  readonly gameId: string;
  readonly season: number;
  readonly collectedAt: string;
  readonly sourceBundleHash: string;
  readonly payloads: Readonly<Record<string, unknown>>;
  readonly missingEndpoints: readonly string[];
}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class StaleStagingDocumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StaleStagingDocumentError";
  }
}

export class StagingWorkspace {
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
    await workspace.initializeDirectories();
    await workspace.recoverTemporaryFiles();
    await workspace.recoverCorrectionJournals();
    return workspace;
  }

  public async saveReady(
    document: StagingGameDocumentV2,
    findings: readonly StoredFinding[],
  ): Promise<void> {
    await this.saveOriginalIfAbsent(document, findings);
    await this.saveDocument("staging", document, findings);
    await this.removeIfPresent(
      this.documentPath("quarantine", document.metadata.season, document.metadata.gameId),
    );
    await this.removeIfPresent(
      this.findingsPath("quarantine", document.metadata.season, document.metadata.gameId),
    );
    await this.removeIfPresent(this.sourceFailurePath(document.metadata.gameId));
  }

  public async saveQuarantine(
    document: StagingGameDocumentV2,
    findings: readonly StoredFinding[],
  ): Promise<void> {
    if (!findings.some((finding) => finding.severity === "blocking")) {
      throw new Error("quarantine에는 차단 finding이 최소 하나 필요합니다.");
    }
    await this.saveOriginalIfAbsent(document, findings);
    await this.saveDocument("quarantine", document, findings);
    await this.removeIfPresent(
      this.documentPath("staging", document.metadata.season, document.metadata.gameId),
    );
    await this.removeIfPresent(
      this.findingsPath("staging", document.metadata.season, document.metadata.gameId),
    );
    await this.removeIfPresent(this.sourceFailurePath(document.metadata.gameId));
  }

  public async saveSourceFailure(
    gameId: string,
    findings: readonly StoredFinding[],
  ): Promise<void> {
    this.assertOpen();
    assertGameId(gameId);
    await this.verifyLock();
    const record: SourceFailureRecord = {
      gameId,
      recordedAt: this.now().toISOString(),
      findings,
    };
    await atomicWrite(this.sourceFailurePath(gameId), `${canonicalStringify(record)}\n`);
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
        const incoming = await gzipAsync(Buffer.from(canonical, "utf8"), { level: 9 });
        if (!existing.equals(incoming)) throw new Error(`immutable source가 다릅니다: ${target}`);
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
    assertSeason(season);
    assertGameId(gameId);
    if (!/^[0-9a-f]{64}$/.test(sourceBundleHash)) {
      throw new Error("허용되지 않은 source bundle hash입니다.");
    }
    const directory = path.join(this.root, "source", String(season), gameId, sourceBundleHash);
    const manifestValue = JSON.parse(
      await readFile(path.join(directory, "manifest.json"), "utf8"),
    ) as unknown;
    const manifest = parseSourceBundleManifest(manifestValue);
    if (
      manifest.gameId !== gameId ||
      manifest.season !== season ||
      manifest.sourceBundleHash !== sourceBundleHash
    ) {
      throw new Error(`source bundle manifest 문맥이 다릅니다: ${gameId}`);
    }
    const payloads: Record<string, unknown> = {};
    for (const endpoint of manifest.endpoints) {
      const compressed = await readFile(path.join(directory, `${endpoint.name}.json.gz`));
      const canonical = (await gunzipAsync(compressed)).toString("utf8");
      const endpointHash = createHash("sha256").update(canonical, "utf8").digest("hex");
      if (endpointHash !== endpoint.hash) {
        throw new Error(`source endpoint hash가 다릅니다: ${gameId}/${endpoint.name}`);
      }
      const parsed = JSON.parse(canonical) as unknown;
      if (canonicalStringify(parsed) !== canonical) {
        throw new Error(`source endpoint가 canonical JSON이 아닙니다: ${gameId}/${endpoint.name}`);
      }
      payloads[endpoint.name] = parsed;
    }
    const calculated = createHash("sha256")
      .update(
        canonicalStringify({
          gameId,
          missingEndpoints: [...manifest.missingEndpoints].sort(compareText),
          payloads,
        }),
        "utf8",
      )
      .digest("hex");
    if (calculated !== sourceBundleHash) {
      throw new Error(`source bundle hash가 manifest와 다릅니다: ${gameId}`);
    }
    return {
      gameId,
      season,
      collectedAt: manifest.collectedAt,
      sourceBundleHash,
      payloads,
      missingEndpoints: manifest.missingEndpoints,
    };
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

  public async catalog(): Promise<GameCatalog> {
    this.assertOpen();
    const items = [
      ...(await this.documentCatalog("staging")),
      ...(await this.documentCatalog("quarantine")),
      ...(await this.sourceFailureCatalog()),
    ].sort(compareCatalogItems);
    return { games: items };
  }

  public async readDocument(
    authority: "staging" | "quarantine",
    season: number,
    gameId: string,
  ): Promise<StagingGameDocumentV2> {
    this.assertOpen();
    return parseStagingGameDocumentV2(
      JSON.parse(await readFile(this.documentPath(authority, season, gameId), "utf8")) as unknown,
    );
  }

  public async readFindings(
    authority: "staging" | "quarantine",
    season: number,
    gameId: string,
  ): Promise<readonly StoredFinding[]> {
    this.assertOpen();
    return readFindings(this.findingsPath(authority, season, gameId));
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
    await this.removeIfPresent(this.documentPath("staging", season, gameId));
    await this.removeIfPresent(this.findingsPath("staging", season, gameId));
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
    const current = await this.readDocument(
      input.baseAuthority,
      input.document.metadata.season,
      input.document.metadata.gameId,
    );
    const currentHash = stagingDocumentHash(current);
    if (currentHash !== input.baseDocumentHash) {
      throw new StaleStagingDocumentError(
        `stale staging hash: expected=${input.baseDocumentHash}, current=${currentHash}`,
      );
    }
    const currentFindings = await this.readFindings(
      input.baseAuthority,
      input.document.metadata.season,
      input.document.metadata.gameId,
    );
    await this.saveOriginalIfAbsent(current, currentFindings);
    const createdAt = this.now().toISOString();
    const journalId = `${createdAt.replaceAll(":", "-")}-${input.baseDocumentHash.slice(0, 12)}`;
    const journal: CorrectionJournal = {
      ...input,
      journalId,
      beforeDocument: current,
      createdAt,
    };
    const journalPath = this.correctionJournalPath(input.document.metadata.gameId, journalId);
    await atomicWrite(journalPath, `${canonicalStringify(journal)}\n`);
    if (failurePoint === "after_journal")
      throw new Error("injected correction failure: after_journal");
    await this.rollForwardCorrection(journal);
    if (failurePoint === "after_current")
      throw new Error("injected correction failure: after_current");
    await unlink(journalPath);
    return input.targetAuthority;
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

  private async saveDocument(
    authority: "staging" | "quarantine",
    document: StagingGameDocumentV2,
    findings: readonly StoredFinding[],
  ): Promise<void> {
    this.assertOpen();
    assertSeason(document.metadata.season);
    assertGameId(document.metadata.gameId);
    await this.verifyLock();
    const directory = path.join(this.root, authority, String(document.metadata.season));
    await mkdir(directory, { recursive: true });
    await atomicWrite(
      this.documentPath(authority, document.metadata.season, document.metadata.gameId),
      `${canonicalStringify(document)}\n`,
    );
    const findingsPath = this.findingsPath(
      authority,
      document.metadata.season,
      document.metadata.gameId,
    );
    if (findings.length === 0) {
      await this.removeIfPresent(findingsPath);
    } else {
      await atomicWrite(findingsPath, `${canonicalStringify(findings)}\n`);
    }
  }

  private async documentCatalog(
    authority: "staging" | "quarantine",
  ): Promise<readonly GameCatalogItem[]> {
    const root = path.join(this.root, authority);
    const items: GameCatalogItem[] = [];
    for (const seasonEntry of await readDirectoryIfPresent(root)) {
      if (!seasonEntry.isDirectory() || !/^\d{4}$/.test(seasonEntry.name)) continue;
      const season = Number(seasonEntry.name);
      const directory = path.join(root, seasonEntry.name);
      for (const file of await readDirectoryIfPresent(directory)) {
        if (!file.isFile() || !file.name.endsWith(".json") || file.name.endsWith(".findings.json"))
          continue;
        const gameId = file.name.slice(0, -5);
        if (!isGameId(gameId)) continue;
        const findings = await readFindings(this.findingsPath(authority, season, gameId));
        const metadata = await stat(path.join(directory, file.name));
        items.push({
          gameId,
          season,
          authority,
          updatedAt: metadata.mtime.toISOString(),
          blockingFindings: findings.filter((finding) => finding.severity === "blocking").length,
          warningFindings: findings.filter((finding) => finding.severity === "warning").length,
        });
      }
    }
    return items;
  }

  private async sourceFailureCatalog(): Promise<readonly GameCatalogItem[]> {
    const directory = path.join(this.root, "quarantine", "source-failures");
    const items: GameCatalogItem[] = [];
    for (const file of await readDirectoryIfPresent(directory)) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const gameId = file.name.slice(0, -5);
      if (!isGameId(gameId)) continue;
      const raw = parseSourceFailureRecord(
        JSON.parse(await readFile(path.join(directory, file.name), "utf8")) as unknown,
      );
      const metadata = await stat(path.join(directory, file.name));
      items.push({
        gameId,
        season: /^\d{4}/.test(gameId) ? Number(gameId.slice(0, 4)) : null,
        authority: "source_failure",
        updatedAt: metadata.mtime.toISOString(),
        blockingFindings: raw.findings.filter((finding) => finding.severity === "blocking").length,
        warningFindings: raw.findings.filter((finding) => finding.severity === "warning").length,
      });
    }
    return items;
  }

  private async initializeDirectories(): Promise<void> {
    for (const directory of [
      "staging",
      "quarantine",
      "original",
      "source",
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
      await atomicWrite(findingsTarget, `${canonicalStringify(findings)}\n`);
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
      await this.saveReady(journal.document, journal.findings);
    } else {
      await this.saveQuarantine(journal.document, journal.findings);
    }
  }

  private documentPath(
    authority: "staging" | "quarantine",
    season: number,
    gameId: string,
  ): string {
    assertSeason(season);
    assertGameId(gameId);
    return path.join(this.root, authority, String(season), `${gameId}.json`);
  }

  private findingsPath(
    authority: "staging" | "quarantine",
    season: number,
    gameId: string,
  ): string {
    assertSeason(season);
    assertGameId(gameId);
    return path.join(this.root, authority, String(season), `${gameId}.findings.json`);
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

  private sourceFailurePath(gameId: string): string {
    assertGameId(gameId);
    return path.join(this.root, "quarantine", "source-failures", `${gameId}.json`);
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
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as unknown;
    return parseStoredFindings(value);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function compareCatalogItems(left: GameCatalogItem, right: GameCatalogItem): number {
  return compareText(right.updatedAt, left.updatedAt) || compareText(left.gameId, right.gameId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
