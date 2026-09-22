import assert from "node:assert/strict";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setInterval, clearInterval } from "node:timers";
import { Pool } from "pg";
import {
  capture,
  assertOwnedDatabase,
  lockValidationRun,
  validationCodeHash,
} from "./analytics-validation-process.mjs";
import { auditHash, checkAuditBaseline, compareAuditRecords } from "./analytics-audit-checks.mjs";
import { auditWorkloads } from "./analytics-audit-workload.mjs";
import { ComputationPool } from "../apps/server/dist/computation-pool.js";
const { AbortController } = globalThis;

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i],
    value = args[i + 1];
  assert(
    ["--run", "--baseline", "--mode", "--seasons"].includes(key) &&
      value &&
      !value.startsWith("--") &&
      !options[key],
    "Use --run RUN_DIRECTORY [--baseline AUDIT_DIRECTORY] [--mode all|workload|queries] [--seasons 2020,2021,...]",
  );
  options[key] = value;
}
assert(options["--run"], "An owned validation run is required");
const run = path.resolve(options["--run"]);
assert(run.startsWith(path.join(root, "analysis", "validation") + path.sep));
const mode = options["--mode"] ?? "all";
assert(["all", "workload", "queries"].includes(mode));
const seasons = (options["--seasons"] ?? "2020,2021,2022,2023,2024,2025")
  .split(",")
  .map(Number)
  .sort();
assert(
  seasons.length > 0 &&
    new Set(seasons).size === seasons.length &&
    seasons.every((s) => Number.isInteger(s) && s >= 2020 && s <= 2025),
);
const unlock = lockValidationRun(run);
const controller = new AbortController();
const abort = () => controller.abort(new Error("Audit cancelled"));
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
let pool, worker, timer, directory;
const report = {
  kind: "kbo-analytics-audit-v1",
  status: "running",
  startedAt: new Date().toISOString(),
  maxSampledRssBytes: process.memoryUsage().rss,
  mode,
  seasons,
};
try {
  const state = JSON.parse(await readFile(path.join(run, "run.json"), "utf8"));
  const inspection = JSON.parse(await capture("docker", ["inspect", state.container]))[0];
  assertOwnedDatabase(state, inspection);
  assert.equal(state.steps?.snapshot?.status, "complete", "Snapshot must be complete");
  const port = inspection.NetworkSettings.Ports["5432/tcp"]?.[0];
  assert.equal(port?.HostIp, "127.0.0.1");
  const password = inspection.Config.Env.find((s) => s.startsWith("POSTGRES_PASSWORD="))?.slice(18);
  assert(password && port.HostPort);
  pool = new Pool({
    host: "127.0.0.1",
    port: Number(port.HostPort),
    user: "kbo_validation",
    database: "kbo_validation",
    password,
    max: 4,
    connectionTimeoutMillis: 5000,
    options: "-c default_transaction_read_only=on -c statement_timeout=30000",
  });
  worker = new ComputationPool(1, 16);
  directory = path.join(run, "audits", randomUUID());
  await mkdir(directory, { recursive: true });
  process.stdout.write(`Audit artifacts: ${directory}\n`);
  const source = async () =>
    auditHash(
      (
        await pool.query(
          `SELECT game_id,revision,document_hash,competition,competition_dataset_hash FROM analytics.current_analysis_games ORDER BY game_id COLLATE "C"`,
        )
      ).rows,
    );
  report.sourceHash = await source();
  const previous = options["--baseline"]
    ? JSON.parse(
        await readFile(path.join(path.resolve(options["--baseline"]), "audit.json"), "utf8"),
      )
    : null;
  // Reject an incompatible baseline before reading/recomputing every pitcher.
  if (previous !== null) checkAuditBaseline(previous, report);
  report.codeHash = await validationCodeHash(root);
  const scriptsHash = createHash("sha256");
  for (const name of [
    "audit-analytics",
    "analytics-audit-checks",
    "analytics-audit-workload",
    "analytics-audit-queries",
  ]) {
    scriptsHash.update(name).update(await readFile(path.join(root, "scripts", `${name}.mjs`)));
  }
  report.auditCodeHash = scriptsHash.digest("hex");
  report.maxSampledRssBytes = process.memoryUsage().rss;
  timer = setInterval(() => {
    report.maxSampledRssBytes = Math.max(report.maxSampledRssBytes, process.memoryUsage().rss);
  }, 25);
  const progress = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  if (mode !== "queries")
    report.workload = await auditWorkloads(
      pool,
      worker,
      seasons,
      directory,
      controller.signal,
      progress,
    );
  if (mode !== "workload") {
    const { auditQueries } = await import("./analytics-audit-queries.mjs");
    report.queries = await auditQueries(
      pool,
      worker,
      path.join(run, "workspace"),
      directory,
      controller.signal,
      progress,
    );
  }
  assert.equal(await source(), report.sourceHash, "Source changed during audit");
  if (previous !== null) {
    report.differences = [];
    if (report.workload) {
      assert.equal(previous.workload.inventoryHash, report.workload.inventoryHash);
      report.differences.push(
        ...compareAuditRecords(previous.workload.records, report.workload.records),
      );
    }
    if (report.queries) {
      assert.deepEqual(previous.queries.modelHashes, report.queries.modelHashes, "Model changed");
      assert.deepEqual(
        previous.queries.sequential.map((r) => r.name),
        report.queries.sequential.map((r) => r.name),
        "HTTP workload set changed",
      );
      for (const row of report.queries.sequential) {
        const prior = previous.queries.sequential.find((r) => r.name === row.name);
        if (!prior || prior.responseHash !== row.responseHash)
          report.differences.push({ key: row.name, reason: "response_changed" });
      }
    }
    assert.equal(report.differences.length, 0, "Baseline differences require review");
  }
  assert.equal(report.workload?.failures.length ?? 0, 0, "Some actors failed validation");
  report.status = "complete";
} catch (error) {
  report.status = controller.signal.aborted ? "cancelled" : "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  if (timer) clearInterval(timer);
  await worker?.close();
  await pool?.end();
  report.finishedAt = new Date().toISOString();
  if (directory) {
    await writeFile(path.join(directory, "audit.json"), JSON.stringify(report, null, 2) + "\n");
    const lines = [
      "# 전체 자료 분석 검증",
      "",
      `상태: ${report.status}`,
      `시작: ${report.startedAt}`,
      `종료: ${report.finishedAt}`,
      "",
      "소유권을 확인한 격리 DB를 읽기 전용으로 조회했다. 표본 부족은 정상 상태이며 효과의 인과성·통계적 유의성 순위를 검증하지 않는다.",
      "",
      "| 시즌 | 투수 | 실제 투구 | 조건 미상 | 제공 가능 | 표본 부족 | 재표집 불안정 |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ];
    for (const s of report.workload?.summaries ?? [])
      lines.push(
        `| ${s.season} | ${s.actors} | ${s.actualPitches} | ${s.excludedConditionPitches} | ${s.ready} | ${s.insufficient_support} | ${s.unstable_interval} |`,
      );
    if (report.queries) {
      lines.push(
        "",
        "## HTTP 조회",
        "",
        "| 조회 | 첫 ms | 이후 30회 p95 ms | 4건 동시 요청 p95 ms |",
        "| --- | ---: | ---: | ---: |",
      );
      for (const row of report.queries.sequential) {
        const concurrent = report.queries.concurrent
          .filter((r) => r.name === row.name)
          .map((r) => r.elapsedMs)
          .sort((a, b) => a - b);
        lines.push(
          `| ${row.name} | ${row.firstMs.toFixed(1)} | ${row.warmP95Ms.toFixed(1)} | ${concurrent[Math.ceil(concurrent.length * 0.95) - 1].toFixed(1)} |`,
        );
      }
      lines.push(
        "",
        "새 보정 캐시 생성과 HTTP 왕복을 포함한다. DB/OS cache는 비우지 않았으며 브라우저·프록시는 제외한다. 동시 4건 10묶음은 이 부하의 관측값이며 최대 처리 용량을 뜻하지 않는다.",
        `운용 요청 취소: ${report.queries.cancellation}. 종료 후 DB 대기 연결: ${report.queries.poolAfter.waiting}.`,
        "",
      );
      const coverage = report.queries.sequential.find((row) => row.name === "coverage");
      if (coverage && report.queries.coverageRestart)
        lines.push(
          `품질 요약의 최초 상태 응답: ${coverage.measurements[0].acceptedMs.toFixed(1)}ms. 위 첫 ms는 준비 완료까지의 전체 시간(상태 polling 포함)이다.`,
          `새 route instance에서 저장 요약 재사용: ${report.queries.coverageRestart.elapsedMs.toFixed(1)}ms, 준비 polling ${report.queries.coverageRestart.preparationPolls}회.`,
        );
    }
    lines.push(
      "",
      `최대 관측 Node RSS: ${(report.maxSampledRssBytes / 2 ** 20).toFixed(1)} MiB (25ms 표본, 부모·worker 포함, DB 제외).`,
      "",
      "입력 순서 반전 재계산·독립 투구 합계·지표 분모·보류 정책을 확인했다. 실행 실패는 성공으로 취급하지 않는다. 개별 결과와 hash는 workload.ndjson, 실행 요약·차이는 audit.json에 보존한다.",
      "",
    );
    if (report.error) lines.push(`실패: ${report.error}`);
    await writeFile(path.join(directory, "report.md"), lines.join("\n") + "\n");
  }
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  unlock();
  process.stdout.write(
    JSON.stringify({ status: report.status, error: report.error, directory }) + "\n",
  );
}
