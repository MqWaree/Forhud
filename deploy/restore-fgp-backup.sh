#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this recovery procedure as root."
  exit 1
fi
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /var/backups/fgp/<backup>.db"
  exit 1
fi
install -d -o root -g root -m 0700 /run/fgp-maintenance
if [ -L /run/fgp-maintenance ] || \
  [ "$(stat -c '%U:%G:%a' /run/fgp-maintenance)" != "root:root:700" ]; then
  echo "Maintenance lock directory is unsafe."
  exit 1
fi
exec 9>/run/fgp-maintenance/maintenance.lock
chmod 0600 /run/fgp-maintenance/maintenance.lock
if ! flock -n 9; then
  echo "Another FGP deployment or recovery operation is active."
  exit 1
fi

backup_dir="/var/backups/fgp"
operator_backup_dir="/var/backups/fgp-operator"
state_directory="/var/lib/fgp"
current_release="/opt/fgp"
restore_helper="$current_release/apps/server/scripts/prepare-offline-restore.mjs"
migration_sql="$current_release/apps/server/prisma/migrations/20260902033000_shared_files/migration.sql"

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

for protected_path in \
  /opt \
  "$current_release" \
  "$current_release/apps" \
  "$current_release/apps/server" \
  "$current_release/apps/server/scripts" \
  "$current_release/apps/server/prisma" \
  "$current_release/apps/server/prisma/migrations" \
  "$current_release/apps/server/prisma/migrations/20260902033000_shared_files" \
  "$current_release/deploy" \
  "$current_release/deploy/restore-fgp-backup.sh" \
  "$restore_helper" \
  "$migration_sql" \
  /etc /etc/fgp /etc/fgp/fgp.env; do
  if ! assert_root_path "$protected_path"; then
    echo "Offline restore refused an untrusted path: $protected_path"
    exit 1
  fi
done

if [ ! -d "$backup_dir" ] || [ -L "$backup_dir" ]; then
  echo "The application backup directory is not trusted."
  exit 1
fi
install -d -o root -g root -m 0700 "$operator_backup_dir"
if [ -L "$operator_backup_dir" ] || \
  [ "$(stat -c '%U:%G:%a' "$operator_backup_dir")" != "root:root:700" ]; then
  echo "Operator backup directory permissions are unsafe."
  exit 1
fi

requested_backup="$1"
if [ -L "$requested_backup" ]; then
  echo "Backup symlinks are not accepted."
  exit 1
fi
source_database="$(readlink -f -- "$requested_backup")"
if [ ! -f "$source_database" ] || [ "$(dirname -- "$source_database")" != "$backup_dir" ]; then
  echo "Choose a regular .db file directly inside $backup_dir."
  exit 1
fi
case "$(basename -- "$source_database")" in
  *.db) ;;
  *) echo "The selected backup must have a .db extension."; exit 1 ;;
esac

unquote() {
  local value="$1"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

database_record="$(grep -E '^DATABASE_URL=' /etc/fgp/fgp.env | tail -n 1 || true)"
database_url="$(unquote "${database_record#DATABASE_URL=}")"
case "$database_url" in
  file:/var/lib/fgp/*.db) configured_database_path="${database_url#file:}" ;;
  *) echo "Offline restore requires a SQLite database inside /var/lib/fgp."; exit 1 ;;
esac
if [ -L "$configured_database_path" ]; then
  echo "The configured database path must not be a symlink."
  exit 1
fi
database_path="$(readlink -m -- "$configured_database_path")"
if [ "$(dirname -- "$database_path")" != "$state_directory" ] || [ ! -f "$database_path" ]; then
  echo "The live database was not found directly inside the approved state directory."
  exit 1
fi
if [ ! -d "$state_directory" ] || [ -L "$state_directory" ]; then
  echo "The FGP state directory is not trusted."
  exit 1
fi

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
storage_path="$(readlink -f -- "$configured_storage_path")"
case "$storage_path" in
  /var/lib/fgp/*) ;;
  *) echo "Shared-file storage is outside the approved state directory."; exit 1 ;;
esac
if [ ! -d "$storage_path" ] || [ -L "$storage_path" ]; then
  echo "Shared-file storage is not a trusted directory."
  exit 1
fi

haze_record="$(grep -E '^HAZE_LZT_NOTIFICATIONS_ENABLED=' /etc/fgp/fgp.env | tail -n 1 || true)"
haze_enabled=0
if [ "$(unquote "${haze_record#HAZE_LZT_NOTIFICATIONS_ENABLED=}")" = "true" ]; then
  haze_enabled=1
fi

stamp="$(date -u +%Y%m%d-%H%M%S)"
restore_directory=""
staged_database=""
safety_backup="$operator_backup_dir/pre-offline-restore-$stamp.db"
services_managed=0
database_swapped=0
state_locked=0
backup_locked=0
restore_committed=0
launch_barrier=0
cron_service=""
atd_service=""
user_manager_masked=0
probe_override="/run/systemd/system/fgp-api.service.d/maintenance-probe.conf"

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

assert_standalone_database() {
  assert_sqlite_artifacts "$1" 1 || return 1
  local suffix
  for suffix in -journal -wal -shm; do
    if [ -e "$1$suffix" ] || [ -L "$1$suffix" ]; then return 1; fi
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
  if [ "$database_swapped" -eq 1 ]; then
    assert_sqlite_artifacts "$database_path" 0 || return 1
  else
    assert_sqlite_artifacts "$database_path" 1 || return 1
  fi
  if [ ! -d "$storage_path" ] || [ -L "$storage_path" ]; then return 1; fi
}

unlock_state_directory() {
  if [ "$state_locked" -ne 1 ]; then return 0; fi
  state_locked=0
}

lock_backup_directory() {
  if [ "$launch_barrier" -ne 1 ] || [ ! -d "$backup_dir" ] || [ -L "$backup_dir" ]; then return 1; fi
  backup_locked=1
}

unlock_backup_directory() {
  if [ "$backup_locked" -ne 1 ]; then return 0; fi
  backup_locked=0
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

critical_recovery_failure() {
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  quiesce_services
  lock_state_directory
  lock_backup_directory
  disable_maintenance_probe || true
  deactivate_launch_barrier || true
  echo "CRITICAL: automatic rollback could not restore a healthy service. Keep FGP stopped."
  echo "Retained safety backup: $safety_backup"
  exit 1
}

recover() {
  local exit_code=$?
  if [ "$exit_code" -eq 0 ]; then exit_code=1; fi
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  if [ "$restore_committed" -eq 1 ]; then
    echo "Offline restore committed, but post-commit service verification failed; database rollback was not attempted."
    core_available=0
    if start_core_services; then
      core_available=1
      start_haze_service || true
    fi
    deactivate_launch_barrier || true
    if [ "$core_available" -eq 1 ]; then start_ingress || true; fi
    exit "$exit_code"
  fi
  if [ "$services_managed" -eq 1 ]; then
    quiesce_services || critical_recovery_failure
    lock_state_directory || critical_recovery_failure
    lock_backup_directory || critical_recovery_failure
    if [ -n "$restore_directory" ]; then rm -rf -- "$restore_directory"; fi
    if [ "$database_swapped" -eq 1 ]; then
      if [ ! -f "$safety_backup" ] || [ -L "$safety_backup" ] || \
        [ "$(stat -c '%U:%h' "$safety_backup")" != "root:1" ]; then
        critical_recovery_failure
      fi
      rollback_directory="$(mktemp -d "$state_directory/.fgp-offline-rollback-$stamp.XXXXXX")" || critical_recovery_failure
      chmod 0700 "$rollback_directory" || critical_recovery_failure
      rollback_database="$rollback_directory/database.db"
      cp --reflink=auto -- "$safety_backup" "$rollback_database" || critical_recovery_failure
      chown fgp:fgp "$rollback_database" || critical_recovery_failure
      chmod 0640 "$rollback_database" || critical_recovery_failure
      sync -f "$rollback_database" || critical_recovery_failure
      remove_sqlite_sidecars "$database_path" || critical_recovery_failure
      mv -- "$rollback_database" "$database_path" || critical_recovery_failure
      rmdir -- "$rollback_directory" || critical_recovery_failure
      sync -f "$state_directory" || critical_recovery_failure
    fi
    quiesce_fgp_uid || critical_recovery_failure
    unlock_backup_directory || critical_recovery_failure
    unlock_state_directory || critical_recovery_failure
    start_core_services || critical_recovery_failure
    start_haze_service || critical_recovery_failure
    deactivate_launch_barrier || critical_recovery_failure
    start_ingress || critical_recovery_failure
  else
    deactivate_launch_barrier || true
  fi
  if [ "$database_swapped" -eq 1 ]; then
    echo "Offline restore failed; the previous database was restored and passed health checks."
  else
    echo "Offline restore failed; the live database was left unchanged and passed health checks."
  fi
  exit "$exit_code"
}
trap recover EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! systemctl is-active --quiet caddy.service; then
  echo "Caddy must be healthy before offline restore begins."
  exit 1
fi
activate_launch_barrier
services_managed=1
quiesce_services
lock_state_directory
lock_backup_directory
if [ "$(readlink -f -- "$source_database")" != "$source_database" ] || \
  ! assert_standalone_database "$source_database"; then
  echo "The selected backup changed or contains unsafe SQLite companion files."
  exit 1
fi

restore_directory="$(mktemp -d "$state_directory/.fgp-offline-restore-$stamp.XXXXXX")"
chmod 0700 "$restore_directory"
staged_database="$restore_directory/candidate.db"
node "$restore_helper" --snapshot "$database_path" "$safety_backup"
chown root:root "$safety_backup"
chmod 0600 "$safety_backup"
sync -f "$safety_backup"
sync -f "$operator_backup_dir"
node "$restore_helper" "$source_database" "$staged_database" "$storage_path"
chown fgp:fgp "$staged_database"
chmod 0640 "$staged_database"
sync -f "$staged_database"

database_swapped=1
remove_sqlite_sidecars "$database_path"
mv -- "$staged_database" "$database_path"
rmdir -- "$restore_directory"
restore_directory=""
sync -f "$state_directory"

node "$restore_helper" --validate "$database_path" "$storage_path"
start_probe_services
restore_committed=1
unlock_backup_directory
unlock_state_directory
start_core_services
start_haze_service
deactivate_launch_barrier
start_ingress
trap - EXIT INT TERM HUP
echo "FGP_OFFLINE_RESTORE_OK safety_backup=$safety_backup"
