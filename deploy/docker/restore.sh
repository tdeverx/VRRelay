#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
umask 077

driver="${VRRELAY_REPOSITORY_DRIVER:-postgres}"
backup_artifact="${1:?Usage: restore.sh backup.dump|backup.sqlite3|backup.enc}"
restore_temporary_file=""
sqlite_target_temporary_file=""

cleanup() {
  if [ -n "$restore_temporary_file" ]; then
    rm -f "$restore_temporary_file"
  fi
  if [ -n "$sqlite_target_temporary_file" ]; then
    rm -f "$sqlite_target_temporary_file"
  fi
}
trap cleanup EXIT INT TERM

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "Required command not found: sha256sum or shasum"
  fi
}

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

sqlite_path() {
  if [ -n "${SQLITE_PATH:-}" ]; then
    printf '%s\n' "$SQLITE_PATH"
  elif [ -n "${VRRELAY_SQLITE_PATH:-}" ]; then
    printf '%s\n' "$VRRELAY_SQLITE_PATH"
  elif [ -n "${VRRELAY_DATA_DIR:-}" ]; then
    printf '%s/vrrelay.sqlite3\n' "$VRRELAY_DATA_DIR"
  else
    fail "Set SQLITE_PATH, VRRELAY_SQLITE_PATH, or VRRELAY_DATA_DIR for SQLite restore"
  fi
}

verify_checksum() {
  artifact="$1"
  checksum_file="${artifact}.sha256"
  if [ ! -f "$checksum_file" ]; then
    return
  fi
  expected="$(awk 'NR == 1 {print $1}' "$checksum_file")"
  actual="$(sha256_file "$artifact")"
  [ "$expected" = "$actual" ] || fail "Backup checksum verification failed"
}

prepare_backup() {
  artifact="$1"
  [ -f "$artifact" ] || fail "Backup artifact not found: $artifact"
  verify_checksum "$artifact"
  case "$artifact" in
    *.enc)
      : "${BACKUP_ENCRYPTION_PASSPHRASE_FILE:?Set BACKUP_ENCRYPTION_PASSPHRASE_FILE for encrypted restore}"
      require_command openssl
      [ -r "$BACKUP_ENCRYPTION_PASSPHRASE_FILE" ] ||
        fail "BACKUP_ENCRYPTION_PASSPHRASE_FILE is not readable"
      restore_temporary_file="$(mktemp "${TMPDIR:-/tmp}/vrrelay-restore.XXXXXX")"
      openssl enc -d -aes-256-cbc -pbkdf2 \
        -in "$artifact" \
        -out "$restore_temporary_file" \
        -pass "file:$BACKUP_ENCRYPTION_PASSPHRASE_FILE"
      printf '%s\n' "$restore_temporary_file"
      ;;
    *)
      printf '%s\n' "$artifact"
      ;;
  esac
}

create_rollback_backup() {
  if [ "${RESTORE_SKIP_ROLLBACK_BACKUP:-0}" = "1" ]; then
    return
  fi
  : "${BACKUP_DIR:?Set BACKUP_DIR for rollback backup or RESTORE_SKIP_ROLLBACK_BACKUP=1}"
  rollback_artifact="$("$script_dir/backup.sh")"
  printf 'Rollback backup: %s\n' "$rollback_artifact" >&2
}

restore_postgres() {
  : "${POSTGRES_URL:?Set POSTGRES_URL}"
  require_command pg_restore
  source_artifact="$(prepare_backup "$backup_artifact")"
  pg_restore --list "$source_artifact" >/dev/null
  create_rollback_backup
  pg_restore --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error \
    --dbname="$POSTGRES_URL" \
    "$source_artifact"
}

restore_sqlite() {
  [ "${RESTORE_RELAY_STOPPED:-0}" = "1" ] ||
    fail "Set RESTORE_RELAY_STOPPED=1 after stopping VRRelay before SQLite restore"
  require_command sqlite3
  source_artifact="$(prepare_backup "$backup_artifact")"
  [ "$(sqlite3 "$source_artifact" 'PRAGMA quick_check;')" = "ok" ] ||
    fail "SQLite backup failed quick_check"
  sqlite3 "$source_artifact" 'SELECT COALESCE(MAX(version), 0) FROM schema_migrations;' >/dev/null
  create_rollback_backup
  sqlite_database="$(sqlite_path)"
  sqlite_directory="$(dirname -- "$sqlite_database")"
  mkdir -p "$sqlite_directory"
  chmod 700 "$sqlite_directory" 2>/dev/null || true
  sqlite_target_temporary_file="$(mktemp "$sqlite_directory/.vrrelay-restore.XXXXXX.sqlite3")"
  cp "$source_artifact" "$sqlite_target_temporary_file"
  chmod 600 "$sqlite_target_temporary_file"
  rm -f "${sqlite_database}-wal" "${sqlite_database}-shm"
  mv -f "$sqlite_target_temporary_file" "$sqlite_database"
  sqlite_target_temporary_file=""
}

case "$driver" in
  postgres)
    restore_postgres
    ;;
  sqlite)
    restore_sqlite
    ;;
  *)
    fail "Unsupported VRRELAY_REPOSITORY_DRIVER: $driver"
    ;;
esac

printf 'Restore completed for %s\n' "$driver"
