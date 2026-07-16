// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backupPath = resolve(root, 'deploy/docker/backup.sh');
const restorePath = resolve(root, 'deploy/docker/restore.sh');
const backup = readFileSync(backupPath, 'utf8');
const restore = readFileSync(restorePath, 'utf8');
const failures = [];

function requireText(source, text, message) {
  if (!source.includes(text)) failures.push(message);
}

for (const path of [backupPath, restorePath]) {
  const result = spawnSync('sh', ['-n', path], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${path} failed sh -n: ${result.stderr.trim()}`);
}

for (const [text, message] of [
  ['umask 077', 'backup script must create private artifacts by default'],
  ['VRRELAY_REPOSITORY_DRIVER:-postgres', 'backup script must support repository driver selection'],
  [
    'pg_dump --format=custom --no-owner --no-acl --file',
    'backup script must create custom PostgreSQL archives'
  ],
  ['PGDATABASE="$POSTGRES_URL"', 'backup script must keep PostgreSQL URLs out of pg_dump argv'],
  ['pg_restore --list "$temporary_file"', 'backup script must validate PostgreSQL archives'],
  ['schema_migrations', 'backup script must verify repository schema metadata'],
  ['sqlite3 "$sqlite_database"', 'backup script must support SQLite backups'],
  [".backup '$temporary_file'", 'backup script must use SQLite online backup'],
  ['PRAGMA quick_check', 'backup script must validate SQLite artifacts'],
  ['BACKUP_ENCRYPTION_PASSPHRASE_FILE', 'backup script must support optional encryption'],
  [
    'openssl enc -aes-256-cbc -pbkdf2 -salt',
    'backup script must encrypt with PBKDF2 when requested'
  ],
  ['.sha256', 'backup script must write checksum sidecars'],
  ['.meta', 'backup script must write metadata sidecars'],
  ['mv -f "$source_path" "$final_path"', 'backup script must publish artifacts atomically']
]) {
  requireText(backup, text, message);
}

for (const [text, message] of [
  ['umask 077', 'restore script must keep temporary files private'],
  ['verify_checksum "$artifact"', 'restore script must verify checksum sidecars when present'],
  ['RESTORE_SKIP_ROLLBACK_BACKUP', 'restore script must create rollback backups by default'],
  ['"$script_dir/backup.sh"', 'restore script must reuse the backup script for rollback artifacts'],
  [
    'pg_restore --list "$source_artifact"',
    'restore script must validate PostgreSQL archives before restore'
  ],
  ['--single-transaction --exit-on-error', 'restore script must restore PostgreSQL atomically'],
  [
    'RESTORE_RELAY_STOPPED=1',
    'restore script must require stopped relay acknowledgement for SQLite'
  ],
  [
    'sqlite3 "$source_artifact" \'PRAGMA quick_check;\'',
    'restore script must validate SQLite backups'
  ],
  [
    'rm -f "${sqlite_database}-wal" "${sqlite_database}-shm"',
    'restore script must remove stale SQLite WAL files'
  ],
  [
    'mv -f "$sqlite_target_temporary_file" "$sqlite_database"',
    'restore script must publish SQLite restore atomically'
  ],
  ['BACKUP_ENCRYPTION_PASSPHRASE_FILE', 'restore script must support encrypted artifacts']
]) {
  requireText(restore, text, message);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('Backup/restore script checks passed.');
