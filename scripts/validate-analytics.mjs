import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { writeValidationReport } from "./analytics-validation-report.mjs";
import {
  capture,
  logged,
  copyDatabase,
  assertOwnedDatabase,
  validationCodeHash,
  lockValidationRun,
} from "./analytics-validation-process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (["--prepare-only", "--cleanup", "--rerun-models", "--measure-only"].includes(key))
    options[key] = true;
  else if (
    ["--source-container", "--source-user", "--source-database", "--resume"].includes(key) &&
    args[i + 1]
  )
    options[key] = args[++i];
  else
    throw new Error(
      "Use --source-container NAME --source-user USER --source-database DB, or --resume RUN_DIRECTORY [--prepare-only | --cleanup]",
    );
}
const resume = options["--resume"],
  directory = resume
    ? path.resolve(resume)
    : path.join(root, "analysis", "validation", randomUUID());
if (!directory.startsWith(path.join(root, "analysis", "validation") + path.sep))
  throw new Error("Validation artifacts must be under analysis/validation");
if (options["--cleanup"] && !resume) throw new Error("Cleanup requires an existing run directory");
if (
  options["--measure-only"] &&
  (!resume || options["--cleanup"] || options["--prepare-only"] || options["--rerun-models"])
)
  throw new Error("Measurement requires --resume and cannot be combined with mutation stages");
await mkdir(directory, { recursive: true });
const unlock = lockValidationRun(directory);
process.once("exit", unlock);
const stateFile = path.join(directory, "run.json");
let state;
async function save() {
  await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2) + "\n");
  await rename(`${stateFile}.tmp`, stateFile);
}
if (resume) state = JSON.parse(await readFile(stateFile, "utf8"));
else {
  const source = {
    container: options["--source-container"],
    user: options["--source-user"],
    database: options["--source-database"],
  };
  if (Object.values(source).some((v) => typeof v !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(v)))
    throw new Error("An explicit source container, user and database are required");
  state = {
    kind: "kbo-analytics-validation-v1",
    source,
    container: `kbo-analysis-${randomUUID()}`,
    startedAt: new Date().toISOString(),
    steps: {},
    status: "preparing",
  };
  await save();
  const password = randomBytes(24).toString("hex");
  state.containerId = await capture("docker", [
    "run",
    "-d",
    "--name",
    state.container,
    "--label",
    `kbo.analytics.validation=${state.container}`,
    "--shm-size",
    "1g",
    "-p",
    "127.0.0.1::5432",
    "-e",
    "POSTGRES_USER=kbo_validation",
    "-e",
    "POSTGRES_DB=kbo_validation",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "postgres:16-bookworm",
  ]);
  await save();
}
const inspection = JSON.parse(await capture("docker", ["inspect", state.container]))[0];
assertOwnedDatabase(state, inspection);
if (options["--cleanup"]) {
  await capture("docker", ["rm", "--force", "--volumes", state.containerId]);
  state.status = "cleaned";
  await save();
  process.stdout.write(`Removed only the database owned by ${directory}\n`);
} else {
  const codeHash = await validationCodeHash(root);
  const modelSteps = ["re24", "count", "win", "park", "quality", "benchmark"];
  if (
    state.codeHash &&
    state.codeHash !== codeHash &&
    modelSteps.some((s) => state.steps[s]?.status === "complete") &&
    !options["--rerun-models"] &&
    !options["--measure-only"]
  )
    throw new Error(
      "Built analysis code changed; use --rerun-models to preserve previous logs and refit before comparing",
    );
  if (options["--rerun-models"]) {
    const history = path.join(directory, "previous", randomUUID());
    await mkdir(history, { recursive: true });
    await writeFile(path.join(history, "run.json"), JSON.stringify(state, null, 2));
    for (const name of modelSteps) {
      if (state.steps[name]) {
        try {
          await rename(path.join(directory, `${name}.log`), path.join(history, `${name}.log`));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        Reflect.deleteProperty(state.steps, name);
      }
    }
  }
  if (!options["--measure-only"]) state.codeHash = codeHash;
  else if (modelSteps.slice(0, -1).some((name) => state.steps[name]?.status !== "complete"))
    throw new Error("Measurement requires every training stage to have completed");
  state.status = "running";
  await save();
  const password = inspection.Config.Env.find((s) => s.startsWith("POSTGRES_PASSWORD="))?.slice(18);
  const port = inspection.NetworkSettings.Ports["5432/tcp"]?.[0]?.HostPort;
  if (!password || !port) throw new Error("Missing isolated database configuration");
  const env = {
    ...process.env,
    PGHOST: "127.0.0.1",
    PGPORT: port,
    PGUSER: "kbo_validation",
    PGPASSWORD: password,
    PGDATABASE: "kbo_validation",
    KBO_DATA_DIR: path.join(directory, "workspace"),
    EXPECTED_MIGRATION_VERSION: "0012_competition_game_links",
    MIGRATIONS_DIR: path.join(root, "database", "v3"),
    KBO_ANALYST_USER: "",
    KBO_ANALYST_PASSWORD: "",
    PGOPTIONS: "",
    KBO_ANALYTICS_VALIDATION: state.container,
    KBO_ANALYTICS_REPORT_DIR: directory,
  };
  const pool = new Pool({
    host: env.PGHOST,
    port: Number(port),
    user: env.PGUSER,
    password,
    database: env.PGDATABASE,
    max: 1,
    connectionTimeoutMillis: 2000,
  });
  async function step(name, work) {
    if (
      state.steps[name]?.status === "complete" &&
      name !== "migration" &&
      !(name === "benchmark" && options["--measure-only"])
    )
      return;
    process.stdout.write(`${name}: started\n`);
    state.steps[name] = { status: "running", startedAt: new Date().toISOString() };
    await save();
    const start = performance.now();
    try {
      await work();
      state.steps[name].status = "complete";
    } catch (error) {
      state.steps[name].status = "failed";
      state.steps[name].error = String(error);
      throw error;
    } finally {
      state.steps[name].elapsedMs = performance.now() - start;
      await save();
    }
    process.stdout.write(`${name}: complete (${Math.round(state.steps[name].elapsedMs)} ms)\n`);
  }
  const cli = (name, file, extra = []) =>
    step(name, () =>
      logged(
        process.execPath,
        [path.join(root, "apps/server/dist", file), ...extra],
        env,
        path.join(directory, `${name}.log`),
      ),
    );
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await pool.query("SELECT 1");
        ready = true;
        break;
      } catch {
        await setTimeout(1000);
      }
    }
    if (!ready) throw new Error("Isolated PostgreSQL did not start");
    if (!options["--measure-only"]) {
      await step("snapshot", async () => {
        const tables = await pool.query(
          "SELECT 1 FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') LIMIT 1",
        );
        if (tables.rows.length)
          throw new Error("Refusing to copy into a nonempty database; create a new run");
        await copyDatabase(state.source, state.container, path.join(directory, "snapshot.log"));
      });
      await cli("migration", "migrate.js");
      await step("statistics", () => pool.query("ANALYZE"));
      for (let season = 2020; season <= 2025; season++)
        await cli(`competition-${season}`, "maintenance/sync-game-competition.js", [
          "--season",
          String(season),
        ]);
      await step("classification-statistics", () =>
        pool.query(
          "ANALYZE reference.competition_datasets; ANALYZE reference.current_competition_datasets; ANALYZE reference.game_competitions; ANALYZE reference.competition_game_links",
        ),
      );
      await step("inventory", async () => {
        const result = await pool.query(
          "SELECT season,competition,count(*)::int AS games FROM analytics.current_analysis_games GROUP BY season,competition ORDER BY season,competition",
        );
        await writeFile(
          path.join(directory, "inventory.json"),
          JSON.stringify(result.rows, null, 2),
        );
        const seasons = new Set(
          result.rows
            .filter((r) => r.competition === "regular" && r.games > 0)
            .map((r) => r.season),
        );
        if (seasons.size !== 6)
          throw new Error("All six seasons require confirmed regular-season observations");
      });
      if (!options["--prepare-only"]) {
        for (const [name, file, extra] of [
          ["re24", "train-run-expectancy.js", []],
          ["count", "train-run-expectancy.js", ["--count"]],
          ["win", "train-run-expectancy.js", ["--win"]],
          ["park", "train-park-environment.js", []],
          ["quality", "train-pitch-quality.js", []],
        ])
          await cli(name, `maintenance/${file}`, ["--through", "2024", ...extra]);
      }
    }
    if (!options["--prepare-only"]) {
      state.measurementCodeHash = codeHash;
      await step("benchmark", () =>
        logged(
          process.execPath,
          ["scripts/measure-analytics-queries.mjs"],
          env,
          path.join(directory, "benchmark.log"),
        ),
      );
    }
    state.status = options["--prepare-only"] ? "prepared" : "complete";
  } catch (error) {
    state.status = "failed";
    throw error;
  } finally {
    await pool.end();
    await save();
    await writeValidationReport(directory, state);
    process.stdout.write(
      `Artifacts: ${directory}\nDatabase retained for inspection; use --resume RUN_DIRECTORY --cleanup to remove only this run's container and volume.\n`,
    );
  }
}
