import { mkdtempDisposable, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisModelJobSchema,
  AnalysisModelManagementSchema,
  type AnalysisModelStatus,
} from "@kbo/contracts";
import {
  StagingWorkspace,
  AnalysisModelSourceRepository,
  pitchQualitySourceHash,
} from "@kbo/persistence";
import { modelTrainingPeriod, trainPitchQuality } from "@kbo/game-core";
import {
  AnalysisModelService,
  MODEL_ORDER,
  ModelSourceChangedError,
} from "../../apps/server/src/analysis-model-service.js";
import { AnalysisModelJobManager } from "../../apps/server/src/jobs/analysis-model-job-manager.js";
import { analysisModelRoutes } from "../../apps/server/src/routes/analysis-models.js";
import { installHttpErrorHandler } from "../../apps/server/src/http-error-handler.js";
import type { createApp } from "../../apps/server/src/app.js";
const Fastify: () => ReturnType<typeof createApp> = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
)("fastify");
const hash = createHash("sha256").update("test").digest("hex");
const statuses = (state: AnalysisModelStatus["state"] = "current"): AnalysisModelStatus[] =>
  MODEL_ORDER.map((kind) => ({
    kind,
    ...modelTrainingPeriod(kind, 2025),
    state,
    sourceHash: hash,
    modelHash: state === "missing" ? null : hash,
    adoptedTargets: 0,
    totalTargets: 1,
  }));
afterEach(() => vi.restoreAllMocks());
it("persists before dispatch, serializes dependency order, skips current models and returns an idempotent job across restart", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-model-jobs-"));
  const workspace = await StagingWorkspace.open(dir.path);
  const values = statuses();
  for (const row of values)
    if (row.kind === "quality" || row.kind === "matchup") row.state = "stale";
  const calls: string[] = [];
  const service = {
    status: async () => values,
    refresh: vi.fn(async (kind: (typeof MODEL_ORDER)[number]) => {
      calls.push(kind);
      expect(
        (await workspace.analysisModelJobs.latest())?.steps.find((s) => s.kind === kind)?.state,
      ).toBe("running");
      return hash;
    }),
  };
  const failures: unknown[] = [];
  const manager = new AnalysisModelJobManager(
    workspace.analysisModelJobs,
    service,
    undefined,
    undefined,
    (error) => failures.push(error),
  );
  try {
    await manager.start();
    const id = randomUUID();
    await manager.create(id, false);
    await vi.waitFor(async () => {
      expect(failures).toEqual([]);
      expect((await manager.get(id)).state).toBe("succeeded");
    });
    const job = await manager.get(id);
    expect(Value.Check(AnalysisModelJobSchema, job)).toBe(true);
    expect(calls).toEqual(["quality", "matchup"]);
    expect(job.steps.slice(0, 4).every((s) => s.state === "skipped")).toBe(true);
    await manager.close();
    const restarted = new AnalysisModelJobManager(workspace.analysisModelJobs, service);
    await restarted.start();
    expect(await restarted.create(id, false)).toEqual(job);
    await expect(restarted.create(id, true)).rejects.toThrow("조건");
    expect(calls).toHaveLength(2);
    await restarted.close();
  } finally {
    await manager.close();
    await workspace.close();
  }
});
it("rejects concurrent jobs, cancels a worker and retains successfully published preceding models", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-model-cancel-"));
  const workspace = await StagingWorkspace.open(dir.path);
  const service = {
    status: async () => statuses("missing"),
    refresh: vi.fn(async (kind: (typeof MODEL_ORDER)[number], signal: AbortSignal) => {
      if (kind === "re24") return hash;
      return new Promise<string>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      );
    }),
  };
  const manager = new AnalysisModelJobManager(workspace.analysisModelJobs, service);
  try {
    await manager.start();
    const id = randomUUID();
    await manager.create(id, false);
    await vi.waitFor(() => expect(service.refresh).toHaveBeenCalledTimes(2));
    await expect(manager.create(randomUUID(), false)).rejects.toThrow("실행 중");
    await manager.cancel(id);
    await vi.waitFor(async () => expect((await manager.get(id)).state).toBe("cancelled"));
    const job = await manager.get(id);
    expect(job.steps[0]?.state).toBe("published");
    expect(job.steps[1]?.state).toBe("cancelled");
    expect(service.refresh).toHaveBeenCalledTimes(2);
  } finally {
    await manager.close();
    await workspace.close();
  }
});
it("recovers interrupted jobs without retraining and runs automatic checks only when enabled", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-model-recovery-"));
  const workspace = await StagingWorkspace.open(dir.path);
  const id = randomUUID(),
    time = "2026-09-20T00:00:00Z";
  await workspace.analysisModelJobs.save({
    id,
    version: 2,
    applicationSeason: 2025,
    force: false,
    trigger: "manual",
    sequence: 3,
    state: "running",
    createdAt: time,
    updatedAt: time,
    error: null,
    steps: MODEL_ORDER.map((kind) => ({
      kind,
      state: "pending",
      phase: "waiting",
      modelHash: null,
    })),
  });
  const service = { status: vi.fn(async () => statuses()), refresh: vi.fn(async () => hash) };
  const manager = new AnalysisModelJobManager(workspace.analysisModelJobs, service);
  try {
    await manager.start();
    expect((await manager.get(id)).state).toBe("failed");
    await manager.check();
    expect(service.status).not.toHaveBeenCalled();
    await manager.setPolicy(true);
    await manager.check();
    expect(service.refresh).not.toHaveBeenCalled();
    await manager.setPolicy(false);
    expect(await workspace.analysisModelJobs.policy()).toEqual({ version: 2, enabledSeasons: [] });
  } finally {
    await manager.close();
    await workspace.close();
  }
});
it("checks freshly changed sources before publication and never replaces a previous artifact on failure", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-model-source-"));
  const workspace = await StagingWorkspace.open(dir.path),
    pool = new Pool();
  const manifest = { version: 1 as const, through: 2024, seasons: [], games: [] };
  const sourceHash = pitchQualitySourceHash(manifest),
    model = trainPitchQuality([], [], sourceHash);
  const saved = await workspace.pitchQuality.save(model, manifest);
  vi.spyOn(AnalysisModelSourceRepository.prototype, "read").mockResolvedValue({
    re24: hash,
    count: hash,
    win: hash,
    park: hash,
    quality: hash,
    matchup: hash,
  });
  const service = new AnalysisModelService(pool, workspace, dir.path, async () => ({
    kind: "quality",
    model,
    manifest,
  }));
  try {
    await expect(
      service.refresh("quality", new AbortController().signal, async () => {}),
    ).rejects.toBeInstanceOf(ModelSourceChangedError);
    expect((await workspace.pitchQuality.read(2024))?.hash).toBe(saved);
    expect((await service.status()).find((s) => s.kind === "quality")?.state).toBe("stale");
  } finally {
    await pool.end();
    await workspace.close();
  }
});
it("validates route bodies, reports conflicts and returns the durable accepted job", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-model-api-"));
  const workspace = await StagingWorkspace.open(dir.path);
  const manager = new AnalysisModelJobManager(workspace.analysisModelJobs, {
    status: async () => statuses(),
    refresh: async () => hash,
  });
  const app = Fastify();
  installHttpErrorHandler(app);
  await manager.start();
  await app.register(analysisModelRoutes, { jobs: manager });
  try {
    const status = await app.inject("/api/v2/analysis/models");
    expect(Value.Check(AnalysisModelManagementSchema, status.json())).toBe(true);
    const id = randomUUID();
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v2/analysis/model-jobs",
      payload: { requestId: id, force: false, applicationSeason: 2025 },
    });
    expect(accepted.statusCode).toBe(202);
    expect(Value.Check(AnalysisModelJobSchema, accepted.json())).toBe(true);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v2/analysis/model-jobs",
          payload: { requestId: id, force: true, applicationSeason: 2025 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v2/analysis/model-jobs",
          payload: { requestId: "../bad", force: false },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject(`/api/v2/analysis/model-jobs/${randomUUID()}`)).statusCode).toBe(404);
    expect((await app.inject("/api/v2/analysis/models?season=2026")).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v2/analysis/model-jobs",
          payload: { requestId: randomUUID(), force: true, applicationSeason: 2020 },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await manager.close();
    await app.close();
    await workspace.close();
  }
});

it("binds idempotency and dispatch to the season, including unsupported steps on a forced refresh", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-season-jobs-"));
  const workspace = await StagingWorkspace.open(dir.path);
  const service = {
    status: vi.fn(async (season = 2025) =>
      statuses("missing").map((s) => ({
        ...s,
        ...modelTrainingPeriod(s.kind, season),
        state: s.kind === "win" && season < 2025 ? ("unsupported" as const) : s.state,
      })),
    ),
    refresh: vi.fn(async () => hash),
  };
  const manager = new AnalysisModelJobManager(workspace.analysisModelJobs, service);
  try {
    await manager.start();
    const id = randomUUID();
    await manager.create(id, true, 2023);
    await vi.waitFor(async () => expect((await manager.get(id)).state).toBe("succeeded"));
    expect(service.refresh).toHaveBeenCalledTimes(5);
    expect(service.refresh.mock.calls.every((call) => call[3] === 2023)).toBe(true);
    expect((await manager.get(id)).steps.find((s) => s.kind === "win")?.state).toBe("unsupported");
    await expect(manager.create(id, true, 2024)).rejects.toThrow("조건");
    await expect(manager.create(randomUUID(), false, 2022)).rejects.toThrow("검증");
    await manager.setPolicy(true, 2023);
    await manager.setPolicy(true, 2025);
    await manager.setPolicy(false, 2023);
    expect((await workspace.analysisModelJobs.policy()).enabledSeasons).toEqual([2025]);
  } finally {
    await manager.close();
    await workspace.close();
  }
});

it("reads the exact legacy job/policy as 2025 without rewriting and rejects ambiguous formats", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-legacy-model-"));
  const workspace = await StagingWorkspace.open(dir.path);
  const manager = new AnalysisModelJobManager(workspace.analysisModelJobs, {
    status: async () => statuses(),
    refresh: async () => hash,
  });
  try {
    await manager.start();
    const id = randomUUID();
    await manager.create(id, false);
    await vi.waitFor(async () => expect((await manager.get(id)).state).toBe("succeeded"));
    await manager.close();
    const current = await manager.get(id);
    const legacy = Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== "version" && key !== "applicationSeason"),
    );
    const file = path.join(dir.path, "analysis", "jobs", `${id}.json`),
      original = JSON.stringify(legacy);
    await writeFile(file, original);
    await writeFile(
      path.join(dir.path, "analysis", "jobs", "policy.json"),
      JSON.stringify({ enabled: true }),
    );
    expect(await workspace.analysisModelJobs.get(id)).toEqual({
      ...legacy,
      version: 2,
      applicationSeason: 2025,
    });
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await workspace.analysisModelJobs.policy()).toEqual({
      version: 2,
      enabledSeasons: [2025],
    });
    await writeFile(file, JSON.stringify({ ...legacy, applicationSeason: 2024 }));
    await expect(workspace.analysisModelJobs.get(id)).rejects.toThrow();
  } finally {
    await manager.close();
    await workspace.close();
  }
});

it("rejects wrong-period training output before publication and avoids DB work for insufficient history", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-model-period-"));
  const workspace = await StagingWorkspace.open(dir.path),
    pool = new Pool();
  const manifest = { version: 1 as const, through: 2024, seasons: [], games: [] },
    sourceHash = pitchQualitySourceHash(manifest),
    model = trainPitchQuality([], [], sourceHash);
  const sources = vi.spyOn(AnalysisModelSourceRepository.prototype, "read").mockResolvedValue({
    re24: sourceHash,
    count: sourceHash,
    win: sourceHash,
    park: sourceHash,
    quality: sourceHash,
    matchup: sourceHash,
  });
  const train = vi.fn(async () => ({ kind: "quality" as const, model, manifest }));
  const service = new AnalysisModelService(pool, workspace, dir.path, train);
  try {
    expect((await service.status(2020)).every((s) => s.state === "unsupported")).toBe(true);
    expect(sources).not.toHaveBeenCalled();
    await expect(
      service.refresh("quality", new AbortController().signal, async () => {}, 2023),
    ).rejects.toBeInstanceOf(ModelSourceChangedError);
    expect(await workspace.pitchQuality.read(2022)).toBeNull();
  } finally {
    await pool.end();
    await workspace.close();
  }
});

it("automatically refreshes enabled seasons serially without retrying unsupported win models", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-auto-seasons-"));
  const workspace = await StagingWorkspace.open(dir.path);
  await workspace.analysisModelJobs.setPolicy(2023, true);
  await workspace.analysisModelJobs.setPolicy(2024, true);
  let active = 0,
    peak = 0;
  const calls: number[] = [];
  const manager = new AnalysisModelJobManager(workspace.analysisModelJobs, {
    status: async (season = 2025) =>
      statuses("missing").map((s) => ({
        ...s,
        ...modelTrainingPeriod(s.kind, season),
        state: s.kind === "win" ? ("unsupported" as const) : s.state,
      })),
    refresh: async (_kind, _signal, phase, season = 2025) => {
      active++;
      peak = Math.max(peak, active);
      calls.push(season);
      await phase("checking");
      active--;
      return hash;
    },
  });
  try {
    await manager.start();
    await manager.check();
    expect(peak).toBe(1);
    expect(calls).toEqual([2023, 2023, 2023, 2023, 2023, 2024, 2024, 2024, 2024, 2024]);
    expect((await workspace.analysisModelJobs.latest())?.applicationSeason).toBe(2024);
  } finally {
    await manager.close();
    await workspace.close();
  }
});
