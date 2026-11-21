import { mkdir, mkdtempDisposable, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { canonicalStringify } from "@kbo/contracts";
import { StagingWorkspace } from "@kbo/persistence";
import { expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile), rename: vi.fn(fs.rename) };
});

const staleOwner = {
  token: "previous-process",
  pid: process.pid,
  hostname: hostname(),
  acquiredAt: "2020-01-01T00:00:00.000Z",
};

it("rejects a delayed stale lock takeover once a new owner has opened the workspace", async () => {
  await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-stale-lock-race-"));
  const lock = path.join(root.path, ".writer.lock");
  const previous = canonicalStringify(staleOwner);
  await writeFile(lock, previous);
  const observed = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<string>();
  vi.mocked(readFile).mockImplementationOnce(() => {
    observed.resolve(undefined);
    return resume.promise;
  });

  const delayed = StagingWorkspace.open(root.path).then(
    async (workspace) => {
      const current = await readFile(lock, "utf8");
      await workspace.close();
      return { status: "opened", current };
    },
    (error: unknown) => ({ status: "rejected", error }),
  );
  await observed.promise;
  const winner = await StagingWorkspace.open(root.path);
  try {
    const acceptedOwner = await readFile(lock, "utf8");
    resume.resolve(previous);
    expect(await delayed).toMatchObject({ status: "rejected" });
    expect(await readFile(lock, "utf8")).toBe(acceptedOwner);
  } finally {
    resume.resolve(previous);
    await delayed;
    await winner.close();
  }
});

it("preserves the foreign writer lock and its in-flight temporary file on startup", async () => {
  await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-foreign-writer-"));
  const lock = path.join(root.path, ".writer.lock");
  const previous = canonicalStringify({ ...staleOwner, hostname: `${hostname()}-other` });
  await writeFile(lock, previous);
  const temporary = path.join(root.path, ".temporary");
  await mkdir(temporary);
  const pendingWrite = path.join(temporary, "in-flight.tmp");
  await writeFile(pendingWrite, "in-flight payload");
  const attempt = StagingWorkspace.open(root.path).then(async (workspace) => {
    await workspace.close();
  });

  await expect(attempt).rejects.toThrow("다른 hostname");
  expect(await readFile(lock, "utf8")).toBe(previous);
  expect(await readFile(pendingWrite, "utf8")).toBe("in-flight payload");
});

it("preserves the lock when the local process cannot be inspected", async () => {
  await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-inaccessible-writer-"));
  const lock = path.join(root.path, ".writer.lock");
  const previous = canonicalStringify({ ...staleOwner, pid: process.pid + 1 });
  await writeFile(lock, previous);
  const inspect = vi.spyOn(process, "kill").mockImplementationOnce(() => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  });
  try {
    await expect(
      StagingWorkspace.open(root.path).then((workspace) => workspace.close()),
    ).rejects.toThrow(/writer process/);
    expect(await readFile(lock, "utf8")).toBe(previous);
  } finally {
    inspect.mockRestore();
  }
});

it("can retry recovery after an interrupted replacement preserves the stale owner", async () => {
  await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-retry-lock-"));
  const lock = path.join(root.path, ".writer.lock");
  const previous = canonicalStringify(staleOwner);
  await writeFile(lock, previous);
  vi.mocked(rename).mockRejectedValueOnce(new Error("simulated interrupted replacement"));

  await expect(StagingWorkspace.open(root.path)).rejects.toThrow(
    "simulated interrupted replacement",
  );
  expect(await readFile(lock, "utf8")).toBe(previous);
  const workspace = await StagingWorkspace.open(root.path);
  try {
    expect(await readFile(lock, "utf8")).not.toBe(previous);
  } finally {
    await workspace.close();
  }
});

it("keeps the stale generation occupied during recovery and rejects a simultaneous recovery", async () => {
  await using root = await mkdtempDisposable(path.join(tmpdir(), "kbo-active-recovery-"));
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const lock = path.join(root.path, ".writer.lock");
  const previous = canonicalStringify(staleOwner);
  await writeFile(lock, previous);
  const replacing = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  vi.mocked(rename).mockImplementationOnce(async (source, target) => {
    replacing.resolve(undefined);
    await resume.promise;
    await fs.rename(source, target);
  });
  const first = StagingWorkspace.open(root.path);
  await replacing.promise;
  try {
    await expect(
      StagingWorkspace.open(root.path).then((workspace) => workspace.close()),
    ).rejects.toThrow("복구가 이미 시작");
    expect(await readFile(lock, "utf8")).toBe(previous);
  } finally {
    resume.resolve(undefined);
    const workspace = await first;
    await workspace.close();
  }
});
