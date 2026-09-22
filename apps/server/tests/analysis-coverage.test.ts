import Fastify from "fastify";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { AnalysisCoverageRepository } from "@kbo/persistence";
import { analysisCoverageRoutes } from "../src/routes/analysis-coverage.js";
import { coverageFixture } from "../../../tests/helpers/analysis-coverage.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";

it("requires a valid season and exposes a strict coverage response", async () => {
  const read = vi.spyOn(AnalysisCoverageRepository.prototype, "inspect").mockResolvedValue({
    sourceKey: "a".repeat(64),
    scope: coverageFixture().scope,
    response: coverageFixture(),
  });
  const app = Fastify();
  const pool = new Pool();
  installHttpErrorHandler(app);
  await app.register(analysisCoverageRoutes, { pool, calibrate: vi.fn() });
  try {
    for (const query of ["", "?season=bad", "?season=2025.5", "?season=1800"])
      expect((await app.inject(`/api/v2/analysis/coverage${query}`)).statusCode).toBe(400);
    const response = await app.inject("/api/v2/analysis/coverage?season=2025");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(coverageFixture());
    expect(read).toHaveBeenCalledWith(2025, {});
  } finally {
    await app.close();
    await pool.end();
    vi.restoreAllMocks();
  }
});

it("returns 202 without waiting, coalesces preparation, and exposes failure/retry", async () => {
  const inspection = { sourceKey: "a".repeat(64), scope: coverageFixture().scope, response: null };
  const inspect = vi
    .spyOn(AnalysisCoverageRepository.prototype, "inspect")
    .mockResolvedValue(inspection);
  const pending = Promise.withResolvers<ReturnType<typeof coverageFixture>>();
  const read = vi
    .spyOn(AnalysisCoverageRepository.prototype, "read")
    .mockReturnValue(pending.promise);
  const app = Fastify(),
    pool = new Pool();
  installHttpErrorHandler(app);
  await app.register(analysisCoverageRoutes, { pool, calibrate: vi.fn() });
  try {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => app.inject("/api/v2/analysis/coverage?season=2025")),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(202);
      expect(response.headers["retry-after"]).toBe("1");
      expect(response.json()).toMatchObject({
        state: "preparing",
        sourceKey: inspection.sourceKey,
      });
    }
    expect(read).toHaveBeenCalledTimes(1);
    pending.reject(new Error("private database failure"));
    await vi.waitFor(async () =>
      expect((await app.inject("/api/v2/analysis/coverage?season=2025")).json()).toMatchObject({
        state: "failed",
      }),
    );
    expect(read).toHaveBeenCalledTimes(1);
    read.mockImplementation(async () => {
      inspect.mockResolvedValue({ ...inspection, response: coverageFixture() });
      return coverageFixture();
    });
    expect(
      (await app.inject({ method: "POST", url: "/api/v2/analysis/coverage/prepare?season=2025" }))
        .statusCode,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect((await app.inject("/api/v2/analysis/coverage?season=2025")).json()).toEqual(
        coverageFixture(),
      ),
    );
    expect(read).toHaveBeenCalledTimes(2);
    // Changing source while an earlier result exists must request a new preparation.
    inspect.mockResolvedValue({ ...inspection, sourceKey: "b".repeat(64) });
    expect((await app.inject("/api/v2/analysis/coverage?season=2025")).statusCode).toBe(202);
  } finally {
    pending.resolve(coverageFixture());
    await app.close();
    await pool.end();
    vi.restoreAllMocks();
  }
});
