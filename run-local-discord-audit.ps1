param(
  [int]$Concurrency = 8,
  [string]$InputPath = "tests\fixtures\known-positive-discord-sites.txt",
  [string]$OutputName = "discord-discovery-local"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$outputs = Join-Path $root "outputs"
$python = Join-Path $root "apps\scraper\.venv\Scripts\python.exe"
$inputFile = if ([System.IO.Path]::IsPathRooted($InputPath)) {
  $InputPath
} else {
  Join-Path $root $InputPath
}
$safeOutputName = [System.IO.Path]::GetFileNameWithoutExtension($OutputName)
$outputStem = Join-Path $outputs $safeOutputName
$auditLog = Join-Path $outputs "$safeOutputName.log"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$scraperOut = Join-Path $outputs "local-scraper-$timestamp.out.log"
$scraperErr = Join-Path $outputs "local-scraper-$timestamp.err.log"

New-Item -ItemType Directory -Force -Path $outputs | Out-Null
if (-not (Test-Path -LiteralPath $python)) {
  throw "Local Scrapling environment is missing. Run the scraper setup first."
}
if (-not (Test-Path -LiteralPath $inputFile)) {
  throw "Known-positive dataset is missing: $inputFile"
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) {
  $nodeCommand.Source
} else {
  Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}
if (-not (Test-Path -LiteralPath $node)) { throw "Node.js was not found." }
$env:PATH = "$(Split-Path -Parent $node);$($env:PATH)"
$portProbe = [System.Net.Sockets.TcpListener]::new(
  [System.Net.IPAddress]::Loopback,
  0
)
$portProbe.Start()
$scraperPort = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port
$portProbe.Stop()
$env:SCRAPER_URL = "http://127.0.0.1:$scraperPort"
$env:SCRAPER_PORT = [string]$scraperPort
$env:SCRAPER_TOKEN = "aether-dev-local-worker"
$env:AUDIT_CONCURRENCY = [string][Math]::Max(1, [Math]::Min(8, $Concurrency))

Push-Location $root
$startedScraper = $false
$scraperProcess = $null
$scraperStdoutTask = $null
$scraperStderrTask = $null
try {
  & $node `
    "node_modules/prisma/build/index.js" `
    generate `
    --schema "apps/server/prisma/schema.prisma"
  if ($LASTEXITCODE -ne 0) { throw "Prisma generation failed." }
  & $node "node_modules/typescript/bin/tsc" -p "apps/server/tsconfig.json"
  if ($LASTEXITCODE -ne 0) { throw "Server TypeScript build failed." }
  & $node "apps/server/scripts/copy-prisma-engine.mjs"
  if ($LASTEXITCODE -ne 0) { throw "Server build failed." }

  $headers = @{ Authorization = "Bearer $($env:SCRAPER_TOKEN)" }
  $healthy = $false
  # PowerShell 5.1 can expose both Path and PATH after Codex runtime setup.
  # Start-Process rejects that duplicate environment even though Windows treats
  # the names case-insensitively. Build a clean, case-insensitive environment
  # for the worker so unattended audits start consistently.
  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = $python
  $processInfo.Arguments = '-m apps.scraper.src.service'
  $processInfo.WorkingDirectory = $root
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $cleanEnvironment = @{}
  [System.Environment]::GetEnvironmentVariables().GetEnumerator() | ForEach-Object {
    $cleanEnvironment[[string]$_.Key.ToUpperInvariant()] = [string]$_.Value
  }
  if ($null -ne $processInfo.EnvironmentVariables) {
    $processInfo.EnvironmentVariables.Clear()
    foreach ($entry in $cleanEnvironment.GetEnumerator()) {
      $processInfo.EnvironmentVariables[$entry.Key] = $entry.Value
    }
  }
  elseif ($null -ne $processInfo.Environment) {
    $processInfo.Environment.Clear()
    foreach ($entry in $cleanEnvironment.GetEnumerator()) {
      $processInfo.Environment[$entry.Key] = $entry.Value
    }
  }
  else {
    throw 'Unable to construct a clean worker environment.'
  }
  $scraperProcess = [System.Diagnostics.Process]::new()
  $scraperProcess.StartInfo = $processInfo
  [void]$scraperProcess.Start()
  $scraperStdoutTask = $scraperProcess.StandardOutput.ReadToEndAsync()
  $scraperStderrTask = $scraperProcess.StandardError.ReadToEndAsync()
  $startedScraper = $true
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
      $health = Invoke-RestMethod -Uri "$($env:SCRAPER_URL)/internal/health" -Headers $headers -TimeoutSec 2
      if ($health.ok) {
        $healthy = $true
        break
      }
    }
    catch {
      $healthy = $false
    }
  }
  if (-not $healthy) {
    throw "Local scraper did not become healthy. See $scraperErr"
  }

  $targetCount = @(Get-Content -LiteralPath $inputFile | Where-Object { $_.Trim() }).Count
  Write-Output "Running local $targetCount-domain audit with $($env:AUDIT_CONCURRENCY) workers..."
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $node `
      "apps/server/scripts/discord-discovery-audit.mjs" `
      $inputFile `
      $outputStem `
      2>&1 | Tee-Object -FilePath $auditLog
    $auditExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($auditExit -ne 0) {
    throw "Local audit failed. Full log: $auditLog"
  }
  Write-Output "Local audit complete. Detailed reports: $outputStem.json and $outputStem.csv"
}
finally {
  if ($startedScraper -and $scraperProcess -and -not $scraperProcess.HasExited) {
    Stop-Process -Id $scraperProcess.Id
    $scraperProcess.WaitForExit()
  }
  if ($scraperStdoutTask) {
    [System.IO.File]::WriteAllText($scraperOut, $scraperStdoutTask.GetAwaiter().GetResult())
  }
  if ($scraperStderrTask) {
    [System.IO.File]::WriteAllText($scraperErr, $scraperStderrTask.GetAwaiter().GetResult())
  }
  Pop-Location
}
