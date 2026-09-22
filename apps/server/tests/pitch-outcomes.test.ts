import Fastify from "fastify";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { PitchLocationRepository, BatterProfileRepository } from "@kbo/persistence";
import { resolveAnalysisScope } from "@kbo/contracts";
import { analyzePitchLocation, analyzeBatterProfile } from "@kbo/game-core";
import { pitchLocationRoutes } from "../src/routes/pitch-location.js";
import { batterProfileRoutes } from "../src/routes/batter-profile.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";
it("validates concrete pitch outcome filters and returns strict independent PA results", async () => {
  vi.spyOn(PitchLocationRepository.prototype, "analyze").mockImplementation(async (q, id) =>
    analyzePitchLocation(
      q,
      id,
      resolveAnalysisScope({ season: q.season }, "regular"),
      "a".repeat(64),
      [],
      [],
    ),
  );
  vi.spyOn(BatterProfileRepository.prototype, "analyze").mockImplementation(async (q, id) =>
    analyzeBatterProfile(
      q,
      id,
      resolveAnalysisScope({ season: q.season }, "regular"),
      "a".repeat(64),
      [],
      [],
    ),
  );
  const app = Fastify(),
    pool = new Pool();
  installHttpErrorHandler(app);
  await app.register(pitchLocationRoutes, { pool });
  await app.register(batterProfileRoutes, { pool });
  try {
    for (const kind of ["pitch-location", "batter-profile"]) {
      expect((await app.inject(`/api/v2/analysis/${kind}/p1?season=2024`)).statusCode).toBe(200);
      for (const suffix of [
        "season=no",
        "season=2024&balls=4",
        "season=2024&cohort=unknown",
        "season=2024&strikes=-1",
      ]) {
        expect((await app.inject(`/api/v2/analysis/${kind}/p1?${suffix}`)).statusCode).toBe(400);
      }
    }
  } finally {
    await app.close();
    await pool.end();
    vi.restoreAllMocks();
  }
});
