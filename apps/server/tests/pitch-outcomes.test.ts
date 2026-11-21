import Fastify from "fastify";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { PitchLocationRepository, BatterProfileRepository } from "@kbo/persistence";
import {
  resolveAnalysisScope,
  pitchLocationComparisonQueries,
  PitchLocationComparisonResponseSchema,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { analyzePitchLocation, analyzeBatterProfile, comparePitchLocations } from "@kbo/game-core";
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

it("validates both location comparison periods and serializes a strict compact response", async () => {
  const compare = vi
    .spyOn(PitchLocationRepository.prototype, "compare")
    .mockImplementation(async (query, id) => {
      const queries = pitchLocationComparisonQueries(query);
      const period = (q: typeof queries.first) => {
        const { season, competition, dateFrom, dateTo } = q;
        return analyzePitchLocation(
          q,
          id,
          resolveAnalysisScope(
            {
              season,
              ...(competition === undefined ? {} : { competition }),
              ...(dateFrom === undefined ? {} : { dateFrom }),
              ...(dateTo === undefined ? {} : { dateTo }),
            },
            "regular",
          ),
          "a".repeat(64),
          [],
          [],
        );
      };
      return comparePitchLocations(query, id, period(queries.first), period(queries.second));
    });
  const app = Fastify(),
    pool = new Pool();
  installHttpErrorHandler(app);
  await app.register(pitchLocationRoutes, { pool });
  try {
    const response = await app.inject(
      "/api/v2/analysis/pitch-location/p1/comparison?season=2024&compareSeason=2025&stance=L&strikes=2",
    );
    expect(response.statusCode).toBe(200);
    expect(Value.Check(PitchLocationComparisonResponseSchema, response.json())).toBe(true);
    expect(compare).toHaveBeenCalledWith(
      expect.objectContaining({ season: 2024, compareSeason: 2025, stance: "L", strikes: 2 }),
      "p1",
    );
    for (const suffix of [
      "season=2024",
      "season=2024&compareSeason=no",
      "season=2024&compareSeason=2025&balls=4",
      "season=2024&compareSeason=2025&compareDateFrom=2024-01-01",
      "season=2024&compareSeason=2025&compareDateFrom=2025-06-30&compareDateTo=2025-06-01",
      "season=2024&compareSeason=2025&compareDateFrom=2025-02-30",
    ])
      expect(
        (await app.inject(`/api/v2/analysis/pitch-location/p1/comparison?${suffix}`)).statusCode,
      ).toBe(400);
  } finally {
    await app.close();
    await pool.end();
    vi.restoreAllMocks();
  }
});
