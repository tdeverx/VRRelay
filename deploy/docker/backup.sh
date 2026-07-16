#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
umask 077

driver="${VRRELAY_REPOSITORY_DRIVER:-postgres}"
: "${BACKUP_DIR:?Set BACKUP_DIR}"
retention_days="${RETENTION_DAYS:-14}"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary_file=""
encrypted_temporary_file=""

cleanup() {
  if [ -n "$temporary_file" ]; then
    rm -f "$temporary_file"
  fi
  if [ -n "$encrypted_temporary_file" ]; then
    rm -f "$encrypted_temporary_file"
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

sqlite_path() {
  if [ -n "${SQLITE_PATH:-}" ]; then
    printf '%s\n' "$SQLITE_PATH"
  elif [ -n "${VRRELAY_SQLITE_PATH:-}" ]; then
    printf '%s\n' "$VRRELAY_SQLITE_PATH"
  elif [ -n "${VRRELAY_DATA_DIR:-}" ]; then
    printf '%s/vrrelay.sqlite3\n' "$VRRELAY_DATA_DIR"
  else
    fail "Set SQLITE_PATH, VRRELAY_SQLITE_PATH, or VRRELAY_DATA_DIR for SQLite backups"
  fi
}

reject_sqlite_cli_path() {
  case "$1" in
    *"'"* | *"
"*) fail "SQLite backup paths must not contain single quotes or newlines" ;;
  esac
}

postgres_schema_version() {
  if [ "${BACKUP_SKIP_SCHEMA_CHECK:-0}" = "1" ]; then
    printf 'skipped\n'
    return
  fi
  require_command psql
  PGDATABASE="$POSTGRES_URL" PGAPPNAME='VRRelay backup schema check' \
    psql -X -A -t -c 'SELECT COALESCE(MAX(version), 0) FROM schema_migrations'
}

sqlite_schema_version() {
  if [ "${BACKUP_SKIP_SCHEMA_CHECK:-0}" = "1" ]; then
    printf 'skipped\n'
    return
  fi
  require_command sqlite3
  sqlite3 "$1" 'SELECT COALESCE(MAX(version), 0) FROM schema_migrations;'
}

publish_artifact() {
  source_path="$1"
  final_path="$2"
  if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE_FILE:-}" ]; then
    require_command openssl
    [ -r "$BACKUP_ENCRYPTION_PASSPHRASE_FILE" ] ||
      fail "BACKUP_ENCRYPTION_PASSPHRASE_FILE is not readable"
    encrypted_temporary_file="${final_path}.enc.part"
    openssl enc -aes-256-cbc -pbkdf2 -salt \
      -in "$source_path" \
      -out "$encrypted_temporary_file" \
      -pass "file:$BACKUP_ENCRYPTION_PASSPHRASE_FILE"
    openssl enc -d -aes-256-cbc -pbkdf2 \
      -in "$encrypted_temporary_file" \
      -out /dev/null \
      -pass "file:$BACKUP_ENCRYPTION_PASSPHRASE_FILE"
    rm -f "$source_path"
    temporary_file=""
    chmod 600 "$encrypted_temporary_file"
    mv -f "$encrypted_temporary_file" "${final_path}.enc"
    encrypted_temporary_file=""
    printf '%s\n' "${final_path}.enc"
  else
    chmod 600 "$source_path"
    mv -f "$source_path" "$final_path"
    temporary_file=""
    printf '%s\n' "$final_path"
  fi
}

write_sidecars() {
  artifact="$1"
  artifact_driver="$2"
  schema_version="$3"
  encrypted="$4"
  checksum="$(sha256_file "$artifact")"
  basename="$(basename "$artifact")"
  printf '%s  %s\n' "$checksum" "$basename" > "${artifact}.sha256"
  chmod 600 "${artifact}.sha256"
  {
    printf 'created_at=%s\n' "$created_at"
    printf 'driver=%s\n' "$artifact_driver"
    printf 'schema_version=%s\n' "$schema_version"
    printf 'encrypted=%s\n' "$encrypted"
    printf 'sha256=%s\n' "$checksum"
  } > "${artifact}.meta"
  chmod 600 "${artifact}.meta"
}

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

case "$driver" in
  postgres)
    : "${POSTGRES_URL:?Set POSTGRES_URL}"
    require_command pg_dump
    require_command pg_restore
    schema_version="$(postgres_schema_version)"
    temporary_file="$(mktemp "$BACKUP_DIR/.vrrelay-postgres-$stamp.XXXXXX.dump.part")"
    PGDATABASE="$POSTGRES_URL" PGAPPNAME='VRRelay backup' \
      pg_dump --format=custom --no-owner --no-acl --file "$temporary_file"
    pg_restore --list "$temporary_file" >/dev/null
    if [ "${BACKUP_SKIP_SCHEMA_CHECK:-0}" != "1" ]; then
      pg_restore --list "$temporary_file" | grep -q 'schema_migrations' ||
        fail "PostgreSQL backup does not contain schema_migrations"
    fi
    final_artifact="$(publish_artifact "$temporary_file" "$BACKUP_DIR/vrrelay-postgres-$stamp.dump")"
    ;;
  sqlite)
    sqlite_database="$(sqlite_path)"
    [ -f "$sqlite_database" ] || fail "SQLite database not found: $sqlite_database"
    require_command sqlite3
    schema_version="$(sqlite_schema_version "$sqlite_database")"
    temporary_file="$(mktemp "$BACKUP_DIR/.vrrelay-sqlite-$stamp.XXXXXX.sqlite3.part")"
    reject_sqlite_cli_path "$sqlite_database"
    reject_sqlite_cli_path "$temporary_file"
    sqlite3 "$sqlite_database" ".backup '$temporary_file'"
    [ "$(sqlite3 "$temporary_file" 'PRAGMA quick_check;')" = "ok" ] ||
      fail "SQLite backup failed quick_check"
    final_artifact="$(publish_artifact "$temporary_file" "$BACKUP_DIR/vrrelay-sqlite-$stamp.sqlite3")"
    ;;
  *)
    fail "Unsupported VRRELAY_REPOSITORY_DRIVER: $driver"
    ;;
esac

if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE_FILE:-}" ]; then
  encrypted=true
else
  encrypted=false
fi

write_sidecars "$final_artifact" "$driver" "$schema_version" "$encrypted"
find "$BACKUP_DIR" -type f \
  \( -name 'vrrelay-postgres-*' -o -name 'vrrelay-sqlite-*' \) \
  -mtime +"$retention_days" -delete
printf '%s\n' "$final_artifact"
