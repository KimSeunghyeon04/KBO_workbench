[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupDirectory,

  [switch]$ConfirmDataReplacement
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $ConfirmDataReplacement) {
  throw "복원은 현재 staging과 DB를 교체합니다. -ConfirmDataReplacement를 명시해야 합니다."
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$BackupDirectory = [IO.Path]::GetFullPath($BackupDirectory)

function Assert-NativeSuccess([string]$Action) {
  if ($LASTEXITCODE -ne 0) { throw "$Action 실패 (exit $LASTEXITCODE)" }
}

function Get-Sha256([string]$LiteralPath) {
  $stream = [IO.File]::OpenRead($LiteralPath)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  }
  finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Invoke-Compose([string[]]$Arguments) {
  & docker compose @Arguments
  Assert-NativeSuccess "docker compose $($Arguments -join ' ')"
}

function Get-ComposeConfiguration {
  $raw = & docker compose config --format json
  Assert-NativeSuccess "docker compose config"
  return (($raw -join "`n") | ConvertFrom-Json)
}

function Get-WorkspacePath($Configuration) {
  $volume = @($Configuration.services.api.volumes) |
    Where-Object { $_.target -eq "/var/lib/kbo" -and $_.type -eq "bind" } |
    Select-Object -First 1
  if ($null -eq $volume -or [string]::IsNullOrWhiteSpace([string]$volume.source)) {
    throw "API workspace bind mount를 찾을 수 없습니다."
  }
  $resolved = [IO.Path]::GetFullPath([string]$volume.source)
  $root = [IO.Path]::GetPathRoot($resolved)
  if ($resolved.TrimEnd('\', '/') -eq $root.TrimEnd('\', '/')) {
    throw "filesystem root는 workspace로 사용할 수 없습니다: $resolved"
  }
  return $resolved
}

function Remove-SafeDirectory([string]$Target, [string]$ExpectedParent) {
  if (-not (Test-Path -LiteralPath $Target)) { return }
  $resolvedTarget = [IO.Path]::GetFullPath($Target)
  $resolvedParent = [IO.Path]::GetFullPath($ExpectedParent)
  if ([IO.Path]::GetDirectoryName($resolvedTarget) -ne $resolvedParent) {
    throw "삭제 대상이 예상한 복원 작업 경로 밖에 있습니다: $resolvedTarget"
  }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}

$manifestPath = Join-Path $BackupDirectory "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "backup manifest가 없습니다: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.formatVersion -ne 1) { throw "지원하지 않는 backup format입니다." }
$databaseFile = Join-Path $BackupDirectory ([string]$manifest.database.file)
$workspaceFile = Join-Path $BackupDirectory ([string]$manifest.workspace.file)
foreach ($file in @($databaseFile, $workspaceFile)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "backup 파일이 없습니다: $file" }
}
$databaseHash = Get-Sha256 $databaseFile
$workspaceHash = Get-Sha256 $workspaceFile
if ($databaseHash -ne [string]$manifest.database.sha256) { throw "PostgreSQL backup hash가 다릅니다." }
if ($workspaceHash -ne [string]$manifest.workspace.sha256) { throw "workspace backup hash가 다릅니다." }

Push-Location $repositoryRoot
$containerDump = "/tmp/kbo-workbench-restore-$PID.dump"
$replacementPath = ""
$rollbackPath = ""
$workspaceSwapped = $false
$restoreSucceeded = $false
$stoppedServices = @()
try {
  $configuration = Get-ComposeConfiguration
  $workspacePath = Get-WorkspacePath $configuration
  $workspaceParent = [IO.Path]::GetDirectoryName($workspacePath)
  $replacementPath = Join-Path $workspaceParent ".kbo-restore-$([Guid]::NewGuid().ToString('N'))"
  $rollbackPath = Join-Path $workspaceParent ".kbo-rollback-$([Guid]::NewGuid().ToString('N'))"
  $null = New-Item -ItemType Directory -Force -Path $workspaceParent
  $null = New-Item -ItemType Directory -Path $replacementPath
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($workspaceFile, $replacementPath)
  $restoredLock = Join-Path $replacementPath ".writer.lock"
  if (Test-Path -LiteralPath $restoredLock -PathType Leaf) { Remove-Item -LiteralPath $restoredLock }

  $runningServices = @(& docker compose ps --status running --services)
  Assert-NativeSuccess "docker compose ps"
  $stoppedServices = @("web", "api") | Where-Object { $runningServices -contains $_ }
  if ($stoppedServices.Count -gt 0) {
    Invoke-Compose -Arguments (@("stop") + $stoppedServices)
  }

  if (Test-Path -LiteralPath $workspacePath) {
    Move-Item -LiteralPath $workspacePath -Destination $rollbackPath
  }
  Move-Item -LiteralPath $replacementPath -Destination $workspacePath
  $workspaceSwapped = $true

  Invoke-Compose -Arguments @("cp", $databaseFile, "db:$containerDump")
  $dbUser = [string]$configuration.services.db.environment.POSTGRES_USER
  $dbName = [string]$configuration.services.db.environment.POSTGRES_DB
  Invoke-Compose -Arguments @(
    "exec", "-T", "db", "pg_restore",
    "--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction",
    "--username", $dbUser,
    "--dbname", $dbName,
    $containerDump
  )
  $restoreSucceeded = $true
  if (Test-Path -LiteralPath $rollbackPath) {
    Remove-SafeDirectory -Target $rollbackPath -ExpectedParent $workspaceParent
  }
  Write-Output "복원이 완료됐습니다: $BackupDirectory"
}
catch {
  if ($workspaceSwapped -and -not $restoreSucceeded) {
    $configurationForRollback = Get-ComposeConfiguration
    $workspaceForRollback = Get-WorkspacePath $configurationForRollback
    $parentForRollback = [IO.Path]::GetDirectoryName($workspaceForRollback)
    Remove-SafeDirectory -Target $workspaceForRollback -ExpectedParent $parentForRollback
    if (Test-Path -LiteralPath $rollbackPath) {
      Move-Item -LiteralPath $rollbackPath -Destination $workspaceForRollback
    }
  }
  throw
}
finally {
  & docker compose exec -T db rm -f $containerDump 2>$null
  if (-not [string]::IsNullOrWhiteSpace($replacementPath) -and (Test-Path -LiteralPath $replacementPath)) {
    Remove-SafeDirectory -Target $replacementPath -ExpectedParent ([IO.Path]::GetDirectoryName($replacementPath))
  }
  if ($stoppedServices.Count -gt 0) {
    Invoke-Compose -Arguments (@("start") + $stoppedServices)
  }
  Pop-Location
}
