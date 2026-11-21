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
