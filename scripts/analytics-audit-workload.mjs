import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { auditHash, checkWorkload } from "./analytics-audit-checks.mjs";
const { WorkloadComparisonRepository } = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
)("@kbo/persistence");

export async function auditWorkloads(pool, worker, seasons, directory, signal, progress) {
  // Include zero-pitch appearances and any actual-pitch actor absent from appearance facts.
  // The independent count uses pitch facts, not the repository's comparison cells.
  const inventory = (
    await pool.query(
      `WITH actual AS (
    SELECT r.season,p.pitcher_id,count(*)::integer AS pitches
    FROM analytics.current_analysis_games r JOIN baseball.pitch_facts p USING(game_id,revision)
    WHERE r.season=ANY($1::integer[]) AND r.competition='regular' AND p.actual
    GROUP BY r.season,p.pitcher_id
  ), actors AS (
    SELECT DISTINCT r.season,f.player_id AS pitcher_id
    FROM analytics.current_analysis_games r JOIN baseball.pitcher_game_facts f USING(game_id,revision)
    WHERE r.season=ANY($1::integer[]) AND r.competition='regular'
    UNION SELECT season,pitcher_id FROM actual
  ) SELECT a.season,a.pitcher_id AS "pitcherId",coalesce(p.pitches,0)::integer AS pitches
    FROM actors a LEFT JOIN actual p USING(season,pitcher_id)
    ORDER BY a.season,a.pitcher_id COLLATE "C"`,
      [seasons],
    )
  ).rows;
  assert(
    inventory.every((r) => typeof r.pitcherId === "string" && Number.isSafeInteger(r.pitches)),
  );
  for (const season of seasons)
    assert(
      inventory.some((r) => r.season === season),
      `No actors in ${season}`,
    );
  const repository = new WorkloadComparisonRepository(pool),
    records = [],
    failures = [];
  const summaries = seasons.map((season) => ({
    season,
    actors: 0,
    actualPitches: 0,
    excludedConditionPitches: 0,
    roleEvidence: { registeredPitches: 0, observedPitches: 0, unknownPitches: 0 },
    ready: 0,
    insufficient_support: 0,
    unstable_interval: 0,
    dimensions: {},
  }));
  for (const actor of inventory) {
    signal.throwIfAborted();
    const start = performance.now();
    try {
      const input = await repository.read(
        { season: actor.season, competition: "regular" },
        actor.pitcherId,
      );
      signal.throwIfAborted();
      const readMs = performance.now() - start;
      const result = await worker.run({ kind: "workload_comparison", ...input }, signal);
      assert.equal(result.kind, "workload_comparison");
      const value = result.value,
        states = checkWorkload(value, actor.pitches);
      const responseHash = auditHash(value);
      // Every actor is recomputed after reversing both source collections.
      const repeated = await worker.run(
        {
          kind: "workload_comparison",
          ...input,
          cells: input.cells.toReversed(),
          history: input.history.toReversed(),
        },
        signal,
      );
      assert.equal(auditHash(repeated.value), responseHash, "Input-order determinism failed");
      const record = {
        ...actor,
        cells: input.cells.length,
        sourceHash: value.sourceHash,
        responseHash,
        readMs,
        totalWithRecheckMs: performance.now() - start,
        states,
      };
      records.push(record);
      await appendFile(
        path.join(directory, "workload.ndjson"),
        JSON.stringify({ ...record, value }) + "\n",
      );
      const summary = summaries.find((s) => s.season === actor.season);
      summary.actors++;
      summary.actualPitches += value.actualPitches;
      summary.excludedConditionPitches += value.excludedConditionPitches;
      for (const k of Object.keys(states)) summary[k] += states[k];
      for (const k of Object.keys(value.roleEvidence))
        summary.roleEvidence[k] += value.roleEvidence[k];
      for (const d of value.dimensions) {
        const row = (summary.dimensions[d.dimension] ??= {
          excludedWorkloadPitches: 0,
          groupedPitches: 0,
          ready: 0,
          insufficient_support: 0,
          unstable_interval: 0,
        });
        row.excludedWorkloadPitches += d.excludedWorkloadPitches;
        row.groupedPitches += d.groupedPitches;
        for (const c of d.comparisons) row[c.status]++;
      }
    } catch (error) {
      signal.throwIfAborted();
      const failure = { ...actor, error: String(error) };
      failures.push(failure);
      await appendFile(path.join(directory, "failures.ndjson"), JSON.stringify(failure) + "\n");
    }
    if ((records.length + failures.length) % 50 === 0)
      progress({
        checked: records.length + failures.length,
        total: inventory.length,
        failures: failures.length,
      });
  }
  return {
    inventoryHash: auditHash(inventory),
    inventoryCount: inventory.length,
    records,
    summaries,
    failures,
  };
}
