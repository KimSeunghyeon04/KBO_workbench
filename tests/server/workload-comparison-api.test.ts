import { createRequire } from "node:module";
import type { createApp } from "../../apps/server/src/app.js";
const Fastify: () => ReturnType<typeof createApp> = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
)("fastify");
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { resolveAnalysisScope, WorkloadComparisonResponseSchema } from "@kbo/contracts";
import { WorkloadComparisonRepository } from "@kbo/persistence";
import { pitcherWorkloadRoutes } from "../../apps/server/src/routes/pitcher-workload.js";
import { compute } from "../../apps/server/src/computation.js";
import { installHttpErrorHandler } from "../../apps/server/src/http-error-handler.js";
import { workloadComparisonFixture } from "../helpers/workload-comparison.js";
it("strictly validates scope and sends only hydrated workload input to the existing worker", async () => {
  const query = { season: 2024 },
    pool = new Pool(),
    app = Fastify();
  const read = vi.spyOn(WorkloadComparisonRepository.prototype, "read").mockResolvedValue({
    query,
    scope: resolveAnalysisScope(query, "regular"),
    pitcherId: "p",
    sourceHash: "a".repeat(64),
    ...workloadComparisonFixture(),
  });
  installHttpErrorHandler(app);
  await app.register(pitcherWorkloadRoutes, {
    pool,
    computation: {
      run: async (input, signal) => {
        expect(signal?.aborted).toBe(false);
        return compute(input);
      },
    },
  });
  try {
    const response = await app.inject("/api/v2/analysis/pitcher-workload/p/comparison?season=2024");
    expect(response.statusCode).toBe(200);
    expect(Value.Check(WorkloadComparisonResponseSchema, response.json())).toBe(true);
    expect(response.json().actualPitches).toBe(300);
    expect(
      (await app.inject("/api/v2/analysis/pitcher-workload/p/comparison?season=2024&dateTo=bad"))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject("/api/v2/analysis/pitcher-workload/p/comparison?season=2024&threshold=1"))
        .statusCode,
    ).toBe(400);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
    await app.close();
    await pool.end();
  }
});
