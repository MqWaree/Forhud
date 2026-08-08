param(
  [string]$Server = "162.35.162.136",
  [string]$User = "root"
)

$ErrorActionPreference = "Stop"
$log = Join-Path $PSScriptRoot "outputs\deploy-scanner-reliability.log"
$archive = Join-Path $PSScriptRoot "outputs\fgp-scanner-reliability-v3.tar.gz"
if (-not (Test-Path -LiteralPath $archive)) {
  throw "Scanner update archive is missing: $archive"
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & scp $archive "${User}@${Server}:/tmp/fgp-scanner-reliability-v3.tar.gz"
  $uploadExit = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
if ($uploadExit -ne 0) {
  throw "Could not upload the scanner speed update."
}

$remote = @'
set -e
cd /opt/fgp
tar -xzf /tmp/fgp-scanner-reliability-v3.tar.gz
set -a
. /etc/fgp/fgp.env
set +a
pnpm run db:generate
pnpm run build -w @lead/server
systemctl daemon-reload
systemctl restart fgp-scraper.service fgp-api.service
healthy=0
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3001/api/health; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  echo "FGP API did not become healthy within 60 seconds."
  systemctl --no-pager --full status fgp-api.service fgp-scraper.service || true
  journalctl -u fgp-api.service -u fgp-scraper.service -n 100 --no-pager || true
  exit 1
fi
set +e
AUDIT_CONCURRENCY=6 pnpm run audit:discord-discovery
audit_exit=$?
set -e
if [ -f outputs/discord-discovery-final-summary.json ]; then
  cat outputs/discord-discovery-final-summary.json
else
  echo "Audit summary was not generated."
fi
exit "$audit_exit"
'@

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & ssh "${User}@${Server}" $remote 2>&1 | Tee-Object -FilePath $log
  $sshExit = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $previousErrorActionPreference
}

if ($sshExit -ne 0) {
  throw "Remote audit failed. Full log: $log"
}

$reportDirectory = Join-Path $PSScriptRoot "outputs\vps-audit"
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & scp "${User}@${Server}:/opt/fgp/outputs/discord-discovery-final*" "$reportDirectory\"
  $reportExit = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
if ($reportExit -ne 0) {
  throw "Audit completed, but its detailed reports could not be downloaded."
}
Write-Output "Detailed audit reports downloaded to $reportDirectory"
