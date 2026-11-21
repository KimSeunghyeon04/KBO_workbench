[CmdletBinding()]
param(
  [string]$DestinationRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "backup-restore-common.ps1")

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
  $DestinationRoot = Join-Path $repositoryRoot ".backups"
}
$DestinationRoot = [IO.Path]::GetFullPath($DestinationRoot)

function Get-RepositoryAppVersion {
  $packagePath = Join-Path $repositoryRoot "package.json"
  $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $version = [string]$package.version
  if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "루트 package.json version이 올바르지 않습니다."
  }
  return $version
}

Push-Location $repositoryRoot
$containerDump = "/tmp/kbo-workbench-backup-$PID.dump"
$stoppedServices = @()
try {
  $configuration = Get-ComposeConfiguration
  $workspacePath = Get-WorkspacePath $configuration
  $dbUser = [string]$configuration.services.db.environment.POSTGRES_USER
  $dbName = [string]$configuration.services.db.environment.POSTGRES_DB
  $runningServices = @(& docker compose ps --status running --services)
  Assert-NativeSuccess "docker compose ps"
  $runtimeAppVersion = Get-RepositoryAppVersion
  if ($runningServices -contains "api") {
    $containerAppVersion = ((& docker compose exec -T api node -p `
      "JSON.parse(require('fs').readFileSync('/app/package.json','utf8')).version") -join "`n").Trim()
    Assert-NativeSuccess "실행 중인 API version 확인"
    if ($containerAppVersion -ne $runtimeAppVersion) {
      throw "실행 중인 API와 루트 package.json version이 다릅니다."
    }
  }
  $runtimeMigrationVersion = ((& docker compose exec -T db psql `
    --username $dbUser --dbname $dbName --tuples-only --no-align `
    --command "SELECT version FROM workbench.schema_migrations ORDER BY applied_at DESC,version DESC LIMIT 1") -join "`n").Trim()
  Assert-NativeSuccess "실행 중인 DB migration 확인"
  $runtimeContract = ((& docker compose exec -T db psql `
    --username $dbUser --dbname $dbName --tuples-only --no-align `
    --command "SELECT analytics_contract_version::text || '/' || projection_version::text || '/' || registry_contract_version::text || COALESCE('/' || (to_jsonb(contract_metadata) ->> 'record_correction_contract_version'), '') FROM workbench.contract_metadata WHERE singleton") -join "`n").Trim()
  Assert-NativeSuccess "실행 중인 DB contract 확인"
  $stoppedServices = @(@("web", "api") | Where-Object { $runningServices -contains $_ })
  if ($stoppedServices.Count -gt 0) {
    Invoke-Compose -Arguments (@("stop") + $stoppedServices)
  }

  if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $workspacePath
  }
  $null = New-Item -ItemType Directory -Force -Path $DestinationRoot
  $backupName = "kbo-workbench-{0}" -f ([DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ"))
  $backupDirectory = Join-Path $DestinationRoot $backupName
  $null = New-Item -ItemType Directory -Path $backupDirectory
  $databaseFile = Join-Path $backupDirectory "postgres.dump"
  $workspaceFile = Join-Path $backupDirectory "workspace.zip"

  Invoke-Compose -Arguments @(
    "exec", "-T", "db", "pg_dump",
    "--username", $dbUser,
    "--dbname", $dbName,
    "--format", "custom",
    "--file", $containerDump
  )
  Invoke-Compose -Arguments @("cp", "db:$containerDump", $databaseFile)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory(
    $workspacePath,
    $workspaceFile,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $manifest = [ordered]@{
    formatVersion = 1
    createdAt = [DateTime]::UtcNow.ToString("o")
    appVersion = $runtimeAppVersion
    migrationVersion = $runtimeMigrationVersion
    databaseContract = $runtimeContract
    database = [ordered]@{
      file = "postgres.dump"
      sha256 = Get-Sha256 $databaseFile
      name = $dbName
    }
    workspace = [ordered]@{
      file = "workspace.zip"
      sha256 = Get-Sha256 $workspaceFile
    }
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText(
    (Join-Path $backupDirectory "manifest.json"),
    "$manifestJson`n",
    [Text.UTF8Encoding]::new($false)
  )
  Write-Output $backupDirectory
}
finally {
  & docker compose exec -T db rm -f $containerDump 2>$null
  if ($stoppedServices.Count -gt 0) {
    Invoke-Compose -Arguments (@("start") + $stoppedServices)
  }
  Pop-Location
}
