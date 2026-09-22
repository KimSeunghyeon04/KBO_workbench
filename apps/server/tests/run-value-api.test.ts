import Fastify from "fastify";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { RunValueRepository } from "@kbo/persistence";
import { evaluateRunValues, evaluateCountRunValues, evaluateWinValues } from "@kbo/game-core";
import type { RunTrainingGame } from "@kbo/contracts";
import { runValueRoutes } from "../src/routes/run-value.js";
import { installHttpErrorHandler } from "../src/http-error-handler.js";
afterEach(() => vi.restoreAllMocks());
it("binds all value endpoints to the requested revision and prior-season model", async () => {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } }),
    pool = new Pool({ max: 1 }),
    models = {
      read: vi.fn(async () => null),
      readCount: vi.fn(async () => null),
      readWin: vi.fn(async () => null),
    },
    game: RunTrainingGame = {
      gameId: "g",
      revision: 2,
      season: 2025,
      gameDate: "2025-06-01",
      scheduledInnings: 9,
      status: "final",
      normalEnd: true,
      documentHash: "a".repeat(64),
    };
  const spies = [
    vi
      .spyOn(RunValueRepository.prototype, "game")
      .mockResolvedValue(evaluateRunValues(game, [], null, null)),
    vi
      .spyOn(RunValueRepository.prototype, "countGame")
      .mockResolvedValue(evaluateCountRunValues(game, [], null, null)),
    vi
      .spyOn(RunValueRepository.prototype, "winGame")
      .mockResolvedValue(evaluateWinValues(game, [], null, null)),
  ];
  installHttpErrorHandler(app);
  await app.register(runValueRoutes, { pool, models });
  try {
    for (const [i, path] of ["run-value", "count-run-value", "win-probability"].entries()) {
      const url = `/api/v2/analysis/${path}/games/g`,
        response = await app.inject(`${url}?revision=2&season=2025`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        gameId: "g",
        revision: 2,
        documentHash: game.documentHash,
      });
      expect(spies[i]).toHaveBeenCalledWith("g", 2, null, null, 2025);
      expect((await app.inject(`${url}?revision=0&season=2025`)).statusCode).toBe(400);
      expect((await app.inject(`${url}?revision=2&season=2025&unexpected=1`)).statusCode).toBe(400);
    }
    expect(models.read).toHaveBeenCalledWith(2024);
    expect(models.readCount).toHaveBeenCalledWith(2024);
    expect(models.readWin).toHaveBeenCalledWith(2024);
    spies[0]?.mockResolvedValueOnce(null);
    expect(
      (await app.inject("/api/v2/analysis/run-value/games/g?revision=2&season=2025")).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
    await pool.end();
  }
});
