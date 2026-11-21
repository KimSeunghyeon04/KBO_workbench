import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { StagingWorkspace } from "@kbo/persistence";
import { AnalysisPreparationManager } from "../../apps/server/src/jobs/analysis-preparation-manager.js";
import { competitionFixture } from "../helpers/game-competition.js";
import { makeDocument } from "../helpers/game-document.js";

const hash = "a".repeat(64),
  changedHash = "b".repeat(64);
it("keeps the source fingerprint stable while an unchanged import is waiting", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-preparation-hash-"));
  const workspace = await StagingWorkspace.open(dir.path);
  const h = harness(workspace);
  let time = "2026-01-01T00:00:00Z";
  const manager = new AnalysisPreparationManager(
    h.repository,
    workspace.analysisPreparation,
    h.collect,
    h.models,
    () => false,
    () => new Date(time),
  );
  try {
    const first = await manager.status();
    time = "2026-01-01T00:01:00Z";
    expect((await manager.status()).sourceHash).toBe(first.sourceHash);
    h.change(2026);
    expect((await manager.status()).sourceHash).not.toBe(first.sourceHash);
  } finally {
    await manager.close();
    await h.manager.close();
    await workspace.close();
  }
});
it("keeps unmatched games explicit while updating verified facts and models for new seasons", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-partial-classification-"));
  const workspace = await StagingWorkspace.open(dir.path);
  try {
    const h = harness(workspace);
    h.repository.adopt.mockImplementation(async () => ({
      datasetHash: changedHash,
      matched: 1,
      unclassified: 1,
      unmatched: 0,
      changed: true,
      dryRun: false,
    }));
    await h.manager.check();
    expect(h.models.afterImport.mock.calls.map(([season]) => season)).toEqual([2025, 2026]);
    expect(await workspace.analysisPreparation.read(2026)).toMatchObject({
      state: "ready",
      unclassified: 1,
    });
    await h.manager.check();
    expect(h.collect).toHaveBeenCalledTimes(2);
    await h.manager.close();
  } finally {
    await workspace.close();
  }
});
function harness(workspace: StagingWorkspace) {
  let sources = [2025, 2026].map((season) => ({
    season,
    sourceHash: hash,
    competitionHash: null as string | null,
    unclassified: 1,
  }));
  let busy = false;
  const order: string[] = [];
  const repository = {
    seasons: async () => structuredClone(sources),
    current: vi.fn(async () => null),
    games: async (season: number) => [
      {
        gameId: `anonymous-${season}`,
        sourceGameId: `source-${season}`,
        gameDate: `${season}-06-01`,
      },
    ],
    adopt: vi.fn(async (dataset: ReturnType<typeof competitionFixture>) => {
      order.push(`classify:${dataset.season}`);
      sources = sources.map((source) =>
        source.season === dataset.season
          ? { ...source, competitionHash: changedHash, unclassified: 0 }
          : source,
      );
      return {
        datasetHash: changedHash,
        matched: 1,
        unclassified: 0,
        unmatched: 0,
        changed: true,
        dryRun: false,
      };
    }),
  };
  const collect = vi.fn(async (season: number) =>
    competitionFixture(season, [
      { sourceGameId: `source-${season}`, gameDate: `${season}-06-01`, competition: "regular" },
    ]),
  );
  const models = {
    afterImport: vi.fn(async (season: number) => {
      order.push(`models:${season}`);
    }),
  };
  const manager = new AnalysisPreparationManager(
    repository,
    workspace.analysisPreparation,
    collect,
    models,
    () => busy,
  );
  return {
    manager,
    repository,
    models,
    collect,
    order,
    setBusy: (value: boolean) => {
      busy = value;
    },
    change: (season: number) => {
      sources = sources.map((source) =>
        source.season === season ? { ...source, sourceHash: changedHash } : source,
      );
    },
  };
}
it("coalesces import batches, classifies before training, resumes from sealed sources and preserves manual files", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-preparation-"));
  const workspace = await StagingWorkspace.open(dir.path);
  try {
    const manual = parseStagingGameDocumentV2(makeDocument([]));
    await workspace.saveCorrectionDraft(manual);
    const manifest = path.join(dir.path, "current", `${manual.metadata.gameId}.json`);
    const before = await readFile(manifest, "utf8");
    const h = harness(workspace);
    h.setBusy(true);
    await h.manager.check();
    expect(h.collect).not.toHaveBeenCalled();
    h.setBusy(false);
    await Promise.all([h.manager.check(), h.manager.check()]);
    expect(h.order).toEqual(["classify:2026", "classify:2025", "models:2025", "models:2026"]);
    expect((await h.manager.status()).seasons).toEqual([2026, 2025]);
    expect((await workspace.analysisPreparation.read(2026))?.state).toBe("ready");
    expect(await readFile(manifest, "utf8")).toBe(before);
    expect((await workspace.readCurrentDocumentSnapshot(manual.metadata.gameId))?.document).toEqual(
      manual,
    );
    await h.manager.close();
    const restarted = harness(workspace);
    // Recreate the same sealed classification pointers after restart.
    await restarted.repository.adopt(competitionFixture(2025, []));
    await restarted.repository.adopt(competitionFixture(2026, []));
    await restarted.manager.check();
    expect(restarted.models.afterImport).not.toHaveBeenCalled();
    restarted.change(2025);
    await restarted.manager.check();
    expect(restarted.models.afterImport.mock.calls.map(([season]) => season)).toEqual([2025, 2026]);
    await restarted.manager.close();
  } finally {
    await workspace.close();
  }
});
it("isolates classification errors and resumes interrupted work without blocking another season", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-preparation-failure-"));
  const workspace = await StagingWorkspace.open(dir.path);
  try {
    const h = harness(workspace);
    h.collect.mockRejectedValueOnce(new Error("official schedule unavailable"));
    await h.manager.check();
    expect(h.models.afterImport).toHaveBeenCalledWith(2025);
    expect(await workspace.analysisPreparation.read(2026)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("official schedule unavailable"),
    });
    await h.manager.check();
    expect(h.collect).toHaveBeenCalledTimes(2);
    await workspace.analysisPreparation.write({
      version: 1,
      season: 2025,
      sourceHash: hash,
      competitionHash: null,
      state: "classifying",
      unclassified: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      error: null,
    });
    await h.manager.check();
    expect(h.models.afterImport).toHaveBeenCalledWith(2026);
    await h.manager.close();
  } finally {
    await workspace.close();
  }
});

it("resumes later model refreshes after the older changed season is already ready", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-preparation-interrupted-"));
  const workspace = await StagingWorkspace.open(dir.path);
  try {
    const h = harness(workspace);
    await h.manager.check();
    h.change(2025);
    h.models.afterImport.mockClear();

    const store = workspace.analysisPreparation;
    let interrupted = false;
    const failure = new Error("interrupted after recording the older season");
    const running = new AnalysisPreparationManager(
      h.repository,
      {
        read: (season) => store.read(season),
        async write(value) {
          if (interrupted) throw failure;
          await store.write(value);
          if (value.season === 2025 && value.state === "ready") {
            interrupted = true;
            throw failure;
          }
        },
      },
      h.collect,
      h.models,
      () => false,
    );
    await expect(running.check()).rejects.toBe(failure);
    await running.close();
    expect((await store.read(2025))?.state).toBe("ready");
    expect(h.models.afterImport.mock.calls.map(([season]) => season)).toEqual([2025]);

    h.models.afterImport.mockClear();
    await h.manager.check();
    expect(h.models.afterImport.mock.calls.map(([season]) => season)).toEqual([2026]);
    expect((await store.read(2026))?.state).toBe("ready");
    await h.manager.close();
  } finally {
    await workspace.close();
  }
});

it("finishes shutdown while the official schedule request is being cancelled", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-preparation-close-"));
  const workspace = await StagingWorkspace.open(dir.path);
  try {
    const h = harness(workspace);
    const started = Promise.withResolvers<undefined>();
    const manager = new AnalysisPreparationManager(
      h.repository,
      workspace.analysisPreparation,
      (_season, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          started.resolve(undefined);
        }),
      h.models,
      () => false,
    );
    const check = Promise.allSettled([manager.check()]);
    await started.promise;
    await expect(manager.close()).resolves.toBeUndefined();
    expect(await check).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(h.repository.adopt).not.toHaveBeenCalled();
    expect(h.models.afterImport).not.toHaveBeenCalled();
    await h.manager.close();
  } finally {
    await workspace.close();
  }
});
