import { constants, type Dirent } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { canonicalStringify, parseWriterLockOwner, type WriterLockOwner } from "@kbo/contracts";
import { prepareWorkspaceTemporaryDirectory, syncDirectory } from "./workspace-temporary-files.js";

export async function acquireWriterLock(lockPath: string, owner: WriterLockOwner): Promise<void> {
  const startedAt = new Date(performance.timeOrigin).toISOString();
  const contents = `${canonicalStringify({ ...owner, processStartedAt: startedAt })}\n`;
  try {
    await writeExclusive(lockPath, contents);
    return;
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
  }
  const existing = await readWriterLock(lockPath);
  if (existing === null) return writeExclusive(lockPath, contents);
  if (existing.hostname !== owner.hostname) {
    throw new Error(
      "다른 hostname의 workspace writer lock이 있습니다. 기존 writer 종료를 확인해야 합니다.",
    );
  }
  // A restarted container can reuse its hostname and PID. Only an older record can be reclaimed.
  const reusedOwnPid =
    existing.pid === process.pid &&
    Date.parse(existing.processStartedAt ?? existing.acquiredAt) < Date.parse(startedAt);
  if (!reusedOwnPid && isProcessAlive(existing.pid)) {
    throw new Error("같은 workspace를 사용하는 writer process가 이미 실행 중입니다.");
  }
  // The guard belongs to this stale generation. Keep its lock path occupied until atomic replacement.
  const recovery = `${lockPath}.recovery-${createHash("sha256").update(existing.token).digest("hex")}`;
  try {
    await mkdir(recovery);
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
    throw new Error("같은 workspace writer lock의 복구가 이미 시작되었습니다.");
  }
  try {
    if ((await readWriterLock(lockPath))?.token !== existing.token) {
      throw new Error("복구를 시작한 뒤 workspace writer lock 소유자가 변경되었습니다.");
    }
    await atomicWrite(path.dirname(lockPath), lockPath, contents);
  } finally {
    await rmdir(recovery);
  }
}

export async function atomicWrite(
  root: string,
  target: string,
  contents: string | Uint8Array,
): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("atomic write 대상은 workspace 안에 있어야 합니다.");
  }
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const temporaryDirectory = await prepareWorkspaceTemporaryDirectory(root);
  const temporary = path.join(temporaryDirectory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    if (typeof contents === "string") await handle.writeFile(contents, "utf8");
    else await handle.writeFile(contents);
    await handle.sync();
  } catch (error: unknown) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, target);
  await syncDirectory(directory);
  await syncDirectory(temporaryDirectory);
}

export async function moveArtifactForRecovery(
  source: string,
  destination: string,
  optional = false,
): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    // A previous recovery attempt may already have moved the artifact.
    try {
      await access(destination, constants.R_OK);
    } catch (destinationError: unknown) {
      if (optional && isMissing(destinationError)) return;
      throw destinationError;
    }
  }
}

export async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
    await syncDirectory(path.dirname(directory));
  } catch (error: unknown) {
    if (!isMissing(error) && !(isNodeError(error) && error.code === "ENOTEMPTY")) throw error;
  }
}

export async function readDirectoryIfPresent(directory: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export async function removeIfPresent(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
}

export async function readWriterLock(target: string): Promise<WriterLockOwner | null> {
  try {
    return parseWriterLockOwner(JSON.parse(await readFile(target, "utf8")) as unknown);
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

async function writeExclusive(target: string, contents: string): Promise<void> {
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
