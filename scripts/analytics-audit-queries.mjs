import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { auditHash, checkWorkload, timingSummary } from "./analytics-audit-checks.mjs";
import { analysisCoverageRoutes } from "../apps/server/dist/routes/analysis-coverage.js";
import { pitchQualityRoutes } from "../apps/server/dist/routes/pitch-quality.js";
import { pitcherWorkloadRoutes } from "../apps/server/dist/routes/pitcher-workload.js";
import { installHttpErrorHandler } from "../apps/server/dist/http-error-handler.js";
const { fetch, AbortSignal, AbortController } = globalThis;
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const Fastify = require("fastify");
const { Value } = require("@sinclair/typebox/value");
const {
  PitchQualityWorkspace,
  PitchCalibrationWorkspace,
  AnalysisCoverageWorkspace,
} = require("@kbo/persistence");
const {
  AnalysisCoverageResponseSchema,
  AnalysisCoveragePreparationSchema,
  PitchQualityResponseSchema,
  validAnalysisCoverage,
} = require("@kbo/contracts");

/** Real loopback HTTP routes and the production-sized worker pool; no browser or model training. */
export async function auditQueries(pool, worker, workspace, directory, signal, progress) {
  const app = Fastify();
  const noWrite = async () => {
    throw new Error("Audit must not publish trained models");
  };
  const models = new PitchQualityWorkspace(workspace, noWrite);
  const model = await models.read(2024);
  assert(model, "2025 pitch-quality model must be available in the owned workspace");
  const actor = (
    await pool.query(`SELECT p.pitcher_id AS "pitcherId",count(*)::integer AS pitches
    FROM analytics.current_analysis_games r JOIN baseball.pitch_facts p USING(game_id,revision)
    WHERE r.season=2025 AND r.competition='regular' AND p.actual
    GROUP BY p.pitcher_id ORDER BY count(*) DESC,p.pitcher_id COLLATE "C" LIMIT 1`)
  ).rows[0];
  assert(actor && typeof actor.pitcherId === "string");
  // Derived calibration cache is isolated inside this new audit directory, never the source workspace.
  const calibrations = new PitchCalibrationWorkspace(path.join(directory, "cache"), async () => {});
  const summaries = new AnalysisCoverageWorkspace(path.join(directory, "cache"), async () => {});
  let cancelStarted,
    cancellationArmed = false;
  const observedCancellation = [];
  const computation = {
    async run(input, requestSignal) {
      if (cancellationArmed && input.kind === "workload_comparison") {
        cancellationArmed = false;
        observedCancellation.push(requestSignal);
        cancelStarted();
      }
      return worker.run(input, requestSignal);
    },
  };
  installHttpErrorHandler(app);
  await app.register(analysisCoverageRoutes, {
    pool,
    calibrations,
    summaries,
    calibrate: async (season, sourceHash, rows, previous) => {
      const result = await worker.run(
        { kind: "pitch_calibration", season, sourceHash, rows, previous },
        signal,
      );
      assert.equal(result.kind, "pitch_calibration");
      return result.value;
    },
  });
  await app.register(pitchQualityRoutes, { pool, models, computation });
  await app.register(pitcherWorkloadRoutes, { pool, computation });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const workloads = [
    {
      name: "coverage",
      url: "/api/v2/analysis/coverage?season=2025&competition=regular",
      validate: (v) => {
        Value.Assert(AnalysisCoverageResponseSchema, v);
        assert(validAnalysisCoverage(v));
      },
    },
    {
      name: "pitch-quality",
      url: `/api/v2/analysis/pitch-quality/${encodeURIComponent(actor.pitcherId)}?season=2025&competition=regular`,
      validate: (v) => {
        Value.Assert(PitchQualityResponseSchema, v);
        assert.equal(v.modelHash, model.hash, "Stored model is not current for this snapshot");
      },
    },
    {
      name: "workload-comparison",
      url: `/api/v2/analysis/pitcher-workload/${encodeURIComponent(actor.pitcherId)}/comparison?season=2025&competition=regular`,
      validate: (v) => checkWorkload(v, actor.pitches),
    },
  ];
  const sequential = [],
    captured = new Map();
  let recording = true;
  const instrumented = [];
  // Instrument all existing/new pool clients only for this audit; restore their original methods.
  const instrument = (client) => {
    if (instrumented.some((r) => r.client === client)) return;
    const original = client.query;
    instrumented.push({ client, original });
    client.query = function (...args) {
      const start = performance.now(),
        result = original.apply(this, args);
      if (!result || typeof result.finally !== "function") return result;
      return result.finally(() => {
        if (!recording || typeof args[0] !== "string" || !/^\s*(SELECT|WITH)\b/i.test(args[0]))
          return;
        const elapsed = performance.now() - start,
          previous = captured.get(args[0]);
        if (!previous || previous.maxMs < elapsed)
          captured.set(args[0], { sql: args[0], parameters: args[1] ?? [], maxMs: elapsed });
      });
    };
  };
  pool.on("acquire", instrument);
  const request = async (workload, base = address) => {
    signal.throwIfAborted();
    const started = performance.now();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    let response = await fetch(base + workload.url, { signal: requestSignal });
    const acceptedMs = performance.now() - started;
    let preparationPolls = 0;
    while (response.status === 202 && workload.name === "coverage") {
      const status = await response.json();
      Value.Assert(AnalysisCoveragePreparationSchema, status);
      assert.equal(status.state, "preparing");
      preparationPolls++;
      await setTimeout(250, undefined, { signal: requestSignal });
      response = await fetch(base + workload.url, { signal: requestSignal });
    }
    assert.equal(response.status, 200, `${workload.name}: HTTP ${response.status}`);
    const value = await response.json(),
      elapsedMs = performance.now() - started;
    workload.validate(value);
    return { elapsedMs, acceptedMs, preparationPolls, responseHash: auditHash(value) };
  };
  try {
    for (const workload of workloads) {
      const values = [];
      for (let i = 0; i < 31; i++) values.push(await request(workload));
      assert.equal(
        new Set(values.map((v) => v.responseHash)).size,
        1,
        "Repeated HTTP results differ",
      );
      const result = {
        name: workload.name,
        responseHash: values[0].responseHash,
        ...timingSummary(values.map((v) => v.elapsedMs)),
        measurements: values,
      };
      sequential.push(result);
      progress({ query: workload.name, firstMs: result.firstMs, warmP95Ms: result.warmP95Ms });
    }
    recording = false;
    const concurrent = [];
    for (let batch = 0; batch < 10; batch++) {
      const selected = [workloads[0], workloads[1], workloads[2], workloads[1]];
      const results = await Promise.all(
        selected.map(async (w) => ({ name: w.name, ...(await request(w)) })),
      );
      for (const result of results)
        assert.equal(
          result.responseHash,
          sequential.find((r) => r.name === result.name).responseHash,
        );
      concurrent.push(...results);
    }
    const restarted = Fastify();
    let coverageRestart;
    try {
      installHttpErrorHandler(restarted);
      await restarted.register(analysisCoverageRoutes, {
        pool,
        summaries,
        calibrations,
        calibrate: async () => {
          throw new Error("Restart must reuse prepared coverage");
        },
      });
      const restartedAddress = await restarted.listen({ host: "127.0.0.1", port: 0 });
      coverageRestart = await request(workloads[0], restartedAddress);
      assert.equal(coverageRestart.preparationPolls, 0, "Restart started heavy preparation");
      assert.equal(coverageRestart.responseHash, sequential[0].responseHash);
    } finally {
      await restarted.close();
    }
    const cancel = new AbortController();
    const started = new Promise((resolve) => {
      cancelStarted = resolve;
    });
    cancellationArmed = true;
    const pending = fetch(address + workloads[2].url, {
      signal: AbortSignal.any([cancel.signal, signal, AbortSignal.timeout(30_000)]),
    });
    const completed = pending.then(
      () => {
        throw new Error("Cancellation request completed too early");
      },
      (error) => error,
    );
    await Promise.race([
      started,
      completed.then((error) => {
        throw error;
      }),
    ]);
    cancel.abort();
    await completed;
    for (let i = 0; i < 100 && !observedCancellation[0]?.aborted; i++)
      await setTimeout(10, undefined, { signal });
    assert(observedCancellation[0]?.aborted, "HTTP disconnect did not reach the worker signal");
    const recovery = await request(workloads[2]);
    assert.equal(recovery.responseHash, sequential[2].responseHash);
    const plans = [];
    for (const query of [...captured.values()].sort((a, b) => b.maxMs - a.maxMs).slice(0, 5)) {
      signal.throwIfAborted();
      plans.push({
        ...query,
        sqlHash: auditHash(query.sql),
        plan: (
          await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`, query.parameters)
        ).rows,
      });
    }
    await writeFile(path.join(directory, "query-plans.json"), JSON.stringify(plans, null, 2));
    return {
      actor,
      coverageRestart,
      modelHashes: { quality: model.hash },
      sequential,
      concurrent,
      concurrentBatches: 10,
      concurrentRequests: 4,
      cancellation: "signal_observed_and_recovered",
      poolAfter: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    };
  } finally {
    recording = false;
    await app.close();
    pool.removeListener("acquire", instrument);
    for (const { client, original } of instrumented) client.query = original;
  }
}
