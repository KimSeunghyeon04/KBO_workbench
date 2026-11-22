import { randomUUID } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import {
  canonicalStringify,
  parseCollectionJob,
  parseCorrectionJournal,
  type CollectionJob,
  type CorrectionJournal,
  type StagingCorrectionCommit,
  type StagingGameDocumentV2,
} from "@kbo/contracts";

import { atomicWrite, isMissing, removeIfPresent } from "./workspace-files.js";
import { assertGameId, assertJobId } from "./workspace-path-policy.js";

// Current transitions and correction validation remain in the owning workspace.
export class WorkspaceJournalStore {
  public constructor(
    private readonly root: string,
    private readonly now: () => Date,
  ) {}

  public async saveCollectionJob(job: CollectionJob): Promise<void> {
    await atomicWrite(this.root, this.collectionJobPath(job.jobId), `${canonicalStringify(job)}\n`);
  }

  public async removeCollectionJob(jobId: string): Promise<void> {
    await removeIfPresent(this.collectionJobPath(jobId));
  }

  public async recoverInterruptedCollectionJobs(): Promise<readonly CollectionJob[]> {
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

  public async commitCorrection(
    input: StagingCorrectionCommit,
    beforeDocument: StagingGameDocumentV2,
    transition: NonNullable<CorrectionJournal["transition"]>,
    apply: (journal: CorrectionJournal) => Promise<void>,
    failurePoint?: "after_journal" | "after_current",
  ): Promise<"staging" | "quarantine"> {
    const createdAt = this.now().toISOString();
    const journalId = randomUUID();
    const journal: CorrectionJournal = {
      ...input,
      journalId,
      beforeDocument,
      createdAt,
      transition,
    };
    const journalPath = this.correctionPath(input.document.metadata.gameId, journalId);
    await atomicWrite(this.root, journalPath, `${canonicalStringify(journal)}\n`);
    if (failurePoint === "after_journal")
      throw new Error("injected correction failure: after_journal");
    await apply(journal);
    if (failurePoint === "after_current")
      throw new Error("injected correction failure: after_current");
    await unlink(journalPath);
    return input.targetAuthority;
  }

  public async recoverCorrections(
    apply: (journal: CorrectionJournal) => Promise<void>,
    gameId?: string,
  ): Promise<void> {
    const directory = path.join(this.root, "journals");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(gameId === undefined ? "correction-" : `correction-${gameId}-`) ||
        !entry.name.endsWith(".json")
      )
        continue;
      const journalPath = path.join(directory, entry.name);
      const contents = await readFile(journalPath, "utf8").catch((error: unknown) => {
        if (gameId !== undefined && isMissing(error)) return null;
        throw error;
      });
      if (contents === null) continue;
      const journal = parseCorrectionJournal(JSON.parse(contents) as unknown);
      if (gameId !== undefined && journal.document.metadata.gameId !== gameId) continue;
      await apply(journal);
      await unlink(journalPath);
    }
  }

  private collectionJobPath(jobId: string): string {
    assertJobId(jobId);
    return path.join(this.root, "journals", `collection-${jobId}.json`);
  }

  private correctionPath(gameId: string, journalId: string): string {
    assertGameId(gameId);
    if (!/^[A-Za-z0-9_.+-]{1,200}$/.test(journalId)) {
      throw new Error("유효하지 않은 correction history ID입니다.");
    }
    return path.join(this.root, "journals", `correction-${gameId}-${journalId}.json`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
