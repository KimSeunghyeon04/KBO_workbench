import { mkdtempDisposable, writeFile, readFile, utimes, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { StagingWorkspace, runTrainingHash } from "@kbo/persistence";
import { trainRunExpectancy, trainCountRunExpectancy, trainWinProbability } from "@kbo/game-core";
it("publishes and reopens 2026 application models without replacing the prior season pointers", async () => {
  await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-model-2026-"));
  const workspace = await StagingWorkspace.open(temporary.path);
  try {
    for (const through of [2024, 2025]) {
      const manifest = { version: 1 as const, through, games: [], scopeHashes: [] };
      const sourceHash = runTrainingHash(manifest);
      const re24 = trainRunExpectancy([], sourceHash, through);
      const count = trainCountRunExpectancy([], [], sourceHash, through);
      const win = trainWinProbability([], sourceHash, through);
      await workspace.runExpectancy.save(re24, manifest);
      await workspace.runExpectancy.saveCount(count, manifest);
      await workspace.runExpectancy.saveWin(win, manifest);
      expect((await workspace.runExpectancy.read(through))?.model).toEqual(re24);
      expect((await workspace.runExpectancy.readCount(through))?.model).toEqual(count);
      expect((await workspace.runExpectancy.readWin(through))?.model).toEqual(win);
    }
    expect((await workspace.runExpectancy.readWin(2024))?.model.policy).toBe(
      "regular-2022-2025-shortened-limit-v1",
    );
    expect((await workspace.runExpectancy.readWin(2025))?.model.policy).toBe(
      "regular-2022-2026-shortened-limit-v2",
    );
  } finally {
    await workspace.close();
  }
});
it("publishes a complete hash-verified model under the writer lock and rejects corrupt or cancelled updates", async () => {
  await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-run-model-"));
  const workspace = await StagingWorkspace.open(temporary.path);
  const manifest = { version: 1 as const, through: 2024, games: [], scopeHashes: [] },
    model = trainRunExpectancy([], runTrainingHash(manifest));
  try {
    expect(await workspace.runExpectancy.read(2024)).toBeNull();
    const hash = await workspace.runExpectancy.save(model, manifest);
    expect(await workspace.runExpectancy.read(2024)).toEqual({ model, hash });
    const countModel = trainCountRunExpectancy([], [], runTrainingHash(manifest)),
      countHash = await workspace.runExpectancy.saveCount(countModel, manifest);
    expect(await workspace.runExpectancy.readCount(2024)).toEqual({
      model: countModel,
      hash: countHash,
    });
    const winModel = trainWinProbability([], runTrainingHash(manifest)),
      winHash = await workspace.runExpectancy.saveWin(winModel, manifest);
    expect(await workspace.runExpectancy.readWin(2024)).toEqual({ model: winModel, hash: winHash });
    await expect(
      workspace.runExpectancy.saveWin({ ...winModel, limits: [12] }, manifest),
    ).rejects.toThrow("Invalid win model provenance");
    const pointer = path.join(temporary.path, "analysis", "run-expectancy", "through-2024.json"),
      before = await readFile(pointer, "utf8"),
      controller = new AbortController();
    controller.abort();
    await expect(
      workspace.runExpectancy.save(model, manifest, controller.signal),
    ).rejects.toThrow();
    expect(await readFile(pointer, "utf8")).toBe(before);
    const artifact = path.join(temporary.path, "analysis", "run-expectancy", `${hash}.json`);
    const timestamp = new Date("2026-06-01T00:00:00.000Z");
    await utimes(artifact, timestamp, timestamp);
    const warm = await workspace.runExpectancy.read(2024);
    if (warm === null) throw new Error("Missing warm model");
    warm.model.trainingSamples = 5;
    expect(await workspace.runExpectancy.read(2024)).toEqual({ model, hash });
    const original = await readFile(artifact, "utf8");
    const corrupt = original.replace('"trainingSamples":0', '"trainingSamples":1');
    expect(corrupt).not.toBe(original);
    expect(corrupt.length).toBe(original.length);
    await writeFile(artifact, corrupt);
    await utimes(artifact, timestamp, timestamp);
    expect(await workspace.runExpectancy.read(2024)).toBeNull();
    await workspace.runExpectancy.save(model, manifest);
    expect(await workspace.runExpectancy.read(2024)).toEqual({ model, hash });
    await unlink(artifact);
    expect(await workspace.runExpectancy.read(2024)).toBeNull();
  } finally {
    await workspace.close();
  }
  await expect(workspace.runExpectancy.save(model, manifest)).rejects.toThrow();
});
