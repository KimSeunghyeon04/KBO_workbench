import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeValidationReport(directory, state) {
  const models = new Map();
  const lines = [
    "# 실제 수집 자료 분석 검증",
    "",
    `시작: ${state.startedAt}`,
    "",
    "운영 DB의 일관된 읽기 전용 snapshot을 새 PostgreSQL에 복사했다. 운영 workspace를 복원한 사본이나 재해 복구용 backup은 아니다. 공식 일정 증거와 파생 모델은 이 실행의 새 workspace에만 저장했다.",
    "",
    "2023·2024 검증으로 후보를 선택한 뒤 2025 평가를 기록했다. 승리확률은 과거 경기를 적용 연도의 연장 상한으로 재구성해 학습한다. 종전 구장 보정 연구에서도 2025를 사용했으므로 완전히 미관측인 외부 검증으로 해석하지 않는다.",
    "",
  ];
  if (state.steps.inventory?.status === "complete") {
    const inventory = JSON.parse(await readFile(path.join(directory, "inventory.json"), "utf8"));
    lines.push("## 경기 분류", "", "| 시즌 | 종류 | 경기 |", "| --- | --- | ---: |");
    for (const row of inventory)
      lines.push(`| ${row.season} | ${row.competition} | ${row.games} |`);
    lines.push("");
  }
  lines.push(
    "## 학습 결과",
    "",
    "기준 모형을 유지하는 결과도 정상적인 검증 결과다. 채택 기준을 완화하거나 2025 결과로 재선택하지 않는다.",
    "",
    "| 모델 | 상태/선택 | 전체 초 | 조회 초 | 계산 초 | 최대 관측 RSS MiB |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  );
  for (const name of ["re24", "count", "win", "park", "quality"]) {
    if (state.steps[name]?.status !== "complete") {
      lines.push(`| ${name} | ${state.steps[name]?.status ?? "미실행"} | — | — | — | — |`);
      continue;
    }
    const text = await readFile(path.join(directory, `${name}.log`), "utf8");
    const report = JSON.parse(text.trim().split(/\r?\n/).at(-1));
    models.set(name, report);
    const selection =
      report.targets
        ?.map((m) => `${m.target}: ${m.adopted ? m.selectedKind : "기준 유지"}`)
        .join("; ") ??
      report.metrics
        ?.map((m) => `${m.metric}: ${m.adopted ? m.selectedFamily : "미채택"}`)
        .join("; ") ??
      `${report.status} / ${report.method}`;
    const seconds = (n) => (typeof n === "number" ? (n / 1000).toFixed(2) : "—");
    lines.push(
      `| ${name} | ${selection} | ${seconds(report.elapsedMs)} | ${seconds(report.phasesMs?.read)} | ${seconds(report.phasesMs?.fit)} | ${report.maxSampledRssBytes ? (report.maxSampledRssBytes / 2 ** 20).toFixed(1) : "—"} |`,
    );
  }
  lines.push(
    "",
    "RSS는 100ms 간격의 최대 관측값으로 순간 peak의 상한이 아니다. 세부 검증 후보·오차·표본은 각 모델의 `.log`와 불변 모델 파일에 있다.",
    "",
  );
  const quality = models.get("quality");
  if (quality) {
    const decimal = (v) => (typeof v === "number" ? v.toFixed(4) : "—");
    lines.push(
      "## 구종 기대 효과 검증",
      "",
      "log loss는 작을수록 좋다. 각 비교는 같은 평가 표본을 사용한다. 헛스윙의 분모는 스윙, 루킹의 분모는 비스윙이다.",
      "",
      "| 대상 | 2023 기준 → 선택 | 2024 기준 → 선택 | 2025 선택 | 2025 평가 표본 |",
      "| --- | ---: | ---: | ---: | ---: |",
    );
    for (const target of quality.targets) {
      const baseline = target.validation.find((v) => v.kind === "baseline");
      const selected = target.validation.find(
        (v) => v.kind === target.selectedKind && v.lambda === target.selectedLambda,
      );
      const comparison = (year) =>
        `${decimal(baseline?.evaluations.find((e) => e.season === year)?.logLoss)} → ${decimal(selected?.evaluations.find((e) => e.season === year)?.logLoss)}`;
      lines.push(
        `| ${target.target} | ${comparison(2023)} | ${comparison(2024)} | ${decimal(target.evaluation.logLoss)} | ${target.evaluation.samples} |`,
      );
    }
    const c = quality.targets[0]?.evaluation.coverage;
    if (c)
      lines.push(
        "",
        `2025 실제 ${c.actual}구 중 공통 지원 표본은 ${c.used}구다. 부적격 ${c.ineligible}, 필수 입력 누락 ${c.missing}, 구장 보정 미지원 ${c.calibrationUnsupported}, 학습 범위 밖 ${c.outOfSupport}구를 구분한다.`,
        "",
      );
  }
  if (state.steps.benchmark?.status === "complete") {
    const report = JSON.parse(await readFile(path.join(directory, "benchmark.json"), "utf8"));
    lines.push(
      "## 조회 성능",
      "",
      "30회 중 첫 실행과 이후 29회의 p95다. PostgreSQL/OS cache를 비우지 않았으며 HTTP·브라우저 렌더링은 제외한다. 모델 원천 검증과 worker 적용을 포함한다.",
      "",
      "| 조회 | 첫 ms | warm p95 ms | DB p95 ms | 계산 등 p95 ms | 응답 KiB |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const r of report.results)
      lines.push(
        `| ${r.label} | ${r.total.firstMs.toFixed(1)} | ${r.total.warmP95Ms.toFixed(1)} | ${r.database.warmP95Ms.toFixed(1)} | ${r.processing.warmP95Ms.toFixed(1)} | ${(r.responseBytes / 1024).toFixed(1)} |`,
      );
    lines.push(
      "",
      "실행계획·SQL hash·모델 hash·선수/시즌은 `benchmark.json`에 기록했다. 각 열 p95는 서로 다른 반복에서 나올 수 있으므로 합산하지 않는다.",
      "",
    );
  }
  await writeFile(path.join(directory, "report.md"), lines.join("\n") + "\n");
}
