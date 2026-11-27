[CmdletBinding()]
param(
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$suffix = "$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$projectName = "kbo-stage6-$suffix"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) $projectName
$workspacePath = Join-Path $testRoot "data"
$backupRoot = Join-Path $testRoot "backups"
$webPort = Get-Random -Minimum 18080 -Maximum 19999
$dbPort = Get-Random -Minimum 20000 -Maximum 21999
$baseUrl = "http://127.0.0.1:$webPort"
$environmentNames = @(
  "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_PATH_SEPARATOR",
  "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB",
  "KBO_DATA_DIR", "KBO_WEB_PORT", "KBO_DB_PORT", "KBO_POSTGRES_VOLUME_NAME", "KBO_COLLECTION_CONCURRENCY",
  "KBO_NAVER_MAX_ATTEMPTS", "KBO_NAVER_REQUESTS_PER_SECOND", "KBO_NAVER_TIMEOUT_MS",
  "KBO_RECORD_CORRECTION_AUTO_SYNC", "KBO_ANALYSIS_AUTO_REFRESH"
)
$previousEnvironment = @{}

function Assert-NativeSuccess([string]$Action) {
  if ($LASTEXITCODE -ne 0) { throw "$Action 실패 (exit $LASTEXITCODE)" }
}

function Invoke-Compose([string[]]$Arguments) {
  & docker compose @Arguments
  Assert-NativeSuccess "docker compose $($Arguments -join ' ')"
}

function Wait-Ready {
  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    try {
      $health = Invoke-RestMethod -Uri "$baseUrl/health/ready" -TimeoutSec 2
      if ($health.status -eq "ok") { return }
    }
    catch { }
    Start-Sleep -Seconds 1
  }
  throw "격리 Compose가 ready 상태가 되지 않았습니다: $baseUrl"
}

function Write-Utf8([string]$Path, [string]$Contents) {
  [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}

function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha256.ComputeHash($stream)
    return -join ($bytes | ForEach-Object { $_.ToString("x2") })
  }
  finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Assert-BrowserUi {
  $browserSmoke = @'
import { chromium } from "playwright";

async function assertNoHorizontalOverflow(page, selector) {
  const overflows = await page.locator(selector).evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  );
  if (overflows) throw new Error(`${selector} overflows its content width.`);
}

async function assertOperationConsole(page, options) {
  const { path, heading, listName, hasRows } = options;
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`http://localhost${path}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: heading }).waitFor();
  const list = page.getByRole("listbox", { name: listName });
  await list.waitFor();
  await assertNoHorizontalOverflow(page, ".operation-page");
  const documentScrolls = await page.locator("html").evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  );
  if (documentScrolls) {
    throw new Error(`${path} stacks below the 1280x720 desktop viewport.`);
  }
  if ((await list.locator('[role="option"] button').count()) !== 0) {
    throw new Error(`${path} repeats action buttons inside list rows.`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://localhost${path}`, { waitUntil: "networkidle" });
  const mobileList = page.getByRole("listbox", { name: listName });
  await mobileList.waitFor();
  await assertNoHorizontalOverflow(page, ".operation-page");
  if (hasRows) {
    const firstRow = mobileList.locator('[role="option"]').first();
    await firstRow.click();
    const detail = page.locator(".operation-console.has-selection .operation-console-detail");
    await detail.waitFor();
    const back = page.getByRole("button", { name: /\uBAA9\uB85D\uC73C\uB85C/ });
    if (!(await back.isVisible())) throw new Error(`${path} mobile detail has no back action.`);
    const actions = detail.locator(".operation-detail-actions");
    if ((await actions.count()) > 0) {
      const [detailBox, actionBox] = await Promise.all([detail.boundingBox(), actions.boundingBox()]);
      if (
        detailBox === null ||
        actionBox === null ||
        actionBox.y + actionBox.height > detailBox.y + detailBox.height + 1
      ) {
        throw new Error(`${path} mobile actions are buried outside the detail viewport.`);
      }
    }
    const selectedUrl = page.url();
    await page.reload({ waitUntil: "networkidle" });
    await detail.waitFor();
    await page.goBack({ waitUntil: "networkidle" });
    await mobileList.waitFor();
    if (!(await mobileList.isVisible())) throw new Error(`${path} history back did not restore list.`);
    await page.goForward({ waitUntil: "networkidle" });
    await detail.waitFor();
    if (page.url() !== selectedUrl) throw new Error(`${path} history forward lost the selection.`);
    await back.click();
    await mobileList.waitFor();
    if (!(await mobileList.isVisible())) throw new Error(`${path} mobile back did not restore list.`);
  }
}

// Use the production localhost secure context, with DNS mapped only inside this test browser.
const { lookup } = await import("node:dns/promises");
const webAddress = (await lookup("web")).address;
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP localhost ${webAddress}`] });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("http://localhost/settings", { waitUntil: "networkidle" });
  if (!await page.evaluate(() => isSecureContext && typeof crypto.subtle?.digest === "function")) {
    throw new Error("UI smoke must use the same secure localhost context as production.");
  }
  await page.locator("h1").waitFor();
  const settingsHeading = await page.locator("h1").innerText();
  await page.locator("details > summary").click();
  const settingsBody = await page.locator("body").innerText();
  if (
    settingsHeading !== "\uC124\uC815 \uBC0F \uC9C4\uB2E8" ||
    !settingsBody.includes("\uCD5C\uADFC \uC2E4\uD328 \uC791\uC5C5") ||
    !settingsBody.includes("PostgreSQL 16") ||
    !settingsBody.includes("\uC800\uC7A5")
  ) {
    throw new Error("Settings browser assertion failed.");
  }

  await page.goto("http://localhost/replay", { waitUntil: "networkidle" });
  await page.locator("h1").waitFor();
  if ((await page.locator("h1").innerText()) !== "\uACBD\uAE30 \uC7AC\uC0DD") {
    throw new Error("Replay browser assertion failed.");
  }
  if (
    (await page.getByRole("region", { name: "\uB0A0\uC9DC\uB85C \uACBD\uAE30 \uCC3E\uAE30" }).count()) !== 1
  ) {
    throw new Error("Replay calendar picker is missing.");
  }
  const replaySearch = page.getByLabel("\uAC8C\uC784 ID \uAC80\uC0C9");
  await replaySearch.fill("golden-game-1");
  const replayGame = page.getByRole("option", { name: /golden-game-1/ });
  await replayGame.click();
  if ((await replayGame.getAttribute("aria-selected")) !== "true") {
    throw new Error("Replay game card selection failed.");
  }
  const replayRevision = page.getByLabel("Revision");
  await replayRevision.locator('option[value="1"]').waitFor({ state: "attached" });
  await replayRevision.selectOption("1");
  await page
    .getByRole("button", { name: "\uC120\uD0DD \uACBD\uAE30 \uC7AC\uC0DD" })
    .click();
  await page.getByRole("heading", { name: "\uC6D0\uC790\uC801 \uD50C\uB808\uC774" }).waitFor();
  const replayFrames = await (
    await page.request.get(
      "http://web/api/v2/games/golden-game-1/revisions/1/replay-frames?limit=1000",
    )
  ).json();
  const movementIndex = replayFrames.frames.findIndex((frame) => frame.movements.length > 0);
  const trackingIndex = replayFrames.frames.findIndex((frame) => frame.tracking.length > 0);
  if (movementIndex < 0 || trackingIndex < 0) {
    throw new Error("Replay fixture must include movement and tracking frames.");
  }
  const replaySlider = page.getByRole("slider", { name: "\uC7AC\uC0DD \uC704\uCE58" });
  await replaySlider.fill(String(movementIndex));
  await page.locator(".movement-block").waitFor();
  await replaySlider.fill(String(trackingIndex));
  await page.locator(".strike-zone-wrap, .tracking-plot-empty").waitFor();
  await page.setViewportSize({ width: 1536, height: 886 });
  if ((await page.locator(".replay-dashboard > .panel").count()) !== 3) {
    throw new Error("Replay dashboard must expose play, state, and tracking together.");
  }
  // Evidence notices and expanded analysis panels may grow the document.
  // Keep the score and evidence readable instead of shrinking fixed grid tracks.
  for (const selector of [".replay-scoreboard", ".replay-dashboard > .panel"]) {
    const clipped = await page.locator(selector).evaluateAll((elements) =>
      elements.flatMap((element) => {
        const panel = element.getBoundingClientRect();
        // The scaled base-diamond SVG contributes unscaled scrollHeight; inspect rendered boxes.
        const outside = Array.from(element.children).filter((child) => {
          const box = child.getBoundingClientRect();
          return box.height > 0 && (box.top < panel.top - 1 || box.bottom > panel.bottom + 1);
        });
        return panel.height < 90 || outside.length > 0
          ? [{ className: element.className, height: panel.height, outside: outside.map((child) => child.className) }]
          : [];
      }),
    );
    if (clipped.length > 0) throw new Error(`Replay evidence is clipped: ${JSON.stringify(clipped)}`);
  }
  await page.getByRole("button", { name: "\uACBD\uAE30 \uBCC0\uACBD" }).click();
  const pickerBox = await page.locator(".replay-game-picker.floating").boundingBox();
  if (pickerBox === null || pickerBox.y + pickerBox.height > 886) {
    throw new Error("Replay game picker does not fit inside the desktop viewport.");
  }
  await page
    .getByRole("button", { name: "\uC120\uD0DD \uB2EB\uAE30", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  const replayOverflows = await page
    .locator(".replay-page")
    .evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  if (replayOverflows) {
    throw new Error("Replay page overflows its mobile content width.");
  }

  for (const [name, table] of [["\ud50c\ub808\uc774 \ub4dd\uc810\uac00\uce58 \ubcf4\uae30", "\ud50c\ub808\uc774 \ub4dd\uc810\uac00\uce58"], ["\ud22c\uad6c\u00b7\ube44\ud22c\uad6c \ub4dd\uc810\uac00\uce58 \ubcf4\uae30", "\uce74\uc6b4\ud2b8 \uac00\uce58 \uc804\uc774"], ["\uc2b9\ub9ac\ud655\ub960 \ubcf4\uae30", "\uc2b9\ub9ac\ud655\ub960 \ud50c\ub808\uc774"]]) {
    await page.getByRole("button", {name, exact:true}).click();
    await page.getByRole("table", {name:table, exact:true}).waitFor();
  }
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error("Value panel horizontal overflow.");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("http://localhost/collect?start=2026-01-01&end=2026-12-31&discovery=stage6-discovery", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "\uc6d4\ubcc4 \ud604\ud669" }).waitFor();
  await assertNoHorizontalOverflow(page, ".collection-period-page");
  await page.getByRole("button", { name: "2026-04", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "\ub0a0\uc9dc\ubcc4 \ud604\ud669" }).waitFor();
  await page.getByRole("button", { name: "2026-04-01", exact: true }).click();
  await page.getByRole("heading", { name: "\uacbd\uae30 \ubaa9\ub85d" }).waitFor();
  if ((await page.locator(".collection-table tbody tr").count()) > 50) throw new Error("Collection list is not paginated.");
  await page.getByRole("button", { name: "\ubbf8\uc218\uc9d1 600\uacbd\uae30 \uc218\uc9d1" }).waitFor();
  await page.getByRole("button", { name: "\ud604\uc7ac \ub0a0\uc9dc\ub9cc \ub300\uc0c1\uc73c\ub85c \uc124\uc815" }).click();
  await page.locator(".collection-row-link").first().click();
  await page.getByRole("complementary", { name: "\uacbd\uae30 \uc0c1\uc138" }).waitFor();
  await page.getByRole("combobox", { name: "\ud45c\uc2dc \uc0c1\ud0dc" }).selectOption("quarantine");
  await page.getByRole("complementary", { name: "\uacbd\uae30 \uc0c1\uc138" }).waitFor({ state: "hidden" });
  await page.goBack();
  await page.getByRole("combobox", { name: "\ud45c\uc2dc \uc0c1\ud0dc" }).selectOption("all");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".collection-row-link").first().click();
  await assertNoHorizontalOverflow(page, ".collection-period-page");
  await page.locator(".collection-periods").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "\uc0c1\uc138 \ub2eb\uae30" }).click();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "\uacbd\uae30 \ubaa9\ub85d" }).waitFor();
  await page.getByRole("button", { name: "\uc218\uc9d1 \uae30\ub85d", exact: true }).click();
  await page.getByRole("region", { name: "\uc218\uc9d1 \uae30\ub85d" }).waitFor();

  await assertOperationConsole(page, {
    path: "/database?scope=stored",
    heading: "\uB370\uC774\uD130\uBCA0\uC774\uC2A4",
    listName: "\uC800\uC7A5\uB41C \uACBD\uAE30",
    hasRows: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("http://localhost/database?scope=ready", { waitUntil: "networkidle" });
  const batchButton = page.getByRole("button", {
    name: "\uD604\uC7AC \uC870\uAC74 \uC804\uCCB4 \uC120\uD0DD",
  });
  if ((await batchButton.count()) !== 1 || !(await batchButton.isDisabled())) {
    throw new Error("Database batch import browser assertion failed.");
  }

  await page.goto("http://localhost/correct", { waitUntil: "networkidle" });
  await page.locator("h1").waitFor();
  if ((await page.locator("h1").innerText()) !== "\uC911\uACC4 \uC6D0\uC7A5 \uBCF4\uC815") {
    throw new Error("Correction browser heading assertion failed.");
  }
  const correctionBody = await page.locator("body").innerText();
  if (
    !correctionBody.includes("\uAC80\uD1A0 \uD544\uC694") ||
    (await page.locator(".correction-empty .workflow-guide li").count()) !== 3
  ) {
    throw new Error("Correction default review scope assertion failed.");
  }
  await page.getByRole("button", { name: /\uC804\uCCB4/ }).click();
  const gameSelect = page.getByLabel("\uACBD\uAE30", { exact: true });
  if ((await gameSelect.locator('option:not([value=""])').count()) !== 0) {
    throw new Error("DB authority game must not be exposed to correction.");
  }
  if (pageErrors.length > 0) {
    throw new Error(`Browser page error: ${pageErrors.join(" | ")}`);
  }

  await assertOperationConsole(page, {
    path: "/record-corrections",
    heading: "KBO \uAE30\uB85D\uC815\uC815",
    listName: "\uAE30\uB85D\uC815\uC815 \uACF5\uC9C0 \uBAA9\uB85D",
    hasRows: false,
  });
  if ((await page.getByLabel("\uAE30\uB85D\uC815\uC815 \uD050").getByRole("button").count()) !== 3) {
    throw new Error("Record correction queues are missing.");
  }
  await page
    .getByText("\uC774 \uD050\uC5D0 \uB0A8\uC740 \uACF5\uC9C0\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.")
    .waitFor();
  if (pageErrors.length > 0) {
    throw new Error(`Browser page error: ${pageErrors.join(" | ")}`);
  }
  console.log(
    JSON.stringify({
      settings: "ok",
      replay: "ok",
      collection: "ok",
      database: "ok",
      correction: "ok",
      recordCorrection: "ok",
      pageErrors: 0,
    }),
  );
}
finally {
  await browser.close();
}
'@
  $browserSmoke | & docker compose exec -T --workdir /app/packages/collection api `
    node --input-type=module
  Assert-NativeSuccess "격리 Chromium UI smoke"
}

foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
[Environment]::SetEnvironmentVariable("COMPOSE_PROJECT_NAME", $projectName, "Process")
[Environment]::SetEnvironmentVariable("POSTGRES_USER", "kbo_e2e", "Process")
[Environment]::SetEnvironmentVariable("POSTGRES_PASSWORD", "kbo_e2e_password", "Process")
[Environment]::SetEnvironmentVariable("POSTGRES_DB", "kbo_e2e", "Process")
[Environment]::SetEnvironmentVariable("KBO_DATA_DIR", $workspacePath, "Process")
[Environment]::SetEnvironmentVariable("KBO_WEB_PORT", [string]$webPort, "Process")
[Environment]::SetEnvironmentVariable("KBO_DB_PORT", [string]$dbPort, "Process")
[Environment]::SetEnvironmentVariable("KBO_POSTGRES_VOLUME_NAME", "$projectName-postgres-v3", "Process")
[Environment]::SetEnvironmentVariable("KBO_COLLECTION_CONCURRENCY", "1", "Process")
[Environment]::SetEnvironmentVariable("KBO_NAVER_MAX_ATTEMPTS", "1", "Process")
[Environment]::SetEnvironmentVariable("KBO_NAVER_REQUESTS_PER_SECOND", "100", "Process")
[Environment]::SetEnvironmentVariable("KBO_NAVER_TIMEOUT_MS", "1000", "Process")
[Environment]::SetEnvironmentVariable("KBO_RECORD_CORRECTION_AUTO_SYNC", "false", "Process")
[Environment]::SetEnvironmentVariable("KBO_ANALYSIS_AUTO_REFRESH", "false", "Process")

$null = New-Item -ItemType Directory -Path $testRoot
$composeStarted = $false
$testImages = @()
$cleanupFailures = @()
Push-Location $repositoryRoot
try {
  $upArguments = @("up", "-d")
  $imageOverrides = @{
    migrate = @{ pull_policy = "never" }
    api = @{ pull_policy = "never" }
    web = @{ pull_policy = "never" }
  }
  if ($SkipBuild) {
    $upArguments += "--no-build"
  }
  else {
    $apiImage = "${projectName}-api:local"
    $webImage = "${projectName}-web:local"
    $testImages = @($apiImage, $webImage)
    $imageOverrides.migrate.image = $apiImage
    $imageOverrides.api.image = $apiImage
    $imageOverrides.web.image = $webImage
    $upArguments += "--build"
  }
  $imageOverridePath = Join-Path $testRoot "compose.images.json"
  Write-Utf8 $imageOverridePath (@{ services = $imageOverrides } | ConvertTo-Json -Depth 5)
  $composeSeparator = [string][IO.Path]::PathSeparator
  $composeFiles = @((Join-Path $repositoryRoot "compose.yaml"), $imageOverridePath)
  [Environment]::SetEnvironmentVariable("COMPOSE_PATH_SEPARATOR", $composeSeparator, "Process")
  [Environment]::SetEnvironmentVariable("COMPOSE_FILE", ($composeFiles -join $composeSeparator), "Process")

  $resolvedCompose = & docker compose config --format json
  Assert-NativeSuccess "격리 E2E 이미지 확인"
  $configuration = ($resolvedCompose -join [Environment]::NewLine) | ConvertFrom-Json
  if ($configuration.name -ne $projectName) {
    throw "격리 E2E의 Compose project가 이 실행에 지정된 이름과 일치하지 않습니다."
  }
  if ($testImages.Count -gt 0) {
    if ($configuration.services.api.image -ne $apiImage -or
        $configuration.services.migrate.image -ne $apiImage -or
        $configuration.services.web.image -ne $webImage) {
      throw "격리 E2E의 앱 이미지가 이 실행에 지정된 태그와 일치하지 않습니다."
    }
    Write-Output "격리 E2E 이미지: $($testImages -join ', ')"
  }

  $composeStarted = $true
  Invoke-Compose -Arguments $upArguments
  Wait-Ready

  Invoke-Compose -Arguments @("stop", "web", "api")
  $stagingDirectory = Join-Path $workspacePath "staging\2026"
  $originalDirectory = Join-Path $workspacePath "original\2026"
  $journalDirectory = Join-Path $workspacePath "journals"
  $null = New-Item -ItemType Directory -Force -Path $stagingDirectory
  $null = New-Item -ItemType Directory -Force -Path $originalDirectory
  $null = New-Item -ItemType Directory -Force -Path $journalDirectory
  $goldenFixture = [IO.File]::ReadAllText(
    (Join-Path $repositoryRoot "tests\fixtures\game-document-v2.golden.json"),
    [Text.Encoding]::UTF8
  )
  Write-Utf8 (Join-Path $stagingDirectory "golden-game-1.json") $goldenFixture
  Write-Utf8 (Join-Path $originalDirectory "golden-game-1.json") $goldenFixture
  Write-Utf8 `
    (Join-Path $stagingDirectory "golden-game-2.json") `
    ($goldenFixture.Replace('"gameId": "golden-game-1"', '"gameId": "golden-game-2"'))
  Write-Utf8 `
    (Join-Path $originalDirectory "golden-game-2.json") `
    ($goldenFixture.Replace('"gameId": "golden-game-1"', '"gameId": "golden-game-2"'))
  # Give isolated fixture imports genuine canonical source bundles, including player heights.
  $heightSources = @'
import { readFile,writeFile,mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { canonicalStringify } from "./packages/contracts/dist/index.js";
for (const gameId of ["golden-game-1","golden-game-2"]) {
  const original=`/var/lib/kbo/original/2026/${gameId}.json`;
  const document=JSON.parse(await readFile(original,"utf8"));
  const lineup=Object.fromEntries(["away","home"].map(side=>[side+"TeamLineUp",{
    fullLineUp:document.rosters[side].players.map(p=>({playerCode:p.playerId,playerName:p.name,height:"180.0"}))
  }]));
  const payloads={lineup:{result:{previewData:lineup}}};
  const hash=text=>createHash("sha256").update(text).digest("hex");
  const sourceBundleHash=hash(canonicalStringify({gameId,missingEndpoints:[],payloads}));
  const dir=`/var/lib/kbo/source/2026/${gameId}/${sourceBundleHash}`;
  await mkdir(dir,{recursive:true});
  const canonical=canonicalStringify(payloads.lineup);
  await writeFile(`${dir}/lineup.json.gz`,gzipSync(canonical));
  await writeFile(`${dir}/manifest.json`,canonicalStringify({gameId,season:2026,
    collectedAt:document.source.collectedAt,sourceBundleHash,missingEndpoints:[],endpoints:[{name:"lineup",hash:hash(canonical)}]})+"\n");
  document.source.sourceBundleHash=sourceBundleHash;
  for(const folder of ["staging","original"]) await writeFile(`/var/lib/kbo/${folder}/2026/${gameId}.json`,JSON.stringify(document));
}
'@
  $heightSources | & docker compose run --rm --no-deps -T api node --input-type=module
  Assert-NativeSuccess "격리 선수 키 원문 fixture 저장"
  $interrupted = [ordered]@{
    jobId = "stage6-interrupted"
    kind = "collection"
    status = "running"
    createdAt = "2026-08-21T00:00:00.000Z"
    startedAt = "2026-08-21T00:00:00.000Z"
    finishedAt = $null
    completedItems = 1
    totalItems = 2
    currentGameId = "golden-game-1"
    scope = [ordered]@{ kind = "game_ids"; gameIds = @("golden-game-1", "golden-game-2") }
    skippedItems = 0
    summary = [ordered]@{ ready = 1; quarantined = 0; sourceFailures = 0 }
    error = $null
    errorCategory = $null
  } | ConvertTo-Json -Depth 5
  Write-Utf8 (Join-Path $journalDirectory "collection-stage6-interrupted.json") "$interrupted`n"
  $migrationBackup = Join-Path $workspacePath "e2e-migration-backup"
  $null = New-Item -ItemType Directory -Force -Path $migrationBackup
  $databaseBackup = Join-Path $migrationBackup "postgres.dump"
  $workspaceBackup = Join-Path $migrationBackup "workspace.zip"
  [IO.File]::WriteAllBytes($databaseBackup, [byte[]](1, 2, 3))
  [IO.File]::WriteAllBytes($workspaceBackup, [byte[]](4, 5, 6))
  $backupManifest = [ordered]@{
    formatVersion = 1
    database = [ordered]@{
      file = "postgres.dump"
      sha256 = Get-Sha256Hex $databaseBackup
    }
    workspace = [ordered]@{
      file = "workspace.zip"
      sha256 = Get-Sha256Hex $workspaceBackup
    }
  } | ConvertTo-Json -Depth 4
  Write-Utf8 (Join-Path $migrationBackup "manifest.json") "$backupManifest`n"
  Invoke-Compose -Arguments @(
    "run", "--rm", "--no-deps", "api", "node",
    "apps/server/dist/maintenance/migrate-workspace.js",
    "--dry-run", "--workspace", "/var/lib/kbo"
  )
  Invoke-Compose -Arguments @(
    "run", "--rm", "--no-deps", "api", "node",
    "apps/server/dist/maintenance/migrate-workspace.js",
    "--apply", "--workspace", "/var/lib/kbo", "--backup", "/var/lib/kbo/e2e-migration-backup"
  )
  $collectionFixture = @'
import { StagingWorkspace } from "./packages/persistence/dist/index.js";
const workspace = await StagingWorkspace.open("/var/lib/kbo");
try {
  const entries = Array.from({ length: 600 }, (_, index) => ({ gameId: `anon-schedule-${index}`, gameDate: "2026-04-01", scheduledAt: "2026-04-01T18:30:00+09:00", label: `\ube44\uc2dd\ubcc4 \uacbd\uae30 ${index}` }));
  entries.push(...["golden-game-1", "golden-game-2"].map((gameId) => ({ gameId, gameDate: "2026-08-21", scheduledAt: "2026-08-21T18:30:00+09:00", label: "\ube44\uc2dd\ubcc4 \uc6d0\uc815 vs \ube44\uc2dd\ubcc4 \ud648" })));
  await workspace.collection.saveEntries("stage6-discovery", entries);
  await workspace.collection.savePage("stage6-discovery", 1, { status: 200, url: "https://fixture.invalid/schedule", payload: { fixture: "sanitized-period-collection", games: entries } });
  await workspace.collection.saveDiscovery({ discovery: { discoveryId: "stage6-discovery", range: { startDate: "2026-01-01", endDate: "2026-12-31" }, status: "succeeded", createdAt: "2026-09-05T00:00:00.000Z", finishedAt: "2026-09-05T00:00:01.000Z", pageCount: 1, gameCount: entries.length, complete: true, error: null }, idempotencyKey: "stage6-discovery-key" });
} finally { await workspace.close(); }
'@
  $collectionFixture | & docker compose run --rm --no-deps -T api node --input-type=module
  Assert-NativeSuccess "격리 수집 현황 fixture 저장"
  Invoke-Compose -Arguments @("start", "api", "web")
  Wait-Ready

  $recoveredJobs = Invoke-RestMethod -Uri "$baseUrl/api/v2/collection-jobs"
  $collectionOverview = Invoke-RestMethod -Uri "$baseUrl/api/v2/collection-discoveries/stage6-discovery/overview"
  if ($collectionOverview.counts.total -ne 602 -or $collectionOverview.counts.uncollected -ne 600) { throw "수집 기간 집계가 올바르지 않습니다." }
  $collectionPage = Invoke-RestMethod -Uri "$baseUrl/api/v2/collection-discoveries/stage6-discovery/games"
  if (@($collectionPage.games).Count -ne 50 -or $collectionPage.total -ne 602) { throw "수집 server pagination이 올바르지 않습니다." }
  $collectionSelection = @{ discoveryId = "stage6-discovery"; range = @{ startDate = "2026-01-01"; endDate = "2026-12-31" }; target = "uncollected"; mode = "all_matching"; gameIds = @(); excludedGameIds = @("anon-schedule-0", "anon-schedule-599") } | ConvertTo-Json -Depth 5
  $selectedCollection = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v2/collection-selections" -ContentType "application/json" -Body $collectionSelection
  if ($selectedCollection.count -ne 598) { throw "500경기 초과 수집 대상 확정이 올바르지 않습니다." }
  $recovered = @($recoveredJobs.jobs) | Where-Object { $_.jobId -eq "stage6-interrupted" }
  if ($recovered.status -ne "failed" -or $recovered.errorCategory -ne "persistence") {
    throw "재시작 journal recovery 결과가 올바르지 않습니다."
  }
  $system = Invoke-RestMethod -Uri "$baseUrl/api/v2/system/status"
  if (@($system.recentFailures).Count -lt 1) { throw "Settings 실패 진단이 비어 있습니다." }

  $importBody = @{ idempotencyKey = "stage6-ready-batch-import-key" } | ConvertTo-Json -Compress
  $created = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v2/import-jobs/batch" `
    -ContentType "application/json" -Body $importBody
  if ($created.createdCount -ne 2 -or @($created.jobs).Count -ne 2) {
    throw "격리 E2E 일괄 적재 등록 수가 올바르지 않습니다."
  }
  $batchJobIds = @($created.jobs | ForEach-Object { $_.jobId })
  $imported = @()
  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    $jobList = Invoke-RestMethod -Uri "$baseUrl/api/v2/import-jobs"
    $imported = @($jobList.jobs | Where-Object { $batchJobIds -contains $_.jobId })
    if (
      $imported.Count -eq 2 -and
      @($imported | Where-Object { $_.status -notin @("succeeded", "failed") }).Count -eq 0
    ) { break }
    Start-Sleep -Milliseconds 250
  }
  $failedImports = @($imported | Where-Object { $_.status -ne "succeeded" })
  if ($imported.Count -ne 2 -or $failedImports.Count -gt 0) {
    throw "격리 E2E 일괄 initial import가 실패했습니다: $($failedImports.error -join ' | ')"
  }
  $revisionOneManifest = Invoke-RestMethod -Uri `
    "$baseUrl/api/v2/games/golden-game-1/revisions/1/replay-manifest"
  $revisionOneFrames = Invoke-RestMethod -Uri `
    "$baseUrl/api/v2/games/golden-game-1/revisions/1/replay-frames?limit=1000"
  if (
    $revisionOneManifest.frameCount -lt 1 -or
    @($revisionOneFrames.frames).Count -ne $revisionOneManifest.frameCount -or
    $null -ne $revisionOneFrames.nextCursor -or
    $revisionOneFrames.documentHash -ne $revisionOneManifest.documentHash -or
    $revisionOneFrames.frameHash -ne $revisionOneManifest.frameHash
  ) {
    throw "격리 E2E replay manifest와 atomic frame page가 일치하지 않습니다."
  }

  $null = Invoke-RestMethod -Method Post -Uri `
    "$baseUrl/api/v2/games/golden-game-1/revisions/1/correction-drafts" `
    -ContentType "application/json" -Body "{}"
  $sessionBody = @{ authority = "staging"; gameId = "golden-game-1" } | ConvertTo-Json -Compress
  $session = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v2/correction-sessions" `
    -ContentType "application/json" -Body $sessionBody
  $unlinkBody = @{
    expectedSessionVersion = 0
    apply = $true
    command = @{ commandId = "e2e-unlink"; kind = "unlink_tracking_candidate"; trackingId = "t1" }
  } | ConvertTo-Json -Depth 5 -Compress
  $unlinked = Invoke-RestMethod -Method Post -Uri `
    "$baseUrl/api/v2/correction-sessions/$($session.sessionId)/commands" `
    -ContentType "application/json" -Body $unlinkBody
  if ($unlinked.session.blockingCount -lt 1) { throw "tracking unlink가 quarantine 차단 상태를 만들지 못했습니다." }
  $linkBody = @{
    expectedSessionVersion = 1
    apply = $true
    command = @{
      commandId = "e2e-link"
      kind = "link_tracking_candidate"
      trackingId = "t1"
      pitchEventId = "e2"
    }
  } | ConvertTo-Json -Depth 5 -Compress
  $linked = Invoke-RestMethod -Method Post -Uri `
    "$baseUrl/api/v2/correction-sessions/$($session.sessionId)/commands" `
    -ContentType "application/json" -Body $linkBody
  if ($linked.session.blockingCount -ne 0) { throw "tracking 재연결 뒤 차단 finding이 남았습니다." }
  $commitBody = @{
    expectedSessionVersion = 2
    allowBlockingStaging = $false
  } | ConvertTo-Json -Compress
  $null = Invoke-RestMethod -Method Post -Uri `
    "$baseUrl/api/v2/correction-sessions/$($session.sessionId)/commit" `
    -ContentType "application/json" -Body $commitBody
  $revisionImportBody = @{
    gameId = "golden-game-1"
    idempotencyKey = "e2e-revision-two-import"
  } | ConvertTo-Json -Compress
  $revisionImport = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v2/import-jobs" `
    -ContentType "application/json" -Body $revisionImportBody
  $revisionJob = $null
  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    $revisionJob = Invoke-RestMethod -Uri "$baseUrl/api/v2/import-jobs/$($revisionImport.jobId)"
    if ($revisionJob.status -in @("succeeded", "failed")) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($revisionJob.status -ne "succeeded" -or $revisionJob.revision -ne 2) {
    throw "격리 E2E revision 2 적재가 실패했습니다: $($revisionJob.error)"
  }
  $manifest = Invoke-RestMethod -Uri `
    "$baseUrl/api/v2/games/golden-game-1/revisions/2/replay-manifest"
  if (
    $manifest.frameCount -ne $revisionOneManifest.frameCount -or
    $manifest.frameHash -eq $revisionOneManifest.frameHash
  ) {
    throw "revision 2 replay의 frame 수 또는 revision-bound hash가 올바르지 않습니다."
  }

  Invoke-Compose -Arguments @("stop", "web", "api")
  & (Join-Path $PSScriptRoot "backup.ps1") -DestinationRoot $backupRoot
  $runningAfterOfflineBackup = @(& docker compose ps --status running --services)
  if ($runningAfterOfflineBackup -contains "api" -or $runningAfterOfflineBackup -contains "web") {
    throw "이미 중지된 writer를 backup이 다시 시작했습니다."
  }
  Invoke-Compose -Arguments @("start", "api", "web")
  Wait-Ready
  $backupDirectory = Get-ChildItem -LiteralPath $backupRoot -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if ($null -eq $backupDirectory) { throw "E2E backup 결과가 없습니다." }

  $corruptBackupDirectory = Join-Path $backupRoot "corrupt"
  Copy-Item -LiteralPath $backupDirectory.FullName -Destination $corruptBackupDirectory -Recurse
  [IO.File]::AppendAllText(
    (Join-Path $corruptBackupDirectory "workspace.zip"),
    "corrupt",
    [Text.UTF8Encoding]::new($false)
  )
  $corruptBackupRejected = $false
  try {
    & (Join-Path $PSScriptRoot "restore.ps1") `
      -BackupDirectory $corruptBackupDirectory `
      -ConfirmDataReplacement
  }
  catch {
    if ($_.Exception.Message -like "*workspace backup hash*") {
      $corruptBackupRejected = $true
    }
    else {
      throw
    }
  }
  if (-not $corruptBackupRejected) { throw "손상 backup이 거부되지 않았습니다." }
  if (-not ([IO.Path]::GetFullPath($corruptBackupDirectory)).StartsWith(([IO.Path]::GetFullPath($backupRoot) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) { throw "격리 backup 정리 범위를 벗어났습니다." }
  Remove-Item -LiteralPath $corruptBackupDirectory -Recurse -Force

  Invoke-Compose -Arguments @("stop", "web")
  $originalFile = Join-Path $originalDirectory "golden-game-1.json"
  $originalBeforeFailedSwap = Get-Sha256Hex $originalFile
  & {
    function Move-Item([string]$LiteralPath, [string]$Destination) {
      $prefix = [IO.Path]::GetFullPath($testRoot) + [IO.Path]::DirectorySeparatorChar
      foreach ($candidate in @($LiteralPath, $Destination)) {
        if (-not [IO.Path]::GetFullPath($candidate).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
          throw "Restore move escaped the E2E workspace."
        }
      }
      if ([IO.Path]::GetFileName($LiteralPath).StartsWith(".kbo-restore-")) {
        throw "Injected workspace promotion failure."
      }
      Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
    }
    try {
      & (Join-Path $PSScriptRoot "restore.ps1") -BackupDirectory $backupDirectory.FullName -ConfirmDataReplacement
      throw "Restore did not detect the injected workspace promotion failure."
    }
    catch {
      if ($_.Exception.Message -ne "Injected workspace promotion failure.") { throw }
    }
  }
  if ((Get-Sha256Hex $originalFile) -ne $originalBeforeFailedSwap) {
    throw "Restore did not put the original workspace back after promotion failed."
  }
  $runningAfterFailedSwap = @(& docker compose ps --status running --services)
  Assert-NativeSuccess "복원 실패 후 실행 서비스 확인"
  if ($runningAfterFailedSwap -contains "web" -or $runningAfterFailedSwap -notcontains "api") {
    throw "복원 실패 후 API만 원래 실행 상태로 돌아와야 합니다."
  }
  Invoke-Compose -Arguments @("start", "web")
  Wait-Ready
  $afterFailedSwap = Invoke-RestMethod -Uri `
    "$baseUrl/api/v2/games/golden-game-1/revisions/2/replay-manifest"
  if ($afterFailedSwap.frameHash -ne $manifest.frameHash) {
    throw "Replay changed after workspace promotion failed."
  }

  Invoke-Compose -Arguments @("stop", "web", "api")
  Remove-Item -LiteralPath (Join-Path $originalDirectory "golden-game-1.json") -Force
  Invoke-Compose -Arguments @(
    "exec", "-T", "db", "psql", "--username", "kbo_e2e", "--dbname", "kbo_e2e",
    "--set", "ON_ERROR_STOP=1", "--command", "DROP SCHEMA analytics CASCADE"
  )
  & (Join-Path $PSScriptRoot "restore.ps1") `
    -BackupDirectory $backupDirectory.FullName `
    -ConfirmDataReplacement
  $runningAfterOfflineRestore = @(& docker compose ps --status running --services)
  Assert-NativeSuccess "오프라인 복원 후 실행 서비스 확인"
  if ($runningAfterOfflineRestore -contains "api" -or $runningAfterOfflineRestore -contains "web") {
    throw "오프라인 복원 후 이미 중지돼 있던 웹·API가 시작됐습니다."
  }
  Invoke-Compose -Arguments @("start", "api", "web")
  Wait-Ready

  if (-not (Test-Path -LiteralPath (Join-Path $originalDirectory "golden-game-1.json"))) {
    throw "workspace 복원 결과가 없습니다."
  }
  $restoredManifest = Invoke-RestMethod -Uri `
    "$baseUrl/api/v2/games/golden-game-1/revisions/2/replay-manifest"
  if ($restoredManifest.documentHash -ne $manifest.documentHash) {
    throw "복원 전후 replay document hash가 다릅니다."
  }

  Invoke-Compose -Arguments @("restart", "api")
  Wait-Ready
  $afterRestart = Invoke-RestMethod -Uri `
    "$baseUrl/api/v2/games/golden-game-1/revisions/2/replay-manifest"
  $collectionHistory = Invoke-RestMethod -Uri "$baseUrl/api/v2/collection-history?page=1&limit=50"
  if (-not (@($collectionHistory.records) | Where-Object { $_.job.jobId -eq "stage6-interrupted" })) { throw "수집 이력이 복원되지 않았습니다." }
  $savedDiscovery = Invoke-RestMethod -Uri "$baseUrl/api/v2/collection-discoveries/stage6-discovery"
  if (-not $savedDiscovery.complete) { throw "저장된 일정 조회가 복원되지 않았습니다." }
  if ($afterRestart.frameHash -ne $manifest.frameHash) {
    throw "API restart 전후 replay frame hash가 다릅니다."
  }
  Assert-BrowserUi
  $analysisSeed = @'
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { GameCompetitionRepository, GameRevisionStore } from "@kbo/persistence";
import { extractNaverPlayerHeights, extractNaverPlayerBattingProfiles } from "@kbo/collection";
const fixture = JSON.parse(await readFile("/var/lib/kbo/original/2026/golden-game-1.json", "utf8"));
const pool = new Pool();
try {
  const store = new GameRevisionStore(pool, process.env.EXPECTED_MIGRATION_VERSION,undefined,undefined,
    async document=>extractNaverPlayerHeights({gameId:document.metadata.gameId,season:document.metadata.season,
      sourceBundleHash:document.source.sourceBundleHash,payloads:{lineup:{result:{previewData:{awayTeamLineUp:{
        fullLineUp:document.rosters.away.players.map(p=>({playerCode:p.playerId,height:"180.0"}))
      }}}}}}),
    async document=>extractNaverPlayerBattingProfiles({gameId:document.metadata.gameId,season:document.metadata.season,
      sourceBundleHash:document.source.sourceBundleHash,payloads:{lineup:{result:{previewData:{awayTeamLineUp:{
        fullLineUp:document.rosters.away.players.map(p=>({playerCode:p.playerId,batsThrows:"\uc88c\ud0c0"}))
      }}}}}}));
  // Season selectors now come from imported facts, including historical model-period examples.
  const competitions = new GameCompetitionRepository(pool);
  async function importReleaseSample(season, sample) {
    const document = structuredClone(fixture);
    const gameId = `release-sample-${season}-${sample}`;
    document.revisionBase = { kind: "new_game" };
    document.source.sourceGameId = gameId;
    document.metadata = { ...document.metadata, gameId, season, gameDate: `${season}-06-02`, status: "final" };
    document.officialRecords = { batters: [], pitchers: [] };
    document.events = document.events.slice(0, 2);
    document.trackingCandidates = [];
    function append(kind, payload) {
      const sequence = document.events.length;
      const eventId = `e${sequence}`;
      document.events.push({ identity: { kind: "source", eventId, endpoint: "relay", blockIndex: 0, eventIndex: sequence },
        sequence, inning: 1, half: "top", kind, payload });
      return eventId;
    }
    const { pitcherId, batterId } = document.events[1].payload;
    for (let i = 0; i < 96; i++) {
      const fastball = i % 2 === 0;
      const sign = (bit) => ((i >> 1) & bit) === 0 ? -1 : 1;
      const sourcePitchId = `p${i}`;
      const speedKph = (season === 2024 ? 140 : 145) - (fastball ? 0 : 12);
      const eventId = append("pitch", { sourcePitchId, pitchType: fastball ? "\uC9C1\uAD6C" : "\uC2AC\uB77C\uC774\uB354",
        call: i < 2 ? "called_strike" : i === 95 ? "swinging_strike" : "foul", speedKph });
      const y0 = sample === 0 ? 50 : 55;
      const vy0 = -speedKph / 1.09728;
      const time = (y0 - (fastball ? 55 : 54)) / vy0;
      const vx = sign(4) * 2, vz = sign(8) * 2;
      const ax = (fastball ? -8 : 8) + sample, az = -15 - sample;
      document.trackingCandidates.push({
        trackingId: `t${i}`, source: { endpoint: "tracking", blockIndex: 0, rowIndex: i },
        sourcePitchId, sourcePitchOrdinal: i + 1, sequence: i, inning: 1, half: "top",
        plateAppearanceEventId: "e1", pitcherId, batterId,
        x0: 1 + sign(1) / 10 + vx * time + ax * time ** 2 / 2, y0,
        z0: 6 + sign(2) / 10 + vz * time + az * time ** 2 / 2,
        vx0: vx + ax * time, vy0, vz0: vz + az * time, ax, ay: 0, az,
        crossPlateX: 0.1, crossPlateY: 1.4167, stance: "R",
        resolution: { kind: "linked", pitchEventId: eventId },
      });
    }
    append("plate_result", { result: "strikeout", batterId, pitcherId });
    await store.importRevision(parseStagingGameDocumentV2(document));
  }
  for (const season of [2020, 2021, 2022, 2023, 2024, 2025]) {
    const document = structuredClone(fixture);
    document.revisionBase = { kind: "new_game" };
    document.metadata = { ...document.metadata, gameId: `analysis-${season}`, season, gameDate: `${season}-06-01` };
    let ordinal = 0;
    for (const event of document.events) {
      if (event.kind === "pitch") {
        event.payload.pitchType = ordinal++ % 2 === 0 ? "\uc9c1\uad6c" : "\uc2ac\ub77c\uc774\ub354";
        event.payload.speedKph = 145;
      }
    }
    for (const tracking of document.trackingCandidates) Object.assign(tracking, {
      x0: -1, y0: 50, z0: 6, vx0: 2, vy0: season === 2024 ? -140 : -145, vz0: -4,
      ax: -8, ay: 25, az: -15, crossPlateX: 0.1, crossPlateY: 1.4167,
      stance: "R",
    });
    const entries = [];
    async function importClassified(kind, suffix, date) {
      const extra = structuredClone(document);
      const gameId = `fixture-${season}-${kind}-${suffix}`;
      extra.metadata = { ...extra.metadata, gameId, gameDate: date };
      extra.source.sourceGameId = gameId;
      await store.importRevision(parseStagingGameDocumentV2(extra));
      entries.push({ sourceGameId: gameId, gameDate: date, competition: kind });
    }
    for (let sample = 0; sample < 5; sample++) await importClassified("regular", sample, document.metadata.gameDate);
    if (season === 2024) {
      await importClassified("allstar", 1, "2024-07-06");
      await importClassified("postseason", 1, "2024-10-01");
    }
    const page = (month, competition, day) => ({
      month, competition, ...(day === undefined ? {} : { day }),
      sourceUrl: "https://fixture.invalid/competition",
      contentHash: createHash("sha256").update(`${season}:${month}:${competition}:${day ?? 0}`).digest("hex"),
      artifactKey: `test/${season}/${month}/${competition}/${day ?? 0}`,
      collectedAt: "2026-01-01T00:00:00Z",
    });
    const pages = Array.from({ length: 12 }, (_, i) => i + 1).flatMap((month) =>
      ["regular", "preseason", "postseason"].map((kind) => page(month, kind)),
    );
    if (season === 2024) pages.push(page(7, "allstar", 6));
    await competitions.adopt({
      version: season === 2024 ? 2 : 1,
      season, pages,
      entries: entries.map((entry) => ({
        ...entry, pageHash: pages.find((p) => p.month === Number(entry.gameDate.slice(5, 7))
          && p.competition === entry.competition).contentHash,
      })),
    });
    if (season === 2021 || season === 2022) continue;
    await store.importRevision(parseStagingGameDocumentV2(document));
    for (let sample = 1; sample <= 4; sample++) {
      const extra = structuredClone(document);
      extra.metadata.gameId = `analysis-${season}-sample-${sample}`;
      for (const t of extra.trackingCandidates) {
        t.stance = sample % 2 === 0 ? "L" : "R";
        t.vy0 -= sample * 2;
        t.ax += sample * 1.5;
        t.az += sample % 2 === 0 ? 2 : -2;
      }
      await store.importRevision(parseStagingGameDocumentV2(extra));
    }
    if (season === 2024 || season === 2025) {
      for (let sample = 0; sample < 3; sample++) await importReleaseSample(season, sample);
    }
  }
} finally { await pool.end(); }
'@
  $analysisSeed | & docker compose exec -T --workdir /app/apps/server api node --input-type=module
  Assert-NativeSuccess "analysis fixture import"
  Get-Content -Raw (Join-Path $repositoryRoot "scripts/measure-analytics-queries.mjs") | & docker compose exec -T -e KBO_ANALYTICS_FIXTURE_BENCHMARK=1 --workdir /app/apps/server api node --input-type=module
  Assert-NativeSuccess "analysis fixture query benchmark"
  $analysisSmoke = @'
import { chromium } from "playwright";
// Use the production localhost secure context, with DNS mapped only inside this test browser.
const { lookup } = await import("node:dns/promises");
const webAddress = (await lookup("web")).address;
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP localhost ${webAddress}`] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const menu = page.getByRole("navigation", { name: "\uc8fc \uba54\ub274" });
  const recordNavigation = page.getByRole("navigation", { name: "\uc120\uc218 \uae30\ub85d \ubcf4\uae30" });
  const playerList = page.getByRole("list", { name: "\uc120\uc218 \ubaa9\ub85d" });
  const playerSearch = page.getByRole("searchbox", { name: "\uc120\uc218 \uac80\uc0c9" });
  const playerScope = { season: "2024", competition: "unknown", dateFrom: "2024-06-01", dateTo: "2024-06-01" };
  async function assertPrimaryReportScope() {
    const editor = page.locator("details.player-analysis-scope-editor");
    await editor.waitFor();
    await recordNavigation.waitFor();
    const beforeTabs = await editor.evaluate((element) => {
      const tabs = element.closest(".player-analysis-context")?.querySelector(".player-analysis-primary");
      return tabs && Boolean(element.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    const dateFields = page.getByLabel("\ubd84\uc11d \uc2dc\uc791\uc77c", { exact: true });
    if (!beforeTabs || await dateFields.count() !== 1) {
      throw new Error("Primary reports need one date scope editor above the player tabs.");
    }
  }
  async function openReportFilters() {
    const filters = page.locator("details.analysis-report-filters, details.player-report-filters").first();
    if (await filters.count() > 0 && await filters.getAttribute("open") === null) {
      await filters.locator(":scope > summary").click();
    }
  }
  async function assertPlayerDestination(path, selection) {
    const expected = Object.entries({ ...playerScope, ...selection });
    await page.waitForURL((url) => url.pathname === path && expected.every(([key, value]) => url.searchParams.get(key) === value));
    const actual = new URL(page.url());
    if (actual.pathname !== path) throw new Error(`Unexpected player destination: ${actual.pathname}`);
    for (const [key, value] of expected) {
      if (actual.searchParams.get(key) !== value) throw new Error(`Player navigation lost ${key}: ${actual}`);
    }
    if (["/analysis/player-statistics", "/analysis/player-games", "/analysis/player-splits",
      "/analysis/pitch-location", "/analysis/batter-profile", "/analysis/matchups"].includes(path)) {
      await assertPrimaryReportScope();
    }
  }
  async function catalogPlayer(role, competition = playerScope.competition) {
    const endpoint = role === "pitcher" ? "pitch-shape" : "batter-discipline";
    const options = new URLSearchParams({ ...playerScope, competition });
    if (competition !== playerScope.competition) {
      options.delete("dateFrom");
      options.delete("dateTo");
    }
    const response = await page.request.get("http://web/api/v2/analysis/" + endpoint + "?" + options);
    if (!response.ok()) throw new Error("Could not read catalog for " + competition);
    const result = await response.json();
    const id = role === "pitcher" ? result.pitchers[0]?.pitcherId : result.batters[0]?.batterId;
    if (result.scope.competition !== competition || !id) throw new Error("Missing player in " + competition);
    return id;
  }
  async function openPitches() {
    await recordNavigation.getByRole("link", { name: "\uad6c\uc885\u00b7\ucf54\uc2a4", exact: true }).click();
  }
  async function inspectPlayerStatistics(role) {
    if (new URL(page.url()).pathname !== "/analysis/player-statistics") {
      await recordNavigation.getByRole("link", { name: "\uae30\ubcf8 \uae30\ub85d", exact: true }).click();
    }
    await assertPlayerDestination("/analysis/player-statistics", { pitcher: null, batter: null });
    await page.getByRole("heading", { name: "\uae30\ubcf8 \uae30\ub85d", exact: true }).waitFor();
    await recordNavigation.locator('a[aria-current="page"]').filter({ hasText: "\uae30\ubcf8 \uae30\ub85d" }).waitFor();
    const annualBatting = "\uc5f0\ub3c4\ubcc4 \ud0c0\uaca9 \uc131\uc801";
    const annualPitching = "\uc5f0\ub3c4\ubcc4 \ud22c\uad6c \uc131\uc801";
    const table = page.getByRole("table", { name: role === "pitcher" ? annualPitching : annualBatting, exact: true });
    await table.waitFor();
    await table.locator("tbody tr").first().waitFor();
    if (await page.getByRole("table", { name: role === "pitcher" ? annualBatting : annualPitching, exact: true }).count() !== 0) throw new Error("Basic records rendered the wrong player role.");
    const years = (await table.getByRole("rowheader").allTextContents()).map(Number);
    if (years.some((year, index) => !Number.isInteger(year) || (index > 0 && year >= years[index - 1]))) {
      throw new Error(`Basic records must show one row per year, newest first: ${years.join(", ")}`);
    }
    if (await table.getByRole("button").count() !== 0) throw new Error("Basic records include an unexpected record disclosure.");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`Player ${role} statistics horizontal overflow.`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  await page.goto("http://localhost/", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "\ubd84\uc11d", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/analysis/players");
  await page.getByRole("heading", { name: "\uc120\uc218 \ubd84\uc11d", exact: true }).waitFor();
  if (new URL(page.url()).pathname !== "/analysis/players") throw new Error("Analysis did not open player discovery by default.");
  const analysisDestinations = await menu.getByRole("link").evaluateAll((links) => links.map((link) => new URL(link.href).pathname));
  if (JSON.stringify(analysisDestinations) !== JSON.stringify([
    "/analysis/players", "/analysis/statistics", "/analysis/baserunning", "/analysis/park-environment", "/replay", "/analysis/coverage", "/analysis/models",
  ])) throw new Error("Analysis sidebar did not expose exactly the seven workspace destinations.");
  for (const competition of ["allstar", "postseason"]) await catalogPlayer("pitcher", competition);
  await playerList.waitFor();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error("Player directory horizontal overflow.");
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const directoryResponse = await page.request.get("http://web/api/v2/analysis/players");
  if (!directoryResponse.ok()) throw new Error("Missing global player directory.");
  const directory = await directoryResponse.json();
  if (new Set(directory.map((player) => player.identity)).size !== directory.length) throw new Error("Duplicate player in the directory.");
  const pitcher = await catalogPlayer("pitcher");
  const pitcherEntry = directory.find((player) => player.sourceIds.includes(pitcher));
  if (!pitcherEntry || !pitcherEntry.teams.length) throw new Error("Pitcher history missing.");
  await playerSearch.fill(pitcher);
  await page.waitForURL((url) => url.pathname === "/analysis/players" && url.searchParams.get("q") === pitcher);
  const pitcherLink = playerList.getByRole("link", { name: pitcherEntry.name + " \ubd84\uc11d \ubcf4\uae30", exact: true });
  await pitcherLink.waitFor();
  if ((await pitcherLink.innerText()).includes("ID " + pitcher)) throw new Error("Search result showed a raw player ID.");
  await pitcherLink.click();
  await page.waitForURL((url) => url.pathname === "/analysis/player-statistics" && url.searchParams.get("player") === pitcherEntry.identity && url.searchParams.get("season") === String(pitcherEntry.seasons[0].season));
  await page.getByLabel("\ubd84\uc11d \uc2dc\uc98c", { exact: true }).selectOption(playerScope.season);
  await openReportFilters();
  const competitionPicker = page.getByLabel("\uacbd\uae30 \uc885\ub958", { exact: true });
  if (await competitionPicker.inputValue() !== "regular") throw new Error("Default competition was not regular.");
  await competitionPicker.selectOption(playerScope.competition);
  await page.waitForURL((url) => url.searchParams.get("competition") === playerScope.competition);
  await page.getByLabel("\ubd84\uc11d \uc2dc\uc791\uc77c", { exact: true }).fill(playerScope.dateFrom);
  await page.waitForURL((url) => url.searchParams.get("dateFrom") === playerScope.dateFrom);
  await page.getByLabel("\ubd84\uc11d \uc885\ub8cc\uc77c", { exact: true }).fill(playerScope.dateTo);
  await inspectPlayerStatistics("pitcher");
  const leagueComparison = page.locator(".player-basic-statistics-page details").filter({ hasText: "\ub9ac\uadf8 \ud3c9\uade0\uacfc \ube44\uad50" });
  const leagueSummary = await leagueComparison.locator(":scope > summary").innerText();
  if (![playerScope.season, playerScope.dateFrom, playerScope.dateTo].every((value) => leagueSummary.includes(value))) throw new Error("League comparison summary omitted the selected period.");
  await leagueComparison.locator(":scope > summary").click();
  await leagueComparison.getByRole("table").waitFor();
  const leagueLink = leagueComparison.getByRole("link");
  const leagueDestination = new URL(await leagueLink.getAttribute("href"), page.url());
  if (Object.entries({ ...playerScope, kind: "pitching" }).some(([key, value]) => leagueDestination.searchParams.get(key) !== value)) throw new Error("League comparison dropped the player scope.");
  await recordNavigation.getByRole("link", { name: "\uacbd\uae30\ubcc4", exact: true }).click();
  await assertPlayerDestination("/analysis/player-games", { pitcher, playerRole: "pitcher" });
  const gameTable = page.getByRole("table", { name: "\uacbd\uae30\ubcc4 \ub4f1\ud310 \uc131\uc801" });
  const firstGame = gameTable.getByRole("link").first();
  await firstGame.waitFor();
  const relatedAnalyses = page.getByRole("region", { name: "\ub4f1\ud310 \uc2ec\ud654 \ubd84\uc11d" });
  if (await relatedAnalyses.getByRole("link").count() !== 2 || !(await gameTable.evaluate((table) => {
    const links = table.closest(".page-stack")?.querySelector(".player-report-related");
    return links && Boolean(links.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING);
  }))) throw new Error("Pitcher follow-up links must appear before the game log.");
  const gameAddress = page.url();
  const replayTarget = new URL(await firstGame.getAttribute("href"), gameAddress);
  if (!replayTarget.searchParams.get("gameId") || !replayTarget.searchParams.get("revision")) throw new Error("Game log replay target lacked its sealed revision.");
  await firstGame.click();
  await page.getByRole("slider").waitFor();
  await page.locator(".replay-analysis-return").getByRole("link").click();
  await page.waitForURL(gameAddress);
  await gameTable.waitFor();
  await recordNavigation.getByRole("link", { name: "\uc0c1\ud669\ubcc4", exact: true }).click();
  await assertPlayerDestination("/analysis/player-splits", { pitcher, playerRole: "pitcher" });
  const splitTable = page.getByRole("table", { name: "\uc0c1\ud669\ubcc4 \uc0c1\ub300 \uc131\uc801" });
  await splitTable.waitFor();
  await page.getByLabel("\ube44\uad50 \uae30\uc900", { exact: true }).selectOption("venue");
  await splitTable.getByRole("rowheader", { name: "\ud648", exact: true }).waitFor();
  await page.getByLabel("\uce74\uc6b4\ud2b8\ubcc4\ub85c \ubcfc \uc0c1\ud669", { exact: true }).selectOption({ index: 1 });
  await page.getByRole("table", { name: "\uc120\ud0dd \uc0c1\ud669\uc758 \uce74\uc6b4\ud2b8\ubcc4 \uc131\uc801" }).waitFor();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error("Situational reports overflow the viewport.");
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPitches();
  await assertPlayerDestination("/analysis/pitch-location", { pitcher });
  await recordNavigation.locator('a[aria-current="page"]').filter({ hasText: "\uad6c\uc885\u00b7\ucf54\uc2a4" }).waitFor();
  if (await recordNavigation.getByRole("link").count() !== 5) throw new Error("Pitcher report navigation is incomplete.");
  if (await menu.getByRole("link", { name: "\uc120\uc218 \ubd84\uc11d", exact: true }).getAttribute("aria-current") !== "page") throw new Error("Player analysis sidebar state was lost on detail navigation.");
  const quickFilters = page.getByRole("region", { name: "\ube60\ub978 \uc0c1\ud669 \uc870\uac74" });
  for (const [name, stance] of [["\uc88c\ud0c0\uc790", "L"], ["\uc6b0\ud0c0\uc790", "R"]]) {
    await quickFilters.getByRole("button", { name, exact: true }).click();
    await assertPlayerDestination("/analysis/pitch-location", { pitcher, stance });
    await quickFilters.getByRole("button", { name, exact: true, pressed: true }).waitFor();
  }
  await quickFilters.getByRole("button", { name: "\ucd08\uad6c", exact: true }).click();
  await assertPlayerDestination("/analysis/pitch-location", { pitcher, stance: "R", balls: "0", strikes: "0" });
  await quickFilters.getByRole("button", { name: "\ucd08\uad6c", exact: true, pressed: true }).waitFor();
  const countTransitions = [];
  const recordCountTransition = (frame) => {
    if (frame === page.mainFrame()) countTransitions.push(new URL(frame.url()));
  };
  page.on("framenavigated", recordCountTransition);
  try {
    await quickFilters.getByRole("button", { name: "2\uc2a4\ud2b8\ub77c\uc774\ud06c", exact: true }).click();
    await assertPlayerDestination("/analysis/pitch-location", { pitcher, stance: "R", balls: null, strikes: "2" });
    await quickFilters.getByRole("button", { name: "2\uc2a4\ud2b8\ub77c\uc774\ud06c", exact: true, pressed: true }).waitFor();
  } finally {
    page.off("framenavigated", recordCountTransition);
  }
  if (countTransitions.length !== 1 || countTransitions.some((url) => url.searchParams.has("balls") || url.searchParams.get("strikes") !== "2")) throw new Error("Two-strike preset did not update both count fields atomically.");
  const stanceChip = quickFilters.getByRole("button", { name: "\uc6b0\ud0c0\uc790 \uc870\uac74 \ud574\uc81c", exact: true });
  await stanceChip.click();
  await assertPlayerDestination("/analysis/pitch-location", { pitcher, stance: null, balls: null, strikes: "2" });
  await stanceChip.waitFor({ state: "hidden" });
  await quickFilters.getByRole("button", { name: "2\uc2a4\ud2b8\ub77c\uc774\ud06c", exact: true, pressed: true }).waitFor();
  await quickFilters.getByRole("button", { name: "\uc88c\ud0c0\uc790", exact: true }).click();
  await assertPlayerDestination("/analysis/pitch-location", { pitcher, stance: "L", balls: null, strikes: "2" });
  await quickFilters.getByRole("button", { name: "\uc88c\ud0c0\uc790", exact: true, pressed: true }).waitFor();
  const resetConditions = quickFilters.getByRole("button", { name: "\uc0c1\ud669 \uc870\uac74 \ucd08\uae30\ud654", exact: true });
  await resetConditions.click();
  await assertPlayerDestination("/analysis/pitch-location", { pitcher, pitchType: null, stance: null, balls: null, strikes: null, cohort: null });
  await quickFilters.getByRole("button", { name: "\uc804\uccb4 \ud0c0\uc11d", exact: true, pressed: true }).waitFor();
  await quickFilters.getByRole("button", { name: "\uc804\uccb4 \uce74\uc6b4\ud2b8", exact: true, pressed: true }).waitFor();
  if (!(await quickFilters.locator(".outcome-filter-reset").isDisabled())) throw new Error("Reset left an active situation condition.");
  const pitchRateTable = page.getByRole("table", { name: "\uad6c\uc885\ubcc4 \ubc18\uc751", exact: true });
  await pitchRateTable.waitFor();
  await pitchRateTable.getByRole("button", { name: "Whiff% \ub0b4\ub9bc\ucc28\uc21c \uc815\ub82c", exact: true }).click();
  await pitchRateTable.locator('thead th[aria-sort="descending"]').filter({ hasText: "Whiff%" }).waitFor();
  await pitchRateTable.getByRole("button", { name: "Whiff% \uc624\ub984\ucc28\uc21c \uc815\ub82c", exact: true }).click();
  await pitchRateTable.locator('thead th[aria-sort="ascending"]').filter({ hasText: "Whiff%" }).waitFor();
  await assertPlayerDestination("/analysis/pitch-location", { pitcher, pitchType: null, stance: null, balls: null, strikes: null, cohort: null });
  const flowRequest = page.waitForResponse(res => new URL(res.url()).pathname.endsWith("/count-flow") && res.ok());
  await page.getByRole("tab", { name: "\uad6c\uc885 \ubc30\ud569", exact: true }).click();
  const flowResult = await flowRequest;
  const flowResponse = await flowResult.json();
  await page.locator(".outcome-arsenal").waitFor();
  const locationUrl = new URL(flowResult.url());
  locationUrl.pathname = locationUrl.pathname.replace(/\/count-flow$/, "");
  locationUrl.searchParams.delete("include");
  const profileArsenal = await page.evaluate(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Profile arsenal API failed.");
    return response.json();
  }, locationUrl.pathname + locationUrl.search);
  if (profileArsenal.arsenal.some(group => group.stance === null) ||
      !profileArsenal.arsenal.some(group => group.stance === "L" && group.pitches > 0)) {
    throw new Error("Untracked pitches must use declared batter profiles without inventing locations.");
  }
  const flow = page.locator(".outcome-arsenal");
  if (await flow.locator(".pitch-flow-tree").count() !== 2) throw new Error("Expected both batting sides in the count flow.");
  if ("countFlow" in profileArsenal) throw new Error("Legacy location response must retain its original shape.");
  const overviewPitches = flowResponse.groups.filter(group => group.stance === "all");
  if (overviewPitches.reduce((total, group) => total + group.pitches, 0) !== flowResponse.scopePitches ||
      flowResponse.scopePitches !== profileArsenal.coverage.scopePitches) {
    throw new Error("Pooled count flow must include all actual pitches.");
  }
  await flow.getByRole("button", { name: "\uc804\uccb4", exact: true }).click();
  if (await flow.locator(".pitch-flow-tree").count() !== 1) throw new Error("Expected one pooled count tree.");
  await flow.getByRole("button", { name: "\uc88c\u00b7\uc6b0 \ube44\uad50", exact: true }).click();
  const leftCountTree = flow.getByRole("figure", { name: "\uc88c\ud0c0\uc790 \uc0c1\ub300" });
  await leftCountTree.locator(".pitch-flow-node:not(:disabled)").first().press("Enter");
  const arsenalChoice = leftCountTree.locator(".pitch-flow-picker button").first();
  await arsenalChoice.click();
  await flow.getByRole("button", { name: "\uc88c\ud0c0\uc790 \uc0c1\ub300 \ucf54\uc2a4 \ubcf4\uae30", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.has("pitchType") && url.searchParams.has("balls") && url.searchParams.has("strikes") && url.searchParams.has("stance"));
  await pitchRateTable.waitFor();
  await quickFilters.getByRole("button", { name: "\uc0c1\ud669 \uc870\uac74 \ucd08\uae30\ud654", exact: true }).click();
  await assertPlayerDestination("/analysis/pitch-location", { pitcher, pitchType: null, stance: null, balls: null, strikes: null, cohort: null });
  await page.getByRole("tab", { name: "\uae30\uac04 \ube44\uad50", exact: true }).click();
  await page.getByRole("button", { name: "\ub450 \uae30\uac04 \ube44\uad50 \uc801\uc6a9", exact: true }).click();
  const comparisonMaps = page.locator(".location-comparison-maps");
  await comparisonMaps.waitFor();
  if (await comparisonMaps.locator(".outcome-zone-grid button").count() !== 50) throw new Error("Period comparison must show two complete location maps.");
  await page.getByLabel("\uc9c0\ub3c4 \uc9c0\ud45c", { exact: true }).selectOption("whiffRate");
  const comparisonCorner = comparisonMaps.locator(".outcome-zone-grid").first().getByRole("button", { name: /^\ucf54\uc2a4 20, \ud3ec\uc218 \uc2dc\uc810 \uc874 \uc704 \uc67c\ucabd \ubc14\uae65, \ud5db\uc2a4\uc719\ub960/ });
  await comparisonCorner.press("Enter");
  if (!(await comparisonCorner.evaluate((button) => button.matches(":focus-visible") && getComputedStyle(button).outlineOffset === "1px"))) {
    throw new Error("Keyboard focus on the selected location cell is not visible.");
  }
  if (await comparisonMaps.locator('button[aria-pressed="true"]').count() !== 2) throw new Error("Location map selection was not shared.");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const selector of [".location-period-comparison", ".outcome-workspace-tabs .workspace-tabs"]) {
      if (await page.locator(selector).evaluate((element) => element.scrollWidth > element.clientWidth + 1)) {
        throw new Error(`${selector} overflows its content width.`);
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const periodBMap = comparisonMaps.locator(".outcome-zone-grid").nth(1);
  await periodBMap.getByRole("button", { name: /, \ud22c\uad6c 0\uad6c$/ }).first().click();
  await page.locator(".location-comparison-values a").nth(1).click();
  const evidenceMap = page.getByRole("group", { name: "\uc2e4\uc81c \ucf54\uc2a4 \uc9c0\ub3c4", exact: true });
  const initialZone = await evidenceMap.locator('button[aria-pressed="true"]').getAttribute("aria-label");
  if (!initialZone?.endsWith(", \ud22c\uad6c 0\uad6c")) throw new Error("Comparison evidence did not open its empty zone.");
  const populatedZone = evidenceMap.getByRole("button", { name: /, \ud22c\uad6c [1-9][\d,]*\uad6c$/ }).first();
  const populatedLabel = await populatedZone.getAttribute("aria-label");
  await populatedZone.click();
  async function replayLocationEvidenceAndReturn() {
    const evidence = page.locator(".outcome-location-panel .analysis-evidence");
    await evidence.locator(":scope > summary").click();
    await evidence.locator("tbody a").first().click();
    await page.getByRole("slider").waitFor();
    await page.locator(".replay-analysis-return").getByRole("link").click();
    await evidenceMap.waitFor();
  }
  await replayLocationEvidenceAndReturn();
  const returnedZone = await evidenceMap.locator('button[aria-pressed="true"]').getAttribute("aria-label");
  if (returnedZone !== populatedLabel) throw new Error("Replay restored " + returnedZone + " instead of " + populatedLabel);
  const allZones = page.getByRole("button", { name: "\ubaa8\ub4e0 \ucf54\uc2a4", exact: true });
  await allZones.click();
  await replayLocationEvidenceAndReturn();
  if (await allZones.getAttribute("aria-pressed") !== "true" || new URL(page.url()).searchParams.has("locationCell")) {
    throw new Error("Replay did not restore all location zones.");
  }
  await inspectPlayerStatistics("pitcher");
  await openPitches();
  await page.getByRole("link", { name: /\uac19\uc740 \ubc94\uc704 \uad6c\uc9c8 \ubcf4\uae30/ }).click();
  await assertPlayerDestination("/analysis/pitch-shape", { pitcher });
  await page.getByRole("img", { name: /\ud3c9\uade0 \ud3ec\uc2ec/ }).waitFor();
  const batter = await catalogPlayer("batter");
  const batterEntry = directory.find((player) => player.sourceIds.includes(batter));
  if (!batterEntry) throw new Error("Batter missing from the global directory.");
  await playerSearch.fill(batter);
  const resultList = page.getByRole("list", { name: "\uc120\uc218 \uac80\uc0c9 \uacb0\uacfc" });
  await resultList.getByRole("button").filter({ hasText: batterEntry.name }).click();
  await assertPlayerDestination("/analysis/player-statistics", { player: batterEntry.identity });
  await inspectPlayerStatistics("batter");
  await openPitches();
  if (await recordNavigation.getByRole("link").count() !== 5) throw new Error("Batter report navigation is incomplete.");
  await page.getByRole("link", { name: /\uc870\uac74 \uc77c\uce58 \uc120\uad6c\uc548 \ube44\uad50/ }).click();
  await assertPlayerDestination("/analysis/batter-discipline", { batter });
  await page.locator(".discipline-map").waitFor();
  await menu.getByRole("link", { name: "\uc120\uc218 \ubd84\uc11d", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/analysis/players" && url.search === "");
  await playerList.waitFor();
  if (await playerSearch.inputValue() !== "") throw new Error("Report search leaked into the global directory.");

  await page.goto("http://localhost/analysis/pitch-shape?season=2024&competition=unknown", { waitUntil: "networkidle" });
  const chart = page.getByRole("img", { name: /\ud3c9\uade0 \ud3ec\uc2ec/ });
  await chart.waitFor();
  const shapeSettings = page.locator(".pitch-view-settings");
  const shapeSettingsSummary = shapeSettings.locator("summary");
  if (await shapeSettings.getAttribute("open") !== null) throw new Error("Pitch view settings must start collapsed.");
  const chartBeforeSettings = await shapeSettings.evaluate((node) => {
    const canvas = node.parentElement?.querySelector("canvas");
    return canvas !== null && canvas !== undefined && Boolean(canvas.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  if (!chartBeforeSettings) throw new Error("Pitch chart must precede optional view settings.");
  if (!(await page.locator(".pitch-axis-key").isVisible()) || !(await page.locator(".pitch-chart-explanation").innerText()).includes("Y=0")) throw new Error("Pitch axis and reference-plane meaning must remain visible.");
  await chart.focus();
  await page.keyboard.press("Home");
  if (await page.locator(".pitch-selected dd").count() !== 4) throw new Error("Collapsed view settings blocked keyboard pitch selection.");
  await shapeSettingsSummary.press("Enter");
  if (await shapeSettings.getAttribute("open") === null) throw new Error("Enter did not open pitch view settings.");
  await shapeSettingsSummary.press("Space");
  if (await shapeSettings.getAttribute("open") !== null) throw new Error("Space did not close pitch view settings.");
  await shapeSettingsSummary.press("Enter");
  const calibrationNote = page.locator(".pitch-cluster-note[aria-label]");
  if (!(await calibrationNote.innerText()).includes("84")) throw new Error("Daily park calibration status missing.");
  await page.getByRole("button", {name:"\uad6c\uc885 \uae30\ub300 \ud6a8\uacfc \ubcf4\uae30"}).click();
  await page.getByRole("table", {name:"\uad6c\uc885 \uad00\uce21 \uae30\ub300 \ube44\uad50"}).waitFor();
  await page.getByRole("button", {name:"\uad6c\uc885 \uae30\ub300 \ud6a8\uacfc \uc811\uae30"}).click();
  const firstTime = await page.locator(".pitch-reference-time strong").innerText();
  await page.locator(".pitch-expectation table").waitFor();
  if (await page.locator(".pitch-expectation-bands > div").count() !== 3) throw new Error("Reference coverage bands missing.");
  const referenceToggle = page.locator(".pitch-reference-toggle input");
  if (!(await referenceToggle.isChecked()) || !(await referenceToggle.isEnabled())) throw new Error("Reference overlay unavailable.");
  const withReference = await chart.evaluate((node) => node.toDataURL());
  await referenceToggle.uncheck();
  await page.waitForFunction((before) => document.querySelector(".pitch-shape-chart canvas")?.toDataURL() !== before, withReference);
  await referenceToggle.check();

  if (await menu.getByRole("link", { name: "\uc218\uc9d1", exact: true }).count() !== 0) throw new Error("Analysis exposes management menu.");
  await page.getByRole("button", { name: "\ud074\ub7ec\uc2a4\ud130\ub9c1 \uae30\uc900" }).click();
  await openReportFilters();
  const clusterCount = page.getByLabel("\uad70\uc9d1 \uc218", { exact: true });
  const defaultCount = await clusterCount.inputValue();
  await page.getByLabel("\uc88c\uc6b0 \ud68c\uc804", { exact: true }).fill("70");
  await clusterCount.selectOption("1");
  await page.waitForFunction(() => !document.querySelector(".pitch-cluster-updating") && [...document.querySelectorAll(".pitch-cluster-note")].some((note) => note.textContent.includes("GMM \uc124\uc815 1\uac1c")));
  if (await page.getByLabel("\uc88c\uc6b0 \ud68c\uc804", { exact: true }).inputValue() !== "70") throw new Error("GMM change reset camera.");
  if (!(await page.locator(".pitch-cluster-note").filter({ hasText: "GMM" }).innerText()).includes("GMM")) throw new Error("GMM result missing.");
  await page.getByRole("button", { name: "\uc911\uacc4 \uad6c\uc885 \uc218\ub85c \ucd08\uae30\ud654" }).click();
  await page.waitForFunction((expected) => !document.querySelector(".pitch-cluster-updating") && document.querySelector('select[aria-label="\uad70\uc9d1 \uc218"]')?.value === expected, defaultCount);
  if (await clusterCount.inputValue() !== defaultCount) throw new Error("GMM default count not restored.");
  await page.getByLabel("\ubd84\uc11d \ud074\ub7ec\uc2a4\ud130").selectOption("\ud074\ub7ec\uc2a4\ud130 1");
  await page.getByRole("link", { name: "\ub370\uc774\ud130 \uad00\ub9ac", exact: true }).click();
  await menu.getByRole("link", { name: "\uc218\uc9d1", exact: true }).waitFor();
  if (await menu.getByRole("link", { name: "\uc120\uc218 \ubd84\uc11d", exact: true }).count() !== 0) throw new Error("Management exposes analysis menu.");
  await page.getByRole("link", { name: "\ubd84\uc11d", exact: true }).click();
  await chart.waitFor();
  if (await page.getByLabel("\ubd84\uc11d \ud074\ub7ec\uc2a4\ud130").inputValue() !== "\ud074\ub7ec\uc2a4\ud130 1") throw new Error("Workspace did not restore filter.");
  if (await shapeSettings.getAttribute("open") !== null) throw new Error("Reopened pitch view settings must start collapsed.");
  await shapeSettingsSummary.press("Enter");
  const yaw = page.getByRole("slider", { name: "\uc88c\uc6b0 \ud68c\uc804" });
  const beforeRotation = await chart.evaluate((node) => node.toDataURL());
  await yaw.fill("75");
  await page.waitForFunction((before) => document.querySelector(".pitch-shape-chart canvas")?.toDataURL() !== before, beforeRotation);
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  if (box === null) throw new Error("Missing 3D chart.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 4 }); await page.mouse.up();
  if (await yaw.inputValue() === "75") throw new Error("3D drag rotation failed.");
  await page.getByRole("button", { name: "\uc911\uacc4 \ud45c\uae30 \uae30\uc900" }).click();
  await chart.focus(); await page.keyboard.press("Home");
  if (await page.locator(".pitch-selected dd").count() !== 4) throw new Error("Analysis keyboard selection failed.");
  await openReportFilters();
  await page.getByLabel("\ubd84\uc11d \uc2dc\uc98c").selectOption("2025");
  await page.waitForFunction((before) => {
    const node = document.querySelector(".pitch-reference-time strong");
    return node !== null && node.textContent !== before;
  }, firstTime);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await chart.waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error("Analysis horizontal overflow.");
    const nonempty = await chart.evaluate((node) => {
      const context = node.getContext("2d");
      const pixels = context?.getImageData(0, 0, node.width, node.height).data ?? [];
      return pixels.some((value, index) => index % 4 === 3 && value !== 0);
    });
    if (!nonempty) throw new Error("Analysis canvas is blank.");
    if (await shapeSettings.getAttribute("open") !== null) throw new Error("Responsive pitch result must retain collapsed view settings.");
    await shapeSettingsSummary.press("Enter");
    if (!(await yaw.isVisible())) throw new Error("Responsive pitch view settings hid the rotation control.");
    await shapeSettingsSummary.press("Space");
  }
  if (errors.length > 0) throw new Error(errors.join(" | "));
  await page.getByRole("button", { name: "\uba54\ub274", exact: true }).click();
  const headerBottom = await page.locator(".topbar").evaluate((node) => node.getBoundingClientRect().bottom);
  const menuTop = await menu.evaluate((node) => node.getBoundingClientRect().top);
  if (menuTop < headerBottom - 1) throw new Error("Mobile navigation overlaps workspace selector.");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://localhost/analysis/batter-discipline?season=2024&competition=unknown", { waitUntil: "networkidle" });
  await page.locator(".discipline-map").waitFor();
  if (await page.locator(".discipline-map button").count() !== 25) throw new Error("Swing map cells missing.");
  if (await page.locator(".discipline-bars .discipline-bar-row").count() !== 6) throw new Error("Deviation bands missing.");
  if (await page.locator(".discipline-course-comparison table").count() !== 3) throw new Error("Course / expectation comparison missing.");
  await page.locator(".discipline-pitch-list button").first().click();
  await page.locator(".discipline-selected").waitFor();
  await openReportFilters();
  await page.locator('select[aria-label="\uc120\uad6c\uc548 \uce74\uc6b4\ud2b8"]').selectOption("0-0");
  await page.locator(".discipline-map").waitFor();
  if (!page.url().includes("balls=0")) throw new Error("Discipline count URL not updated.");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".discipline-map").waitFor();
  await openReportFilters();
  if (await page.locator('select[aria-label="\uc120\uad6c\uc548 \uce74\uc6b4\ud2b8"]').inputValue() !== "0-0") throw new Error("Discipline URL restoration failed.");
  await page.getByRole("button", { name: "\uc870\uac74 \ucd08\uae30\ud654" }).click();
  await page.locator(".discipline-map").waitFor();
  await page.locator('select[aria-label="\uc120\uad6c\uc548 \uce74\uc6b4\ud2b8"]').selectOption("*-2");
  if (!page.url().includes("strikes=2") || page.url().includes("balls=")) throw new Error("Strike-only filter incorrect.");
  await page.reload({ waitUntil: "networkidle" });
  await openReportFilters();
  if (await page.locator('select[aria-label="\uc120\uad6c\uc548 \uce74\uc6b4\ud2b8"]').inputValue() !== "*-2") throw new Error("Strike-only restoration failed.");
  await page.getByRole("button", { name: "\uc870\uac74 \ucd08\uae30\ud654" }).click();
  await page.locator(".discipline-map").waitFor();
  await page.getByRole("combobox", { name: "\ubd84\uc11d \uc2dc\uc98c", exact: true }).selectOption("2025");
  await page.waitForURL((url) => url.pathname === "/analysis/batter-discipline" && url.searchParams.get("season") === "2025");
  await page.locator(".discipline-map").waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({width,height:844});
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error("Discipline horizontal overflow.");
  }
  if (errors.length > 0) throw new Error(errors.join(" | "));
  for (const [url, selector] of [
    ["http://localhost/analysis/coverage?season=2024&competition=unknown", ".coverage-overview"],
    ["http://localhost/analysis/models", "table"],
    ["http://localhost/analysis/park-environment?season=2024&competition=unknown", ".park-rate-chart"],
    ["http://localhost/analysis/statistics?season=2024&competition=unknown", "table"],
    ["http://localhost/analysis/statistics?season=2024&competition=unknown&kind=pitching", "table"],
    ["http://localhost/analysis/pitch-location?season=2024&competition=unknown", "table:visible"],
    ["http://localhost/analysis/batter-profile?season=2024&competition=unknown", "table:visible"],
    ["http://localhost/analysis/pitcher-changes?season=2024&competition=unknown", ".pitch-change-summary"],
    ["http://localhost/analysis/pitch-sequences?season=2024&competition=unknown", ".sequence-groups"],
    ["http://localhost/analysis/pitcher-workload?season=2024&competition=unknown", ".workload-timeline"],
    ["http://localhost/analysis/baserunning?season=2024&competition=unknown", "table"],
    ["http://localhost/analysis/matchups?season=2024&competition=unknown", ".player-report-table"],
  ]) {
    await page.goto(url, {waitUntil:"networkidle"});
    await page.locator(selector).first().waitFor();
    if (url.includes("/analysis/statistics")) {
      if (await page.locator("table thead th").count() !== 10) throw new Error("Statistics summary columns are missing.");
      await page.locator(".statistics-detail-toggle input").check();
      if (await page.locator("table thead th").count() <= 10) throw new Error("Detailed statistics are missing.");
      await page.locator(".statistics-detail-toggle input").uncheck();
    }
    if (url.includes("pitch-sequences")) {
      await page.locator(".sequence-group-header select").selectOption({ index: 1 });
      await page.locator(".sequence-comparison .analysis-comparison-target").waitFor();
      await page.locator(".sequence-group-details > summary").click();
      await page.locator(".sequence-group-details table").waitFor();
      await page.getByRole("button", { name: "\uADA4\uC801 \uBE44\uAD50", exact: true }).first().press("Enter");
      await page.waitForFunction(() => document.activeElement?.classList.contains("analysis-comparison-target"));
    }
    if (url.includes("park-environment")) {
      await page.locator(".park-rate-heading select").selectOption("completeRunRate");
      await page.locator(".park-observed-details > summary").click();
      await page.locator(".park-observed-details table").waitFor();
    }
    if (url.includes("baserunning")) {
      const runnerButton = page.getByRole("table", { name: "\uC120\uC218\uBCC4 \uC8FC\uB8E8", exact: true }).getByRole("button").first();
      await runnerButton.press("Enter");
      await page.locator(".baserunning-summary").waitFor();
      await page.waitForFunction(() => document.activeElement?.id === "baserunning-selection-heading");
      if (await page.locator(".baserunning-summary li").count() !== 4) throw new Error("Runner opportunity outcomes are missing.");
    }
    if (url.endsWith("/analysis/models")) {
      await page.locator("select").selectOption("2023");
      await page.getByText(/2021, 2022/).first().waitFor();
      await page.locator("select").selectOption("2020");
      await page.waitForFunction(() => [...document.querySelectorAll("table tbody tr")].length === 6 && [...document.querySelectorAll("table tbody tr")].every(row => row.cells[3]?.textContent === "2020"));
      if (!await page.locator(".primary-button").isDisabled()) throw new Error("Unsupported historical training was enabled.");
    }
    if (url.includes("pitcher-changes")) {
      await page.getByText("\uC804\uCCB4 \uAD6C\uC885\u00B7\uC9C0\uD45C\uBCC4 \uBCC0\uD654", { exact: true }).click();
      await page.getByRole("table", { name: "\uAD6C\uC885\uBCC4 \uBCC0\uD654", exact: true }).waitFor();
      await page.getByRole("button", {name: "\uC9C4\uC785\uAC01 VAA/HAA \uBCF4\uAE30",exact:true}).click();
      await page.getByRole("table", {name: "\uAD6C\uC885 \uC9C4\uC785\uAC01",exact:true}).waitFor();
    }
    if (url.includes("pitcher-workload")) {
      const appearancePicker = page.locator(".workload-appearance-picker select");
      await appearancePicker.selectOption({ index: 0 });
      const selectedDate = (await appearancePicker.locator("option:checked").innerText()).slice(0, 10);
      await page.getByRole("heading", { name: new RegExp(selectedDate) }).waitFor();
      if (await page.locator(".workload-selected-summary dd").count() !== 4) throw new Error("Workload selected appearance summary is missing.");
      await page.getByRole("button", {name: "\uc870\uac74\uc744 \ub9de\ucd98 \uc6b4\uc6a9 \ube44\uad50 \ubcf4\uae30",exact:true}).click();
      await page.getByRole("table", {name: "\uc870\uac74\uc744 \ub9de\ucd98 \uc6b4\uc6a9 \uc131\uacfc",exact:true}).waitFor();
      await page.getByRole("combobox", {name: "\uc6b4\uc6a9 \ube44\uad50 \uc131\uacfc",exact:true}).selectOption("whiff");
      await page.getByRole("combobox", {name: "\uc6b4\uc6a9 \ube44\uad50 \ud56d\ubaa9",exact:true}).selectOption("rest");
      if (await page.getByRole("table", {name: "\uc870\uac74\uc744 \ub9de\ucd98 \uc6b4\uc6a9 \uc131\uacfc",exact:true}).getByText("\uacf5\ud1b5 \ud45c\ubcf8 \ubd80\uc871", {exact:true}).count() !== 2) throw new Error("Sparse workload comparison was published.");
      const workloadPath = `/api/v2/analysis/pitcher-workload/${encodeURIComponent(pitcher)}`;
      const selectedScope = new URLSearchParams({ season: "2024", competition: "allstar", pitcher });
      const workloadResponse = page.waitForResponse(res => new URL(res.url()).pathname === workloadPath);
      await page.goto(`http://localhost/analysis/pitcher-workload?${selectedScope}`, { waitUntil: "networkidle" });
      const workload = await (await workloadResponse).json();
      if (workload.scope.competition !== "allstar" || workload.lookbackCompetition !== "all" ||
          workload.appearances.length !== 1 || workload.appearances[0].gameDate !== "2024-07-06" ||
          workload.appearances[0].previousObservedDate !== "2024-06-01" || workload.appearances[0].observedRestDays !== 34) {
        throw new Error("All-Star workload did not retain regular-season appearance history.");
      }
      const notes = page.getByText("\ub204\uc801 \ud22c\uad6c\uc640 \ud734\uc2dd\uc77c\uc744 \uc77d\ub294 \uae30\uc900", { exact: true });
      await notes.press("Enter");
      await page.getByText(/\uacbd\uae30 \uc885\ub958\uc5d0 \uad00\uacc4\uc5c6\uc774/).waitFor();
      const comparisonResponse = page.waitForResponse(res => new URL(res.url()).pathname === `${workloadPath}/comparison`);
      await page.getByRole("button", { name: "\uc870\uac74\uc744 \ub9de\ucd98 \uc6b4\uc6a9 \ube44\uad50 \ubcf4\uae30", exact: true }).click();
      const comparison = await (await comparisonResponse).json();
      if (comparison.scope.competition !== "allstar" || comparison.lookbackCompetition !== "all" ||
          comparison.actualPitches !== workload.appearances[0].pitches) throw new Error("All-Star comparison included pitches from other competitions.");
    }
    if (url.includes("matchups")) {
      await assertPrimaryReportScope();
      const previousViewport = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 844 });
      const opponentSearch = page.getByRole("searchbox", { name: /\uc0c1\ub300 .* \uac80\uc0c9/ });
      await opponentSearch.click();
      const opponentChoices = page.getByRole("list", { name: /\uc0c1\ub300 .* \uac80\uc0c9 \uacb0\uacfc/ });
      const firstOpponent = opponentChoices.getByRole("button").first();
      await firstOpponent.waitFor();
      if (!(await firstOpponent.innerText()).includes("\uc9c1\uc811 \uc0c1\ub300") ||
          !(await firstOpponent.innerText()).includes("ID ")) {
        throw new Error("Direct opponents must appear first with identifying details.");
      }
      await firstOpponent.click({ trial: true });
      await opponentSearch.press("Escape");
      await page.setViewportSize(previousViewport);
      if (await page.locator(".matchup-observed-summary").count() !== 0) throw new Error("Similar matchup comparison opened before selection.");
      const similar = page.waitForResponse(res => new URL(res.url()).pathname === "/api/v2/analysis/matchups" && res.ok());
      await page.getByText("\uc720\uc0ac \uc870\uac74\uc758 \ud22c\uad6c\uc640 \ube44\uad50", { exact: true }).click();
      await similar;
      await page.locator(".matchup-observed-summary").waitFor();
      await page.getByRole("button", {name: "\uAD6C\uC9C8 \uC720\uC0AC\uB3C4\u00B7\uAE30\uB300 \uBC18\uC751 \uBCF4\uAE30",exact:true}).click();
      await page.getByText("\uC774 \uBD84\uC11D\uC740 \uD655\uC778\uB41C \uC815\uADDC\uC2DC\uC98C\uC5D0\uC11C \uC81C\uACF5\uD569\uB2C8\uB2E4.",{exact:true}).waitFor();
    }
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:844});
      if (await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)) throw new Error(`Analysis table overflow: ${url}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join(" | "));
  for (const [path, role, id] of [
    ["player-statistics", "pitcher", pitcher], ["player-statistics", "batter", batter],
    ["pitch-shape", "pitcher", pitcher], ["pitcher-changes", "pitcher", pitcher],
    ["batter-profile", "batter", batter], ["batter-discipline", "batter", batter],
  ]) {
    const params = new URLSearchParams({ season: "2025", competition: "unknown", playerRole: role, [role]: id });
    let comparisonRequests = 0;
    const countComparison = request => { if (new URL(request.url()).pathname.endsWith("/comparison")) comparisonRequests++; };
    page.on("request", countComparison);
    try {
      await page.goto(`http://localhost/analysis/${path}?${params}`, { waitUntil: "networkidle" });
      if (path === "batter-profile") await page.getByRole("tab", { name: "\uae30\uac04 \ube44\uad50", exact: true }).click();
      else await page.getByRole("button", { name: "\uae30\uac04 \ube44\uad50 \uc5f4\uae30", exact: true }).click();
      await page.getByLabel("\uae30\uac04 A \uc2dc\uc98c", { exact: true }).selectOption("2024");
      if (comparisonRequests !== 0) throw new Error(`${path}: comparison was fetched before apply.`);
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/comparison"));
      await page.getByRole("button", { name: "\ub450 \uae30\uac04 \ube44\uad50 \uc801\uc6a9", exact: true }).click();
      const response = await responsePromise;
      if (response.status() !== 200) throw new Error(`${path}: comparison ${response.status()} ${await response.text()}`);
      await page.locator(".period-results table").waitFor();
      if (comparisonRequests !== 1) throw new Error(`${path}: applying periods sent duplicate requests.`);
      if (await page.locator(".period-snapshot").count() !== 2) throw new Error(`${path}: missing A/B sample coverage.`);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`${path}: A/B comparison overflows.`);
      }
      await page.reload({ waitUntil: "networkidle" });
      await page.locator(".period-results table").waitFor();
      if (await page.getByLabel("\uae30\uac04 A \uc2dc\uc98c", { exact: true }).inputValue() !== "2024") throw new Error(`${path}: A/B URL was not restored.`);
    } finally { page.off("request", countComparison); }
  }
  if (errors.length > 0) throw new Error(errors.join(" | "));
  console.log(JSON.stringify({ playerDiscovery: "ok", playerScopeNavigation: "ok", playerBasicStatistics: "ok", quickSituationFilters: "ok", pitchRateSorting: "ok", pitchLocationReplayReturn: "selected zone and all zones", pitchAnalysis: "ok", periodComparisons: "six pages, lazy requests, URL restore, desktop/mobile", seasons: [2024, 2025], workspaces: "ok", clustering: "ok", rotation: "ok", keyboard: "ok", canvas: "ok", responsive: "ok" }));
} finally { await browser.close(); }
'@
  $analysisSmoke | & docker compose exec -T --workdir /app/packages/collection api node --input-type=module
  Assert-NativeSuccess "analysis Chromium UI smoke"
  $referenceResponses = @{}
  $modelRequest = @{ requestId = [Guid]::NewGuid().ToString(); force = $false; applicationSeason = 2025 } | ConvertTo-Json -Compress
  $modelJob = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v2/analysis/model-jobs" -ContentType "application/json" -Body $modelRequest
  for ($attempt = 0; $attempt -lt 180 -and $modelJob.state -eq "running"; $attempt++) {
    Start-Sleep -Seconds 1
    $modelJob = Invoke-RestMethod -Uri "$baseUrl/api/v2/analysis/model-jobs/$($modelJob.id)"
  }
  if ($modelJob.state -ne "succeeded" -or @($modelJob.steps | Where-Object { $_.state -ne "published" }).Count -ne 0) {
    throw "Model worker training/publication did not complete: $($modelJob | ConvertTo-Json -Depth 10 -Compress)"
  }
  $modelState = Invoke-RestMethod -Uri "$baseUrl/api/v2/analysis/models"
  if (@($modelState.models | Where-Object { $_.state -ne "current" }).Count -ne 0) { throw "Published models are not current." }
  $modelHashes = $modelState.models.modelHash -join ","
  $duplicateModelJob = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v2/analysis/model-jobs" -ContentType "application/json" -Body $modelRequest
  if ($duplicateModelJob.id -ne $modelJob.id -or $duplicateModelJob.sequence -ne $modelJob.sequence) { throw "Model refresh is not idempotent." }
  $historicalRequest = @{ requestId = [Guid]::NewGuid().ToString(); force = $true; applicationSeason = 2023 } | ConvertTo-Json -Compress
  $historicalJob = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/v2/analysis/model-jobs" -ContentType "application/json" -Body $historicalRequest
  for ($attempt = 0; $attempt -lt 180 -and $historicalJob.state -eq "running"; $attempt++) {
    Start-Sleep -Seconds 1
    $historicalJob = Invoke-RestMethod -Uri "$baseUrl/api/v2/analysis/model-jobs/$($historicalJob.id)"
  }
  if ($historicalJob.state -ne "succeeded" -or @($historicalJob.steps | Where-Object { $_.state -eq "published" }).Count -ne 5 -or @($historicalJob.steps | Where-Object { $_.kind -eq "win" -and $_.state -eq "unsupported" }).Count -ne 1) { throw "Historical model dispatch failed." }
  $historicalState = Invoke-RestMethod -Uri "$baseUrl/api/v2/analysis/models?season=2023"
  if (@($historicalState.models | Where-Object { $_.trainedThrough -ne 2022 }).Count -ne 0) { throw "Historical model period mismatch." }
  $currentModels = Invoke-RestMethod -Uri "$baseUrl/api/v2/analysis/models?season=2025"
  if (($currentModels.models.modelHash -join ",") -ne $modelHashes) { throw "Historical publication changed the 2025 models." }
  $referenceFiles = @{}
  foreach ($season in @(2024, 2025)) {
    $catalog = Invoke-RestMethod -Uri "$baseUrl/api/v2/analysis/pitch-shape?season=$season&competition=unknown"
    $pitcherId = $catalog.pitchers[0].pitcherId
    $uri = "$baseUrl/api/v2/analysis/pitch-shape/${pitcherId}?season=$season&competition=unknown"
    $response = Invoke-RestMethod -Uri $uri
    $referenceResponses[$uri] = $response | ConvertTo-Json -Depth 100 -Compress
    if ($null -eq $response.baseline -or $response.points.Count -eq 0) {
      throw "Release-based reference fixture did not produce points."
    }
    if ($response.calibration.plane -ne "middle" -or
        ($response.calibration.calibratedCount + $response.calibration.uncalibratedCount) -ne $response.points.Count) {
      throw "Pitch calibration coverage does not match points."
    }
    $referencePath = Join-Path $workspacePath "analysis/pitch-reference/v$($response.modelVersion)/reference-v4/$($response.calibration.profileHash)/$season/$($response.referenceSourceHash).json"
    $calibrationPath = Join-Path $workspacePath "analysis/pitch-calibration/v$($response.calibration.modelVersion)/$season/$($response.referenceSourceHash).json"
    foreach ($cachePath in @($referencePath, $calibrationPath)) {
      $referenceFiles[$cachePath] = @{
        hash = Get-Sha256Hex $cachePath
        modified = (Get-Item -LiteralPath $cachePath).LastWriteTimeUtc.Ticks
      }
    }
  }
  Invoke-Compose -Arguments @("restart", "api")
  Wait-Ready
  foreach ($uri in $referenceResponses.Keys) {
    $response = Invoke-RestMethod -Uri $uri
    if (($response | ConvertTo-Json -Depth 100 -Compress) -ne $referenceResponses[$uri]) {
      throw "Pitch analysis changed after reference cache restart."
    }
  }
  foreach ($referencePath in $referenceFiles.Keys) {
    $before = $referenceFiles[$referencePath]
    if ((Get-Sha256Hex $referencePath) -ne $before.hash -or
        (Get-Item -LiteralPath $referencePath).LastWriteTimeUtc.Ticks -ne $before.modified) {
      throw "Pitch reference was rewritten instead of reused after restart."
    }
  }
  Write-Output "Pitch reference cache persisted and reused across API restart."
  $modelState = Invoke-RestMethod -Uri "$baseUrl/api/v2/analysis/models"
  if (($modelState.models.modelHash -join ",") -ne $modelHashes -or $modelState.latestJob.id -ne $historicalJob.id) { throw "Model artifacts/job did not survive restart." }
  Write-Output "All six model workers, publication, idempotency and restart persistence passed."
  $page = Invoke-WebRequest -Uri "$baseUrl/replay" -UseBasicParsing
  if ($page.StatusCode -ne 200) { throw "replay web route를 열 수 없습니다." }
}
catch {
  if ($composeStarted) {
    try {
      & docker compose logs --no-color api migrate
    }
    catch {
      Write-Warning "격리 E2E 진단 로그 수집 실패: $($_.Exception.Message)"
    }
  }
  throw
}
finally {
  if ($composeStarted) {
    try {
      & docker compose down -v --remove-orphans
      Assert-NativeSuccess "격리 Compose 자원 정리"
    }
    catch {
      $cleanupFailures += $_.Exception.Message
    }
  }
  foreach ($image in $testImages) {
    try {
      $present = @(& docker image ls --quiet --filter "reference=$image")
      Assert-NativeSuccess "격리 E2E 이미지 존재 확인 ($image)"
      if ($present.Count -gt 0) {
        & docker image rm $image
        Assert-NativeSuccess "격리 E2E 이미지 정리 ($image)"
      }
    }
    catch {
      $cleanupFailures += $_.Exception.Message
    }
  }
  Pop-Location
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($resolvedTestRoot).StartsWith("kbo-stage6-")) {
    try {
      Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction Stop
    }
    catch {
      $cleanupFailures += "격리 E2E 임시 폴더 정리 실패: $($_.Exception.Message)"
    }
  }
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
  foreach ($failure in $cleanupFailures) { Write-Warning $failure }
}
if ($cleanupFailures.Count -gt 0) { throw "격리 E2E 자원 정리에 실패했습니다." }
Write-Output "격리 Compose restart/backup/restore E2E 통과: $projectName"
