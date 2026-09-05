[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$suffix = "$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$containerName = "kbo-integration-postgres-$suffix"
$networkName = "kbo-integration-$suffix"
$workspaceVolume = "kbo-integration-workspace-$suffix"
$dsn = "postgresql://kbo_test:kbo_integration_password@$containerName`:5432/kbo_test"

function Assert-NativeSuccess([string]$Action) {
  if ($LASTEXITCODE -ne 0) { throw "$Action 실패 (exit $LASTEXITCODE)" }
}

Push-Location $repositoryRoot
try {
  & docker network create $networkName
  Assert-NativeSuccess "integration network 생성"
  & docker volume create $workspaceVolume
  Assert-NativeSuccess "integration workspace volume 생성"
  & docker run -d --name $containerName --network $networkName `
    -e POSTGRES_USER=kbo_test `
    -e POSTGRES_PASSWORD=kbo_integration_password `
    -e POSTGRES_DB=kbo_test `
    postgres:16-bookworm
  Assert-NativeSuccess "PostgreSQL 16 integration container 생성"

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    & docker exec $containerName pg_isready -U kbo_test -d kbo_test *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "PostgreSQL 16 integration container가 준비되지 않았습니다." }

  & docker run --rm --network $networkName `
    -v "${repositoryRoot}:/source:ro" -v "${workspaceVolume}:/workspace" -w /workspace `
    -e PGHOST=$containerName -e PGPORT=5432 -e PGUSER=kbo_test `
    -e PGPASSWORD=kbo_integration_password -e PGDATABASE=kbo_test `
    -e EXPECTED_MIGRATION_VERSION=0004_pitch_metadata `
    -e MIGRATIONS_DIR=database/v3 `
    -e KBO_ANALYST_USER=kbo_analyst_test `
    -e KBO_ANALYST_PASSWORD=kbo_analyst_test_password `
    node:24-bookworm sh -lc "tar -C /source --exclude=.git --exclude=.data --exclude=.backups --exclude=.env --exclude=node_modules --exclude=dist -cf - . | tar -xf - && corepack enable >/dev/null && pnpm install --frozen-lockfile && pnpm build:server && node apps/server/dist/migrate.js"
  Assert-NativeSuccess "integration migration"

  & docker run --rm --network $networkName `
    -v "${workspaceVolume}:/workspace" -w /workspace `
    -e KBO_TEST_POSTGRES_DSN=$dsn `
    node:24-bookworm sh -lc "corepack enable >/dev/null && pnpm exec vitest run tests/persistence/postgres-revision-store.test.ts tests/persistence/postgres-pitch-metadata.test.ts"
  Assert-NativeSuccess "PostgreSQL integration test"
}
finally {
  & docker rm -f $containerName 2>$null
  & docker network rm $networkName 2>$null
  & docker volume rm $workspaceVolume 2>$null
  Pop-Location
}
