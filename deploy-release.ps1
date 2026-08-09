param(
  [string]$Server = "162.35.162.136",
  [string]$User = "root",
  [string]$Archive = (Join-Path $PSScriptRoot "deploy\fgp-release.tar.gz")
)

$ErrorActionPreference = "Stop"

$resolvedArchive = (Resolve-Path -LiteralPath $Archive).Path
$archiveHash = (Get-FileHash -LiteralPath $resolvedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$remoteArchive = "/tmp/fgp-release-$stamp.tar.gz"
$log = Join-Path $PSScriptRoot "outputs\deploy-release-$stamp.log"

Write-Host "Uploading verified release $archiveHash"
& scp -- $resolvedArchive "${User}@${Server}:$remoteArchive"
if ($LASTEXITCODE -ne 0) {
  throw "Upload failed. The server was not changed."
}

$remoteTemplate = @'
set -Eeuo pipefail

archive="__REMOTE_ARCHIVE__"
expected_sha="__ARCHIVE_HASH__"
stamp="__STAMP__"
current="/opt/fgp"
previous="/opt/fgp-rollback-$stamp"
failed="/opt/fgp-failed-$stamp"
preflight="/tmp/fgp-preflight-$stamp"
backup_dir="/var/backups/fgp"
services_stopped=0
initial_services_healthy=0
if systemctl is-active --quiet fgp-api.service && systemctl is-active --quiet fgp-scraper.service; then
  initial_services_healthy=1
fi
emergency_previous="$(find /opt -maxdepth 1 -mindepth 1 -type d -name 'fgp-rollback-*' -printf '%T@ %p\n' 2>/dev/null | sort -nr | sed -n '1s/^[^ ]* //p')"

rollback() {
  exit_code=$?
  trap - ERR
  set +e
  if [ "$exit_code" -ne 0 ]; then
    rm -rf -- "$preflight"
    echo "Deployment failed - restoring the previous release."
    systemctl stop fgp-api.service fgp-scraper.service || true
    if [ -d "$current" ]; then
      mv "$current" "$failed"
    fi
    restore_source="$previous"
    if [ "$initial_services_healthy" -ne 1 ] && [ -n "$emergency_previous" ] && [ -d "$emergency_previous" ]; then
      restore_source="$emergency_previous"
    fi
    if [ -d "$restore_source" ]; then
      if [ -d "$failed/apps/scraper/.venv" ] && [ ! -e "$restore_source/apps/scraper/.venv" ]; then
        mkdir -p "$restore_source/apps/scraper"
        mv "$failed/apps/scraper/.venv" "$restore_source/apps/scraper/.venv"
      fi
      mv "$restore_source" "$current"
      install -m 0644 "$current/deploy/fgp-api.service" /etc/systemd/system/fgp-api.service
      install -m 0644 "$current/deploy/fgp-scraper.service" /etc/systemd/system/fgp-scraper.service
      install -m 0644 "$current/deploy/Caddyfile" /etc/caddy/Caddyfile
      systemctl daemon-reload
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true
      systemctl reload caddy || true
      systemctl start fgp-scraper.service fgp-api.service || true
    fi
  fi
  exit "$exit_code"
}
trap rollback ERR

actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "Release checksum mismatch."
  exit 1
fi

# Validate the exact workspace/lockfile combination before stopping the live
# services. This catches package-manager configuration drift without downtime.
install -d -m 0755 "$preflight"
tar -xzf "$archive" -C "$preflight"
cd "$preflight"
pnpm install --frozen-lockfile --lockfile-only --ignore-scripts
cd /
rm -rf -- "$preflight"

test -d "$current"
test ! -e "$previous"
install -d -m 0750 "$backup_dir"

set -a
. /etc/fgp/fgp.env
set +a
db_path="${DATABASE_URL#file:}"

systemctl stop fgp-api.service fgp-scraper.service
services_stopped=1

if [ -f "$db_path" ]; then
  cp --preserve=mode,timestamps "$db_path" "$backup_dir/pre-deploy-$stamp.db"
fi

mv "$current" "$previous"
install -d -m 0755 "$current"
tar -xzf "$archive" -C "$current"

if [ -d "$previous/apps/scraper/.venv" ]; then
  mkdir -p "$current/apps/scraper"
  mv "$previous/apps/scraper/.venv" "$current/apps/scraper/.venv"
fi

chown -R fgp:fgp "$current"
cd "$current"
pnpm install --frozen-lockfile --prod=false
pnpm run db:generate
pnpm run db:push
pnpm run build

install -m 0644 "$current/deploy/fgp-api.service" /etc/systemd/system/fgp-api.service
install -m 0644 "$current/deploy/fgp-scraper.service" /etc/systemd/system/fgp-scraper.service
install -m 0644 "$current/deploy/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl reload caddy
systemctl start fgp-scraper.service fgp-api.service
services_stopped=0

healthy=0
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3001/api/health >/tmp/fgp-health-$stamp.json; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  systemctl --no-pager --full status fgp-api.service fgp-scraper.service || true
  journalctl -u fgp-api.service -u fgp-scraper.service -n 100 --no-pager || true
  exit 1
fi

curl -fsS https://forhud.shop/api/health >/tmp/fgp-public-health-$stamp.json
cat /tmp/fgp-health-$stamp.json
printf '\n'
cat /tmp/fgp-public-health-$stamp.json
printf '\n'
systemctl is-active --quiet fgp-api.service
systemctl is-active --quiet fgp-scraper.service

rm -f "$archive" /tmp/fgp-health-$stamp.json /tmp/fgp-public-health-$stamp.json
echo "FGP_DEPLOYMENT_OK rollback=$previous database_backup=$backup_dir/pre-deploy-$stamp.db"
'@

$remote = $remoteTemplate.Replace("__REMOTE_ARCHIVE__", $remoteArchive).Replace("__ARCHIVE_HASH__", $archiveHash).Replace("__STAMP__", $stamp).Replace("`r", "")

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & ssh "${User}@${Server}" $remote 2>&1 | Tee-Object -FilePath $log
  $sshExit = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $previousPreference
}

if ($sshExit -ne 0) {
  throw "Deployment failed or was rolled back. Full log: $log"
}

Write-Host "Deployment completed. Full log: $log"
