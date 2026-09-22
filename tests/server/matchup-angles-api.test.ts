import { createRequire } from "node:module";
import type { createApp } from "../../apps/server/src/app.js";
const Fastify: () => ReturnType<typeof createApp> = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
)("fastify");
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MatchupModelRepository, PitchAnglesRepository } from "@kbo/persistence";
import {
  resolveAnalysisScope,
  MatchupModelResponseSchema,
  PitchAnglesResponseSchema,
} from "@kbo/contracts";
import { matchupRoutes } from "../../apps/server/src/routes/matchups.js";
import { pitchAnglesRoutes } from "../../apps/server/src/routes/pitch-angles.js";
import { compute } from "../../apps/server/src/computation.js";
import { installHttpErrorHandler } from "../../apps/server/src/http-error-handler.js";
afterEach(() => vi.restoreAllMocks());
it("strictly validates modeled matchup and angle routes while keeping model absence a normal response", async () => {
  const pool = new Pool(),
    app = Fastify(),
    scope = resolveAnalysisScope({ season: 2025 }, "regular"),
    query = { season: 2025, pitcherId: "p", batterId: "b" };
  installHttpErrorHandler(app);
  const read = vi.spyOn(MatchupModelRepository.prototype, "read").mockResolvedValue({
    query,
    scope,
    sourceHash: "a".repeat(64),
    pitcherRows: [],
    batterRows: [],
    model: null,
    modelHash: null,
  });
  vi.spyOn(PitchAnglesRepository.prototype, "read").mockResolvedValue({
    scope,
    pitcherId: "p",
    sourceHash: "a".repeat(64),
    rows: [],
  });
  await app.register(matchupRoutes, {
    pool,
    models: { read: async () => null },
    computation: { run: async (input) => compute(input) },
  });
  await app.register(pitchAnglesRoutes, {
    pool,
    computation: { run: async (input) => compute(input) },
  });
  try {
    const r = await app.inject(
      "/api/v2/analysis/matchups/model?season=2025&pitcherId=p&batterId=b",
    );
    expect(r.statusCode).toBe(200);
    expect(Value.Check(MatchupModelResponseSchema, r.json())).toBe(true);
    expect(r.json().status).toBe("model_unavailable");
    expect(
      (await app.inject("/api/v2/analysis/matchups/model?season=2025&pitcherId=p")).statusCode,
    ).toBe(400);
    expect(read).toHaveBeenCalledTimes(1);
    const angle = await app.inject("/api/v2/analysis/pitch-angles/p?season=2025");
    expect(angle.statusCode).toBe(200);
    expect(Value.Check(PitchAnglesResponseSchema, angle.json())).toBe(true);
    expect(
      (await app.inject("/api/v2/analysis/pitch-angles/p?season=2025&dateTo=not-a-date"))
        .statusCode,
    ).toBe(400);
  } finally {
    await app.close();
    await pool.end();
  }
});
