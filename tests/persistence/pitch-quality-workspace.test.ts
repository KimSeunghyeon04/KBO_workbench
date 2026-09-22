import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { StagingWorkspace, pitchQualitySourceHash } from "@kbo/persistence";
import { trainPitchQuality } from "@kbo/game-core";
it("publishes quality models only with matching manifests and intact feature dimensions", async () => {
  await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-quality-"));
  const workspace = await StagingWorkspace.open(directory.path),
    manifest = { version: 1 as const, through: 2024, games: [], seasons: [] },
    model = trainPitchQuality([], [], pitchQualitySourceHash(manifest));
  try {
    const hash = await workspace.pitchQuality.save(model, manifest);
    expect(await workspace.pitchQuality.read(2024)).toEqual({ model, hash });
    await expect(
      workspace.pitchQuality.save(
        { ...model, preprocessing: { ...model.preprocessing, scales: [] } },
        manifest,
      ),
    ).rejects.toThrow("dimensions");
    const abort = new AbortController();
    abort.abort();
    await expect(workspace.pitchQuality.save(model, manifest, abort.signal)).rejects.toThrow();
    expect(await workspace.pitchQuality.read(2024)).toEqual({ model, hash });
    await writeFile(path.join(directory.path, "analysis", "pitch-quality", `${hash}.json`), "{}");
    expect(await workspace.pitchQuality.read(2024)).toBeNull();
  } finally {
    await workspace.close();
  }
});
