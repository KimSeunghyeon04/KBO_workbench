import { resolveAnalysisScope, type DisciplineQuery } from "@kbo/contracts";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import Fastify from "fastify";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { BatterDisciplineRepository, DisciplinePreparedWorkspace } from "@kbo/persistence";
import { BatterDisciplineService } from "../src/batter-discipline-service.js";
import { batterDisciplineRoutes } from "../src/routes/batter-discipline.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";
import { disciplineRow, disciplineSnapshot } from "../../../tests/helpers/batter-discipline.js";

describe("batter discipline API and worker", () => {
  it("shares pending requests, reuses the season, invalidates on source changes and closes", async () => {
    let source = disciplineSnapshot(
      Array.from({ length: 12001 }, (_, i) => disciplineRow({ pitchId: `p${i}` })),
    );
    const snapshot = vi.fn(async (season: number, hash?: string) => ({
      ...source,
      season,
      rows: hash === source.sourceHash ? null : source.rows,
    }));
    const service = new BatterDisciplineService({ snapshot });
    try {
      const first = service.analyze({ season: 2024 }, "b1");
      const second = service.analyze({ season: 2024 }, "b1");
      expect(first).toBe(second);
      let ticked = false;
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          ticked = true;
          resolve();
        }, 5),
      );
      expect(ticked).toBe(true);
      expect((await first).points).toHaveLength(12001);
      expect(snapshot).toHaveBeenCalledTimes(1);
      await service.analyze({ season: 2024, balls: 1 }, "b1");
      expect(snapshot).toHaveBeenLastCalledWith(2024, "a".repeat(64), {});
      source = { ...disciplineSnapshot(), sourceHash: "b".repeat(64) };
      expect((await service.analyze({ season: 2024 }, "b1")).points).toHaveLength(1);
      expect((await service.analyze({ season: 2025 }, "b1")).query.season).toBe(2025);
      expect(snapshot).toHaveBeenLastCalledWith(2025, undefined, {});
    } finally {
      await service.close();
    }
    await expect(service.analyze({ season: 2024 }, "b1")).rejects.toThrow("closed");
  }, 15000);
  it("rejects active and queued requests on shutdown", async () => {
    const snapshot = vi.fn(async () => disciplineSnapshot());
    const service = new BatterDisciplineService({ snapshot });
    const pending = Promise.allSettled([
      service.analyze({ season: 2024 }, "b1"),
      service.analyze({ season: 2025 }, "b1"),
    ]);
    await service.close();
    expect((await pending).every((p) => p.status === "rejected")).toBe(true);
  });

  it("reuses prepared rows across workers and rebuilds outdated or damaged files", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "discipline-prepared-"));
    const scope = { season: 2024, competition: "regular" } as const;
    const guard = vi.fn(async () => {});
    const store = new DisciplinePreparedWorkspace(directory.path, guard);
    await store.write(scope, Buffer.from("incomplete"));
    guard.mockClear();
    const original = disciplineSnapshot([disciplineRow({ pitchId: "new-pitch" })]);
    const snapshot = vi.fn(async () => ({ ...original, sourceHash: "b".repeat(64) }));
    const sourceHash = vi.fn(async () => "b".repeat(64)).mockResolvedValueOnce("a".repeat(64));
    const cache = { store, sourceHash, reportError: vi.fn() };
    const analyze = async (query: DisciplineQuery = { season: 2024 }) => {
      const service = new BatterDisciplineService({ snapshot }, cache);
      try {
        return await service.analyze(query, "b1");
      } finally {
        await service.close();
      }
    };

    const first = await analyze();
    expect(first.sourceHash).toBe("b".repeat(64));
    expect(first.points.map(({ pitchId }) => pitchId)).toEqual(["new-pitch"]);
    expect(first.coverage.actualPitches).toBe(1);
    expect(guard).toHaveBeenCalledTimes(1);
    snapshot.mockClear();
    expect(await analyze({ season: 2024, competition: "regular" })).toEqual({
      ...first,
      query: { season: 2024, competition: "regular" },
    });
    expect(snapshot).not.toHaveBeenCalled();

    const updated = { ...original, sourceHash: "c".repeat(64), rows: [] };
    sourceHash.mockResolvedValue(updated.sourceHash);
    snapshot.mockResolvedValue(updated);
    expect((await analyze()).coverage.actualPitches).toBe(0);
    expect(snapshot).toHaveBeenCalledTimes(1);

    await store.write(scope, Buffer.from("damaged"));
    snapshot.mockClear();
    expect((await analyze()).sourceHash).toBe(updated.sourceHash);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("responds in pitch order during a blocked save and drains the latest prepared rows on close", async () => {
    let source = disciplineSnapshot([
      disciplineRow({ pitchId: "pitch-b", swing: true }),
      disciplineRow({ pitchId: "pitch-a" }),
    ]);
    const snapshot = vi.fn(async () => source);
    const firstWriteStarted = Promise.withResolvers<undefined>();
    const firstWrite = Promise.withResolvers<undefined>();
    const lastWriteStarted = Promise.withResolvers<undefined>();
    const lastWrite = Promise.withResolvers<undefined>();
    let saved: Uint8Array | undefined;
    const cache = {
      store: {
        read: async () => saved,
        write: vi
          .fn<DisciplinePreparedWorkspace["write"]>()
          .mockImplementationOnce(async (_scope, artifact) => {
            firstWriteStarted.resolve(undefined);
            await firstWrite.promise;
            saved = artifact;
          })
          .mockImplementationOnce(async (_scope, artifact) => {
            lastWriteStarted.resolve(undefined);
            await lastWrite.promise;
            saved = artifact;
          }),
      },
      sourceHash: async () => source.sourceHash,
      reportError: vi.fn(),
    };
    const service = new BatterDisciplineService({ snapshot }, cache);
    const query = { season: 2024 };
    try {
      const result = service.analyze(query, "b1");
      await firstWriteStarted.promise;
      const first = await Promise.race([
        result,
        new Promise<null>((resolve) => setImmediate(() => resolve(null))),
      ]);
      expect(first?.coverage.actualPitches).toBe(2);
      expect(first?.points.map(({ pitchId }) => pitchId)).toEqual(["pitch-b", "pitch-a"]);

      source = {
        ...disciplineSnapshot([disciplineRow({ pitchId: "intermediate" })]),
        sourceHash: "b".repeat(64),
      };
      expect((await service.analyze(query, "b1")).points.map(({ pitchId }) => pitchId)).toEqual([
        "intermediate",
      ]);
      source = {
        ...disciplineSnapshot([disciplineRow({ pitchId: "latest" })]),
        sourceHash: "c".repeat(64),
      };
      const latest = await service.analyze(query, "b1");
      expect(latest.points.map(({ pitchId }) => pitchId)).toEqual(["latest"]);
      expect(cache.store.write).toHaveBeenCalledOnce();

      const closed = vi.fn();
      const workerStopped = Promise.withResolvers<undefined>();
      const terminate = Worker.prototype.terminate;
      const terminating = vi.spyOn(Worker.prototype, "terminate").mockImplementationOnce(function (
        this: Worker,
      ) {
        return terminate.call(this).then((code) => {
          workerStopped.resolve(undefined);
          return code;
        });
      });
      try {
        const closing = service.close().then(closed);
        await workerStopped.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        firstWrite.resolve(undefined);
        await lastWriteStarted.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closed).not.toHaveBeenCalled();
        lastWrite.resolve(undefined);
        await closing;
      } finally {
        terminating.mockRestore();
      }
      expect(cache.store.write).toHaveBeenCalledTimes(2);

      snapshot.mockClear();
      const reopened = new BatterDisciplineService({ snapshot }, cache);
      try {
        expect(await reopened.analyze(query, "b1")).toEqual(latest);
        expect(snapshot).not.toHaveBeenCalled();
      } finally {
        await reopened.close();
      }
    } finally {
      firstWrite.resolve(undefined);
      lastWrite.resolve(undefined);
      await service.close();
    }
  });

  it("returns a correct response when saving the prepared rows fails", async () => {
    const snapshot = vi.fn(async () => disciplineSnapshot());
    const failure = new Error("read-only cache storage");
    const reportError = vi.fn();
    const sourceHash = vi.fn(async () => "a".repeat(64));
    const service = new BatterDisciplineService(
      { snapshot },
      {
        sourceHash,
        reportError,
        store: {
          read: async () => undefined,
          write: async () => {
            throw failure;
          },
        },
      },
    );
    try {
      expect((await service.analyze({ season: 2024 }, "b1")).coverage.actualPitches).toBe(1);
      expect(sourceHash).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
    expect(reportError).toHaveBeenCalledWith(failure);
  });
  it("validates filters and returns a strict API response", async () => {
    let firstPeriodHash = "a".repeat(64);
    const sourceHash = (season: number) => (season === 2026 ? firstPeriodHash : "a".repeat(64));
    const read = vi
      .spyOn(BatterDisciplineRepository.prototype, "snapshot")
      .mockImplementation(async (season) => ({
        ...disciplineSnapshot([disciplineRow({ season, gameDate: `${season}-06-01` })]),
        season,
        sourceHash: sourceHash(season),
      }));
    const readHash = vi
      .spyOn(BatterDisciplineRepository.prototype, "readSourceHash")
      .mockImplementation(async ({ season }) => sourceHash(season));
    const catalog = vi.spyOn(BatterDisciplineRepository.prototype, "catalog").mockResolvedValue({
      season: 2024,
      scope: resolveAnalysisScope({ season: 2024 }),
      batters: [],
    });
    const app = Fastify();
    const pool = new Pool();
    installHttpErrorHandler(app);
    await app.register(batterDisciplineRoutes, { pool, references: { getOrCreate: vi.fn() } });
    try {
      for (const query of [
        "",
        "season=bad",
        "season=2201",
        "season=2024&balls=4",
        "season=2024&strikes=-1",
        "season=2024&stance=bad",
      ])
        expect(
          (await app.inject(`/api/v2/analysis/batter-discipline/b1?${query}`)).statusCode,
        ).toBe(400);
      expect((await app.inject("/api/v2/analysis/batter-discipline?season=2024")).statusCode).toBe(
        200,
      );
      const response = await app.inject(
        "/api/v2/analysis/batter-discipline/b1?season=2024&balls=0",
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().coverage.locationPitches).toBe(1);
      expect(response.json().courseComparison.conventional.batter).toMatchObject({
        pitches: 1,
        outsidePitches: 0,
        chaseRate: null,
      });
      expect(response.json().courseComparison.paired).toHaveLength(3);

      const future = await app.inject("/api/v2/analysis/batter-discipline/b1?season=2027");
      expect(future.statusCode, future.body).toBe(200);
      expect(future.json()).toMatchObject({
        query: { season: 2027 },
        coverage: { locationPitches: 1 },
      });

      read.mockClear();
      const comparisonUrl =
        "/api/v2/analysis/batter-discipline/b1/comparison?season=2026&compareSeason=2027";
      const comparison = await app.inject(comparisonUrl);
      expect(comparison.statusCode, comparison.body).toBe(200);
      expect(comparison.json()).toMatchObject({
        first: { scope: { season: 2026 } },
        second: { scope: { season: 2027 } },
      });
      expect(read.mock.calls.map(([season]) => season)).toEqual([2026, 2027]);
      expect(readHash).toHaveBeenLastCalledWith({ season: 2026 });

      read.mockClear();
      const repeated = await app.inject(comparisonUrl);
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(repeated.json()).toEqual(comparison.json());
      expect(read).not.toHaveBeenCalled();

      // A changed source is rejected even if both period results were cache hits.
      readHash
        .mockResolvedValueOnce("a".repeat(64))
        .mockResolvedValueOnce("a".repeat(64))
        .mockResolvedValueOnce("b".repeat(64));
      expect((await app.inject(comparisonUrl)).statusCode).toBe(400);
      expect(read).not.toHaveBeenCalled();

      const narrower = await app.inject(comparisonUrl + "&dateFrom=2026-06-02");
      expect(narrower.statusCode, narrower.body).toBe(200);
      expect(narrower.json()).toMatchObject({
        first: {
          scope: { season: 2026, dateFrom: "2026-06-02" },
          samples: expect.arrayContaining([{ label: "지도 표본", count: 0 }]),
        },
        second: { scope: { season: 2027 } },
      });
      expect(read.mock.calls.map(([season]) => season)).toEqual([2026]);
      read.mockClear();

      firstPeriodHash = "b".repeat(64);
      const refreshed = await app.inject(comparisonUrl);
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(refreshed.json()).toMatchObject({
        first: { sourceHash: "b".repeat(64) },
        second: { sourceHash: "a".repeat(64) },
      });
      expect(read.mock.calls.map(([season]) => season)).toEqual([2026]);
    } finally {
      await app.close();
      await pool.end();
      read.mockRestore();
      readHash.mockRestore();
      catalog.mockRestore();
    }
  });
});
