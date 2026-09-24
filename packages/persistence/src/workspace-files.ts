import type { Dirent } from "node:fs";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { canonicalStringify, parseWriterLockOwner, type WriterLockOwner } from "@kbo/contracts";

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
  // A restarted container reuses both hostname and PID. Its own old lock is not a live writer.
  const reusedOwnPid =
    existing?.pid === process.pid &&
    (existing.processStartedAt === undefined
      ? Date.parse(existing.acquiredAt) < performance.timeOrigin
      : existing.processStartedAt !== startedAt);
  if (
    existing !== null &&
    existing.hostname === hostname() &&
    isProcessAlive(existing.pid) &&
    !reusedOwnPid
  ) {
    throw new Error("같은 workspace를 사용하는 writer process가 이미 실행 중입니다.");
  }
  const recovered = `${lockPath}.recovered-${randomUUID()}`;
  await rename(lockPath, recovered);
  try {
    await writeExclusive(lockPath, contents);
  } finally {
    await unlink(recovered).catch(() => undefined);
  }
}

export async function atomicWrite(target: string, contents: string | Uint8Array): Promise<void> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
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
  try {
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Some filesystems do not allow syncing a directory; the file itself is already flushed.
  }
}

export async function removeTemporaryFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await removeTemporaryFiles(absolute);
    else if (entry.isFile() && entry.name.endsWith(".tmp")) await unlink(absolute);
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
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
