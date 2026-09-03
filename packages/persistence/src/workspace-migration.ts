import { constants as fsConstants, createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";

import {
  canonicalStringify,
  compareCanonicalStrings,
  parseCurrentWorkspaceEntry,
  parseLegacyCurrentWorkspaceEntryV1,
  parseSourceFailureRecord,
  parseStagingGameDocumentV2,
  parseStoredFindingEnvelopeV2,
  parseStoredFindings,
  type CurrentWorkspaceEntry,
  type LegacyCurrentWorkspaceEntryV1,
  type SourceFailureRecord,
  type StagingGameDocumentV2,
  type StoredFinding,
  type StoredFindingEnvelopeV2,
  type WorkspaceTransitionJournal,
  type WorkspaceManifestUpgradeJournal,
  type WriterLockOwner,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash, type Finding } from "@kbo/game-core";

import {
  acquireWriterLock,
  atomicWrite,
  isMissing,
  readDirectoryIfPresent,
  readWriterLock,
} from "./workspace-files.js";
import { assertGameId, assertSeason, isGameId } from "./workspace-path-policy.js";

type LegacyAuthority = "staging" | "quarantine" | "source_failure";

interface LegacyCandidate {
  readonly gameId: string;
  readonly authority: LegacyAuthority;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly findingsPath: string | null;
}

interface PreparedDocumentCandidate extends LegacyCandidate {
  readonly authority: "staging" | "quarantine";
  readonly document: StagingGameDocumentV2;
  readonly findings: readonly StoredFinding[];
  readonly documentHash: string;
  readonly contentHash: string;
  readonly season: number;
}

interface PreparedFailureCandidate extends LegacyCandidate {
  readonly authority: "source_failure";
  readonly record: SourceFailureRecord;
  readonly contentHash: string;
  readonly season: number | null;
}

type PreparedCandidate = PreparedDocumentCandidate | PreparedFailureCandidate;

export interface WorkspaceMigrationConflict {
  readonly gameId: string;
  readonly candidates: readonly {
    readonly authority: LegacyAuthority;
    readonly relativePath: string;
  }[];
}

export interface WorkspaceMigrationReport {
  readonly mode: "dry-run" | "apply";
  readonly legacyArtifactCount: number;
  readonly gameCount: number;
  readonly migratedCount: number;
  readonly currentManifestV1Count: number;
  readonly upgradedManifestCount: number;
  readonly sourceFailureManifestCount: number;
  readonly derivableDisplaySummaryCount: number;
  readonly manifestValidationFailures: readonly {
    readonly gameId: string;
    readonly message: string;
  }[];
  readonly conflicts: readonly WorkspaceMigrationConflict[];
}

export interface WorkspaceMigrationOptions {
  readonly root: string;
  readonly apply: boolean;
  readonly backupDirectory?: string;
  readonly resolutionFile?: string;
  readonly now?: () => Date;
}

interface MigrationResolution {
  readonly schemaVersion: 1;
  readonly selections: ReadonlyMap<string, string>;
}

interface PreparedManifestUpgrade {
  readonly previous: LegacyCurrentWorkspaceEntryV1;
  readonly target: CurrentWorkspaceEntry;
}

export async function migrateWorkspaceLayout(
  options: WorkspaceMigrationOptions,
): Promise<WorkspaceMigrationReport> {
  const root = path.resolve(options.root);
  await access(root, fsConstants.R_OK | (options.apply ? fsConstants.W_OK : 0));
  const manifestScan = await scanCurrentManifestUpgrades(root);
  const candidates = await scanLegacyCandidates(root);
  const grouped = groupCandidates(candidates);
  const resolution =
    options.resolutionFile === undefined
      ? null
      : await readMigrationResolution(options.resolutionFile);
  const { selected, conflicts } = resolveCandidates(grouped, resolution);
  if (!options.apply) {
    return {
      mode: "dry-run",
      legacyArtifactCount: candidates.length,
      gameCount: grouped.size,
      migratedCount: 0,
      currentManifestV1Count: manifestScan.v1Count,
      upgradedManifestCount: 0,
      sourceFailureManifestCount: manifestScan.sourceFailureCount,
      derivableDisplaySummaryCount: manifestScan.upgrades.filter(
        (upgrade) => upgrade.target.authority !== "source_failure",
      ).length,
      manifestValidationFailures: manifestScan.failures,
      conflicts,
    };
  }
  if (options.backupDirectory === undefined) {
    throw new Error("workspace migration apply에는 --backup <verified-path>가 필요합니다.");
  }
  await verifyBackupDirectory(options.backupDirectory);
  if (conflicts.length > 0) {
    throw new Error(
      `권위 충돌 ${String(conflicts.length)}건을 증명 없이 해결할 수 없습니다. --resolution 파일이 필요합니다.`,
    );
  }
  if (manifestScan.failures.length > 0) {
    throw new Error(
      `current manifest 검증 실패 ${String(manifestScan.failures.length)}건을 해결해야 합니다.`,
    );
  }

  const now = options.now ?? (() => new Date());
  const owner: WriterLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: now().toISOString(),
  };
  const lockPath = path.join(root, ".writer.lock");
  await acquireWriterLock(lockPath, owner);
  let migratedCount = 0;
  try {
    for (const directory of ["active", "current", "journals", "migration-archive"]) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    for (const upgrade of manifestScan.upgrades.sort((left, right) =>
      compareCanonicalStrings(left.target.gameId, right.target.gameId),
    )) {
      await applyManifestUpgrade(root, upgrade, now);
    }
    for (const candidate of selected.sort((left, right) =>
      compareCanonicalStrings(left.gameId, right.gameId),
    )) {
      await migrateCandidate(root, candidate, now);
      for (const discarded of grouped.get(candidate.gameId) ?? []) {
        if (discarded.relativePath !== candidate.relativePath) {
          await archiveDiscardedLegacyCandidate(root, discarded);
        }
      }
      migratedCount += 1;
    }
  } finally {
    const currentOwner = await readWriterLock(lockPath);
    if (currentOwner?.token === owner.token) await unlink(lockPath);
  }
  return {
    mode: "apply",
    legacyArtifactCount: candidates.length,
    gameCount: grouped.size,
    migratedCount,
    currentManifestV1Count: manifestScan.v1Count,
    upgradedManifestCount: manifestScan.upgrades.length,
    sourceFailureManifestCount: manifestScan.sourceFailureCount,
    derivableDisplaySummaryCount: manifestScan.upgrades.filter(
      (upgrade) => upgrade.target.authority !== "source_failure",
    ).length,
    manifestValidationFailures: [],
    conflicts: [],
  };
}

async function scanCurrentManifestUpgrades(root: string): Promise<{
  readonly v1Count: number;
  readonly sourceFailureCount: number;
  readonly upgrades: PreparedManifestUpgrade[];
  readonly failures: { readonly gameId: string; readonly message: string }[];
}> {
  let v1Count = 0;
  let sourceFailureCount = 0;
  const upgrades: PreparedManifestUpgrade[] = [];
  const failures: { gameId: string; message: string }[] = [];
  for (const file of await readDirectoryIfPresent(path.join(root, "current"))) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const gameId = file.name.slice(0, -5);
    try {
      assertGameId(gameId);
      const value = JSON.parse(
        await readFile(path.join(root, "current", file.name), "utf8"),
      ) as unknown;
      try {
        parseCurrentWorkspaceEntry(value);
        continue;
      } catch {
        // A V1 entry is accepted only by the explicit migration decoder below.
      }
      const previous = parseLegacyCurrentWorkspaceEntryV1(value);
      if (previous.gameId !== gameId) {
        throw new Error("manifest gameId가 파일 이름과 다릅니다.");
      }
      v1Count += 1;
      if (previous.authority === "source_failure") sourceFailureCount += 1;
      upgrades.push(await prepareManifestUpgrade(root, previous));
    } catch (error: unknown) {
      failures.push({ gameId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { v1Count, sourceFailureCount, upgrades, failures };
}

async function prepareManifestUpgrade(
  root: string,
  previous: LegacyCurrentWorkspaceEntryV1,
): Promise<PreparedManifestUpgrade> {
  const artifact = path.join(root, ...previous.artifactPath.split("/"));
  if (previous.authority === "source_failure") {
    const record = parseSourceFailureRecord(
      JSON.parse(await readFile(artifact, "utf8")) as unknown,
    );
    if (
      previous.documentHash !== null ||
      record.gameId !== previous.gameId ||
      record.season !== previous.season ||
      sha256(canonicalStringify(record)) !== previous.contentHash
    ) {
      throw new Error("source failure artifact hash 또는 문맥이 current manifest와 다릅니다.");
    }
    return {
      previous,
      target: {
        ...previous,
        schemaVersion: 2,
        authority: "source_failure",
        documentHash: null,
        displaySummary: null,
      },
    };
  }
  if (previous.season === null || previous.documentHash === null) {
    throw new Error("원장 current manifest에 season 또는 document hash가 없습니다.");
  }
  const document = parseStagingGameDocumentV2(
    JSON.parse(await readFile(artifact, "utf8")) as unknown,
  );
  const envelope = await readCurrentFindingEnvelope(artifact);
  if (
    document.metadata.gameId !== previous.gameId ||
    document.metadata.season !== previous.season ||
    stagingDocumentHash(document) !== previous.documentHash ||
    sha256(canonicalStringify({ document, findingEnvelope: envelope })) !== previous.contentHash
  ) {
    throw new Error("원장 artifact hash 또는 문맥이 current manifest와 다릅니다.");
  }
  return {
    previous,
    target: {
      ...previous,
      schemaVersion: 2,
      season: previous.season,
      authority: previous.authority,
      documentHash: previous.documentHash,
      displaySummary: displaySummary(document),
    },
  };
}

async function readCurrentFindingEnvelope(artifact: string): Promise<StoredFindingEnvelopeV2> {
  const target = artifact.replace(".document.json", ".findings.json");
  try {
    return parseStoredFindingEnvelopeV2(JSON.parse(await readFile(target, "utf8")) as unknown);
  } catch (error: unknown) {
    if (isMissing(error)) return findingEnvelope([]);
    throw error;
  }
}

async function applyManifestUpgrade(
  root: string,
  upgrade: PreparedManifestUpgrade,
  now: () => Date,
): Promise<void> {
  const transitionId = randomUUID();
  const journal: WorkspaceManifestUpgradeJournal = {
    schemaVersion: 1,
    kind: "manifest_upgrade",
    transitionId,
    gameId: upgrade.target.gameId,
    previous: upgrade.previous,
    target: upgrade.target,
    createdAt: now().toISOString(),
  };
  const journalPath = path.join(
    root,
    "journals",
    `manifest-upgrade-${upgrade.target.gameId}-${transitionId}.json`,
  );
  await atomicWrite(journalPath, `${canonicalStringify(journal)}\n`);
  await atomicWrite(
    path.join(root, "current", `${upgrade.target.gameId}.json`),
    `${canonicalStringify(upgrade.target)}\n`,
  );
  await unlink(journalPath);
}

async function scanLegacyCandidates(root: string): Promise<readonly LegacyCandidate[]> {
  const result: LegacyCandidate[] = [];
  for (const authority of ["staging", "quarantine"] as const) {
    const authorityRoot = path.join(root, authority);
    for (const seasonEntry of await readDirectoryIfPresent(authorityRoot)) {
      if (!seasonEntry.isDirectory()) continue;
      if (authority === "quarantine" && seasonEntry.name === "source-failures") continue;
      for (const file of await readDirectoryIfPresent(path.join(authorityRoot, seasonEntry.name))) {
        if (
          !file.isFile() ||
          !file.name.endsWith(".json") ||
          file.name.endsWith(".findings.json")
        ) {
          continue;
        }
        const gameId = file.name.slice(0, -5);
        if (!isGameId(gameId))
          throw new Error("legacy workspace에 허용되지 않은 game ID가 있습니다.");
        const absolutePath = path.join(authorityRoot, seasonEntry.name, file.name);
        result.push({
          gameId,
          authority,
          relativePath: toWorkspaceRelativePath(root, absolutePath),
          absolutePath,
          findingsPath: path.join(authorityRoot, seasonEntry.name, `${gameId}.findings.json`),
        });
      }
    }
  }
  const failuresRoot = path.join(root, "quarantine", "source-failures");
  for (const file of await readDirectoryIfPresent(failuresRoot)) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const gameId = file.name.slice(0, -5);
    if (!isGameId(gameId))
      throw new Error("legacy source failure에 허용되지 않은 game ID가 있습니다.");
    const absolutePath = path.join(failuresRoot, file.name);
    result.push({
      gameId,
      authority: "source_failure",
      relativePath: toWorkspaceRelativePath(root, absolutePath),
      absolutePath,
      findingsPath: null,
    });
  }
  return result.sort((left, right) =>
    compareCanonicalStrings(left.relativePath, right.relativePath),
  );
}

function groupCandidates(
  candidates: readonly LegacyCandidate[],
): ReadonlyMap<string, readonly LegacyCandidate[]> {
  const grouped = new Map<string, LegacyCandidate[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.gameId) ?? [];
    group.push(candidate);
    grouped.set(candidate.gameId, group);
  }
  return grouped;
}

function resolveCandidates(
  grouped: ReadonlyMap<string, readonly LegacyCandidate[]>,
  resolution: MigrationResolution | null,
): { readonly selected: LegacyCandidate[]; readonly conflicts: WorkspaceMigrationConflict[] } {
  const selected: LegacyCandidate[] = [];
  const conflicts: WorkspaceMigrationConflict[] = [];
  for (const [gameId, candidates] of grouped) {
    if (candidates.length === 1) {
      const candidate = candidates[0];
      if (candidate !== undefined) selected.push(candidate);
      continue;
    }
    const selectedPath = resolution?.selections.get(gameId);
    const resolved =
      selectedPath === undefined
        ? undefined
        : candidates.find((candidate) => candidate.relativePath === selectedPath);
    if (resolved === undefined) {
      conflicts.push({
        gameId,
        candidates: candidates.map(({ authority, relativePath }) => ({ authority, relativePath })),
      });
    } else {
      selected.push(resolved);
    }
  }
  return { selected, conflicts };
}

async function migrateCandidate(
  root: string,
  legacy: LegacyCandidate,
  now: () => Date,
): Promise<void> {
  const prepared = await prepareCandidate(legacy);
  const existing = await readCurrentEntryIfPresent(root, prepared.gameId);
  const artifactName =
    prepared.authority === "source_failure"
      ? `1-${prepared.contentHash}.failure.json`
      : `1-${prepared.contentHash}.document.json`;
  const artifactPath = path.posix.join("active", prepared.gameId, artifactName);
  const target: CurrentWorkspaceEntry =
    prepared.authority === "source_failure"
      ? {
          schemaVersion: 2,
          gameId: prepared.gameId,
          season: prepared.season,
          authority: "source_failure",
          generation: 1,
          updatedAt: now().toISOString(),
          artifactPath,
          contentHash: prepared.contentHash,
          documentHash: null,
          displaySummary: null,
        }
      : {
          schemaVersion: 2,
          gameId: prepared.gameId,
          season: prepared.season,
          authority: prepared.authority === "staging" ? "ready" : "quarantine",
          generation: 1,
          updatedAt: now().toISOString(),
          artifactPath,
          contentHash: prepared.contentHash,
          documentHash: prepared.documentHash,
          displaySummary: displaySummary(prepared.document),
        };
  if (existing !== null && !sameMigrationTarget(existing, target)) {
    throw new Error(`기존 current manifest와 legacy artifact가 충돌합니다: ${prepared.gameId}`);
  }
  const artifactAbsolute = path.join(root, ...artifactPath.split("/"));
  if (prepared.authority === "source_failure") {
    await atomicWrite(artifactAbsolute, `${canonicalStringify(prepared.record)}\n`);
  } else {
    await atomicWrite(artifactAbsolute, `${canonicalStringify(prepared.document)}\n`);
    if (prepared.findings.length > 0) {
      await atomicWrite(
        artifactAbsolute.replace(".document.json", ".findings.json"),
        `${canonicalStringify(findingEnvelope(prepared.findings))}\n`,
      );
    }
  }
  const transitionId = randomUUID();
  const journal: WorkspaceTransitionJournal = {
    schemaVersion: 1,
    transitionId,
    gameId: prepared.gameId,
    previous: existing,
    target,
    createdAt: now().toISOString(),
  };
  const journalPath = path.join(
    root,
    "journals",
    `workspace-${prepared.gameId}-${transitionId}.json`,
  );
  await atomicWrite(journalPath, `${canonicalStringify(journal)}\n`);
  await atomicWrite(
    path.join(root, "current", `${prepared.gameId}.json`),
    `${canonicalStringify(target)}\n`,
  );
  await archiveLegacyCandidate(root, prepared);
  await unlink(journalPath);
}

async function prepareCandidate(legacy: LegacyCandidate): Promise<PreparedCandidate> {
  if (legacy.authority === "source_failure") {
    const record = parseLegacySourceFailure(
      JSON.parse(await readFile(legacy.absolutePath, "utf8")) as unknown,
      legacy.gameId,
    );
    if (!record.findingEnvelope.findings.some((finding) => finding.severity === "blocking")) {
      throw new Error(`legacy source failure에 blocking finding이 없습니다: ${legacy.gameId}`);
    }
    return {
      ...legacy,
      authority: "source_failure",
      record,
      contentHash: sha256(canonicalStringify(record)),
      season: record.season,
    };
  }
  const document = parseStagingGameDocumentV2(
    JSON.parse(await readFile(legacy.absolutePath, "utf8")) as unknown,
  );
  if (document.metadata.gameId !== legacy.gameId) {
    throw new Error(`legacy 원장 gameId가 파일명과 다릅니다: ${legacy.gameId}`);
  }
  assertSeason(document.metadata.season);
  const legacyFindings =
    legacy.findingsPath === null ? [] : await readLegacyFindings(legacy.findingsPath);
  const compile = compileStagingGameDocumentV2(document);
  const findings = classifyLegacyFindings(legacyFindings, compile.findings, document);
  const blocked =
    findings.some((finding) => finding.severity === "blocking") ||
    compile.findings.some((finding) => finding.severity === "blocking");
  if (legacy.authority === "staging" && blocked) {
    throw new Error(`legacy staging 원장이 compile 결과상 blocking입니다: ${legacy.gameId}`);
  }
  if (legacy.authority === "quarantine" && !blocked) {
    throw new Error(`legacy quarantine 원장이 compile 결과상 ready입니다: ${legacy.gameId}`);
  }
  return {
    ...legacy,
    authority: legacy.authority,
    document,
    findings,
    documentHash: stagingDocumentHash(document),
    contentHash: sha256(
      canonicalStringify({ document, findingEnvelope: findingEnvelope(findings) }),
    ),
    season: document.metadata.season,
  };
}

async function archiveLegacyCandidate(root: string, candidate: PreparedCandidate): Promise<void> {
  const directory = path.join(root, "migration-archive", candidate.gameId);
  await mkdir(directory, { recursive: true });
  const prefix = candidate.contentHash.slice(0, 16);
  await moveLegacyFile(
    candidate.absolutePath,
    path.join(directory, `${prefix}-${path.basename(candidate.absolutePath)}`),
  );
  if (candidate.findingsPath !== null) {
    await moveLegacyFile(
      candidate.findingsPath,
      path.join(directory, `${prefix}-${path.basename(candidate.findingsPath)}`),
      true,
    );
  }
}

async function archiveDiscardedLegacyCandidate(
  root: string,
  candidate: LegacyCandidate,
): Promise<void> {
  const directory = path.join(root, "migration-archive", candidate.gameId);
  await mkdir(directory, { recursive: true });
  const prefix = (await hashFile(candidate.absolutePath)).slice(0, 16);
  await moveLegacyFile(
    candidate.absolutePath,
    path.join(directory, `discarded-${prefix}-${path.basename(candidate.absolutePath)}`),
  );
  if (candidate.findingsPath !== null) {
    await moveLegacyFile(
      candidate.findingsPath,
      path.join(directory, `discarded-${prefix}-${path.basename(candidate.findingsPath)}`),
      true,
    );
  }
}

async function moveLegacyFile(
  source: string,
  destination: string,
  optional = false,
): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    try {
      await access(destination, fsConstants.R_OK);
    } catch (destinationError: unknown) {
      if (optional && isMissing(destinationError)) return;
      throw destinationError;
    }
  }
}

async function readCurrentEntryIfPresent(
  root: string,
  gameId: string,
): Promise<CurrentWorkspaceEntry | null> {
  try {
    return parseCurrentWorkspaceEntry(
      JSON.parse(await readFile(path.join(root, "current", `${gameId}.json`), "utf8")) as unknown,
    );
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readLegacyFindings(target: string): Promise<readonly StoredFinding[]> {
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as unknown;
    if (isPlainRecord(value) && value.schemaVersion === 2) {
      return parseStoredFindingEnvelopeV2(value).findings;
    }
    if (!Array.isArray(value)) throw new Error("legacy finding sidecar가 배열이 아닙니다.");
    return parseStoredFindings(
      value.map((finding) => ({
        ...(isPlainRecord(finding) ? finding : {}),
        producer: "migration",
        lifecycle: "persistent",
      })),
    );
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function parseLegacySourceFailure(value: unknown, gameId: string): SourceFailureRecord {
  if (!isPlainRecord(value)) throw new Error(`legacy source failure 형식이 아닙니다: ${gameId}`);
  const allowed = new Set(["gameId", "season", "recordedAt", "findings", "findingEnvelope"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`legacy source failure에 알 수 없는 필드가 있습니다: ${gameId}`);
  }
  const season = value.season ?? null;
  const envelope =
    value.findingEnvelope === undefined
      ? findingEnvelope(
          parseStoredFindings(
            Array.isArray(value.findings)
              ? value.findings.map((finding) => ({
                  ...(isPlainRecord(finding) ? finding : {}),
                  producer: "migration",
                  lifecycle: "persistent",
                }))
              : value.findings,
          ),
        )
      : parseStoredFindingEnvelopeV2(value.findingEnvelope);
  return parseSourceFailureRecord({
    gameId: value.gameId,
    season,
    recordedAt: value.recordedAt,
    findingEnvelope: envelope,
  });
}

async function readMigrationResolution(target: string): Promise<MigrationResolution> {
  const value = JSON.parse(await readFile(path.resolve(target), "utf8")) as unknown;
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.selections)) {
    throw new Error("workspace migration resolution 형식이 올바르지 않습니다.");
  }
  if (Object.keys(value).some((key) => key !== "schemaVersion" && key !== "selections")) {
    throw new Error("workspace migration resolution에 알 수 없는 필드가 있습니다.");
  }
  const selections = new Map<string, string>();
  for (const selection of value.selections) {
    if (
      !isPlainRecord(selection) ||
      Object.keys(selection).some((key) => key !== "gameId" && key !== "relativePath") ||
      typeof selection.gameId !== "string" ||
      typeof selection.relativePath !== "string"
    ) {
      throw new Error("workspace migration selection 형식이 올바르지 않습니다.");
    }
    assertGameId(selection.gameId);
    if (selections.has(selection.gameId)) {
      throw new Error(`workspace migration selection이 중복되었습니다: ${selection.gameId}`);
    }
    selections.set(selection.gameId, selection.relativePath);
  }
  return { schemaVersion: 1, selections };
}

async function verifyBackupDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const manifest = JSON.parse(
    await readFile(path.join(resolved, "manifest.json"), "utf8"),
  ) as unknown;
  if (!isPlainRecord(manifest) || manifest.formatVersion !== 1) {
    throw new Error("backup manifest formatVersion이 올바르지 않습니다.");
  }
  for (const key of ["database", "workspace"] as const) {
    const entry = manifest[key];
    if (
      !isPlainRecord(entry) ||
      typeof entry.file !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`backup manifest ${key} 항목이 올바르지 않습니다.`);
    }
    const target = path.resolve(resolved, entry.file);
    if (!target.startsWith(`${resolved}${path.sep}`)) {
      throw new Error(`backup ${key} 파일이 backup 디렉터리 밖을 가리킵니다.`);
    }
    if ((await hashFile(target)) !== entry.sha256) {
      throw new Error(`backup ${key} SHA-256 검증에 실패했습니다.`);
    }
  }
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

function sameMigrationTarget(
  current: CurrentWorkspaceEntry,
  target: CurrentWorkspaceEntry,
): boolean {
  return (
    current.gameId === target.gameId &&
    current.authority === target.authority &&
    current.contentHash === target.contentHash &&
    current.documentHash === target.documentHash
  );
}

function classifyLegacyFindings(
  findings: readonly StoredFinding[],
  compiled: readonly Finding[],
  document: StagingGameDocumentV2,
): StoredFinding[] {
  const compilerFingerprints = new Set(compiled.map(findingFingerprint));
  const unresolvedIds = new Set(
    document.events
      .filter((event) => event.kind === "unresolved")
      .map((event) => event.identity.eventId),
  );
  return findings.map((finding) => {
    if (compilerFingerprints.has(findingFingerprint(finding))) {
      return { ...finding, producer: "compiler", lifecycle: "recomputed" };
    }
    if (finding.eventId !== undefined && unresolvedIds.has(finding.eventId)) {
      return { ...finding, producer: "migration", lifecycle: "while_event_unresolved" };
    }
    return { ...finding, producer: "migration", lifecycle: "persistent" };
  });
}

function findingFingerprint(finding: StoredFinding | Finding): string {
  return canonicalStringify({
    code: finding.code,
    category: finding.category,
    severity: finding.severity,
    message: finding.message,
    eventId: finding.eventId ?? null,
    eventSequence: finding.eventSequence ?? null,
    recordIdentity: finding.recordIdentity ?? null,
    details: finding.details ?? [],
  });
}

function findingEnvelope(findings: readonly StoredFinding[]): StoredFindingEnvelopeV2 {
  return parseStoredFindingEnvelopeV2({ schemaVersion: 2, findings });
}

function displaySummary(document: StagingGameDocumentV2) {
  return {
    gameDate: document.metadata.gameDate,
    teams: {
      away: { teamId: document.teams.away.teamId, name: document.teams.away.name },
      home: { teamId: document.teams.home.teamId, name: document.teams.home.name },
    },
  };
}

function toWorkspaceRelativePath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("legacy artifact가 workspace 밖을 가리킵니다.");
  }
  return relative.split(path.sep).join("/");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
