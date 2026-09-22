import Fastify from "fastify";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { analyzeParkEnvironment } from "@kbo/game-core";
import { PitchQualityRepository, ParkEnvironmentRepository } from "@kbo/persistence";
import { inlineComputation } from "../src/computation.js";
import { pitchQualityRoutes } from "../src/routes/pitch-quality.js";
import { parkEnvironmentRoutes } from "../src/routes/park-environment.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";
afterEach(() => vi.restoreAllMocks());
it("decodes model queries strictly and returns descriptive results without a trained artifact", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } }),
    pool = new Pool({ max: 1 }),
    models = { read: vi.fn(async () => null) },
    scope = resolveAnalysisScope({ season: 2025 }, "regular");
  vi.spyOn(PitchQualityRepository.prototype, "read").mockResolvedValue({
    rows: [],
    scope,
    pitcherId: "p",
    sourceHash: "a".repeat(64),
    model: null,
    modelHash: null,
  });
  vi.spyOn(ParkEnvironmentRepository.prototype, "read").mockResolvedValue(
    analyzeParkEnvironment(scope, "a".repeat(64), [], null, null),
  );
  installHttpErrorHandler(app);
  await app.register(pitchQualityRoutes, { pool, models, computation: inlineComputation });
  await app.register(parkEnvironmentRoutes, { pool, models });
  try {
    for (const path of ["pitch-quality/p", "park-environment"]) {
      const url = `/api/v2/analysis/${path}?season=2025`,
        response = await app.inject(url);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ scope });
      expect((await app.inject(`${url}&unknown=1`)).statusCode).toBe(400);
      expect((await app.inject(`/api/v2/analysis/${path}?season=wrong`)).statusCode).toBe(400);
    }
    expect(models.read).toHaveBeenCalledWith(2024);
  } finally {
    await app.close();
    await pool.end();
  }
});
