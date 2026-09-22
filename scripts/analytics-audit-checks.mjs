import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { URL } from "node:url";
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { Value } = require("@sinclair/typebox/value");
const { canonicalStringify, WorkloadComparisonResponseSchema } = require("@kbo/contracts");

export const auditHash = (value) =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");

export function checkAuditBaseline(previous, current) {
  assert.equal(previous.kind, "kbo-analytics-audit-v1");
  assert.equal(previous.status, "complete", "Baseline must be a completed audit");
  assert.equal(
    previous.sourceHash,
    current.sourceHash,
    "Cannot compare different source snapshots",
  );
  assert.equal(previous.mode, current.mode, "Audit mode differs from baseline");
  assert.deepEqual(previous.seasons, current.seasons, "Audit seasons differ from baseline");
}

export function timingSummary(values) {
  assert(values.length > 1, "At least one first and one warm measurement required");
  assert(values.every((v) => Number.isFinite(v) && v >= 0));
  const warm = values.slice(1).sort((a, b) => a - b);
  return {
    firstMs: values[0],
    warmCount: warm.length,
    warmP50Ms: warm[Math.ceil(warm.length * 0.5) - 1],
    warmP95Ms: warm[Math.ceil(warm.length * 0.95) - 1],
    maxMs: Math.max(...values),
  };
}

/** Check independent conservation and support rules, without reimplementing the estimator. */
export function checkWorkload(value, expectedPitches) {
  Value.Assert(WorkloadComparisonResponseSchema, value);
  assert.equal(value.actualPitches, expectedPitches, "Independent actual-pitch count differs");
  assert.equal(
    Object.values(value.roleEvidence).reduce((a, b) => a + b, 0),
    expectedPitches,
  );
  assert.deepEqual(value.dimensions.map((d) => d.dimension).sort(), [
    "meeting",
    "pitchNumber",
    "previous3Days",
    "previous7Days",
    "rest",
  ]);
  const states = { ready: 0, insufficient_support: 0, unstable_interval: 0 };
  for (const dimension of value.dimensions) {
    assert.equal(
      dimension.groupedPitches + dimension.excludedWorkloadPitches + value.excludedConditionPitches,
      expectedPitches,
      "Eligibility counts do not conserve pitches",
    );
    assert.equal(dimension.comparisons.length, dimension.dimension === "pitchNumber" ? 9 : 6);
    assert.equal(
      new Set(dimension.comparisons.map((c) => `${c.reference}/${c.comparison}/${c.metric}`)).size,
      dimension.comparisons.length,
    );
    for (const c of dimension.comparisons) {
      states[c.status]++;
      assert(c.validReplicates <= value.policy.bootstrapReplicates);
      for (const arm of [c.baseline, c.target]) {
        assert(arm.matchedSamples <= arm.samples && arm.matchedGames <= arm.games);
        assert(arm.samples <= dimension.groupedPitches);
        assert.equal(arm.rawMean === null, arm.samples === 0);
        assert(arm.games <= arm.samples && arm.matchedGames <= arm.matchedSamples);
        for (const mean of [arm.rawMean, arm.adjustedMean]) {
          if (mean === null) continue;
          assert(Number.isFinite(mean) && mean >= 0);
          if (c.metric !== "speed") assert(mean <= 1 + 1e-12);
        }
      }
      assert(c.overlapWeight <= Math.min(c.baseline.matchedSamples, c.target.matchedSamples));
      const supported =
        [c.baseline, c.target].every(
          (g) =>
            g.matchedSamples >= value.policy.minGroupSamples &&
            g.matchedGames >= value.policy.minGroupGames,
        ) && c.overlapWeight > 0;
      assert.equal(c.status === "insufficient_support", !supported);
      if (c.status === "ready") {
        assert(c.validReplicates >= value.policy.minValidReplicates);
        assert(c.interval !== null && c.interval.low <= c.interval.high);
        assert(c.baseline.adjustedMean !== null && c.target.adjustedMean !== null);
        assert(c.difference !== null);
        assert(Math.abs(c.difference - (c.target.adjustedMean - c.baseline.adjustedMean)) < 1e-9);
        if (c.metric !== "speed") assert(c.interval.low >= -1 && c.interval.high <= 1);
      } else {
        assert.equal(c.difference, null);
        assert.equal(c.interval, null);
        assert.equal(c.baseline.adjustedMean, null);
        assert.equal(c.target.adjustedMean, null);
        assert(c.validReplicates < value.policy.minValidReplicates);
      }
    }
  }
  assert.equal(
    Object.values(states).reduce((a, b) => a + b, 0),
    33,
  );
  return states;
}

export function compareAuditRecords(before, after) {
  const key = (r) => `${r.season}/${r.pitcherId}`;
  const previous = new Map(before.map((r) => [key(r), r]));
  assert.equal(previous.size, before.length, "Duplicate baseline actor");
  assert.equal(new Set(after.map(key)).size, after.length, "Duplicate measured actor");
  const differences = [];
  for (const record of after) {
    const prior = previous.get(key(record));
    if (!prior) differences.push({ key: key(record), reason: "added" });
    else if (prior.sourceHash !== record.sourceHash)
      differences.push({ key: key(record), reason: "source_changed" });
    else if (prior.responseHash !== record.responseHash)
      differences.push({ key: key(record), reason: "response_changed" });
    previous.delete(key(record));
  }
  for (const name of previous.keys()) differences.push({ key: name, reason: "removed" });
  return differences;
}
