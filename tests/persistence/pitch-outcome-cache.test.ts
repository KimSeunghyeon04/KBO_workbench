import { Client, Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import {
  BatterProfileRepository,
  PitchLocationRepository,
  type PitchOutcomeSnapshot,
} from "@kbo/persistence";
import { BoundedReadCache } from "../../apps/server/src/bounded-read-cache.js";

function outcomeReader() {
  const pool = new Pool();
  const client = Object.assign(new Client(), { release: vi.fn() });
  const samples = new BoundedReadCache<PitchOutcomeSnapshot>(1024 * 1024, 8, 300_000);
  let supplements = "a".repeat(64);
  vi.spyOn(pool, "connect").mockResolvedValue(client);
  const query = vi.spyOn(client, "query").mockImplementation(async (statement) => {
    if (typeof statement !== "string") throw new Error("Expected text SQL");
    const rows = statement.includes("AS supplements")
      ? [{ sources: [], dataset: [], supplements }]
      : [];
    return { rows, command: "", rowCount: rows.length, fields: [], oid: 0 };
  });
  return {
    location: new PitchLocationRepository(pool, samples),
    batter: new BatterProfileRepository(pool, samples),
    sqlCalls() {
      const count = query.mock.calls.length;
      query.mockClear();
      return count;
    },
    changeSupplement() {
      supplements = "b".repeat(64);
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it("reuses pitch and PA input across count, pitch type and stance changes", async () => {
  const reader = outcomeReader();
  const scope = { season: 2024 };
  const first = await reader.location.analyze(scope, "p1");
  expect(reader.sqlCalls()).toBe(6);

  for (const query of [
    { ...scope, balls: 1 },
    { ...scope, balls: 1, pitchType: "직구" },
    { ...scope, balls: 1, pitchType: "직구", stance: "L" as const },
  ]) {
    const result = await reader.location.analyze(query, "p1");
    expect(reader.sqlCalls()).toBe(4);
    expect(result).toEqual({ ...first, query });
  }

  const batter = await reader.batter.analyze(scope, "p1");
  expect(reader.sqlCalls()).toBe(6);
  expect(batter.sourceHash).not.toBe(first.sourceHash);
  const differentActor = await reader.location.analyze(scope, "p2");
  expect(reader.sqlCalls()).toBe(6);
  expect(differentActor.sourceHash).not.toBe(first.sourceHash);

  reader.changeSupplement();
  expect(await reader.location.analyze(scope, "p1")).toEqual(first);
  expect(reader.sqlCalls()).toBe(6);
});

it("shares overlapping rows while retaining each period's scope, fingerprint and cache entry", async () => {
  const reader = outcomeReader();
  const scope = {
    season: 2024,
    dateFrom: "2024-04-01",
    compareSeason: 2024,
    compareDateFrom: "2024-06-01",
  };
  const first = await reader.location.compare(scope, "p1");
  expect(reader.sqlCalls()).toBe(7);
  expect(first.first.scope.dateFrom).toBe("2024-04-01");
  expect(first.second.scope.dateFrom).toBe("2024-06-01");
  expect(first.second.sourceHash).not.toBe(first.first.sourceHash);

  const filtered = await reader.location.compare({ ...scope, stance: "L" }, "p1");
  expect(reader.sqlCalls()).toBe(5);
  expect(filtered.first).toEqual({ ...first.first, query: { ...first.first.query, stance: "L" } });
  expect(filtered.second).toEqual({
    ...first.second,
    query: { ...first.second.query, stance: "L" },
  });
});
