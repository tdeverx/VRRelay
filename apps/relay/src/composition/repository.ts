// SPDX-License-Identifier: GPL-3.0-or-later
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresRepository, SqliteRepository } from '@vrrelay/adapters';
import type { AuditRepository, ClusterRepository, Repository } from '@vrrelay/application';
import type { RelayConfig } from '../config.js';
import { postgresMigrationBackupHook } from './postgres-backup.js';

export type RuntimeRepository = Repository &
  ClusterRepository &
  AuditRepository & { close(): void | Promise<void> };

export function prepareDataDirectory(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700);
}

export function createRepository(config: RelayConfig): RuntimeRepository {
  prepareDataDirectory(config.dataDir);
  if (config.repositoryDriver === 'postgres') {
    if (!config.postgresUrl) throw new Error('VRRELAY_POSTGRES_URL is required for PostgreSQL');
    return new PostgresRepository(config.postgresUrl, {
      backupBeforeMigration: postgresMigrationBackupHook(config)
    });
  }
  return new SqliteRepository(join(config.dataDir, 'vrrelay.sqlite3'));
}
