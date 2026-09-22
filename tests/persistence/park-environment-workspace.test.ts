import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { StagingWorkspace, parkTrainingHash } from "@kbo/persistence";
import { trainParkEnvironment } from "@kbo/game-core";
it("checks source manifests, incomplete publication and corrupt model files", async () => {
  await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-park-model-"));
  const workspace = await StagingWorkspace.open(directory.path),
    manifest = { version: 1 as const, through: 2024, games: [], seasons: [] },
    model = trainParkEnvironment([], parkTrainingHash(manifest));
  try {
    expect(await workspace.parkEnvironment.read(2024)).toBeNull();
    const hash = await workspace.parkEnvironment.save(model, manifest);
    expect(await workspace.parkEnvironment.read(2024)).toEqual({ model, hash });
    const abort = new AbortController();
    abort.abort();
    await expect(workspace.parkEnvironment.save(model, manifest, abort.signal)).rejects.toThrow();
    expect(await workspace.parkEnvironment.read(2024)).toEqual({ model, hash });
    await writeFile(
      path.join(directory.path, "analysis", "park-environment", `${hash}.json`),
      "{}",
    );
    expect(await workspace.parkEnvironment.read(2024)).toBeNull();
    await expect(
      workspace.parkEnvironment.save({ ...model, sourceHash: "b".repeat(64) }, manifest),
    ).rejects.toThrow("provenance");
  } finally {
    await workspace.close();
  }
  await expect(workspace.parkEnvironment.save(model, manifest)).rejects.toThrow();
});
