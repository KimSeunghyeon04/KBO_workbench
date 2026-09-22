import { mkdtempDisposable, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { StagingWorkspace, runTrainingHash } from "@kbo/persistence";
import { trainRunExpectancy, trainCountRunExpectancy, trainWinProbability } from "@kbo/game-core";
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
    await writeFile(path.join(temporary.path, "analysis", "run-expectancy", `${hash}.json`), "{}");
    expect(await workspace.runExpectancy.read(2024)).toBeNull();
  } finally {
    await workspace.close();
  }
  await expect(workspace.runExpectancy.save(model, manifest)).rejects.toThrow();
});
