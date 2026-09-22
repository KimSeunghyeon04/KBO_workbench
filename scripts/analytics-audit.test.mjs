import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { URL } from "node:url";
import {
  checkAuditBaseline,
  checkWorkload,
  compareAuditRecords,
  timingSummary,
} from "./analytics-audit-checks.mjs";
const { structuredClone } = globalThis;
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { resolveAnalysisScope } = require("@kbo/contracts");
const { comparePitcherWorkload } = require("@kbo/game-core");
test("incomplete, changed-source and differently scoped baselines are rejected before expensive work", () => {
  const previous = {
    kind: "kbo-analytics-audit-v1",
    status: "complete",
    sourceHash: "a",
    mode: "all",
    seasons: [2025],
  };
  assert.doesNotThrow(() => checkAuditBaseline(previous, previous));
  for (const difference of [
    { status: "failed" },
    { status: "cancelled" },
    { sourceHash: "b" },
    { mode: "queries" },
    { seasons: [2024, 2025] },
  ]) {
    assert.throws(() => checkAuditBaseline({ ...previous, ...difference }, previous));
  }
});
function fixture() {
  const query = { season: 2025, competition: "regular" };
  const history = Array.from({ length: 6 }, (_, i) => ({
    gameId: `game-${i}`,
    revision: 1,
    gameDate: `2025-06-${String(i + 1).padStart(2, "0")}`,
    teamId: "team",
    teamName: "Team",
    side: "home",
    role: "starter",
    pitches: 50,
    battersFaced: 12,
    outs: 9,
  }));
  const cells = history.flatMap((h) =>
    [0, 1].map((pitchBucket) => ({
      gameId: h.gameId,
      revision: 1,
      observedRole: "first_pitcher",
      pitchBucket,
      meeting: pitchBucket + 1,
      pitchType: "fast",
      stance: "R",
      balls: 0,
      strikes: 0,
      pitches: 25,
      speedCount: 25,
      speedSum: 3500,
      swings: 15,
      whiffs: 3,
    })),
  );
  return comparePitcherWorkload(
    query,
    resolveAnalysisScope(query),
    "p",
    "a".repeat(64),
    history,
    cells,
  );
}
test("audit accepts supported and sparse cells but rejects count, denominator and null-policy corruption", () => {
  const value = fixture();
  assert(checkWorkload(value, 300).ready > 0);
  assert.throws(() => checkWorkload(value, 301));
  const cloned = structuredClone(value);
  cloned.dimensions[0].groupedPitches++;
  assert.throws(() => checkWorkload(cloned, 300));
  const invalid = structuredClone(value);
  const row = invalid.dimensions.flatMap((d) => d.comparisons).find((c) => c.status === "ready");
  row.target.matchedSamples = row.target.samples + 1;
  assert.throws(() => checkWorkload(invalid, 300));
  const missing = structuredClone(value);
  missing.dimensions.flatMap((d) => d.comparisons).find((c) => c.status !== "ready").difference = 0;
  assert.throws(() => checkWorkload(missing, 300));
  assert.throws(() => checkWorkload({ ...value, undocumented: true }, 300));
});
test("baseline comparison distinguishes source, response and inventory changes without ignoring missing rows", () => {
  const record = { season: 2025, pitcherId: "p", sourceHash: "a", responseHash: "b" };
  assert.deepEqual(compareAuditRecords([record], [{ ...record, readMs: 900 }]), []);
  assert.equal(
    compareAuditRecords([record], [{ ...record, responseHash: "c" }])[0].reason,
    "response_changed",
  );
  assert.equal(
    compareAuditRecords([record], [{ ...record, sourceHash: "c" }])[0].reason,
    "source_changed",
  );
  assert.equal(compareAuditRecords([record], [])[0].reason, "removed");
  assert.equal(compareAuditRecords([], [record])[0].reason, "added");
  assert.throws(() => compareAuditRecords([record, record], [record]));
});
test("warm percentile excludes first request and uses nearest-rank convention", () => {
  const result = timingSummary([9000, ...Array.from({ length: 30 }, (_, i) => i + 1)]);
  assert.equal(result.firstMs, 9000);
  assert.equal(result.warmP50Ms, 15);
  assert.equal(result.warmP95Ms, 29);
  assert.throws(() => timingSummary([1]));
  assert.throws(() => timingSummary([1, Infinity]));
});
