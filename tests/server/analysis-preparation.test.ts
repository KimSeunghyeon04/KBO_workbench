import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { COMPETITION_CLASSIFICATION_POLICY_VERSION, StagingWorkspace } from "@kbo/persistence";
import { AnalysisPreparationManager } from "../../apps/server/src/jobs/analysis-preparation-manager.js";
import { competitionFixture } from "../helpers/game-competition.js";
import { makeDocument } from "../helpers/game-document.js";

const hash = "a".repeat(64),
  changedHash = "b".repeat(64);

it("refreshes prepared status after writes and protects cached records from callers", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-preparation-status-"));
  const workspace = await StagingWorkspace.open(dir.path);
  const store = workspace.analysisPreparation;
  try {
    expect(await store.read(2026)).toBeNull();
    const row = {
      version: 1,
      season: 2026,
      sourceHash: hash,
      competitionHash: null,
      unclassified: 1,
      state: "models",
      updatedAt: "2026-11-21T00:00:00Z",
      error: null,
    } as const;
    await store.write(row);
    const [loaded, other] = await Promise.all([store.read(2026), store.read(2026)]);
    expect(loaded).toEqual(row);
    if (loaded === null) throw new Error("Missing preparation state");
    loaded.unclassified = 9;
    expect(other).toEqual(row);
    expect(await store.read(2026)).toEqual(row);
    const ready = { ...row, state: "ready", updatedAt: "2026-11-21T00:00:01Z" } as const;
    await store.write(ready);
    expect(await store.read(2026)).toEqual(ready);
    expect(await store.readClassification(2026)).toBeNull();
    await store.writeClassification(row, row.updatedAt, "schedule unavailable");
    const checkpoint = await store.readClassification(2026);
    expect(checkpoint).toEqual({
      season: 2026,
      sourceHash: hash,
      competitionHash: null,
      completedAt: row.updatedAt,
      policyVersion: COMPETITION_CLASSIFICATION_POLICY_VERSION,
      error: "schedule unavailable",
    });
    if (checkpoint === null) throw new Error("Missing classification checkpoint");
    checkpoint.error = null;
    await store.write(ready);
    expect((await store.readClassification(2026))?.error).toBe("schedule unavailable");
  } finally {
    await workspace.close();
  }
});

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
    h.leaveUnclassified(1);
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
function harness(workspace: StagingWorkspace, now?: () => Date) {
  let sources = [2025, 2026].map((season) => ({
    season,
    sourceHash: hash,
    competitionHash: null as string | null,
    unclassified: 1,
  }));
  let busy = false;
  let unclassified = 0;
  const order: string[] = [];
  const repository = {
    seasons: async () => structuredClone(sources),
    current: vi.fn<(season: number) => Promise<ReturnType<typeof competitionFixture> | null>>(
      async () => null,
    ),
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
          ? { ...source, competitionHash: changedHash, unclassified }
          : source,
      );
      return {
        datasetHash: changedHash,
        matched: 1,
        unclassified,
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
    now,
  );
  return {
    manager,
    repository,
    models,
    collect,
    order,
    leaveUnclassified: (count: number) => {
      unclassified = count;
    },
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

it("refreshes legacy ready seasons immediately and preserves manual mode", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-preparation-legacy-"));
  const workspace = await StagingWorkspace.open(dir.path);
  const now = () => new Date("2026-11-21T00:00:01Z");
  const h = harness(workspace, now);
  const disabled = new AnalysisPreparationManager(
    h.repository,
    workspace.analysisPreparation,
    h.collect,
    h.models,
    () => false,
    now,
    undefined,
    false,
  );
  try {
    for (const season of [2025, 2026]) {
      await h.repository.adopt(competitionFixture(season, []));
      await workspace.analysisPreparation.write({
        version: 1,
        season,
        sourceHash: hash,
        competitionHash: changedHash,
        unclassified: 0,
        state: "ready",
        error: null,
        updatedAt: "2026-11-21T00:00:00Z",
      });
    }
    h.repository.current.mockImplementation((season) => h.collect(season));
    await disabled.check();
    expect((await disabled.status()).preparation.map((row) => row.state)).toEqual([
      "ready",
      "ready",
    ]);
    expect(h.collect).not.toHaveBeenCalled();
    expect((await h.manager.status()).preparation.map((row) => row.state)).toEqual([
      "pending",
      "pending",
    ]);
    await h.manager.check();
    expect(h.repository.current).not.toHaveBeenCalled();
    expect(h.collect.mock.calls.map(([season]) => season)).toEqual([2026, 2025]);
    await h.manager.check();
    expect(h.collect).toHaveBeenCalledTimes(2);
    expect((await h.manager.status()).preparation.map((row) => row.state)).toEqual([
      "ready",
      "ready",
    ]);
  } finally {
    await disabled.close();
    await h.manager.close();
    await workspace.close();
  }
});

it("keeps classification retries independent of later model work and restarts", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-preparation-retry-"));
  const workspace = await StagingWorkspace.open(dir.path);
  let time = "2026-11-21T00:00:00Z";
  const now = () => new Date(time);
  const h = harness(workspace, now);
  const store = workspace.analysisPreparation;
  const restarted = new AnalysisPreparationManager(
    h.repository,
    store,
    h.collect,
    h.models,
    () => false,
    now,
  );
  try {
    h.collect.mockRejectedValueOnce(new Error("official schedule unavailable"));
    await h.manager.check();
    expect(await store.readClassification(2026)).toMatchObject({
      completedAt: now().toISOString(),
      error: "official schedule unavailable",
    });
    await h.manager.close();
    const failed = await store.readClassification(2026);
    h.change(2025);
    h.collect.mockClear();
    time = "2026-11-21T05:59:59Z";
    const modelStarted = Promise.withResolvers<undefined>();
    const finishModel = Promise.withResolvers<undefined>();
    h.models.afterImport.mockImplementation(async (season) => {
      if (season !== 2026) return;
      modelStarted.resolve(undefined);
      await finishModel.promise;
    });
    const checking = restarted.check();
    try {
      await modelStarted.promise;
      expect(
        (await restarted.status()).preparation.find((row) => row.season === 2026),
      ).toMatchObject({ state: "models" });
    } finally {
      finishModel.resolve(undefined);
      await checking;
    }
    expect(h.collect.mock.calls.map(([season]) => season)).toEqual([2025]);
    expect(await store.readClassification(2026)).toEqual(failed);
    expect((await restarted.status()).preparation.find((row) => row.season === 2026)).toMatchObject(
      {
        state: "failed",
        error: "official schedule unavailable",
        updatedAt: "2026-11-21T05:59:59.000Z",
      },
    );
    time = "2026-11-21T06:00:00Z";
    h.collect.mockRejectedValueOnce(new Error("official schedule still unavailable"));
    await restarted.check();
    expect(h.collect.mock.calls.map(([season]) => season)).toEqual([2025, 2026]);
    h.change(2026);
    await restarted.check();
    expect(h.collect.mock.calls.map(([season]) => season)).toEqual([2025, 2026, 2026]);
    expect(await store.readClassification(2026)).toMatchObject({
      sourceHash: changedHash,
      competitionHash: changedHash,
      error: null,
    });
  } finally {
    await h.manager.close();
    await restarted.close();
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
        readClassification: (season) => store.readClassification(season),
        writeClassification: (...args) => store.writeClassification(...args),
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
    h.collect.mockClear();
    await h.manager.check();
    expect(h.models.afterImport.mock.calls.map(([season]) => season)).toEqual([2026]);
    expect(h.collect).not.toHaveBeenCalled();
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
    expect(await workspace.analysisPreparation.readClassification(2026)).toBeNull();
    await h.manager.close();
  } finally {
    await workspace.close();
  }
});
