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
  "COMPOSE_PROJECT_NAME", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB",
  "KBO_DATA_DIR", "KBO_WEB_PORT", "KBO_DB_PORT", "KBO_POSTGRES_VOLUME_NAME", "KBO_COLLECTION_CONCURRENCY",
  "KBO_NAVER_MAX_ATTEMPTS", "KBO_NAVER_REQUESTS_PER_SECOND", "KBO_NAVER_TIMEOUT_MS",
  "KBO_RECORD_CORRECTION_AUTO_SYNC"
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

function Assert-BrowserUi {
  $browserSmoke = @'
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("http://web/settings", { waitUntil: "networkidle" });
  await page.locator("h1").waitFor();
  const settingsHeading = await page.locator("h1").innerText();
  const settingsBody = await page.locator("body").innerText();
  if (
    settingsHeading !== "\uC124\uC815 \uBC0F \uC9C4\uB2E8" ||
    !settingsBody.includes("\uCD5C\uADFC \uC2E4\uD328 \uC791\uC5C5") ||
    !settingsBody.includes("PostgreSQL 16") ||
    !settingsBody.includes("\uC800\uC7A5")
  ) {
    throw new Error("Settings browser assertion failed.");
  }

  await page.goto("http://web/replay", { waitUntil: "networkidle" });
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
  const replayDocumentScrolls = await page.locator("html").evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  );
  if (replayDocumentScrolls) {
    throw new Error("Replay dashboard requires vertical document scrolling on desktop.");
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

  await page.goto("http://web/database", { waitUntil: "networkidle" });
  await page.locator("h1").waitFor();
  const batchButton = page.getByRole("button", {
    name: /\uC801\uC7AC \uAC00\uB2A5\uD55C 0\uACBD\uAE30 \uC77C\uAD04 \uC801\uC7AC/,
  });
  if ((await batchButton.count()) !== 1 || !(await batchButton.isDisabled())) {
    throw new Error("Database batch import browser assertion failed.");
  }

  await page.goto("http://web/correct", { waitUntil: "networkidle" });
  await page.locator("h1").waitFor();
  if ((await page.locator("h1").innerText()) !== "\uC911\uACC4 \uC6D0\uC7A5 \uBCF4\uC815") {
    throw new Error("Correction browser heading assertion failed.");
  }
  const correctionBody = await page.locator("body").innerText();
  if (
    !correctionBody.includes("\uAC80\uD1A0 \uD544\uC694") ||
    !correctionBody.includes("\uD30C\uC77C \uC6D0\uC7A5\uC744 \uC120\uD0DD\uD574 \uC791\uC5C5 \uC0AC\uBCF8\uC744 \uC5EC\uC138\uC694.")
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

  await page.goto("http://web/record-corrections", { waitUntil: "networkidle" });
  await page.locator("h1").waitFor();
  if (
    (await page.locator("h1").innerText()) !==
    "KBO \uAE30\uB85D\uC815\uC815 \uAC80\uD1A0\uD568"
  ) {
    throw new Error("Record correction inbox heading assertion failed.");
  }
  if (
    (await page.getByRole("region", { name: "\uAE30\uB85D\uC815\uC815 \uC0C1\uD0DC \uC694\uC57D" }).count()) !==
    1
  ) {
    throw new Error("Record correction summary is missing.");
  }
  await page
    .getByText("\uC870\uAC74\uC5D0 \uB9DE\uB294 \uACF5\uC9C0\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.")
    .waitFor();
  if (pageErrors.length > 0) {
    throw new Error(`Browser page error: ${pageErrors.join(" | ")}`);
  }
  console.log(
    JSON.stringify({
      settings: "ok",
      replay: "ok",
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

$null = New-Item -ItemType Directory -Path $testRoot
$composeStarted = $false
Push-Location $repositoryRoot
try {
  $upArguments = @("up", "-d")
  if (-not $SkipBuild) { $upArguments += "--build" }
  Invoke-Compose -Arguments $upArguments
  $composeStarted = $true
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
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $databaseBackup).Hash.ToLowerInvariant()
    }
    workspace = [ordered]@{
      file = "workspace.zip"
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $workspaceBackup).Hash.ToLowerInvariant()
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
  Invoke-Compose -Arguments @("start", "api", "web")
  Wait-Ready

  $recoveredJobs = Invoke-RestMethod -Uri "$baseUrl/api/v2/collection-jobs"
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
  # 원장 21행 중 타석 결과와 연결 주자 행은 같은 원자적 play로 compile된다.
  if ($revisionOneManifest.frameCount -ne 18) { throw "격리 E2E replay frame 수가 다릅니다." }

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

  & (Join-Path $PSScriptRoot "backup.ps1") -DestinationRoot $backupRoot
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
  Remove-Item -LiteralPath $corruptBackupDirectory -Recurse -Force

  Invoke-Compose -Arguments @("stop", "web", "api")
  Remove-Item -LiteralPath (Join-Path $originalDirectory "golden-game-1.json") -Force
  Invoke-Compose -Arguments @(
    "exec", "-T", "db", "psql", "--username", "kbo_e2e", "--dbname", "kbo_e2e",
    "--set", "ON_ERROR_STOP=1", "--command", "DROP SCHEMA analytics CASCADE"
  )
  Invoke-Compose -Arguments @("start", "api", "web")
  Start-Sleep -Seconds 2
  & (Join-Path $PSScriptRoot "restore.ps1") `
    -BackupDirectory $backupDirectory.FullName `
    -ConfirmDataReplacement
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
  if ($afterRestart.frameHash -ne $manifest.frameHash) {
    throw "API restart 전후 replay frame hash가 다릅니다."
  }
  Assert-BrowserUi
  $page = Invoke-WebRequest -Uri "$baseUrl/replay" -UseBasicParsing
  if ($page.StatusCode -ne 200) { throw "replay web route를 열 수 없습니다." }
  Write-Output "격리 Compose restart/backup/restore E2E 통과: $projectName"
}
catch {
  if ($composeStarted) {
    & docker compose logs --no-color api migrate
  }
  throw
}
finally {
  if ($composeStarted) {
    & docker compose down -v --remove-orphans
  }
  Pop-Location
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($resolvedTestRoot).StartsWith("kbo-stage6-")) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
}
