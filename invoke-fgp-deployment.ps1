$ErrorActionPreference = "Stop"
$mutexName = "Local\FGP.Forhud.Deployment"
$deploymentMutex = [System.Threading.Mutex]::new($false, $mutexName)
$lockAcquired = $false
$exitCode = 0

function Invoke-ReleaseBuild {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if ($node -and $pnpm) {
    & $pnpm.Source run release:build
    if ($LASTEXITCODE -ne 0) {
      throw "Release build failed. Nothing was committed or deployed."
    }
    return
  }

  $wrapperCandidates = @(
    (Join-Path $PSScriptRoot "..\..\recovery-installers\Run-With-FgpTools.cmd")
  )
  if ($env:USERPROFILE) {
    $wrapperCandidates += Join-Path $env:USERPROFILE "Documents\Codex\recovery-installers\Run-With-FgpTools.cmd"
  }

  $toolWrapper = $null
  foreach ($candidate in $wrapperCandidates) {
    if (Test-Path -LiteralPath $candidate) {
      $toolWrapper = (Resolve-Path -LiteralPath $candidate).Path
      break
    }
  }
  if (-not $toolWrapper) {
    throw "Node.js is unavailable and the restored FGP tool wrapper was not found."
  }

  & $toolWrapper pnpm run release:build
  if ($LASTEXITCODE -ne 0) {
    throw "Release build failed. Nothing was committed or deployed."
  }
}

try {
  try {
    $lockAcquired = $deploymentMutex.WaitOne(0)
  }
  catch [System.Threading.AbandonedMutexException] {
    $lockAcquired = $true
  }

  if (-not $lockAcquired) {
    Write-Host "Another FGP deployment is already running. Close or finish that window before retrying." -ForegroundColor Yellow
    $exitCode = 73
  }
  else {
    Invoke-ReleaseBuild
    & (Join-Path $PSScriptRoot "deploy-release.ps1")
    if ($LASTEXITCODE -ne 0) {
      throw "Deployment exited with code $LASTEXITCODE."
    }
  }
}
catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  $exitCode = 1
}
finally {
  if ($lockAcquired) {
    $deploymentMutex.ReleaseMutex()
  }
  $deploymentMutex.Dispose()
}

exit $exitCode
