import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const fixture = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$scriptPath = Join-Path (Get-Location) "scripts/verify-compose-recovery.ps1"
$fixtureScriptsRoot = Split-Path -Parent $scriptPath
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw "E2E script failed to parse" }
$testRun = $ast.EndBlock.Statements | Where-Object {
  $_ -is [System.Management.Automation.Language.TryStatementAst] -and
    $_.CatchClauses.Count -gt 0 -and $null -ne $_.Finally
} | Select-Object -Last 1
if ($null -eq $testRun) { throw "E2E test run not found" }

function docker {
  $operation = "$($args[0]) $($args[1])"
  $image = if ($args[-1] -like "*-api:local") { "api" } elseif ($args[-1] -like "*-web:local") { "web" } else { "" }
  Write-Host "fixture Docker $operation $image"
  $global:LASTEXITCODE = 0
  if ($env:KBO_CLEANUP_TEST_FAILURE -eq $operation -and $image -ne "web") {
    if ($operation -eq "compose logs") { throw "fixture diagnostic failure" }
    $global:LASTEXITCODE = 7
    return
  }
  if ($operation -eq "image ls") { Write-Output "fixture-image-id" }
}

$body = @'
{
  $composeStarted = $true
  $testImages = @(("$projectName" + "-api:local"), ("$projectName" + "-web:local"))
  if ($env:KBO_CLEANUP_TEST_FAILURE -eq "workspace-lock") {
    $global:fixtureLockPath = Join-Path $testRoot "fixture-locked.tmp"
    $global:fixtureHandle = [IO.File]::Open($global:fixtureLockPath, "CreateNew", "ReadWrite", "None")
  }
  if ($env:KBO_CLEANUP_TEST_MAIN_FAILURE -eq "1") { throw "fixture main failure" }
}
'@
$source = [IO.File]::ReadAllText($scriptPath)
$start = $testRun.Body.Extent.StartOffset
$end = $testRun.Body.Extent.EndOffset
$source = $source.Substring(0, $start) + $body + $source.Substring($end)
try {
  & ([ScriptBlock]::Create($source.Replace('$PSScriptRoot', '$fixtureScriptsRoot')))
}
finally {
  if ($env:KBO_CLEANUP_TEST_FAILURE -eq "workspace-lock" -and $null -ne $global:fixtureHandle) {
    $global:fixtureHandle.Dispose()
    [IO.File]::Delete($global:fixtureLockPath)
    [IO.Directory]::Delete((Split-Path -Parent $global:fixtureLockPath), $false)
  }
}
`;

function runCleanup(failedOperation = "", mainFailed = false) {
  const command = Buffer.from(fixture, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", command],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        KBO_CLEANUP_TEST_FAILURE: failedOperation,
        KBO_CLEANUP_TEST_MAIN_FAILURE: mainFailed ? "1" : "0",
      },
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { exitCode: result.status, output: result.stdout + result.stderr };
}

describe.skipIf(process.platform !== "win32")("isolated Compose recovery cleanup", () => {
  it("reports success when the checks and cleanup pass", () => {
    const result = runCleanup();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("fixture Docker compose down");
    expect(result.output).toContain("fixture Docker image rm web");
    expect(result.output).toContain("E2E 통과");
  });

  it.each(["compose down", "image ls", "image rm"])(
    "fails the run when %s fails and still removes the other image",
    (operation) => {
      const result = runCleanup(operation);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("exit 7");
      expect(result.output).toContain("fixture Docker image rm web");
      expect(result.output).not.toContain("E2E 통과");
    },
  );

  it("preserves the original check failure if cleanup fails too", () => {
    const result = runCleanup("image rm", true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("fixture main failure");
    expect(result.output).toContain("exit 7");
    expect(result.output).toContain("fixture Docker image rm web");
  });

  it("fails the run when a locked file prevents workspace cleanup", () => {
    const result = runCleanup("workspace-lock");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("임시 폴더 정리 실패");
    expect(result.output).not.toContain("E2E 통과");
  });

  it("preserves the original check failure if collecting diagnostics throws", () => {
    const result = runCleanup("compose logs", true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("fixture main failure");
    expect(result.output).toContain("fixture diagnostic failure");
    expect(result.output).toContain("fixture Docker image rm web");
  });
});
