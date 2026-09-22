// Isolated fixture or explicitly owned validation snapshot. No model fitting or writes.
import process from "node:process";
import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { URL, pathToFileURL } from "node:url";
const validation = process.env.KBO_ANALYTICS_VALIDATION;
const {
  PlayerStatisticsRepository,
  PitchQualityRepository,
  ParkEnvironmentRepository,
  PitchSequenceRepository,
  PitchQualityWorkspace,
  ParkEnvironmentWorkspace,
  RunExpectancyWorkspace,
  RunValueRepository,
} = await import(
  validation
    ? pathToFileURL(
        createRequire(new URL("../apps/server/package.json", import.meta.url)).resolve(
          "@kbo/persistence",
        ),
      ).href
    : "@kbo/persistence"
);
if (!validation && process.env.KBO_ANALYTICS_FIXTURE_BENCHMARK !== "1")
  throw new Error("An explicit isolated-fixture benchmark environment is required");
if (validation) {
  const { capture, assertOwnedDatabase } = await import("./analytics-validation-process.mjs");
  const state = JSON.parse(
    await readFile(path.join(process.env.KBO_ANALYTICS_REPORT_DIR, "run.json"), "utf8"),
  );
  const inspection = JSON.parse(await capture("docker", ["inspect", validation]))[0];
  assertOwnedDatabase(state, inspection);
  if (
    process.env.PGHOST !== "127.0.0.1" ||
    process.env.PGDATABASE !== "kbo_validation" ||
    process.env.PGPORT !== inspection.NetworkSettings.Ports["5432/tcp"][0].HostPort
  )
    throw new Error("Benchmark connection must point at the owned snapshot");
}
const pool = new Pool({ max: 1, options: "-c default_transaction_read_only=on" }),
  worker = validation
    ? new (await import("../apps/server/dist/computation-pool.js")).ComputationPool(1, 1)
    : null,
  captured = new Map();
let sqlMs = 0,
  queries = 0,
  recording = true,
  maxRss = process.memoryUsage().rss;
pool.on("connect", (client) => {
  const query = client.query.bind(client);
  client.query = (...args) => {
    const start = performance.now(),
      result = query(...args);
    if (recording && typeof args[0] === "string" && /^\s*(SELECT|WITH)\b/i.test(args[0]))
      captured.set(args[0], args[1]);
    if (result === undefined || typeof result.finally !== "function") return result;
    return result.finally(() => {
      if (recording) {
        sqlMs += performance.now() - start;
        queries++;
      }
    });
  };
});
const summary = (values) => {
  const sorted = values.slice(1).sort((a, b) => a - b);
  return {
    firstMs: values[0],
    warmMeanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    warmP95Ms: sorted[Math.floor(sorted.length * 0.95)],
  };
};
try {
  const fixture = await pool.query(
    validation
      ? "SELECT game_id,revision FROM analytics.current_analysis_games WHERE season=2025 AND competition='regular' ORDER BY game_id LIMIT 1"
      : "SELECT game_id FROM analytics.current_game_revisions WHERE game_id='analysis-2024'",
  );
  if (fixture.rows.length !== 1) throw new Error("Expected analysis fixture absent");
  const actors = await pool.query(
      validation
        ? "SELECT pitcher_id,count(*) AS pitches FROM baseball.pitch_facts p JOIN analytics.current_analysis_games r USING(game_id,revision) WHERE r.season=2025 AND r.competition='regular' AND p.actual GROUP BY pitcher_id ORDER BY count(*) DESC,pitcher_id LIMIT 1"
        : "SELECT DISTINCT pitcher_id FROM analytics.current_pitches WHERE game_id='analysis-2024' AND actual ORDER BY pitcher_id",
    ),
    pitcher = actors.rows[0]?.pitcher_id;
  if (typeof pitcher !== "string") throw new Error("Missing fixture pitcher");
  captured.clear();
  const results = [],
    scope = { season: validation ? 2025 : 2024, competition: validation ? "regular" : "all" },
    statistics = new PlayerStatisticsRepository(pool),
    quality = new PitchQualityRepository(pool),
    parks = new ParkEnvironmentRepository(pool),
    sequences = new PitchSequenceRepository(pool);
  const workloads = [
    ["batting", () => statistics.batting(scope)],
    ["pitching", () => statistics.pitching(scope)],
    ["quality-input", () => quality.read(scope, pitcher, null, null)],
    ["park-environment", () => parks.read(scope)],
    ["pitch-sequences", () => sequences.analyze(scope, pitcher)],
  ];
  const modelHashes = {};
  if (validation) {
    const root = process.env.KBO_DATA_DIR,
      noWrite = async () => {
        throw new Error("Read only benchmark");
      };
    const qualityModel = await new PitchQualityWorkspace(root, noWrite).read(2024);
    const parkModel = await new ParkEnvironmentWorkspace(root, noWrite).read(2024);
    const runWorkspace = new RunExpectancyWorkspace(root, noWrite),
      runs = new RunValueRepository(pool);
    const re = await runWorkspace.read(2024),
      count = await runWorkspace.readCount(2024),
      win = await runWorkspace.readWin(2024);
    if (![qualityModel, parkModel, re, count, win].every(Boolean))
      throw new Error("Every trained artifact must decode before measurement");
    Object.assign(modelHashes, {
      quality: qualityModel.hash,
      park: parkModel.hash,
      re24: re.hash,
      count: count.hash,
      win: win.hash,
    });
    workloads.push(
      [
        "quality-with-model",
        async () => {
          const input = await quality.read(scope, pitcher, qualityModel.model, qualityModel.hash);
          const result = await worker.run({ kind: "pitch_quality_summary", ...input });
          if (result.kind !== "pitch_quality_summary") throw new Error("Unexpected summary");
          return result.value;
        },
      ],
      ["park-with-model", () => parks.read(scope, parkModel.model, parkModel.hash)],
      [
        "re24-with-model",
        () => runs.game(fixture.rows[0].game_id, fixture.rows[0].revision, re.model, re.hash, 2025),
      ],
      [
        "count-with-model",
        () =>
          runs.countGame(
            fixture.rows[0].game_id,
            fixture.rows[0].revision,
            count.model,
            count.hash,
            2025,
          ),
      ],
      [
        "win-with-model",
        () =>
          runs.winGame(
            fixture.rows[0].game_id,
            fixture.rows[0].revision,
            win.model,
            win.hash,
            2025,
          ),
      ],
    );
  }
  for (const [label, work] of workloads) {
    const total = [],
      database = [],
      processing = [],
      serialization = [];
    let bytes = 0,
      queryCount = 0;
    for (let i = 0; i < 30; i++) {
      sqlMs = 0;
      queries = 0;
      const start = performance.now(),
        result = await work(),
        elapsed = performance.now() - start;
      total.push(elapsed);
      database.push(sqlMs);
      processing.push(Math.max(0, elapsed - sqlMs));
      queryCount = queries;
      const s = performance.now(),
        json = JSON.stringify(result);
      serialization.push(performance.now() - s);
      bytes = Buffer.byteLength(json);
      maxRss = Math.max(maxRss, process.memoryUsage().rss);
    }
    results.push({
      label,
      repetitions: 30,
      queries: queryCount,
      total: summary(total),
      database: summary(database),
      processing: summary(processing),
      serialization: summary(serialization),
      responseBytes: bytes,
    });
    if (validation)
      process.stderr.write(`${label}: warm p95 ${Math.round(summary(total).warmP95Ms)} ms\n`);
  }
  recording = false;
  const client = await pool.connect(),
    plans = [];
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='30s'");
    for (const [sql, parameters] of captured) {
      const result = await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, parameters),
        plan = result.rows[0]?.["QUERY PLAN"]?.[0];
      if (plan === undefined) throw new Error("Missing query plan");
      const nodes = [];
      function walk(n) {
        nodes.push({
          node: n["Node Type"],
          relation: n["Relation Name"] ?? null,
          rows: n["Actual Rows"],
          loops: n["Actual Loops"],
          sharedHits: n["Shared Hit Blocks"] ?? 0,
          sharedReads: n["Shared Read Blocks"] ?? 0,
        });
        for (const child of n.Plans ?? []) walk(child);
      }
      walk(plan.Plan);
      plans.push({
        sqlHash: createHash("sha256").update(sql).digest("hex"),
        planningMs: plan["Planning Time"],
        executionMs: plan["Execution Time"],
        nodes,
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const report = {
    kind: validation ? "analytics-snapshot-query-benchmark" : "analytics-fixture-query-benchmark",
    node: process.version,
    note: "First query is not a cold PostgreSQL cache; network and hydration included in database time; repository and fixed-worker calculation, excluding HTTP/browser rendering",
    scope,
    pitcher,
    modelHashes,
    maxSampledRssBytes: maxRss,
    results,
    plans,
  };
  if (validation)
    await writeFile(
      path.join(process.env.KBO_ANALYTICS_REPORT_DIR, "benchmark.json"),
      JSON.stringify(report, null, 2),
    );
  process.stdout.write(JSON.stringify(report) + "\n");
} finally {
  await worker?.close();
  await pool.end();
}
