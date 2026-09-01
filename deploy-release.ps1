param(
  [string]$Server = "162.35.162.136",
  [string]$User = "root",
  [string]$Archive = (Join-Path $PSScriptRoot "deploy\fgp-release.tar.gz"),
  [string]$GitRemote = "origin",
  [string]$GitCommitMessage = "",
  [switch]$SkipGitPublish
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  & git -C $PSScriptRoot @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $($Arguments -join ' ')"
  }
}

function Publish-GitRelease {
  if ($SkipGitPublish) {
    Write-Warning "GitHub publishing was explicitly skipped for this deployment."
    return
  }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required so the release can be committed and pushed before deployment."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot ".git"))) {
    throw "The deployment folder is not a Git working tree."
  }

  $branch = (& git -C $PSScriptRoot branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) {
    throw "Deployments require a named Git branch; detached HEAD is not supported."
  }

  Write-Host "Checking GitHub branch $GitRemote/$branch"
  Invoke-Git fetch --prune $GitRemote $branch

  & git -C $PSScriptRoot show-ref --verify --quiet "refs/remotes/$GitRemote/$branch"
  $remoteBranchExists = $LASTEXITCODE -eq 0
  if ($remoteBranchExists) {
    & git -C $PSScriptRoot merge-base --is-ancestor "$GitRemote/$branch" HEAD
    if ($LASTEXITCODE -ne 0) {
      throw "Local $branch is behind or has diverged from $GitRemote/$branch. Reconcile it before deploying; no force-push will be attempted."
    }
  }

  # Commit only source and operational files that form the release. Local
  # diagnostics and one-off patch helpers at the repository root stay local.
  $releasePaths = @(
    ".env.example",
    ".gitignore",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "apps",
    "deploy",
    "eslint.config.js",
    "package.json",
    "packages",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts",
    "tests",
    "tsconfig.base.json",
    "vitest.config.ts",
    "deploy-release.ps1",
    "DEPLOY-FGP.cmd",
    "DEPLOY-CORRECTED-RELEASE.cmd",
    "deploy-now.cmd",
    "run-deploy-interactive.ps1"
  ) | Where-Object { Test-Path -LiteralPath (Join-Path $PSScriptRoot $_) }

  Invoke-Git add -- @releasePaths
  & git -C $PSScriptRoot diff --cached --quiet --exit-code
  if ($LASTEXITCODE -ne 0) {
    $message = $GitCommitMessage
    if ([string]::IsNullOrWhiteSpace($message)) {
      $message = "Deploy FGP " + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss 'UTC'")
    }
    Invoke-Git commit -m $message
  }
  else {
    Write-Host "No new release source changes to commit."
  }

  Invoke-Git push $GitRemote "HEAD:$branch"
  $releaseCommit = (& git -C $PSScriptRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Could not resolve the Git commit selected for deployment."
  }
  Write-Host "GitHub release commit: $releaseCommit"
}

$resolvedArchive = (Resolve-Path -LiteralPath $Archive).Path
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$archiveStream = [System.IO.File]::OpenRead($resolvedArchive)
try {
  $archiveHash = ([System.BitConverter]::ToString($sha256.ComputeHash($archiveStream))).Replace("-", "").ToLowerInvariant()
}
finally {
  $archiveStream.Dispose()
  $sha256.Dispose()
}
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$remoteArchive = "/tmp/fgp-release-$stamp.tar.gz"
$outputDirectory = Join-Path $PSScriptRoot "outputs"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$log = Join-Path $outputDirectory "deploy-release-$stamp.log"

Publish-GitRelease

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
release_replaced=0
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
    if [ "$release_replaced" -ne 1 ]; then
      echo "Preflight failed before service replacement and the live release is untouched."
      exit "$exit_code"
    fi
    systemctl stop fgp-haze-notifier.service fgp-api.service fgp-scraper.service || true
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
install -m 0644 "$current/deploy/fgp-haze-notifier.service" /etc/systemd/system/fgp-haze-notifier.service
      install -m 0644 "$current/deploy/Caddyfile" /etc/caddy/Caddyfile
      systemctl daemon-reload
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true
      systemctl reload caddy || true
      systemctl start fgp-scraper.service fgp-api.service fgp-haze-notifier.service || true
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

if [ ! -d "$current" ]; then
  recovery_source="$(find /opt -maxdepth 1 -mindepth 1 -type d \( -name 'fgp-failed-*' -o -name 'fgp-rollback-*' \) -printf '%T@ %p\n' 2>/dev/null | sort -nr | sed -n '1s/^[^ ]* //p')"
  if [ -z "$recovery_source" ] || [ ! -d "$recovery_source" ]; then
    echo "No recoverable FGP release was found."
    exit 1
  fi
  echo "Recovering saved release from $recovery_source before deployment."
  mv "$recovery_source" "$current"
fi
test -d "$current"
test ! -e "$previous"
install -d -m 0750 "$backup_dir"

# This release changes the requested standard LZT alert ceiling to USD 5.00.
# Preserve all existing secrets and settings while updating only this value.
if grep -q '^LZT_NOTIFY_BELOW_USD=' /etc/fgp/fgp.env; then
  sed -i 's/^LZT_NOTIFY_BELOW_USD=.*/LZT_NOTIFY_BELOW_USD=5.00/' /etc/fgp/fgp.env
else
  printf '\nLZT_NOTIFY_BELOW_USD=5.00\n' >>/etc/fgp/fgp.env
fi

# Raise the former 60-request discovery ceiling only when the installation is
# still using that legacy default. Preserve any deliberate custom limit.
if grep -q '^BRAVE_MAX_REQUESTS=60$' /etc/fgp/fgp.env; then
  sed -i 's/^BRAVE_MAX_REQUESTS=60$/BRAVE_MAX_REQUESTS=300/' /etc/fgp/fgp.env
elif ! grep -q '^BRAVE_MAX_REQUESTS=' /etc/fgp/fgp.env; then
  printf '\nBRAVE_MAX_REQUESTS=300\n' >>/etc/fgp/fgp.env
fi
if ! grep -q '^BRAVE_SEARCH_CONCURRENCY=' /etc/fgp/fgp.env; then
  printf 'BRAVE_SEARCH_CONCURRENCY=3\n' >>/etc/fgp/fgp.env
fi

# Move installations that still use the original synchronous Discord checker
# limits to the background job's safer defaults. Preserve deliberate custom
# values set by the operator.
if grep -q '^DISCORD_INVITE_RECONCILE_CONCURRENCY=3$' /etc/fgp/fgp.env; then
  sed -i 's/^DISCORD_INVITE_RECONCILE_CONCURRENCY=3$/DISCORD_INVITE_RECONCILE_CONCURRENCY=2/' /etc/fgp/fgp.env
elif ! grep -q '^DISCORD_INVITE_RECONCILE_CONCURRENCY=' /etc/fgp/fgp.env; then
  printf 'DISCORD_INVITE_RECONCILE_CONCURRENCY=2\n' >>/etc/fgp/fgp.env
fi
if grep -q '^DISCORD_INVITE_RECONCILE_DEADLINE_MS=45000$' /etc/fgp/fgp.env; then
  sed -i 's/^DISCORD_INVITE_RECONCILE_DEADLINE_MS=45000$/DISCORD_INVITE_RECONCILE_DEADLINE_MS=600000/' /etc/fgp/fgp.env
elif ! grep -q '^DISCORD_INVITE_RECONCILE_DEADLINE_MS=' /etc/fgp/fgp.env; then
  printf 'DISCORD_INVITE_RECONCILE_DEADLINE_MS=600000\n' >>/etc/fgp/fgp.env
fi

# Read only the database setting needed by the deployment. Do not execute the
# environment file as shell code; systemd's EnvironmentFile syntax may contain
# a malformed legacy line that the running services safely ignore.
database_record="$(grep -E '^DATABASE_URL=' /etc/fgp/fgp.env | tail -n 1)"
if [ -z "$database_record" ]; then
  echo "DATABASE_URL is missing from /etc/fgp/fgp.env."
  exit 1
fi
DATABASE_URL="${database_record#DATABASE_URL=}"
export DATABASE_URL
db_path="${DATABASE_URL#file:}"

systemctl stop fgp-haze-notifier.service fgp-api.service fgp-scraper.service || true
services_stopped=1

if [ -f "$db_path" ]; then
  cp --preserve=mode,timestamps "$db_path" "$backup_dir/pre-deploy-$stamp.db"
fi

mv "$current" "$previous"
release_replaced=1
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
node apps/server/scripts/ensure-lzt-metric-bigints.mjs
pnpm run db:push
pnpm run build

install -m 0644 "$current/deploy/fgp-api.service" /etc/systemd/system/fgp-api.service
install -m 0644 "$current/deploy/fgp-scraper.service" /etc/systemd/system/fgp-scraper.service
install -m 0644 "$current/deploy/fgp-haze-notifier.service" /etc/systemd/system/fgp-haze-notifier.service
install -m 0644 "$current/deploy/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl enable fgp-haze-notifier.service
systemctl reload caddy
systemctl start fgp-scraper.service fgp-api.service fgp-haze-notifier.service
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
if grep -Eq '^HAZE_LZT_NOTIFICATIONS_ENABLED=true([[:space:]]|$)' /etc/fgp/fgp.env; then
  systemctl is-active --quiet fgp-haze-notifier.service
fi

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
