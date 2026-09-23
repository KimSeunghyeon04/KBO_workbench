import {
  canonicalStringify,
  compareCanonicalStrings,
  parseCurrentWorkspaceEntry,
  parseWorkspaceManifestUpgradeJournal,
  parseWorkspaceTransitionJournal,
  type CurrentWorkspaceEntry,
  type StoredFinding,
  type WorkspaceManifestUpgradeJournal,
  type WorkspaceTransitionJournal,
} from "@kbo/contracts";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  StaleStagingDocumentError,
  WorkspaceMigrationRequiredError,
  WorkspacePersistenceBlockedError,
} from "./workspace-errors.js";
import { atomicWrite, isMissing, readDirectoryIfPresent } from "./workspace-files.js";
import { assertGameId } from "./workspace-path-policy.js";

// The workspace owns the writer lock and serialization; this store owns the durable current transition.
export class WorkspaceCurrentStore {
  public constructor(
    private readonly root: string,
    private readonly now: () => Date,
    private readonly verifyLock: () => Promise<void>,
    private readonly readCurrentFindings: (
      current: CurrentWorkspaceEntry,
    ) => Promise<readonly StoredFinding[]>,
  ) {}
  public activeArtifactPath(gameId: string, fileName: string): string {
    assertGameId(gameId);
    if (!/^[A-Za-z0-9_.-]{1,300}$/.test(fileName)) {
      throw new Error("허용되지 않은 workspace artifact 이름입니다.");
    }
    return path.posix.join("active", gameId, fileName);
  }

  public absoluteArtifactPath(artifactPath: string): string {
    if (!/^active\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(artifactPath)) {
      throw new Error("허용되지 않은 workspace artifact 경로입니다.");
    }
    const absolute = path.resolve(this.root, ...artifactPath.split("/"));
    if (!absolute.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("workspace artifact가 root 밖을 가리킵니다.");
    }
    return absolute;
  }

  public findingsArtifactPath(artifactPath: string): string {
    if (!artifactPath.endsWith(".document.json")) {
      throw new Error("원장 artifact만 finding sidecar를 가질 수 있습니다.");
    }
    return this.absoluteArtifactPath(
      `${artifactPath.slice(0, -".document.json".length)}.findings.json`,
    );
  }

  public supersededArtifactPath(gameId: string, snapshotId: string): string {
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

  public async readCurrentEntry(gameId: string): Promise<CurrentWorkspaceEntry | null> {
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

  public async requiredCurrentEntry(gameId: string): Promise<CurrentWorkspaceEntry> {
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

  public async performCurrentTransition(
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
      await removeIfPresent(this.currentEntryPath(gameId));
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

  public async recoverWorkspaceTransitions(): Promise<void> {
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

  public async recoverManifestUpgradeJournals(): Promise<void> {
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

  public async supersededCount(gameId: string): Promise<number> {
    assertGameId(gameId);
    return (await readDirectoryIfPresent(path.join(this.root, "superseded", gameId))).filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".document.json") || entry.name.endsWith(".failure.json")),
    ).length;
  }

  public async nextGeneration(
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
}

function sameCurrentEntry(
  left: CurrentWorkspaceEntry | null,
  right: CurrentWorkspaceEntry | null,
): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

export function snapshotContentHash(snapshotId: string): string {
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

export async function removeIfPresent(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
}
