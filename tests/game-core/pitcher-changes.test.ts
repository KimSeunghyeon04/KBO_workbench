import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PitcherChangesResponseSchema,
  resolveAnalysisScope,
  type PitchChangeObservation,
} from "@kbo/contracts";
import { analyzePitcherChanges } from "@kbo/game-core";
function rows(): PitchChangeObservation[] {
  return Array.from({ length: 8 }, (_, i) =>
    Array.from({ length: 40 }, (_, p) => ({
      gameId: `g${i}`,
      revision: 1,
      gameDate: `2024-06-${String(i + 1).padStart(2, "0")}`,
      pitchId: `p${p}`,
      stadium: "잠실",
      pitchType: "직구",
      speedKph: i < 5 ? 140 : 145,
      stance: "R",
      balls: 0,
      strikes: 0,
      swing: false,
      whiff: false,
      xCm: 3,
      zCm: 4,
      arrivalMs: 400,
      calibrated: true,
    })),
  ).flat();
}
const query = { season: 2024, dateTo: "2024-06-08" },
  scope = resolveAnalysisScope(query, "regular");
it("uses disjoint 3/5 appearance windows, pitch weighted changes and deterministic game bootstrap", () => {
  const source = rows(),
    r = analyzePitcherChanges(query, "p", scope, "hash", source, "2024-06-08");
  expect(Value.Check(PitcherChangesResponseSchema, r)).toBe(true);
  expect(r.status).toBe("ready");
  expect(r.recent.games.map((g) => g.gameId)).toEqual(["g5", "g6", "g7"]);
  expect(r.previous.games).toHaveLength(5);
  expect(r.changes[0]?.metrics.find((m) => m.metric === "speedKph")).toMatchObject({
    difference: 5,
    lower: 5,
    upper: 5,
    recentCount: 120,
    previousCount: 200,
    status: "sufficient",
  });
  expect(r.changes[0]?.metrics.find((m) => m.metric === "xCm")?.difference).toBe(0);
  expect(
    analyzePitcherChanges(query, "p", scope, "hash", [...source].reverse(), "2024-06-08"),
  ).toEqual(r);
  expect(
    analyzePitcherChanges(
      query,
      "p",
      scope,
      "hash",
      [
        ...source,
        ...source.map((r) => ({
          ...r,
          gameId: `later-${r.gameId}`,
          gameDate: "2024-07-01",
          speedKph: 180,
        })),
      ],
      "2024-06-08",
    ),
  ).toEqual(r);
});
it("does not invent doubleheader order or turn absent pitch types and unsupported calibration into zero", () => {
  const source = rows();
  const ambiguous = analyzePitcherChanges(
    query,
    "p",
    scope,
    "hash",
    source.map((r) => ({ ...r, gameDate: r.gameId === "g7" ? "2024-06-07" : r.gameDate })),
    null,
  );
  expect(ambiguous.status).toBe("ambiguous_same_day");
  expect(ambiguous.changes).toEqual([]);
  const sparse = analyzePitcherChanges(
    query,
    "p",
    scope,
    "hash",
    source.map((r) => ({
      ...r,
      calibrated: false,
      pitchType: r.gameId === "g7" ? "희소" : "직구",
    })),
    null,
  );
  expect(
    sparse.changes
      .find((c) => c.pitchType === "희소")
      ?.metrics.find((m) => m.metric === "speedKph"),
  ).toMatchObject({ previous: null, difference: null, lower: null, status: "unavailable" });
  expect(sparse.changes[0]?.metrics.find((m) => m.metric === "xCm")).toMatchObject({
    recent: null,
    previous: null,
  });
});
