import Fastify from "fastify";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { PitchLocationRepository, BatterProfileRepository } from "@kbo/persistence";
import {
  resolveAnalysisScope,
  pitchLocationComparisonQueries,
  PitchLocationComparisonResponseSchema,
  pitchOutcomeScope,
  PitchCountFlowResponseSchema,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import {
  analyzePitchCountFlow,
  analyzePitchLocation,
  analyzeBatterProfile,
  comparePitchLocations,
} from "@kbo/game-core";
import { countFlowRow, outcomeRow, terminalPa } from "../../../tests/helpers/pitch-outcomes.js";
import { pitchLocationRoutes } from "../src/routes/pitch-location.js";
import { batterProfileRoutes } from "../src/routes/batter-profile.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";

it("serves count flow separately while retaining the old location response keys", async () => {
  const source = "a".repeat(64);
  const flow = vi
    .spyOn(PitchLocationRepository.prototype, "countFlow")
    .mockImplementation(async (query, id) =>
      analyzePitchCountFlow(
        query,
        id,
        pitchOutcomeScope(query),
        source,
        id === "p1"
          ? [
              countFlowRow({
                pitchCall: "ball",
                afterBalls: 1,
                afterStrikes: 0,
                terminalResult: "hit_by_pitch",
              }),
              countFlowRow({ pitchId: "second" }),
              countFlowRow({
                pitchId: "third",
                balls: 2,
                strikes: 2,
                afterStrikes: 2,
                pitchCall: "in_play",
                inPlay: true,
                terminalResult: "home_run",
              }),
            ]
          : [],
      ),
    );
  vi.spyOn(PitchLocationRepository.prototype, "analyze").mockImplementation(async (query, id) =>
    analyzePitchLocation(
      query,
      id,
      pitchOutcomeScope(query),
      source,
      [outcomeRow()],
      [terminalPa()],
    ),
  );
  const app = Fastify();
  const pool = new Pool();
  installHttpErrorHandler(app);
  await app.register(pitchLocationRoutes, { pool });
  const path = "/api/v2/analysis/pitch-location/p1";
  try {
    const location = await app.inject(`${path}?season=2024`);
    expect(location.statusCode).toBe(200);
    expect(Object.keys(location.json()).sort()).toEqual([
      "arsenal",
      "byCount",
      "byStance",
      "byType",
      "cells",
      "coverage",
      "pitcherId",
      "points",
      "query",
      "scope",
      "sourceHash",
      "total",
    ]);
    expect(flow).not.toHaveBeenCalled();
    const response = await app.inject(`${path}/count-flow?season=2024`);
    expect(response.statusCode).toBe(200);
    const payload = Value.Decode(PitchCountFlowResponseSchema, response.json());
    expect(
      payload.groups
        .find((group) => group.stance === "all")
        ?.transitions.find((step) => step.outcome === "hitByPitch"),
    ).toEqual({ outcome: "hitByPitch", pitches: 1, rate: 0.5 });
    expect(payload.query).not.toHaveProperty("include");
    for (const group of payload.groups) {
      expect(group).not.toHaveProperty("terminalDetails");
      expect(group.types.every((type) => !("terminalDetails" in type))).toBe(true);
    }
    const detailed = await app.inject(`${path}/count-flow?season=2024&include=terminal-details`);
    expect(detailed.statusCode).toBe(200);
    const expanded = Value.Decode(PitchCountFlowResponseSchema, detailed.json());
    expect(expanded.query.include).toBe("terminal-details");
    expect(expanded.sourceHash).toBe(payload.sourceHash);
    expect(
      expanded.groups.find((group) => group.stance === "all" && group.balls === 2),
    ).toMatchObject({
      terminalDetails: [{ outcome: "homeRun", pitches: 1, rate: 1 }],
      types: [{ terminalDetails: [{ outcome: "homeRun", pitches: 1, rate: 1 }] }],
    });
    const empty = await app.inject(
      "/api/v2/analysis/pitch-location/unlisted/count-flow?season=2024",
    );
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ scopePitches: 0, groups: [] });
    expect((await app.inject(`${path}/count-flow?season=2024&cohort=unknown`)).statusCode).toBe(
      400,
    );
  } finally {
    await app.close();
    await pool.end();
    vi.restoreAllMocks();
  }
});

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
