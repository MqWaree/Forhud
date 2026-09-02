#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo "Run the deployment transaction as root."
  exit 1
fi
if [ "$#" -ne 4 ]; then
  echo "Usage: $0 <archive> <sha256> <stamp> <commit>"
  exit 1
fi

archive="$1"
expected_sha="$2"
stamp="$3"
expected_commit="$4"
upload_dir="$(dirname -- "$archive")"
if [[ ! "$upload_dir" =~ ^/tmp/fgp-upload\.[A-Za-z0-9]+$ ]] || \
  [ -L "$upload_dir" ] || \
  [ "$(stat -c '%U:%G:%a' "$upload_dir")" != "root:root:700" ]; then
  echo "Deployment upload directory is unsafe."
  exit 1
fi
if [ "$(basename -- "$archive")" != "fgp-release.tar.gz" ] || \
  [ ! -f "$archive" ] || [ -L "$archive" ] || \
  [ "$(stat -c '%U:%h' "$archive")" != "root:1" ]; then
  echo "Deployment archive is unsafe."
  exit 1
fi
if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || \
  [[ ! "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || \
  [[ ! "$stamp" =~ ^[0-9]{8}-[0-9]{6}$ ]]; then
  echo "Deployment metadata is invalid."
  exit 1
fi

install -d -o root -g root -m 0700 /run/fgp-maintenance
if [ -L /run/fgp-maintenance ] || \
  [ "$(stat -c '%U:%G:%a' /run/fgp-maintenance)" != "root:root:700" ]; then
  echo "Maintenance lock directory is unsafe."
  exit 1
fi
exec 8>/run/fgp-maintenance/maintenance.lock
chmod 0600 /run/fgp-maintenance/maintenance.lock
if ! flock -n 8; then
  echo "Another FGP deployment or recovery operation is active."
  exit 1
fi

current="/opt/fgp"
previous="/opt/fgp-rollback-$stamp"
failed="/opt/fgp-failed-$stamp"
candidate_marker=".fgp-deployment-candidate-$stamp"
backup_dir="/var/backups/fgp"
operator_backup_dir="/var/backups/fgp-operator"
state_directory="/var/lib/fgp"
preflight=""
config_backup=""
environment_work=""
venv_home=""
scraper_build_source=""
database_path=""
database_backup=""
database_existed=0
database_mutated=0
state_locked=0
services_managed=0
configuration_changed=0
deployment_complete=0
transaction_committed=0
launch_barrier=0
cron_service=""
atd_service=""
user_manager_masked=0
probe_override="/run/systemd/system/fgp-api.service.d/maintenance-probe.conf"
haze_enabled=0
haze_unit_was_enabled=0

unquote() {
  local value="$1"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

exchange_directories() {
  python3 - "$1" "$2" <<'PY'
import ctypes
import os
import sys

left, right = (value.encode() for value in sys.argv[1:])
libc = ctypes.CDLL(None, use_errno=True)
if not hasattr(libc, "renameat2"):
    raise OSError("renameat2 is unavailable")
libc.renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
libc.renameat2.restype = ctypes.c_int
if libc.renameat2(-100, left, -100, right, 2) != 0:
    errno = ctypes.get_errno()
    raise OSError(errno, os.strerror(errno))
PY
}

install_configuration_file() {
  local source="$1" destination="$2" mode="$3" directory temporary
  directory="$(dirname -- "$destination")" || return 1
  temporary="$(mktemp "$directory/.fgp-install.XXXXXX")" || return 1
  install -o root -g root -m "$mode" "$source" "$temporary" || return 1
  sync -f "$temporary" || return 1
  mv -f -- "$temporary" "$destination" || return 1
  sync -f "$directory" || return 1
}

assert_root_path() {
  local path="$1"
  if [ ! -e "$path" ] || [ -L "$path" ] || \
    [ "$(stat -c '%U' "$path")" != "root" ]; then
    return 1
  fi
  local permissions
  permissions=$((8#$(stat -c '%a' "$path")))
  (( (permissions & 0022) == 0 ))
}

assert_sqlite_artifacts() {
  local base="$1"
  local require_main="${2:-1}"
  local suffix path
  for suffix in "" -journal -wal -shm; do
    path="$base$suffix"
    if [ -L "$path" ]; then return 1; fi
    if [ -e "$path" ]; then
      if [ ! -f "$path" ] || [ "$(stat -c '%h' "$path")" -ne 1 ]; then
        return 1
      fi
    elif [ -z "$suffix" ] && [ "$require_main" -eq 1 ]; then
      return 1
    fi
  done
}

remove_sqlite_sidecars() {
  rm -f -- "$1-journal" "$1-wal" "$1-shm"
}

lock_state_directory() {
  if [ "$launch_barrier" -ne 1 ] || [ ! -d "$state_directory" ] || [ -L "$state_directory" ]; then
    return 1
  fi
  state_locked=1
}

unlock_state_directory() {
  if [ "$state_locked" -ne 1 ]; then return 0; fi
  state_locked=0
}

activate_launch_barrier() {
  local fgp_uid fgp_shell unit
  fgp_uid="$(id -u fgp)" || return 1
  fgp_shell="$(getent passwd fgp | awk -F: '{print $7}')"
  case "$fgp_shell" in
    */nologin|*/false) ;;
    *) echo "The fgp service account must use a non-login shell."; return 1 ;;
  esac
  loginctl terminate-user fgp >/dev/null 2>&1 || true
  systemctl mask --runtime "user@$fgp_uid.service" >/dev/null || return 1
  user_manager_masked=1
  for unit in cron.service crond.service; do
    if systemctl is-active --quiet "$unit"; then
      cron_service="$unit"
      systemctl stop "$unit" || return 1
      break
    fi
  done
  if systemctl is-active --quiet atd.service; then
    atd_service="atd.service"
    systemctl stop "$atd_service" || return 1
  fi
  launch_barrier=1
}

deactivate_launch_barrier() {
  local fgp_uid
  fgp_uid="$(id -u fgp)" || return 1
  if [ "$user_manager_masked" -eq 1 ]; then
    systemctl unmask --runtime "user@$fgp_uid.service" >/dev/null || return 1
    user_manager_masked=0
  fi
  if [ -n "$cron_service" ]; then
    systemctl start "$cron_service" || return 1
    cron_service=""
  fi
  if [ -n "$atd_service" ]; then
    systemctl start "$atd_service" || return 1
    atd_service=""
  fi
  launch_barrier=0
}

quiesce_fgp_uid() {
  if pgrep -u fgp >/dev/null 2>&1; then
    pkill -KILL -u fgp >/dev/null 2>&1 || true
    sleep 1
  fi
  ! pgrep -u fgp >/dev/null 2>&1
}

quiesce_services() {
  systemctl stop caddy.service fgp-haze-notifier.service fgp-api.service fgp-scraper.service || return 1
  quiesce_fgp_uid
}

health_is_ready() {
  local expected_probe="${1:-false}" response
  response="$(curl --connect-timeout 2 --max-time 5 -fsS http://127.0.0.1:3001/api/health)" || return 1
  HEALTH_RESPONSE="$response" EXPECTED_PROBE="$expected_probe" node -e '
    const health = JSON.parse(process.env.HEALTH_RESPONSE);
    if (health.ok !== true || health.database !== "connected" ||
        health.sharedFiles?.healthy === false || health.scraper?.healthy !== true ||
        Boolean(health.maintenanceProbe) !== (process.env.EXPECTED_PROBE === "true"))
      process.exit(1);
  '
}

wait_for_core_health() {
  local expected_probe="${1:-false}" attempt
  for attempt in $(seq 1 30); do
    if systemctl is-active --quiet fgp-scraper.service && \
      systemctl is-active --quiet fgp-api.service && health_is_ready "$expected_probe"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

enable_maintenance_probe() {
  local directory temporary
  directory="$(dirname -- "$probe_override")"
  install -d -o root -g root -m 0755 "$directory" || return 1
  if [ -L "$probe_override" ]; then return 1; fi
  temporary="$(mktemp "$directory/.maintenance-probe.XXXXXX")" || return 1
  printf '[Service]\nEnvironment=FGP_MAINTENANCE_PROBE=true\n' >"$temporary" || return 1
  chmod 0644 "$temporary" || return 1
  sync -f "$temporary" || return 1
  mv -f -- "$temporary" "$probe_override" || return 1
  sync -f "$directory" || return 1
  systemctl daemon-reload || return 1
}

disable_maintenance_probe() {
  local directory
  directory="$(dirname -- "$probe_override")"
  rm -f -- "$probe_override" || return 1
  rmdir -- "$directory" >/dev/null 2>&1 || true
  sync -f /run/systemd/system || return 1
  systemctl daemon-reload || return 1
}

start_probe_services() {
  enable_maintenance_probe || return 1
  systemctl start fgp-scraper.service || return 1
  systemctl start fgp-api.service || return 1
  wait_for_core_health true || return 1
  systemctl stop fgp-api.service fgp-scraper.service || return 1
  quiesce_fgp_uid || return 1
  disable_maintenance_probe
}

start_core_services() {
  disable_maintenance_probe || return 1
  systemctl start fgp-scraper.service || return 1
  systemctl start fgp-api.service || return 1
  wait_for_core_health
}

start_haze_service() {
  if [ "$haze_enabled" -eq 1 ]; then
    systemctl start fgp-haze-notifier.service || return 1
    sleep 2
    systemctl is-active --quiet fgp-haze-notifier.service || return 1
  else
    systemctl stop fgp-haze-notifier.service >/dev/null 2>&1 || true
  fi
}

start_ingress() {
  systemctl start caddy.service
}

restore_database() {
  if [ "$database_mutated" -ne 1 ]; then return 0; fi
  lock_state_directory || return 1
  if [ "$database_existed" -eq 1 ]; then
    if [ ! -f "$database_backup" ] || [ -L "$database_backup" ] || \
      [ "$(stat -c '%U:%h' "$database_backup")" != "root:1" ]; then
      return 1
    fi
    local restore_directory restore_database
    restore_directory="$(mktemp -d "$state_directory/.fgp-deploy-rollback-$stamp.XXXXXX")" || return 1
    chmod 0700 "$restore_directory" || return 1
    restore_database="$restore_directory/database.db"
    cp --reflink=auto -- "$database_backup" "$restore_database" || return 1
    chown fgp:fgp "$restore_database" || return 1
    chmod 0640 "$restore_database" || return 1
    sync -f "$restore_database" || return 1
    remove_sqlite_sidecars "$database_path" || return 1
    mv -- "$restore_database" "$database_path" || return 1
    rmdir -- "$restore_directory" || return 1
  else
    remove_sqlite_sidecars "$database_path" || return 1
    rm -f -- "$database_path" || return 1
  fi
  sync -f "$state_directory" || return 1
  database_mutated=0
}

restore_configuration() {
  if [ -z "$config_backup" ] || [ ! -d "$config_backup" ]; then return 0; fi
  install_configuration_file "$config_backup/fgp-api.service" /etc/systemd/system/fgp-api.service 0644 || return 1
  install_configuration_file "$config_backup/fgp-scraper.service" /etc/systemd/system/fgp-scraper.service 0644 || return 1
  install_configuration_file "$config_backup/fgp-haze-notifier.service" /etc/systemd/system/fgp-haze-notifier.service 0644 || return 1
  install_configuration_file "$config_backup/Caddyfile" /etc/caddy/Caddyfile 0644 || return 1
  local restored_environment
  restored_environment="$(mktemp /etc/fgp/fgp.env.rollback.XXXXXX)" || return 1
  cp --preserve=mode,ownership -- "$config_backup/fgp.env" "$restored_environment" || return 1
  sync -f "$restored_environment" || return 1
  mv -f -- "$restored_environment" /etc/fgp/fgp.env || return 1
  sync -f /etc/fgp || return 1
  systemctl daemon-reload || return 1
  if [ "$haze_unit_was_enabled" -eq 1 ]; then
    systemctl enable fgp-haze-notifier.service || return 1
  else
    systemctl disable fgp-haze-notifier.service || return 1
  fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || return 1
}

cleanup_temporary_paths() {
  if [ -n "$environment_work" ]; then rm -f -- "$environment_work"; fi
  if [ -n "$venv_home" ]; then rm -rf -- "$venv_home"; fi
  if [ -n "$preflight" ]; then
    rm -rf -- "$preflight"
    sync -f /opt || true
  fi
  if [ -n "$config_backup" ]; then
    rm -rf -- "$config_backup"
    sync -f /etc/fgp || true
  fi
  rm -rf -- "$upload_dir"
}

critical_recovery_failure() {
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  if [ "$services_managed" -eq 1 ]; then
    quiesce_services
    lock_state_directory
  fi
  disable_maintenance_probe || true
  deactivate_launch_barrier || true
  echo "CRITICAL: deployment rollback could not restore a healthy installation. FGP remains stopped."
  echo "Retained recovery artifacts: ${database_backup:-none} ${config_backup:-none} ${upload_dir:-none}"
  exit 1
}

finish() {
  local exit_code=$?
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  if [ "$deployment_complete" -eq 1 ] && [ "$exit_code" -eq 0 ]; then
    deactivate_launch_barrier || critical_recovery_failure
    cleanup_temporary_paths
    exit 0
  fi
  if [ "$exit_code" -eq 0 ]; then exit_code=1; fi
  if [ "$transaction_committed" -eq 1 ]; then
    echo "Deployment committed, but post-commit service verification failed; database rollback was not attempted."
    core_available=0
    if start_core_services; then
      core_available=1
      start_haze_service || true
    fi
    deactivate_launch_barrier || true
    if [ "$core_available" -eq 1 ]; then start_ingress || true; fi
    cleanup_temporary_paths
    exit "$exit_code"
  fi
  echo "Deployment failed; restoring the previous installation."
  if [ "$services_managed" -eq 1 ]; then
    quiesce_services || critical_recovery_failure
    lock_state_directory || critical_recovery_failure
  fi
  if [ ! -d "$previous" ] && [ -n "$preflight" ] && [ -d "$preflight" ] && \
    [ -f "$current/$candidate_marker" ]; then
    exchange_directories "$current" "$preflight" || critical_recovery_failure
    rm -f -- "$preflight/$candidate_marker" || critical_recovery_failure
    mv -- "$preflight" "$failed" || critical_recovery_failure
    preflight=""
    sync -f /opt || critical_recovery_failure
  fi
  if [ -d "$previous" ]; then
    if [ ! -d "$current" ] || [ -L "$current" ] || \
      [ -e "$failed" ] || [ -L "$failed" ]; then
      critical_recovery_failure
    fi
    exchange_directories "$current" "$previous" || critical_recovery_failure
    mv -- "$previous" "$failed" || critical_recovery_failure
    sync -f /opt || critical_recovery_failure
  fi
  if [ "$services_managed" -eq 1 ]; then
    restore_database || critical_recovery_failure
  fi
  if [ "$configuration_changed" -eq 1 ]; then
    restore_configuration || critical_recovery_failure
  fi
  if [ "$services_managed" -eq 1 ]; then
    quiesce_fgp_uid || critical_recovery_failure
    unlock_state_directory || critical_recovery_failure
    start_core_services || critical_recovery_failure
    start_haze_service || critical_recovery_failure
    deactivate_launch_barrier || critical_recovery_failure
    start_ingress || critical_recovery_failure
  else
    deactivate_launch_barrier || true
  fi
  echo "The previous installation was restored and passed health checks."
  cleanup_temporary_paths
  exit "$exit_code"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "Release checksum mismatch."
  exit 1
fi

if ! assert_root_path /opt; then
  echo "The release parent directory is not trusted."
  exit 1
fi
preflight="$(mktemp -d /opt/fgp-preflight-$stamp.XXXXXX)"
chmod 0700 "$preflight"
tar -xzf "$archive" -C "$preflight" --no-same-owner --no-same-permissions
if find "$preflight" -type l -print -quit | grep -q .; then
  echo "Release archives must not contain symlinks."
  exit 1
fi
node - "$preflight/RELEASE-METADATA.json" "$expected_commit" <<'NODE'
import { readFileSync } from "node:fs";
const [metadataPath, expectedCommit] = process.argv.slice(2);
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
if (metadata.policy !== "allowlisted-source-only" || metadata.sourceCommit !== expectedCommit)
  throw new Error("Release metadata does not match the published commit");
NODE
cd "$preflight"
pnpm install --frozen-lockfile --lockfile-only --ignore-scripts
cd /

if [ ! -d "$current" ]; then
  echo "The live release is missing. Select a specific root-owned rollback directory manually before deploying."
  exit 1
fi
if [ ! -d "$current" ] || [ -L "$current" ] || \
  [ -e "$previous" ] || [ -L "$previous" ] || \
  [ -e "$failed" ] || [ -L "$failed" ]; then
  echo "Release paths are unsafe."
  exit 1
fi

for trusted_path in \
  /etc /etc/fgp /etc/fgp/fgp.env \
  /etc/systemd /etc/systemd/system \
  /etc/systemd/system/fgp-api.service \
  /etc/systemd/system/fgp-scraper.service \
  /etc/systemd/system/fgp-haze-notifier.service \
  /etc/caddy /etc/caddy/Caddyfile; do
  if ! assert_root_path "$trusted_path"; then
    echo "Deployment refused an untrusted configuration path: $trusted_path"
    exit 1
  fi
done
if systemctl is-enabled --quiet fgp-haze-notifier.service; then
  haze_unit_was_enabled=1
fi

config_backup="$(mktemp -d /etc/fgp/.deploy-config-$stamp.XXXXXX)"
chmod 0700 "$config_backup"
install -m 0600 /etc/systemd/system/fgp-api.service "$config_backup/fgp-api.service"
install -m 0600 /etc/systemd/system/fgp-scraper.service "$config_backup/fgp-scraper.service"
install -m 0600 /etc/systemd/system/fgp-haze-notifier.service "$config_backup/fgp-haze-notifier.service"
install -m 0600 /etc/caddy/Caddyfile "$config_backup/Caddyfile"
cp --preserve=mode,ownership -- /etc/fgp/fgp.env "$config_backup/fgp.env"
sync -f "$config_backup"
sync -f /etc/fgp

if [ -L "$backup_dir" ]; then
  echo "The application backup directory must not be a symlink."
  exit 1
fi
install -d -o fgp -g fgp -m 0750 "$backup_dir"
install -d -o root -g root -m 0700 "$operator_backup_dir"
if [ -L "$operator_backup_dir" ] || \
  [ "$(stat -c '%U:%G:%a' "$operator_backup_dir")" != "root:root:700" ]; then
  echo "Operator backup directory permissions are unsafe."
  exit 1
fi
if [ ! -d "$state_directory" ] || [ -L "$state_directory" ]; then
  echo "The FGP state directory is not trusted."
  exit 1
fi

environment_work="$(mktemp /etc/fgp/fgp.env.XXXXXX)"
cp --preserve=mode,ownership -- /etc/fgp/fgp.env "$environment_work"
if grep -q '^LZT_NOTIFY_BELOW_USD=' "$environment_work"; then
  sed -i 's/^LZT_NOTIFY_BELOW_USD=.*/LZT_NOTIFY_BELOW_USD=5.00/' "$environment_work"
else
  printf '\nLZT_NOTIFY_BELOW_USD=5.00\n' >>"$environment_work"
fi
if grep -q '^BRAVE_MAX_REQUESTS=60$' "$environment_work"; then
  sed -i 's/^BRAVE_MAX_REQUESTS=60$/BRAVE_MAX_REQUESTS=300/' "$environment_work"
elif ! grep -q '^BRAVE_MAX_REQUESTS=' "$environment_work"; then
  printf '\nBRAVE_MAX_REQUESTS=300\n' >>"$environment_work"
fi
if ! grep -q '^BRAVE_SEARCH_CONCURRENCY=' "$environment_work"; then
  printf 'BRAVE_SEARCH_CONCURRENCY=3\n' >>"$environment_work"
fi
if grep -q '^DISCORD_INVITE_RECONCILE_CONCURRENCY=3$' "$environment_work"; then
  sed -i 's/^DISCORD_INVITE_RECONCILE_CONCURRENCY=3$/DISCORD_INVITE_RECONCILE_CONCURRENCY=2/' "$environment_work"
elif ! grep -q '^DISCORD_INVITE_RECONCILE_CONCURRENCY=' "$environment_work"; then
  printf 'DISCORD_INVITE_RECONCILE_CONCURRENCY=2\n' >>"$environment_work"
fi
if grep -q '^DISCORD_INVITE_RECONCILE_DEADLINE_MS=45000$' "$environment_work"; then
  sed -i 's/^DISCORD_INVITE_RECONCILE_DEADLINE_MS=45000$/DISCORD_INVITE_RECONCILE_DEADLINE_MS=600000/' "$environment_work"
elif ! grep -q '^DISCORD_INVITE_RECONCILE_DEADLINE_MS=' "$environment_work"; then
  printf 'DISCORD_INVITE_RECONCILE_DEADLINE_MS=600000\n' >>"$environment_work"
fi
file_link_record="$(grep -E '^FILE_LINK_SECRET=' "$environment_work" | tail -n 1 || true)"
file_link_secret="$(unquote "${file_link_record#FILE_LINK_SECRET=}")"
if [ "${#file_link_secret}" -lt 32 ] || \
  [ "$file_link_secret" = "replace-with-at-least-32-random-characters" ] || \
  [ "$file_link_secret" = "REPLACE_WITH_A_LONG_RANDOM_FILE_LINK_SECRET" ] || \
  [ "$file_link_secret" = "fgp-local-file-link-secret-for-development-only" ]; then
  generated_file_link_secret="$(openssl rand -hex 32)"
  if [[ ! "$generated_file_link_secret" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Secure FILE_LINK_SECRET generation failed."
    exit 1
  fi
  sed -i '/^FILE_LINK_SECRET=/d' "$environment_work"
  printf '\nFILE_LINK_SECRET=%s\n' "$generated_file_link_secret" >>"$environment_work"
  unset generated_file_link_secret
fi
unset file_link_record file_link_secret
sync -f "$environment_work"
configuration_changed=1
mv -f -- "$environment_work" /etc/fgp/fgp.env
environment_work=""
sync -f /etc/fgp

database_record="$(grep -E '^DATABASE_URL=' /etc/fgp/fgp.env | tail -n 1 || true)"
database_url="$(unquote "${database_record#DATABASE_URL=}")"
case "$database_url" in
  file:/var/lib/fgp/*.db) configured_database_path="${database_url#file:}" ;;
  *) echo "Deployment requires a SQLite database inside /var/lib/fgp."; exit 1 ;;
esac
if [ -L "$configured_database_path" ]; then
  echo "The configured database path must not be a symlink."
  exit 1
fi
database_path="$(readlink -m -- "$configured_database_path")"
if [ "$(dirname -- "$database_path")" != "$state_directory" ]; then
  echo "The configured database path is outside the approved state directory."
  exit 1
fi
export DATABASE_URL="$database_url"

storage_record="$(grep -E '^FILE_STORAGE_DIR=' /etc/fgp/fgp.env | tail -n 1 || true)"
if [ -n "$storage_record" ]; then
  configured_storage_path="$(unquote "${storage_record#FILE_STORAGE_DIR=}")"
else
  configured_storage_path="$state_directory/shared-files"
fi
if [ -L "$configured_storage_path" ]; then
  echo "Shared-file storage must not be a symlink."
  exit 1
fi
storage_path="$(readlink -m -- "$configured_storage_path")"
if [ "$(dirname -- "$storage_path")" != "$state_directory" ]; then
  echo "Shared-file storage must be directly inside the approved state directory."
  exit 1
fi

haze_record="$(grep -E '^HAZE_LZT_NOTIFICATIONS_ENABLED=' /etc/fgp/fgp.env | tail -n 1 || true)"
if [ "$(unquote "${haze_record#HAZE_LZT_NOTIFICATIONS_ENABLED=}")" = "true" ]; then
  haze_enabled=1
fi
browser_record="$(grep -E '^SCRAPER_BROWSER_EXECUTABLE=' /etc/fgp/fgp.env | tail -n 1 || true)"
browser_path="$(unquote "${browser_record#SCRAPER_BROWSER_EXECUTABLE=}")"
if [[ "$browser_path" != /* ]] || [ ! -x "$browser_path" ]; then
  echo "SCRAPER_BROWSER_EXECUTABLE must identify a provisioned executable."
  exit 1
fi

cd "$preflight"
pnpm install --frozen-lockfile --prod=false
pnpm run db:generate
pnpm run build
chown -R root:root "$preflight"
chmod -R a+rX,go-w "$preflight"
venv_home="$(mktemp -d /tmp/fgp-venv-$stamp.XXXXXX)"
chown nobody "$venv_home"
chmod 0700 "$venv_home"
scraper_build_source="$venv_home/scraper-source"
install -d -o nobody -g root -m 0700 "$scraper_build_source"
runuser -u nobody -- cp -R --no-preserve=ownership -- \
  "$preflight/apps/scraper/." "$scraper_build_source/"
install -d -o nobody -g root -m 0700 "$preflight/apps/scraper/.venv"
runuser -u nobody -- env \
  HOME="$venv_home" \
  SCRAPER_BROWSER_EXECUTABLE="$browser_path" \
  SCRAPER_INSTALL_EDITABLE=false \
  SCRAPER_PACKAGE_SOURCE="$scraper_build_source" \
  SCRAPER_SKIP_BROWSER_INSTALL=true \
  node apps/scraper/scripts/setup.mjs
rm -rf -- "$venv_home"
venv_home=""
scraper_build_source=""
sed -i 's/\r$//' "$preflight/deploy/deploy-fgp-release.sh" "$preflight/deploy/restore-fgp-backup.sh"
chown -R root:root "$preflight"
chmod -R a+rX,go-w "$preflight"
chmod 0750 "$preflight/deploy/deploy-fgp-release.sh" "$preflight/deploy/restore-fgp-backup.sh"
install -o root -g root -m 0600 /dev/null "$preflight/$candidate_marker"
sync -f "$preflight/$candidate_marker"
sync -f "$preflight"
sync -f /opt
cd /

if ! systemctl is-active --quiet caddy.service; then
  echo "Caddy must be healthy before deployment begins."
  exit 1
fi

activate_launch_barrier
services_managed=1
quiesce_services
lock_state_directory
if ! assert_sqlite_artifacts "$database_path" 0; then
  echo "SQLite state contains an unsafe file or link."
  exit 1
fi
if [ -e "$storage_path" ]; then
  if [ ! -d "$storage_path" ] || [ -L "$storage_path" ]; then
    echo "Shared-file storage is not a trusted directory."
    exit 1
  fi
else
  install -d -o fgp -g fgp -m 0750 "$storage_path"
fi
chown fgp:fgp "$storage_path"
chmod 0750 "$storage_path"

if [ -f "$database_path" ]; then
  database_existed=1
  database_backup="$operator_backup_dir/pre-deploy-$stamp.db"
  node "$preflight/apps/server/scripts/prepare-offline-restore.mjs" \
    --snapshot "$database_path" "$database_backup"
  chown root:root "$database_backup"
  chmod 0600 "$database_backup"
  sync -f "$database_backup"
  sync -f "$operator_backup_dir"
fi

cd "$preflight"
database_mutated=1
node apps/server/scripts/ensure-lzt-metric-bigints.mjs
pnpm run db:push
if ! assert_sqlite_artifacts "$database_path" 1; then
  echo "SQLite migration produced unsafe state files."
  exit 1
fi
for suffix in "" -journal -wal -shm; do
  database_file="$database_path$suffix"
  if [ -e "$database_file" ]; then
    chown fgp:fgp "$database_file"
    chmod 0640 "$database_file"
    sync -f "$database_file"
  fi
done
sync -f "$state_directory"
node apps/server/scripts/prepare-offline-restore.mjs \
  --validate "$database_path" "$storage_path"
cd /

exchange_directories "$current" "$preflight"
mv -- "$preflight" "$previous"
preflight=""
rm -f -- "$current/$candidate_marker"
sync -f /opt
install_configuration_file "$current/deploy/fgp-api.service" /etc/systemd/system/fgp-api.service 0644
install_configuration_file "$current/deploy/fgp-scraper.service" /etc/systemd/system/fgp-scraper.service 0644
install_configuration_file "$current/deploy/fgp-haze-notifier.service" /etc/systemd/system/fgp-haze-notifier.service 0644
install_configuration_file "$current/deploy/Caddyfile" /etc/caddy/Caddyfile 0644
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
if [ "$haze_enabled" -eq 1 ]; then
  systemctl enable fgp-haze-notifier.service
else
  systemctl disable fgp-haze-notifier.service
fi

start_probe_services
transaction_committed=1
unlock_state_directory
start_core_services
start_haze_service
deactivate_launch_barrier
start_ingress

local_health="$(curl --connect-timeout 2 --max-time 5 -fsS http://127.0.0.1:3001/api/health)"
public_health="$(curl --connect-timeout 3 --max-time 10 -fsS https://forhud.shop/api/health)"
HEALTH_RESPONSE="$public_health" node -e '
  const health = JSON.parse(process.env.HEALTH_RESPONSE);
  if (health.ok !== true) process.exit(1);
'
printf '%s\n%s\n' "$local_health" "$public_health"
systemctl is-active --quiet fgp-api.service
systemctl is-active --quiet fgp-scraper.service
if [ "$haze_enabled" -eq 1 ]; then
  systemctl is-active --quiet fgp-haze-notifier.service
fi

deployment_complete=1
echo "FGP_DEPLOYMENT_OK rollback=$previous database_backup=${database_backup:-none}"
