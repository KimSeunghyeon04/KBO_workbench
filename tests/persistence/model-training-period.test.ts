import { mkdtempDisposable } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  StagingWorkspace,
  pitchQualitySourceHash,
  runTrainingHash,
  parkTrainingHash,
} from "@kbo/persistence";
import {
  trainRunExpectancy,
  trainCountRunExpectancy,
  trainWinProbability,
  trainPitchQuality,
  trainMatchupModel,
  trainParkEnvironment,
} from "@kbo/game-core";

it("isolates historical model files and rejects reused or future validation years", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-model-periods-"));
  const workspace = await StagingWorkspace.open(dir.path);
  try {
    for (const through of [2022, 2023, 2024]) {
      const runManifest = { version: 1 as const, through, games: [], scopeHashes: [] },
        manifest = { version: 1 as const, through, games: [], seasons: [] },
        sourceHash = pitchQualitySourceHash(manifest),
        re24 = trainRunExpectancy([], runTrainingHash(runManifest), through),
        count = trainCountRunExpectancy([], [], runTrainingHash(runManifest), through),
        base = trainPitchQuality([], [], sourceHash, through),
        park = trainParkEnvironment([], parkTrainingHash(manifest), through);
      const reHash = await workspace.runExpectancy.save(re24, runManifest);
      await workspace.runExpectancy.saveCount(count, runManifest);
      const baseHash = await workspace.pitchQuality.save(base, manifest);
      const matchup = trainMatchupModel([], base, baseHash, sourceHash);
      await workspace.matchupModels.save(matchup, manifest);
      await workspace.parkEnvironment.save(park, manifest);
      expect(await workspace.runExpectancy.read(through)).toEqual({ model: re24, hash: reHash });
      expect(await workspace.pitchQuality.read(through)).toEqual({ model: base, hash: baseHash });
      const wrong = structuredClone(base);
      wrong.validationPreprocessing[0] = { season: through + 1, hash: "a".repeat(64) };
      await expect(workspace.pitchQuality.save(wrong, manifest)).rejects.toThrow("provenance");
      const wrongRe = {
        ...re24,
        validation: re24.validation.map((v) => ({
          ...v,
          evaluations: v.evaluations.map((e) => ({ ...e, season: through + 1 })),
        })),
      };
      await expect(workspace.runExpectancy.save(wrongRe, runManifest)).rejects.toThrow(
        "provenance",
      );
      if (through < 2024)
        await expect(
          workspace.runExpectancy.saveWin(
            trainWinProbability([], runTrainingHash(runManifest), through),
            runManifest,
          ),
        ).rejects.toThrow("provenance");
    }
    expect((await workspace.pitchQuality.read(2022))?.model.trainedThrough).toBe(2022);
    expect((await workspace.pitchQuality.read(2024))?.model.trainedThrough).toBe(2024);
  } finally {
    await workspace.close();
  }
});
