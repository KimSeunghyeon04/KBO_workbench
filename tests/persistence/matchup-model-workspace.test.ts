import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { StagingWorkspace, pitchQualitySourceHash } from "@kbo/persistence";
import { trainPitchQuality, trainMatchupModel } from "@kbo/game-core";
it("binds matchup models to the immutable base model and rejects corruption, false adoption and cancellation", async () => {
  await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-matchup-"));
  const workspace = await StagingWorkspace.open(directory.path),
    manifest = { version: 1 as const, through: 2024, games: [], seasons: [] },
    sourceHash = pitchQualitySourceHash(manifest),
    base = trainPitchQuality([], [], sourceHash),
    baseHash = await workspace.pitchQuality.save(base, manifest),
    model = trainMatchupModel([], base, baseHash, sourceHash);
  try {
    const hash = await workspace.matchupModels.save(model, manifest);
    expect(await workspace.matchupModels.read(2024)).toEqual({ model, hash });
    await expect(
      workspace.matchupModels.save({ ...model, baseModelHash: "a".repeat(64) }, manifest),
    ).rejects.toThrow("provenance");
    const invalidBase = {
      ...base,
      preprocessing: { ...base.preprocessing, scales: base.preprocessing.scales.map(() => 0) },
    };
    await expect(
      workspace.matchupModels.save(
        {
          ...model,
          base: invalidBase,
          baseModelHash: pitchQualitySourceHash({ model: invalidBase, manifest }),
        },
        manifest,
      ),
    ).rejects.toThrow("provenance");
    await expect(
      workspace.matchupModels.save(
        { ...model, targets: model.targets.map((m) => ({ ...m, adopted: true })) },
        manifest,
      ),
    ).rejects.toThrow("validation");
    const abort = new AbortController();
    abort.abort();
    await expect(workspace.matchupModels.save(model, manifest, abort.signal)).rejects.toThrow();
    expect(await workspace.matchupModels.read(2024)).toEqual({ model, hash });
    await writeFile(path.join(directory.path, "analysis", "matchup", `${hash}.json`), "{}");
    expect(await workspace.matchupModels.read(2024)).toBeNull();
  } finally {
    await workspace.close();
  }
});
