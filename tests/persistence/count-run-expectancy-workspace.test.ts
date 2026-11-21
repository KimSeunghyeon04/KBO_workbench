import { createHash } from "node:crypto";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalStringify, type CountRunModel } from "@kbo/contracts";
import { trainCountRunExpectancy } from "@kbo/game-core";
import { StagingWorkspace, runTrainingHash } from "@kbo/persistence";
import { expect, it } from "vitest";

it("saves and loads ordered count cells and rejects mislabelled cells even with a valid file hash", async () => {
  const manifest = { version: 1 as const, through: 2024, games: [], scopeHashes: [] };
  const cells: CountRunModel["cells"] = [];
  for (const outs of [0, 1, 2])
    for (const bases of [0, 1, 2, 3, 4, 5, 6, 7])
      for (const balls of [0, 1, 2, 3])
        for (const strikes of [0, 1, 2])
          cells.push({ outs, bases, balls, strikes, samples: 0, mean: null });
  const model = trainCountRunExpectancy([], [], runTrainingHash(manifest));
  expect(model.cells).toStrictEqual(cells);
  const mislabelled = {
    ...model,
    // At cell 3, (0 balls, 3 strikes) and (1 ball, 0 strikes) would encode to the same index.
    cells: cells.map((cell, index) => (index === 3 ? { ...cell, balls: 0, strikes: 3 } : cell)),
  };

  await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-count-re-"));
  const workspace = await StagingWorkspace.open(directory.path);
  try {
    const hash = await workspace.runExpectancy.saveCount(model, manifest);
    expect(await workspace.runExpectancy.readCount(2024)).toStrictEqual({ model, hash });
    await expect(workspace.runExpectancy.saveCount(mislabelled, manifest)).rejects.toThrow(
      "Invalid count RE model provenance",
    );
    expect(await workspace.runExpectancy.readCount(2024)).toStrictEqual({ model, hash });

    const payload = canonicalStringify({ model: mislabelled, manifest });
    const invalidHash = createHash("sha256").update(payload).digest("hex");
    const artifactRoot = path.join(directory.path, "analysis", "count-run-expectancy");
    await writeFile(path.join(artifactRoot, `${invalidHash}.json`), payload);
    await writeFile(
      path.join(artifactRoot, "through-2024.json"),
      canonicalStringify({ hash: invalidHash }),
    );
    expect(await workspace.runExpectancy.readCount(2024)).toBeNull();
  } finally {
    await workspace.close();
  }
});
