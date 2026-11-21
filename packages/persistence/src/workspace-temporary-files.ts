import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { compareCanonicalStrings } from "@kbo/contracts";
import { WorkspacePersistenceBlockedError } from "./workspace-errors.js";

const legacyDirectories = [
  "staging",
  "quarantine",
  "original",
  "source",
  "active",
  "current",
  "superseded",
  "journals",
  "collection",
  "imports",
  "analysis",
  "registry",
  "record-corrections",
  "reference",
];
const completionFile = "legacy-cleanup-complete";

export async function prepareWorkspaceTemporaryDirectory(root: string): Promise<string> {
  const directory = path.resolve(root, ".temporary");
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) {
    throw new WorkspacePersistenceBlockedError(
      "workspace 임시 디렉터리는 실제 디렉터리여야 합니다.",
    );
  }
  return directory;
}

export async function recoverWorkspaceTemporaryFiles(root: string): Promise<void> {
  const directory = await prepareWorkspaceTemporaryDirectory(root);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".tmp")) {
      await unlink(path.join(directory, entry.name));
    }
  }
  await syncDirectory(directory);
  const marker = path.join(directory, completionFile);
  try {
    const info = await lstat(marker);
    if (!info.isFile() || info.size !== 0) {
      throw new WorkspacePersistenceBlockedError(
        "workspace 임시 파일 전환 완료 표식이 올바르지 않습니다.",
      );
    }
    return;
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }

  // Older writers placed temporary files beside each destination. This one-time
  // sweep must finish before the durable marker permits directory-local recovery.
  const pending = legacyDirectories.map((name) => path.resolve(root, name));
  while (pending.length > 0) {
    const batch = pending.splice(0, 16);
    const results = await Promise.allSettled(
      batch.map(async (parent) => {
        let entries: Dirent[];
        try {
          if (!(await lstat(parent)).isDirectory()) return [];
          entries = await readdir(parent, { withFileTypes: true });
        } catch (error: unknown) {
          if (isMissing(error)) return [];
          throw error;
        }
        const children: string[] = [];
        let removed = false;
        for (const entry of entries.sort((a, b) => compareCanonicalStrings(a.name, b.name))) {
          const target = path.join(parent, entry.name);
          if (entry.isDirectory()) children.push(target);
          else if (entry.isFile() && entry.name.endsWith(".tmp")) {
            await unlink(target);
            removed = true;
          }
        }
        if (removed) await syncDirectory(parent);
        return children;
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      pending.push(...result.value);
    }
  }
  const handle = await open(marker, "wx", 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows and some filesystems do not support directory fsync.
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
