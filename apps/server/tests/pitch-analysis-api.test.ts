import { resolveAnalysisScope } from "@kbo/contracts";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PitchAnalysisRepository } from "@kbo/persistence";
import { PitchAnalysisResponseSchema } from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { pitchAnalysisRoutes } from "../src/routes/pitch-analysis.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";
import { calibrationSummary } from "../../../tests/helpers/pitch-calibration.js";

describe("pitch analysis HTTP contracts", () => {
  it("requires a season and delegates a strict read response", async () => {
    const catalog = vi.spyOn(PitchAnalysisRepository.prototype, "catalog").mockResolvedValue({
      season: 2024,
      scope: resolveAnalysisScope({ season: 2024 }),
      pitchers: [],
    });
    const response = {
      modelVersion: 2 as const,
      calibration: calibrationSummary(0),
      season: 2024,
      pitcherId: "p1",
      sourceHash: "a".repeat(64),
      referenceSourceHash: "a".repeat(64),
      profile: { groups: [], months: [] },
      baseline: null,
      referenceDistribution: null,
      actualPitchCount: 0,
      missingTrackingCount: 0,
      invalidTrackingCount: 0,
      points: [],
    };
    const analyze = vi
      .spyOn(PitchAnalysisRepository.prototype, "analyze")
      .mockResolvedValue(response);
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    installHttpErrorHandler(app);
    const pool = new Pool();
    await app.register(pitchAnalysisRoutes, { pool, references: { getOrCreate: vi.fn() } });
    try {
      expect((await app.inject("/api/v2/analysis/pitch-shape")).statusCode).toBe(400);
      expect((await app.inject("/api/v2/analysis/pitch-shape?season=bad")).statusCode).toBe(400);
      expect((await app.inject("/api/v2/analysis/pitch-shape?season=2024")).json()).toEqual({
        season: 2024,
        scope: resolveAnalysisScope({ season: 2024 }),
        pitchers: [],
      });
      const result = await app.inject("/api/v2/analysis/pitch-shape/p1?season=2024");
      expect(result.statusCode).toBe(200);
      expect(Value.Check(PitchAnalysisResponseSchema, result.json())).toBe(true);
      expect(analyze).toHaveBeenCalledWith(2024, "p1", {});
      expect(result.json().clustering).toMatchObject({
        algorithm: "gmm",
        modelVersion: 2,
        defaultClusterCount: 0,
        status: "empty",
      });
      for (const count of ["0", "-1", "1.5", "bad", "100001", "1"]) {
        expect(
          (await app.inject(`/api/v2/analysis/pitch-shape/p1?season=2024&clusterCount=${count}`))
            .statusCode,
        ).toBe(400);
      }
      expect(catalog).toHaveBeenCalledWith(2024, {});

      analyze.mockClear();
      const recheck = vi
        .spyOn(PitchAnalysisRepository.prototype, "readSourceHash")
        .mockResolvedValue(response.sourceHash);
      const comparison =
        "/api/v2/analysis/pitch-shape/p1/comparison?season=2024&dateFrom=2024-04-01&compareSeason=2025";
      const compared = await app.inject(comparison);
      expect(compared.statusCode, compared.body).toBe(200);
      expect(analyze.mock.calls).toEqual([
        [2024, "p1", { dateFrom: "2024-04-01" }],
        [2025, "p1", {}],
      ]);
      expect(recheck).toHaveBeenCalledExactlyOnceWith({ season: 2024, dateFrom: "2024-04-01" });
      recheck.mockResolvedValueOnce("c".repeat(64));
      expect((await app.inject(comparison)).statusCode).toBe(400);
    } finally {
      await app.close();
      await pool.end();
      vi.restoreAllMocks();
    }
  });
});
