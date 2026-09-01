$ErrorActionPreference = "Continue"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$log = Join-Path $PSScriptRoot "outputs\deploy-launcher-$stamp.log"

Start-Transcript -Path $log -Force
try {
  Write-Host "FGP verified release deployment" -ForegroundColor Cyan
  Write-Host "Enter the VPS root password when prompted." -ForegroundColor Yellow
  & (Join-Path $PSScriptRoot "deploy-release.ps1")
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Deployment exited with code $LASTEXITCODE." -ForegroundColor Red
  }
} catch {
  Write-Host $_ -ForegroundColor Red
} finally {
  Stop-Transcript
}

Write-Host "Leave this window open for verification." -ForegroundColor Green
Read-Host "Press Enter to close"
