// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  AuditEvent,
  CompatibilityResult,
  ClusterNode,
  LiveChannel,
  PersonalAccessToken,
  PlaybackGrant,
  ProviderBinding,
  NodeCertificateState,
  AgentLogEntry,
  JobLogEntry,
  ProfileRevision,
  ProviderConnection,
  RelaySession,
  SegmentJob,
  UserIdentity,
  VodProducer
} from '@vrrelay/domain';
import type {
  AtomicDeleteResult,
  AtomicWriteResult,
  AuditQuery,
  AuditRepository,
  ClusterRepository,
  LiveChannelCapacityWriteResult,
  NodeCertificateRotation,
  NodeDrainUpdate,
  NodeHeartbeatUpdate,
  NodeOperationalStateUpdate,
  NodeRevocation,
  PersonalTokenUse,
  ProviderBindingCreateResult,
  Repository,
  SegmentJobCreateResult,
  SettingInsertResult,
  VersionedRecord
} from '@vrrelay/application';
import { sameSessionIdentity } from './repository-invariants.js';

type StoredEntity =
  | ProviderConnection
  | ProfileRevision
  | RelaySession
  | PlaybackGrant
  | LiveChannel
  | CompatibilityResult
  | PersonalAccessToken
  | UserIdentity;

interface StoredProviderRecord extends VersionedRecord<ProviderConnection> {
  deletionPending: boolean;
}

interface StoredProviderBindingRecord extends VersionedRecord<ProviderBinding> {
  deletionPending: boolean;
}

export interface SqliteMigration {
  version: number;
  name: string;
  checksum: string;
  statements: readonly string[];
}

export function sqliteMigrationChecksum(
  migration: Pick<SqliteMigration, 'version' | 'name' | 'statements'>
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: migration.version,
        name: migration.name,
        statements: [...migration.statements]
      })
    )
    .digest('hex');
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: 'core repository',
    checksum: 'c7b62ec82b38dc38d50b655f5dc767ccb16bac86a187f488a2bc2f7e6fe2b8c2',
    statements: [
      `CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS profiles (
        profile_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, revision)
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS playback_grants (
        token_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS playback_grants_session ON playback_grants(session_id)',
      `CREATE TABLE IF NOT EXISTS live_channels (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS compatibility_results (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        tested_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS personal_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ]
  },
  {
    version: 2,
    name: 'cluster repository',
    checksum: 'f1f18672a0d2813944d510d5980e2be319137bb9a9756833c960de7095acdeec',
    statements: [
      `CREATE TABLE IF NOT EXISTS cluster_nodes (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS segment_jobs (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS provider_bindings (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS provider_bindings_provider ON provider_bindings(provider_id)',
      'CREATE INDEX IF NOT EXISTS provider_bindings_node ON provider_bindings(node_id)',
      `CREATE TABLE IF NOT EXISTS node_certificates (
        serial_number TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS node_certificates_node ON node_certificates(node_id)',
      `CREATE TABLE IF NOT EXISTS agent_logs (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        json TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS agent_logs_node_time ON agent_logs(node_id, timestamp DESC)'
    ]
  },
  {
    version: 3,
    name: 'atomic revisions and audit log',
    checksum: '9cc51d80c6ebc7e94e4cd20075288961e5f1058bf0a66323cb8fd76fc61cf44d',
    statements: [
      'ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE cluster_nodes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE segment_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE provider_bindings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE schema_migrations ADD COLUMN name TEXT',
      'ALTER TABLE schema_migrations ADD COLUMN checksum TEXT',
      `CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_id TEXT,
        target_id TEXT,
        json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      )`,
      'CREATE INDEX audit_events_time ON audit_events(occurred_at DESC)',
      'CREATE INDEX audit_events_category_time ON audit_events(category, occurred_at DESC)',
      'CREATE INDEX audit_events_actor_time ON audit_events(actor_id, occurred_at DESC)',
      'CREATE INDEX audit_events_target_time ON audit_events(target_id, occurred_at DESC)'
    ]
  },
  {
    version: 4,
    name: 'atomic live channels',
    checksum: '5a8e76d6caefab2bd2eccf78588c72e3846095d43951d3631dde4554c198a709',
    statements: ['ALTER TABLE live_channels ADD COLUMN revision INTEGER NOT NULL DEFAULT 1']
  },
  {
    version: 5,
    name: 'atomic provider lifecycle',
    checksum: 'f959f36f9eb6efb60943d546c92b93a65b12f8854b891aa4aefed6a36ca46a14',
    statements: [
      'ALTER TABLE providers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      `ALTER TABLE providers ADD COLUMN deletion_pending INTEGER NOT NULL DEFAULT 0
       CHECK (deletion_pending IN (0, 1))`
    ]
  },
  {
    version: 6,
    name: 'crash-safe provider binding deletion',
    checksum: '9e63669a93e5448cfbb3f1ae260a2b2aa11e825f3f3468397af0fd770bfaa80f',
    statements: [
      `ALTER TABLE provider_bindings ADD COLUMN deletion_pending INTEGER NOT NULL DEFAULT 0
       CHECK (deletion_pending IN (0, 1))`
    ]
  },
  {
    version: 7,
    name: 'bounded job logs',
    checksum: 'edb88ed051c621c49bfc7cce6d5972ace7200315c899e5e9a71b811880d45aa6',
    statements: [
      `CREATE TABLE IF NOT EXISTS job_logs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        node_id TEXT,
        json TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS job_logs_job_time ON job_logs(job_id, timestamp DESC)'
    ]
  },
  {
    version: 8,
    name: 'unified user identities',
    checksum: 'dc63a28381d241a52ea538aa43c8dcffaea5e6b34e6f8718128c44e75ba3cb25',
    statements: [
      `CREATE TABLE user_identities (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(provider_id, provider_user_id)
      )`,
      'CREATE INDEX user_identities_last_seen ON user_identities(updated_at DESC)',
      `INSERT OR IGNORE INTO settings(key,value,updated_at,revision)
       SELECT 'auth.signInConfiguration',value,updated_at,revision
       FROM settings WHERE key='portal.configuration'`,
      `DELETE FROM settings WHERE key='portal.configuration'`
    ]
  },
  {
    version: 9,
    name: 'durable vod producers',
    checksum: 'a325c22f1631f01d551e7988402051e94f1ce295beb88a6b218ae89472df2f0b',
    statements: [
      `CREATE TABLE vod_producers (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        owner_node_id TEXT,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      )`,
      'CREATE INDEX vod_producers_state_time ON vod_producers(state, updated_at DESC)',
      'CREATE INDEX vod_producers_owner ON vod_producers(owner_node_id)'
    ]
  }
] as const;

type SqliteAffinity = 'INTEGER' | 'TEXT';
type SqliteNullability = 'explicit' | 'primary-key' | 'nullable';

interface SqliteColumnShape {
  declaredType: 'INTEGER' | 'TEXT';
  affinity: SqliteAffinity;
  nullability: SqliteNullability;
  defaultSql?: '0' | '1';
}

interface SqliteTableShape {
  columns: Readonly<Record<string, SqliteColumnShape>>;
  primaryKey: readonly string[];
  unique?: readonly (readonly string[])[];
  indexes?: Readonly<Record<string, readonly string[]>>;
}

const SQLITE_TEXT_REQUIRED = {
  declaredType: 'TEXT',
  affinity: 'TEXT',
  nullability: 'explicit'
} as const;
const SQLITE_TEXT_KEY = {
  declaredType: 'TEXT',
  affinity: 'TEXT',
  nullability: 'primary-key'
} as const;
const SQLITE_TEXT_NULLABLE = {
  declaredType: 'TEXT',
  affinity: 'TEXT',
  nullability: 'nullable'
} as const;
const SQLITE_INTEGER_REQUIRED = {
  declaredType: 'INTEGER',
  affinity: 'INTEGER',
  nullability: 'explicit'
} as const;
const SQLITE_INTEGER_KEY = {
  declaredType: 'INTEGER',
  affinity: 'INTEGER',
  nullability: 'primary-key'
} as const;
const SQLITE_REVISION = { ...SQLITE_INTEGER_REQUIRED, defaultSql: '1' } as const;
const SQLITE_DELETION_FLAG = { ...SQLITE_INTEGER_REQUIRED, defaultSql: '0' } as const;

const SQLITE_SCHEMA_SHAPE = {
  schema_migrations: {
    columns: {
      version: SQLITE_INTEGER_KEY,
      applied_at: SQLITE_TEXT_REQUIRED,
      name: SQLITE_TEXT_NULLABLE,
      checksum: SQLITE_TEXT_NULLABLE
    },
    primaryKey: ['version']
  },
  providers: {
    columns: {
      id: SQLITE_TEXT_KEY,
      json: SQLITE_TEXT_REQUIRED,
      updated_at: SQLITE_TEXT_REQUIRED,
      revision: SQLITE_REVISION,
      deletion_pending: SQLITE_DELETION_FLAG
    },
    primaryKey: ['id']
  },
  profiles: {
    columns: {
      profile_id: SQLITE_TEXT_REQUIRED,
      revision: SQLITE_INTEGER_REQUIRED,
      json: SQLITE_TEXT_REQUIRED,
      created_at: SQLITE_TEXT_REQUIRED
    },
    primaryKey: ['profile_id', 'revision']
  },
  sessions: {
    columns: {
      id: SQLITE_TEXT_KEY,
      json: SQLITE_TEXT_REQUIRED,
      updated_at: SQLITE_TEXT_REQUIRED,
      revision: SQLITE_REVISION
    },
    primaryKey: ['id']
  },
  playback_grants: {
    columns: {
      token_hash: SQLITE_TEXT_KEY,
      session_id: SQLITE_TEXT_REQUIRED,
      json: SQLITE_TEXT_REQUIRED,
      created_at: SQLITE_TEXT_REQUIRED
    },
    primaryKey: ['token_hash'],
    indexes: { playback_grants_session: ['session_id'] }
  },
  live_channels: {
    columns: {
      id: SQLITE_TEXT_KEY,
      json: SQLITE_TEXT_REQUIRED,
      created_at: SQLITE_TEXT_REQUIRED,
      revision: SQLITE_REVISION
    },
    primaryKey: ['id']
  },
  compatibility_results: {
    columns: {
      id: SQLITE_TEXT_KEY,
      json: SQLITE_TEXT_REQUIRED,
      tested_at: SQLITE_TEXT_REQUIRED
    },
    primaryKey: ['id']
  },
  personal_tokens: {
    columns: {
      id: SQLITE_TEXT_KEY,
      token_hash: SQLITE_TEXT_REQUIRED,
      json: SQLITE_TEXT_REQUIRED,
      created_at: SQLITE_TEXT_REQUIRED
    },
    primaryKey: ['id'],
    unique: [['token_hash']]
  },
  user_identities: {
    columns: {
      id: SQLITE_TEXT_KEY,
      provider_id: SQLITE_TEXT_REQUIRED,
      provider_user_id: SQLITE_TEXT_REQUIRED,
      json: SQLITE_TEXT_REQUIRED,
      updated_at: SQLITE_TEXT_REQUIRED,
      revision: SQLITE_REVISION
    },
    primaryKey: ['id'],
    unique: [['provider_id', 'provider_user_id']],
    indexes: { user_identities_last_seen: ['updated_at'] }
  },
  settings: {
    columns: {
      key: SQLITE_TEXT_KEY,
      value: SQLITE_TEXT_REQUIRED,
      updated_at: SQLITE_TEXT_REQUIRED,
      revision: SQLITE_REVISION
    },
    primaryKey: ['key']
  },
  cluster_nodes: {
    columns: {
      id: SQLITE_TEXT_KEY,
      json: SQLITE_TEXT_REQUIRED,
      updated_at: SQLITE_TEXT_REQUIRED,
      revision: SQLITE_REVISION
    },
    primaryKey: ['id']
  },
  segment_jobs: {
    columns: {
      id: SQLITE_TEXT_KEY,
      json: SQLITE_TEXT_REQUIRED,
      updated_at: SQLITE_TEXT_REQUIRED,
      revision: SQLITE_REVISION
    },
    primaryKey: ['id']
  },
  vod_producers: {
    columns: {
      session_id: SQLITE_TEXT_KEY,
      state: SQLITE_TEXT_REQUIRED,
      owner_node_id: SQLITE_TEXT_NULLABLE,
      json: SQLITE_TEXT_REQUIRED,
      updated_at: SQLITE_TEXT_REQUIRED,
      revision: SQLITE_REVISION
    },
    primaryKey: ['session_id'],
    indexes: {
      vod_producers_state_time: ['state', 'updated_at'],
      vod_producers_owner: ['owner_node_id']
    }
  },
  provider_bindings: {
    columns: {
      id: SQLITE_TEXT_KEY,
      provider_id: SQLITE_TEXT_REQUIRED,
      node_id: SQLITE_TEXT_REQUIRED,
      json: SQLITE_TEXT_REQUIRED,
      updated_at: SQLITE_TEXT_REQUIRED,
      revision: SQLITE_REVISION,
      deletion_pending: SQLITE_DELETION_FLAG
    },
    primaryKey: ['id'],
    indexes: {
      provider_bindings_provider: ['provider_id'],
      provider_bindings_node: ['node_id']
    }
  },
  node_certificates: {
    columns: {
      serial_number: SQLITE_TEXT_KEY,
      node_id: SQLITE_TEXT_REQUIRED,
      json: SQLITE_TEXT_REQUIRED,
      created_at: SQLITE_TEXT_REQUIRED
    },
    primaryKey: ['serial_number'],
    indexes: { node_certificates_node: ['node_id'] }
  },
  agent_logs: {
    columns: {
      id: SQLITE_TEXT_KEY,
      node_id: SQLITE_TEXT_REQUIRED,
      json: SQLITE_TEXT_REQUIRED,
      timestamp: SQLITE_TEXT_REQUIRED
    },
    primaryKey: ['id'],
    indexes: { agent_logs_node_time: ['node_id', 'timestamp'] }
  },
  job_logs: {
    columns: {
      id: SQLITE_TEXT_KEY,
      job_id: SQLITE_TEXT_REQUIRED,
      node_id: SQLITE_TEXT_NULLABLE,
      json: SQLITE_TEXT_REQUIRED,
      timestamp: SQLITE_TEXT_REQUIRED
    },
    primaryKey: ['id'],
    indexes: { job_logs_job_time: ['job_id', 'timestamp'] }
  },
  audit_events: {
    columns: {
      id: SQLITE_TEXT_KEY,
      category: SQLITE_TEXT_REQUIRED,
      action: SQLITE_TEXT_REQUIRED,
      actor_id: SQLITE_TEXT_NULLABLE,
      target_id: SQLITE_TEXT_NULLABLE,
      json: SQLITE_TEXT_REQUIRED,
      occurred_at: SQLITE_TEXT_REQUIRED
    },
    primaryKey: ['id'],
    indexes: {
      audit_events_time: ['occurred_at'],
      audit_events_category_time: ['category', 'occurred_at'],
      audit_events_actor_time: ['actor_id', 'occurred_at'],
      audit_events_target_time: ['target_id', 'occurred_at']
    }
  }
} as const satisfies Record<string, SqliteTableShape>;

const SQLITE_TABLES = Object.keys(SQLITE_SCHEMA_SHAPE) as Array<keyof typeof SQLITE_SCHEMA_SHAPE>;
const APPLICATION_TABLES = SQLITE_TABLES.filter((table) => table !== 'schema_migrations');

function canonicalProviderBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function providersReferenceSameServer(
  current: ProviderConnection,
  candidate: ProviderConnection
): boolean {
  return (
    current.id === candidate.id &&
    current.type === candidate.type &&
    canonicalProviderBaseUrl(current.baseUrl) === canonicalProviderBaseUrl(candidate.baseUrl)
  );
}

function mergeProviderMetadata(
  current: ProviderConnection,
  candidate: ProviderConnection
): ProviderConnection {
  return {
    ...current,
    name: candidate.name,
    healthy: candidate.healthy,
    capabilities: [...candidate.capabilities],
    ...(candidate.userId ? { userId: candidate.userId } : {}),
    ...(candidate.username ? { username: candidate.username } : {}),
    ...(candidate.serverName ? { serverName: candidate.serverName } : {}),
    ...(candidate.serverVersion ? { serverVersion: candidate.serverVersion } : {}),
    ...(candidate.securityNotice ? { securityNotice: candidate.securityNotice } : {}),
    updatedAt: candidate.updatedAt
  };
}

const BINDING_CLEANUP_PENDING_MESSAGE = 'Provider credential cleanup is pending';
const NODE_REVOKED_BINDING_MESSAGE =
  'Node revoked; provider credential cleanup requires administrator acknowledgement';

function storedProviderBinding(value: ProviderBinding, deletionPending: boolean): ProviderBinding {
  return { ...value, deletionPending };
}

function sqliteTableExists(database: Database.Database, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function sqliteColumnExists(database: Database.Database, table: string, column: string): boolean {
  if (!sqliteTableExists(database, table)) return false;
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    ({ name }) => name === column
  );
}

function sqliteIndexColumns(database: Database.Database, index: string): string[] | undefined {
  const exists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index);
  if (!exists) return undefined;
  return (
    database.prepare(`PRAGMA index_info("${index}")`).all() as Array<{
      seqno: number;
      name: string;
    }>
  )
    .sort((left, right) => left.seqno - right.seqno)
    .map(({ name }) => name);
}

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((column, index) => column === right[index]);
}

interface SqliteColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

function sqliteAffinity(declaredType: string): 'BLOB' | 'INTEGER' | 'NUMERIC' | 'REAL' | 'TEXT' {
  const normalized = declaredType.trim().toUpperCase();
  if (normalized.includes('INT')) return 'INTEGER';
  if (normalized.includes('CHAR') || normalized.includes('CLOB') || normalized.includes('TEXT'))
    return 'TEXT';
  if (!normalized || normalized.includes('BLOB')) return 'BLOB';
  if (normalized.includes('REAL') || normalized.includes('FLOA') || normalized.includes('DOUB'))
    return 'REAL';
  return 'NUMERIC';
}

function normalizeSqliteDefault(value: string | null): string | undefined {
  if (value === null) return undefined;
  let normalized = value.trim();
  while (normalized.startsWith('(') && normalized.endsWith(')'))
    normalized = normalized.slice(1, -1).trim();
  return normalized;
}

function assertSqliteColumnShape(
  table: string,
  column: SqliteColumnInfo,
  shape: SqliteColumnShape
): void {
  const declaredType = column.type.trim().toUpperCase();
  if (declaredType !== shape.declaredType || sqliteAffinity(column.type) !== shape.affinity)
    throw new Error(
      `SQLite schema column ${table}.${column.name} must use ${shape.declaredType} with ${shape.affinity} affinity`
    );
  const nullabilityMatches =
    shape.nullability === 'explicit'
      ? column.notnull === 1
      : shape.nullability === 'primary-key'
        ? column.pk > 0
        : column.notnull === 0 && column.pk === 0;
  if (!nullabilityMatches)
    throw new Error(
      `SQLite schema column ${table}.${column.name} has invalid nullability; expected ${shape.nullability}`
    );
  if (
    shape.defaultSql !== undefined &&
    normalizeSqliteDefault(column.dflt_value) !== shape.defaultSql
  )
    throw new Error(
      `SQLite schema column ${table}.${column.name} must use default ${shape.defaultSql}`
    );
}

function assertSqliteDeletionCheck(database: Database.Database, table: string): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string | null } | undefined;
  if (
    !row?.sql ||
    !/\bCHECK\s*\(\s*"?deletion_pending"?\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(row.sql)
  )
    throw new Error(`SQLite schema is missing required boolean check on ${table}.deletion_pending`);
}

function validateMigrationDefinitions(migrations: readonly SqliteMigration[]): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1)
      throw new Error('SQLite migration definitions must be contiguous and start at version 1');
    if (!migration.name || migration.statements.length === 0)
      throw new Error(`SQLite migration ${migration.version} is incomplete`);
    if (migration.checksum !== sqliteMigrationChecksum(migration))
      throw new Error(
        `SQLite migration ${migration.version} checksum does not match its immutable definition`
      );
  }
}

interface AppliedSqliteMigration {
  version: number;
  name: string | null;
  checksum: string | null;
}

interface SqliteMigrationHistory {
  rows: AppliedSqliteMigration[];
  hasMetadata: boolean;
}

function sqliteMigrationHistory(database: Database.Database): SqliteMigrationHistory {
  if (!sqliteTableExists(database, 'schema_migrations')) return { rows: [], hasMetadata: false };
  const hasName = sqliteColumnExists(database, 'schema_migrations', 'name');
  const hasChecksum = sqliteColumnExists(database, 'schema_migrations', 'checksum');
  if (hasName !== hasChecksum)
    throw new Error('SQLite migration history metadata columns are incomplete');
  const hasMetadata = hasName && hasChecksum;
  const rows = database
    .prepare(
      hasMetadata
        ? 'SELECT version,name,checksum FROM schema_migrations ORDER BY version'
        : 'SELECT version,NULL AS name,NULL AS checksum FROM schema_migrations ORDER BY version'
    )
    .all() as AppliedSqliteMigration[];
  return { rows, hasMetadata };
}

function validateMigrationHistory(
  history: SqliteMigrationHistory,
  migrations: readonly SqliteMigration[]
): void {
  const latest = migrations.at(-1)?.version ?? 0;
  const future = history.rows.find(({ version }) => version > latest)?.version;
  if (future !== undefined)
    throw new Error(
      `SQLite schema version ${future} is newer than this VRRelay build supports (${latest})`
    );
  for (const [index, applied] of history.rows.entries()) {
    const version = applied.version;
    if (version !== index + 1)
      throw new Error('SQLite migration history is not a contiguous prefix of this build');
    if (history.hasMetadata) {
      const expected = migrations[index];
      if (!expected || applied.name !== expected.name || applied.checksum !== expected.checksum)
        throw new Error(`SQLite migration ${version} history does not match this build`);
    }
  }
  if (!history.hasMetadata && history.rows.some(({ version }) => version >= 3))
    throw new Error('SQLite migration history is missing immutable metadata');
}

function applySqliteMigrations(
  database: Database.Database,
  migrations: readonly SqliteMigration[]
): void {
  validateMigrationDefinitions(migrations);
  let history = sqliteMigrationHistory(database);
  validateMigrationHistory(history, migrations);
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  for (const migration of migrations.slice(history.rows.length)) {
    for (const statement of migration.statements) database.exec(statement);
    history = sqliteMigrationHistory(database);
    if (history.hasMetadata) {
      const updateLegacy = database.prepare(
        `UPDATE schema_migrations
         SET name = ?, checksum = ?
         WHERE version = ? AND name IS NULL AND checksum IS NULL`
      );
      for (const applied of migrations.slice(0, migration.version - 1))
        updateLegacy.run(applied.name, applied.checksum, applied.version);
      database
        .prepare(
          `INSERT INTO schema_migrations(version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    } else {
      database
        .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
    }
  }
  validateMigrationHistory(sqliteMigrationHistory(database), migrations);
}

export function runSqliteMigrations(
  database: Database.Database,
  migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS
): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    applySqliteMigrations(database, migrations);
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function assertSqliteSchemaCurrent(
  database: Database.Database,
  migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS
): void {
  validateMigrationDefinitions(migrations);
  if (!sqliteTableExists(database, 'schema_migrations'))
    throw new Error('SQLite schema is not initialized; run migrations on the controller first');
  const history = sqliteMigrationHistory(database);
  validateMigrationHistory(history, migrations);
  const latest = migrations.at(-1)?.version ?? 0;
  if (history.rows.length !== latest)
    throw new Error(
      `SQLite schema is at version ${history.rows.at(-1)?.version ?? 0}; version ${latest} is required`
    );
  const missingTable = SQLITE_TABLES.find((table) => !sqliteTableExists(database, table));
  if (missingTable) throw new Error(`SQLite schema is missing required table ${missingTable}`);
  for (const table of SQLITE_TABLES) {
    const shape: SqliteTableShape = SQLITE_SCHEMA_SHAPE[table];
    const tableInfo = database
      .prepare(`PRAGMA table_xinfo("${table}")`)
      .all() as SqliteColumnInfo[];
    const presentColumns = new Set(tableInfo.map(({ name }) => name));
    const expectedColumns = Object.keys(shape.columns);
    const missingColumn = expectedColumns.find((column) => !presentColumns.has(column));
    if (missingColumn)
      throw new Error(`SQLite schema is missing required column ${table}.${missingColumn}`);
    const unexpectedColumn = tableInfo.find(
      ({ name, hidden }) => hidden !== 0 || !(name in shape.columns)
    );
    if (unexpectedColumn)
      throw new Error(`SQLite schema has unexpected column ${table}.${unexpectedColumn.name}`);
    for (const column of tableInfo)
      assertSqliteColumnShape(table, column, shape.columns[column.name]!);
    const primaryKey = tableInfo
      .filter(({ pk }) => pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(({ name }) => name);
    if (!sameColumns(primaryKey, shape.primaryKey))
      throw new Error(`SQLite schema has an invalid primary key on ${table}`);
    if (table === 'providers' || table === 'provider_bindings')
      assertSqliteDeletionCheck(database, table);
    for (const [index, columns] of Object.entries(shape.indexes ?? {})) {
      if (!sameColumns(sqliteIndexColumns(database, index) ?? [], columns))
        throw new Error(`SQLite schema is missing required index ${index}`);
    }
    if (shape.unique) {
      const uniqueIndexes = (
        database.prepare(`PRAGMA index_list("${table}")`).all() as Array<{
          name: string;
          unique: number;
        }>
      ).filter((index) => index.unique === 1);
      for (const columns of shape.unique) {
        const present = uniqueIndexes.some((index) =>
          sameColumns(sqliteIndexColumns(database, index.name) ?? [], columns)
        );
        if (!present)
          throw new Error(
            `SQLite schema is missing required unique constraint on ${table}(${columns.join(',')})`
          );
      }
    }
  }
}

const PRIVATE_FILE_MODE = 0o600;

function chmodSqliteFileIfPresent(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function secureSqliteFiles(path: string): void {
  if (path === ':memory:' || process.platform === 'win32') return;
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    chmodSqliteFileIfPresent(`${path}${suffix}`);
}

function prepareSqlitePath(path: string): void {
  if (path === ':memory:') return;
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, 'a', PRIVATE_FILE_MODE);
  try {
    chmodSqliteFileIfPresent(path);
  } finally {
    closeSync(descriptor);
  }
  secureSqliteFiles(path);
}

export class SqliteRepository implements Repository, ClusterRepository, AuditRepository {
  readonly #db: Database.Database;
  readonly #path: string;
  #lastMigrationBackupPath: string | undefined;

  constructor(path: string) {
    prepareSqlitePath(path);
    this.#path = path;
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#db.pragma('busy_timeout = 5000');
    secureSqliteFiles(path);
  }

  async migrate(): Promise<void> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      validateMigrationDefinitions(SQLITE_MIGRATIONS);
      const history = sqliteMigrationHistory(this.#db);
      validateMigrationHistory(history, SQLITE_MIGRATIONS);
      const pending = history.rows.length < SQLITE_MIGRATIONS.length;
      const hasExistingSchema = APPLICATION_TABLES.some((table) =>
        sqliteTableExists(this.#db, table)
      );
      if (pending && hasExistingSchema && this.#path !== ':memory:') {
        const suffix = new Date().toISOString().replaceAll(/[:.]/g, '-');
        const backupPath = `${this.#path}.pre-migration-v${history.rows.length}-${suffix}-${randomUUID()}.bak`;
        let backupCreated = false;
        try {
          const destination = await open(backupPath, 'wx', PRIVATE_FILE_MODE);
          backupCreated = true;
          try {
            if (process.platform !== 'win32') await destination.chmod(PRIVATE_FILE_MODE);
          } finally {
            await destination.close();
          }

          const source = new Database(this.#path, { readonly: true, fileMustExist: true });
          try {
            await source.backup(backupPath);
          } finally {
            source.close();
          }
          chmodSqliteFileIfPresent(backupPath);

          const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
          try {
            const quickCheck = backup.pragma('quick_check') as Array<{ quick_check: string }>;
            if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok')
              throw new Error('SQLite pre-migration backup failed its integrity check');
          } finally {
            backup.close();
          }
        } catch (error) {
          if (backupCreated) {
            try {
              await rm(backupPath, { force: true });
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                'SQLite pre-migration backup failed and its partial file could not be removed',
                { cause: cleanupError }
              );
            }
          }
          throw error;
        }
        this.#lastMigrationBackupPath = backupPath;
      }
      applySqliteMigrations(this.#db, SQLITE_MIGRATIONS);
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.inTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async assertSchemaCurrent(): Promise<void> {
    assertSqliteSchemaCurrent(this.#db);
  }

  get lastMigrationBackupPath(): string | undefined {
    return this.#lastMigrationBackupPath;
  }

  async createProvider(provider: ProviderConnection): Promise<VersionedRecord<ProviderConnection>> {
    this.#db
      .prepare(
        `INSERT INTO providers(id, json, updated_at, revision, deletion_pending)
         VALUES (?, ?, ?, 1, 0)`
      )
      .run(provider.id, JSON.stringify(provider), provider.updatedAt);
    return { value: provider, revision: 1 };
  }

  async listProviders(): Promise<ProviderConnection[]> {
    const rows = this.#db
      .prepare('SELECT json FROM providers WHERE deletion_pending = 0 ORDER BY updated_at DESC')
      .all() as Array<{ json: string }>;
    return rows.map(({ json }) => JSON.parse(json) as ProviderConnection);
  }

  async getProvider(id: string): Promise<ProviderConnection | undefined> {
    const current = this.#getStoredProvider(id);
    return current && !current.deletionPending ? current.value : undefined;
  }

  async getVersionedProvider(id: string): Promise<VersionedRecord<ProviderConnection> | undefined> {
    const current = this.#getStoredProvider(id);
    return current && !current.deletionPending
      ? { value: current.value, revision: current.revision }
      : undefined;
  }

  async compareAndSetProvider(
    provider: ProviderConnection,
    expectedRevision: number
  ): Promise<AtomicWriteResult<ProviderConnection>> {
    const result = this.#db
      .prepare(
        `UPDATE providers
         SET json = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND deletion_pending = 0`
      )
      .run(JSON.stringify(provider), provider.updatedAt, provider.id, expectedRevision);
    if (result.changes === 1)
      return { applied: true, record: { value: provider, revision: expectedRevision + 1 } };
    const current = this.#getStoredProvider(provider.id);
    if (!current) return { applied: false, reason: 'not-found' };
    const record = { value: current.value, revision: current.revision };
    if (current.revision !== expectedRevision)
      return { applied: false, reason: 'revision-conflict', current: record };
    return { applied: false, reason: 'invalid-state', current: record };
  }

  async beginProviderDeletion(id: string): Promise<AtomicWriteResult<ProviderConnection>> {
    const operation = this.#db.transaction((): AtomicWriteResult<ProviderConnection> => {
      const current = this.#getStoredProvider(id);
      if (!current) return { applied: false, reason: 'not-found' };
      const record = { value: current.value, revision: current.revision };
      if (current.deletionPending) return { applied: true, record };
      const dependencies = this.#providerDependencies(id);
      if (dependencies.length > 0)
        return { applied: false, reason: 'dependency-conflict', current: record, dependencies };
      const updated = this.#db
        .prepare(
          `UPDATE providers
           SET deletion_pending = 1, revision = revision + 1
           WHERE id = ? AND revision = ? AND deletion_pending = 0`
        )
        .run(id, current.revision);
      if (updated.changes !== 1) throw new Error('Locked provider deletion transition was lost');
      return {
        applied: true,
        record: { value: current.value, revision: current.revision + 1 }
      };
    });
    return operation.immediate();
  }

  async finalizeProviderDeletion(
    id: string,
    expectedRevision: number
  ): Promise<AtomicDeleteResult<ProviderConnection>> {
    const operation = this.#db.transaction((): AtomicDeleteResult<ProviderConnection> => {
      const current = this.#getStoredProvider(id);
      if (!current) return { applied: false, reason: 'not-found' };
      const record = { value: current.value, revision: current.revision };
      if (current.revision !== expectedRevision)
        return { applied: false, reason: 'revision-conflict', current: record };
      if (!current.deletionPending)
        return { applied: false, reason: 'invalid-state', current: record };
      const dependencies = this.#providerDependencies(id);
      if (dependencies.length > 0)
        return { applied: false, reason: 'dependency-conflict', current: record, dependencies };
      const deleted = this.#db
        .prepare('DELETE FROM providers WHERE id = ? AND revision = ? AND deletion_pending = 1')
        .run(id, expectedRevision);
      if (deleted.changes !== 1) throw new Error('Locked provider deletion was lost');
      return { applied: true, deleted: record };
    });
    return operation.immediate();
  }

  async putProfile(profile: ProfileRevision): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO profiles(profile_id, revision, json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, revision) DO NOTHING`
      )
      .run(profile.profileId, profile.revision, JSON.stringify(profile), profile.createdAt);
  }

  async listProfiles(): Promise<ProfileRevision[]> {
    return this.#list<ProfileRevision>('profiles', 'profile_id, revision DESC');
  }

  async getProfile(id: string, revision?: number): Promise<ProfileRevision | undefined> {
    const row = revision
      ? this.#db
          .prepare('SELECT json FROM profiles WHERE profile_id = ? AND revision = ?')
          .get(id, revision)
      : this.#db
          .prepare('SELECT json FROM profiles WHERE profile_id = ? ORDER BY revision DESC LIMIT 1')
          .get(id);
    return this.#parseRow<ProfileRevision>(row);
  }

  async createSessionWithPlaybackGrant(
    session: RelaySession,
    grant: PlaybackGrant,
    expectedLiveChannelRevision?: number
  ): Promise<AtomicWriteResult<RelaySession>> {
    if (grant.sessionId !== session.id)
      throw new Error('Playback grant must belong to the session being created');
    const operation = this.#db.transaction((): AtomicWriteResult<RelaySession> => {
      if (session.kind === 'vod') {
        if (!session.source?.providerId)
          throw new Error('VOD session creation requires a provider reference');
        const provider = this.#getStoredProvider(session.source.providerId);
        if (!provider) return { applied: false, reason: 'not-found' };
        if (provider.deletionPending) return { applied: false, reason: 'invalid-state' };
      } else {
        if (!session.liveChannelId || expectedLiveChannelRevision === undefined)
          throw new Error('Live session creation requires an expected live-channel revision');
        const channel = this.#getVersioned<LiveChannel>(
          'live_channels',
          'id',
          session.liveChannelId
        );
        if (!channel) return { applied: false, reason: 'not-found' };
        if (channel.revision !== expectedLiveChannelRevision)
          return { applied: false, reason: 'revision-conflict' };
      }
      this.#db
        .prepare(
          `INSERT INTO playback_grants(token_hash, session_id, json, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(grant.tokenHash, grant.sessionId, JSON.stringify(grant), grant.createdAt);
      this.#db
        .prepare('INSERT INTO sessions(id, json, updated_at, revision) VALUES (?, ?, ?, 1)')
        .run(session.id, JSON.stringify(session), session.updatedAt);
      return { applied: true, record: { value: session, revision: 1 } };
    });
    return operation.immediate();
  }

  async listSessions(): Promise<RelaySession[]> {
    return this.#list<RelaySession>('sessions', 'updated_at DESC');
  }

  async getSession(id: string): Promise<RelaySession | undefined> {
    return this.#get<RelaySession>('sessions', 'id', id);
  }

  async getVersionedSession(id: string): Promise<VersionedRecord<RelaySession> | undefined> {
    return this.#getVersioned<RelaySession>('sessions', 'id', id);
  }

  async compareAndSetSession(
    session: RelaySession,
    expectedRevision: number
  ): Promise<AtomicWriteResult<RelaySession>> {
    const current = await this.getVersionedSession(session.id);
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.revision !== expectedRevision)
      return { applied: false, reason: 'revision-conflict', current };
    if (!sameSessionIdentity(current.value, session))
      return { applied: false, reason: 'invalid-state', current };
    return this.#compareAndSetVersioned(
      'sessions',
      'id',
      session.id,
      session,
      'updated_at',
      session.updatedAt,
      expectedRevision
    );
  }

  async setSessionViewers(
    sessionId: string,
    expectedRevision: number,
    viewers: number,
    updatedAt: string
  ): Promise<AtomicWriteResult<RelaySession>> {
    if (!Number.isInteger(viewers) || viewers < 0)
      throw new Error('Session viewers must be a non-negative integer');
    const current = await this.getVersionedSession(sessionId);
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.revision !== expectedRevision)
      return { applied: false, reason: 'revision-conflict', current };
    return this.compareAndSetSession({ ...current.value, viewers, updatedAt }, expectedRevision);
  }

  async deleteSessionAndRevokePlaybackGrants(
    sessionId: string,
    revokedAt = new Date().toISOString()
  ): Promise<void> {
    this.#db.transaction(() => {
      this.#revokePlaybackGrants(sessionId, revokedAt);
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    })();
  }

  async getPlaybackGrant(tokenHash: string): Promise<PlaybackGrant | undefined> {
    return this.#get<PlaybackGrant>('playback_grants', 'token_hash', tokenHash);
  }

  async createLiveChannel(channel: LiveChannel): Promise<VersionedRecord<LiveChannel>> {
    this.#db
      .prepare('INSERT INTO live_channels(id, json, created_at, revision) VALUES (?, ?, ?, 1)')
      .run(channel.id, JSON.stringify(channel), channel.createdAt);
    return { value: channel, revision: 1 };
  }

  async createLiveChannelWithinCapacity(
    channel: LiveChannel,
    limits: { maxTotal: number; maxPerOwner: number }
  ): Promise<LiveChannelCapacityWriteResult> {
    return this.#db
      .transaction(() => {
        const total = this.#db.prepare('SELECT COUNT(*) AS count FROM live_channels').get() as {
          count: number;
        };
        if (total.count >= limits.maxTotal)
          return { created: false, reason: 'installation-limit' } as const;
        if (channel.ownerId) {
          const owned = this.#db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM live_channels
                WHERE json_extract(json, '$.ownerId') = ?`
            )
            .get(channel.ownerId) as { count: number };
          if (owned.count >= limits.maxPerOwner)
            return { created: false, reason: 'owner-limit' } as const;
        }
        this.#db
          .prepare('INSERT INTO live_channels(id, json, created_at, revision) VALUES (?, ?, ?, 1)')
          .run(channel.id, JSON.stringify(channel), channel.createdAt);
        return {
          created: true,
          record: { value: channel, revision: 1 }
        } as const;
      })
      .immediate();
  }

  async listLiveChannels(): Promise<LiveChannel[]> {
    return this.#list<LiveChannel>('live_channels', 'created_at DESC');
  }

  async getLiveChannel(id: string): Promise<LiveChannel | undefined> {
    return this.#get<LiveChannel>('live_channels', 'id', id);
  }

  async getVersionedLiveChannel(id: string): Promise<VersionedRecord<LiveChannel> | undefined> {
    return this.#getVersioned<LiveChannel>('live_channels', 'id', id);
  }

  async compareAndSetLiveChannel(
    channel: LiveChannel,
    expectedRevision: number
  ): Promise<AtomicWriteResult<LiveChannel>> {
    return this.#compareAndSetVersioned(
      'live_channels',
      'id',
      channel.id,
      channel,
      'created_at',
      channel.createdAt,
      expectedRevision
    );
  }

  async deleteLiveChannel(
    id: string,
    expectedRevision: number
  ): Promise<AtomicWriteResult<LiveChannel>> {
    const operation = this.#db.transaction((): AtomicWriteResult<LiveChannel> => {
      const current = this.#getVersioned<LiveChannel>('live_channels', 'id', id);
      if (!current) return { applied: false, reason: 'not-found' };
      if (current.revision !== expectedRevision)
        return { applied: false, reason: 'revision-conflict', current };
      if (current.value.publisherState !== 'offline')
        return { applied: false, reason: 'invalid-state', current };
      const dependent = this.#db
        .prepare(
          `SELECT 1 FROM sessions
           WHERE json_extract(json, '$.liveChannelId') = ?
           LIMIT 1`
        )
        .get(id);
      if (dependent) return { applied: false, reason: 'invalid-state', current };
      const deleted = this.#db
        .prepare('DELETE FROM live_channels WHERE id = ? AND revision = ?')
        .run(id, expectedRevision);
      if (deleted.changes !== 1) throw new Error('Locked live-channel deletion was lost');
      return { applied: true, record: current };
    });
    return operation.immediate();
  }

  async putCompatibilityResult(result: CompatibilityResult): Promise<void> {
    this.#put('compatibility_results', 'id', result.id, result, 'tested_at', result.testedAt);
  }

  async listCompatibilityResults(): Promise<CompatibilityResult[]> {
    return this.#list<CompatibilityResult>('compatibility_results', 'tested_at DESC');
  }

  async putPersonalToken(token: PersonalAccessToken): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO personal_tokens(id, token_hash, json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, json = excluded.json`
      )
      .run(token.id, token.tokenHash, JSON.stringify(token), token.createdAt);
  }

  async getPersonalToken(tokenHash: string): Promise<PersonalAccessToken | undefined> {
    return this.#get<PersonalAccessToken>('personal_tokens', 'token_hash', tokenHash);
  }

  async usePersonalToken(update: PersonalTokenUse): Promise<PersonalAccessToken | undefined> {
    const row = this.#db
      .prepare(
        `UPDATE personal_tokens
         SET json = CASE
           WHEN json_extract(json, '$.lastUsedAt') IS NULL
             OR json_extract(json, '$.lastUsedAt') <= ?
           THEN json_set(json, '$.lastUsedAt', ?)
           ELSE json
         END
         WHERE token_hash = ?
           AND json_extract(json, '$.revokedAt') IS NULL
           AND (
             json_extract(json, '$.expiresAt') IS NULL
             OR json_extract(json, '$.expiresAt') > ?
           )
         RETURNING json`
      )
      .get(update.touchBefore, update.usedAt, update.tokenHash, update.usedAt);
    return this.#parseRow<PersonalAccessToken>(row);
  }

  async listPersonalTokens(): Promise<PersonalAccessToken[]> {
    return this.#list<PersonalAccessToken>('personal_tokens', 'created_at DESC');
  }

  async revokePersonalToken(id: string, revokedAt = new Date().toISOString()): Promise<void> {
    this.#db
      .prepare(
        `UPDATE personal_tokens
         SET json = json_set(json, '$.revokedAt', ?)
         WHERE id = ? AND json_extract(json, '$.revokedAt') IS NULL`
      )
      .run(revokedAt, id);
  }

  async createUserIdentity(identity: UserIdentity): Promise<VersionedRecord<UserIdentity>> {
    this.#db
      .prepare(
        `INSERT INTO user_identities
         (id, provider_id, provider_user_id, json, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .run(
        identity.id,
        identity.providerId,
        identity.providerUserId,
        JSON.stringify(identity),
        identity.lastSeenAt
      );
    return { value: identity, revision: 1 };
  }

  async listUserIdentities(): Promise<Array<VersionedRecord<UserIdentity>>> {
    const rows = this.#db
      .prepare('SELECT json, revision FROM user_identities ORDER BY updated_at DESC')
      .all() as Array<{ json: string; revision: number }>;
    return rows.map(({ json, revision }) => ({
      value: JSON.parse(json) as UserIdentity,
      revision
    }));
  }

  async getUserIdentity(id: string): Promise<VersionedRecord<UserIdentity> | undefined> {
    return this.#getVersioned<UserIdentity>('user_identities', 'id', id);
  }

  async compareAndSetUserIdentity(
    identity: UserIdentity,
    expectedRevision: number
  ): Promise<AtomicWriteResult<UserIdentity>> {
    return this.#compareAndSetVersioned(
      'user_identities',
      'id',
      identity.id,
      identity,
      'updated_at',
      identity.lastSeenAt,
      expectedRevision
    );
  }

  async compareAndSetUserIdentityPreservingOwner(
    identity: UserIdentity,
    expectedRevision: number
  ): Promise<AtomicWriteResult<UserIdentity>> {
    const operation = this.#db.transaction((): AtomicWriteResult<UserIdentity> => {
      const current = this.#getVersioned<UserIdentity>('user_identities', 'id', identity.id);
      if (!current) return { applied: false, reason: 'not-found' };
      if (current.revision !== expectedRevision)
        return { applied: false, reason: 'revision-conflict', current };
      if (current.value.roles.includes('owner') && !identity.roles.includes('owner')) {
        const owners = this.#db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM user_identities
             WHERE EXISTS (
               SELECT 1
               FROM json_each(user_identities.json, '$.roles')
               WHERE json_each.value = 'owner'
             )`
          )
          .get() as { count: number };
        if (owners.count <= 1)
          return {
            applied: false,
            reason: 'dependency-conflict',
            current,
            dependencies: ['assigned-owner']
          };
      }
      return this.#compareAndSetVersioned(
        'user_identities',
        'id',
        identity.id,
        identity,
        'updated_at',
        identity.lastSeenAt,
        expectedRevision
      );
    });
    return operation.immediate();
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO settings(key, value, updated_at, revision) VALUES (?, ?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           revision = settings.revision + 1`
      )
      .run(key, value, new Date().toISOString());
  }

  async getSetting(key: string): Promise<string | undefined> {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  async getVersionedSetting(key: string): Promise<VersionedRecord<string> | undefined> {
    const row = this.#db.prepare('SELECT value, revision FROM settings WHERE key = ?').get(key) as
      { value: string; revision: number } | undefined;
    return row ? { value: row.value, revision: row.revision } : undefined;
  }

  async putSettingIfAbsent(key: string, value: string): Promise<SettingInsertResult> {
    const updatedAt = new Date().toISOString();
    const result = this.#db
      .prepare(
        `INSERT INTO settings(key, value, updated_at, revision)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(key) DO NOTHING`
      )
      .run(key, value, updatedAt);
    const record = await this.getVersionedSetting(key);
    if (!record) throw new Error('Setting insert did not produce a readable record');
    return { inserted: result.changes === 1, record };
  }

  async compareAndSetSetting(
    key: string,
    value: string,
    expectedRevision: number
  ): Promise<AtomicWriteResult<string>> {
    const result = this.#db
      .prepare(
        `UPDATE settings
         SET value = ?, updated_at = ?, revision = revision + 1
         WHERE key = ? AND revision = ?`
      )
      .run(value, new Date().toISOString(), key, expectedRevision);
    if (result.changes === 1)
      return { applied: true, record: { value, revision: expectedRevision + 1 } };
    const current = await this.getVersionedSetting(key);
    return current
      ? { applied: false, reason: 'revision-conflict', current }
      : { applied: false, reason: 'not-found' };
  }

  async createNode(
    node: ClusterNode,
    initialCertificate?: NodeCertificateState
  ): Promise<VersionedRecord<ClusterNode>> {
    if (
      initialCertificate &&
      (initialCertificate.nodeId !== node.id || initialCertificate.revokedAt !== null)
    )
      throw new Error('Initial certificate must be active and belong to the node being created');
    const operation = this.#db.transaction((): VersionedRecord<ClusterNode> => {
      this.#db
        .prepare('INSERT INTO cluster_nodes(id, json, updated_at, revision) VALUES (?, ?, ?, 1)')
        .run(node.id, JSON.stringify(node), node.updatedAt);
      if (initialCertificate)
        this.#db
          .prepare(
            `INSERT INTO node_certificates(serial_number,node_id,json,created_at)
             VALUES(?,?,?,?)`
          )
          .run(
            initialCertificate.serialNumber,
            initialCertificate.nodeId,
            JSON.stringify(initialCertificate),
            initialCertificate.createdAt
          );
      return { value: node, revision: 1 };
    });
    return operation.immediate();
  }

  async ensureLocalNode(node: ClusterNode): Promise<VersionedRecord<ClusterNode>> {
    const operation = this.#db.transaction((): VersionedRecord<ClusterNode> => {
      const current = this.#getVersioned<ClusterNode>('cluster_nodes', 'id', node.id);
      if (!current) {
        this.#db
          .prepare('INSERT INTO cluster_nodes(id, json, updated_at, revision) VALUES (?, ?, ?, 1)')
          .run(node.id, JSON.stringify(node), node.updatedAt);
        return { value: node, revision: 1 };
      }
      const state =
        current.value.state === 'draining' || current.value.state === 'revoked'
          ? current.value.state
          : node.state;
      const certificateExpiresAt = node.certificateExpiresAt ?? current.value.certificateExpiresAt;
      const ensured: ClusterNode = {
        ...node,
        state,
        createdAt: current.value.createdAt,
        ...(certificateExpiresAt ? { certificateExpiresAt } : {})
      };
      const result = this.#compareAndSetVersioned(
        'cluster_nodes',
        'id',
        node.id,
        ensured,
        'updated_at',
        ensured.updatedAt,
        current.revision
      );
      if (!result.applied) throw new Error('Locked local node update was lost');
      return result.record;
    });
    return operation.immediate();
  }

  async getNode(id: string): Promise<ClusterNode | undefined> {
    return this.#get<ClusterNode>('cluster_nodes', 'id', id);
  }

  async getVersionedNode(id: string): Promise<VersionedRecord<ClusterNode> | undefined> {
    return this.#getVersioned<ClusterNode>('cluster_nodes', 'id', id);
  }

  async recordNodeHeartbeat(update: NodeHeartbeatUpdate): Promise<AtomicWriteResult<ClusterNode>> {
    const current = await this.getVersionedNode(update.nodeId);
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.revision !== update.expectedRevision)
      return { applied: false, reason: 'revision-conflict', current };
    const protectedState =
      current.value.state === 'draining' || current.value.state === 'revoked'
        ? current.value.state
        : update.reportedState;
    const node: ClusterNode = {
      ...current.value,
      capabilities: update.capabilities,
      state: protectedState,
      lastHeartbeatAt: update.lastHeartbeatAt,
      updatedAt: update.updatedAt,
      ...(update.certificateExpiresAt ? { certificateExpiresAt: update.certificateExpiresAt } : {})
    };
    return this.#compareAndSetVersioned(
      'cluster_nodes',
      'id',
      node.id,
      node,
      'updated_at',
      node.updatedAt,
      update.expectedRevision
    );
  }

  async setNodeDrain(update: NodeDrainUpdate): Promise<AtomicWriteResult<ClusterNode>> {
    const current = await this.getVersionedNode(update.nodeId);
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.revision !== update.expectedRevision)
      return { applied: false, reason: 'revision-conflict', current };
    if (current.value.state === 'revoked')
      return { applied: false, reason: 'invalid-state', current };
    const state = update.draining
      ? 'draining'
      : current.value.state === 'draining'
        ? 'online'
        : current.value.state;
    const node: ClusterNode = { ...current.value, state, updatedAt: update.updatedAt };
    return this.#compareAndSetVersioned(
      'cluster_nodes',
      'id',
      node.id,
      node,
      'updated_at',
      node.updatedAt,
      update.expectedRevision
    );
  }

  async setNodeOperationalState(
    update: NodeOperationalStateUpdate
  ): Promise<AtomicWriteResult<ClusterNode>> {
    const current = await this.getVersionedNode(update.nodeId);
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.revision !== update.expectedRevision)
      return { applied: false, reason: 'revision-conflict', current };
    if (current.value.state === 'draining' || current.value.state === 'revoked')
      return { applied: false, reason: 'invalid-state', current };
    const node: ClusterNode = {
      ...current.value,
      state: update.state,
      updatedAt: update.updatedAt
    };
    return this.#compareAndSetVersioned(
      'cluster_nodes',
      'id',
      node.id,
      node,
      'updated_at',
      node.updatedAt,
      update.expectedRevision,
      ['joining', 'online', 'degraded', 'offline']
    );
  }

  async listNodes(): Promise<ClusterNode[]> {
    return this.#list<ClusterNode>('cluster_nodes', 'updated_at DESC');
  }

  async removeNode(id: string, expectedRevision: number): Promise<AtomicDeleteResult<ClusterNode>> {
    const operation = this.#db.transaction((): AtomicDeleteResult<ClusterNode> => {
      const current = this.#getVersioned<ClusterNode>('cluster_nodes', 'id', id);
      if (!current) return { applied: false, reason: 'not-found' };
      if (current.revision !== expectedRevision)
        return { applied: false, reason: 'revision-conflict', current };
      if (current.value.state !== 'revoked')
        return { applied: false, reason: 'invalid-state', current };
      const dependencies = (
        this.#db.prepare('SELECT id FROM provider_bindings WHERE node_id = ?').all(id) as Array<{
          id: string;
        }>
      ).map(({ id: bindingId }) => `binding:${bindingId}`);
      if (dependencies.length > 0)
        return { applied: false, reason: 'dependency-conflict', current, dependencies };
      const deleted = this.#db
        .prepare('DELETE FROM cluster_nodes WHERE id = ? AND revision = ?')
        .run(id, expectedRevision);
      if (deleted.changes !== 1) throw new Error('Locked cluster-node removal was lost');
      return { applied: true, deleted: current };
    });
    return operation.immediate();
  }

  async createSegmentJob(job: SegmentJob): Promise<SegmentJobCreateResult> {
    const operation = this.#db.transaction((): SegmentJobCreateResult => {
      const result = this.#db
        .prepare(
          `INSERT INTO segment_jobs(id, json, updated_at, revision) VALUES (?, ?, ?, 1)
           ON CONFLICT(id) DO NOTHING`
        )
        .run(job.id, JSON.stringify(job), job.updatedAt);
      const record = this.#getVersioned<SegmentJob>('segment_jobs', 'id', job.id);
      if (!record) throw new Error('Segment job creation did not produce a readable record');
      return { created: result.changes === 1, record };
    });
    return operation.immediate();
  }

  async getSegmentJob(id: string): Promise<SegmentJob | undefined> {
    return this.#get<SegmentJob>('segment_jobs', 'id', id);
  }

  async getVersionedSegmentJob(id: string): Promise<VersionedRecord<SegmentJob> | undefined> {
    return this.#getVersioned<SegmentJob>('segment_jobs', 'id', id);
  }

  async compareAndSetSegmentJob(
    job: SegmentJob,
    expectedRevision: number,
    allowedCurrentStates: readonly SegmentJob['state'][]
  ): Promise<AtomicWriteResult<SegmentJob>> {
    if (allowedCurrentStates.length === 0)
      throw new Error('A segment-job transition must declare its allowed current states');
    return this.#compareAndSetVersioned(
      'segment_jobs',
      'id',
      job.id,
      job,
      'updated_at',
      job.updatedAt,
      expectedRevision,
      allowedCurrentStates
    );
  }

  async completeSegmentJob(
    job: SegmentJob,
    expectedRevision: number
  ): Promise<AtomicWriteResult<SegmentJob>> {
    if (job.state !== 'complete')
      throw new Error('completeSegmentJob requires a complete job value');
    return this.compareAndSetSegmentJob(job, expectedRevision, ['leased', 'running']);
  }

  async cancelSegmentJob(
    job: SegmentJob,
    expectedRevision: number
  ): Promise<AtomicWriteResult<SegmentJob>> {
    if (job.state !== 'cancelled')
      throw new Error('cancelSegmentJob requires a cancelled job value');
    return this.compareAndSetSegmentJob(job, expectedRevision, [
      'queued',
      'leased',
      'running',
      'failed'
    ]);
  }

  async listSegmentJobs(limit = 100): Promise<SegmentJob[]> {
    const rows = this.#db
      .prepare('SELECT json FROM segment_jobs ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as SegmentJob);
  }

  async createVodProducer(
    producer: VodProducer
  ): Promise<{ created: boolean; record: VersionedRecord<VodProducer> }> {
    const result = this.#db
      .prepare(
        `INSERT INTO vod_producers(session_id,state,owner_node_id,json,updated_at,revision)
         VALUES(?,?,?,?,?,1) ON CONFLICT(session_id) DO NOTHING`
      )
      .run(
        producer.sessionId,
        producer.state,
        producer.ownerNodeId ?? null,
        JSON.stringify(producer),
        producer.updatedAt
      );
    const record = this.#getVersioned<VodProducer>(
      'vod_producers',
      'session_id',
      producer.sessionId
    );
    if (!record) throw new Error('VOD producer creation did not produce a readable record');
    return { created: result.changes === 1, record };
  }

  async getVodProducer(sessionId: string): Promise<VodProducer | undefined> {
    return this.#get<VodProducer>('vod_producers', 'session_id', sessionId);
  }

  async getVersionedVodProducer(
    sessionId: string
  ): Promise<VersionedRecord<VodProducer> | undefined> {
    return this.#getVersioned<VodProducer>('vod_producers', 'session_id', sessionId);
  }

  async listVodProducers(limit = 100): Promise<VodProducer[]> {
    const rows = this.#db
      .prepare('SELECT json FROM vod_producers ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as VodProducer);
  }

  async compareAndSetVodProducer(
    producer: VodProducer,
    expectedRevision: number,
    allowedCurrentStates: readonly VodProducer['state'][]
  ): Promise<AtomicWriteResult<VodProducer>> {
    if (!allowedCurrentStates.length)
      throw new Error('A VOD producer transition must declare its allowed current states');
    const placeholders = allowedCurrentStates.map(() => '?').join(',');
    const result = this.#db
      .prepare(
        `UPDATE vod_producers
         SET state=?,owner_node_id=?,json=?,updated_at=?,revision=revision+1
         WHERE session_id=? AND revision=? AND state IN (${placeholders})`
      )
      .run(
        producer.state,
        producer.ownerNodeId ?? null,
        JSON.stringify(producer),
        producer.updatedAt,
        producer.sessionId,
        expectedRevision,
        ...allowedCurrentStates
      );
    if (result.changes === 1)
      return { applied: true, record: { value: producer, revision: expectedRevision + 1 } };
    const current = await this.getVersionedVodProducer(producer.sessionId);
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.revision !== expectedRevision)
      return { applied: false, reason: 'revision-conflict', current };
    return { applied: false, reason: 'invalid-state', current };
  }

  async createProviderBinding(
    provider: ProviderConnection,
    binding: ProviderBinding,
    expectedProviderRevision: number | null
  ): Promise<ProviderBindingCreateResult> {
    if (binding.providerId !== provider.id)
      throw new Error('Provider binding must reference the provider being created');
    const operation = this.#db.transaction((): ProviderBindingCreateResult => {
      const currentBinding = this.#getStoredProviderBinding(binding.id);
      const existingProvider = this.#getStoredProvider(provider.id);
      if (currentBinding) {
        return {
          applied: false,
          reason: currentBinding.deletionPending ? 'binding-deleting' : 'binding-conflict',
          ...(existingProvider ? { provider: existingProvider.value } : {}),
          binding: { value: currentBinding.value, revision: currentBinding.revision }
        };
      }

      const targetNode = this.#getVersioned<ClusterNode>('cluster_nodes', 'id', binding.nodeId);
      if (
        !targetNode ||
        targetNode.value.state === 'revoked' ||
        !targetNode.value.roles.includes('source-worker')
      )
        return { applied: false, reason: 'node-unavailable' };

      let storedProvider: ProviderConnection;
      if (expectedProviderRevision === null) {
        if (existingProvider)
          return {
            applied: false,
            reason: existingProvider.deletionPending ? 'provider-deleting' : 'provider-conflict',
            provider: existingProvider.value
          };
        this.#db
          .prepare(
            `INSERT INTO providers(id, json, updated_at, revision, deletion_pending)
             VALUES (?, ?, ?, 1, 0)`
          )
          .run(provider.id, JSON.stringify(provider), provider.updatedAt);
        storedProvider = provider;
      } else {
        if (!existingProvider) return { applied: false, reason: 'provider-not-found' };
        if (existingProvider.deletionPending)
          return {
            applied: false,
            reason: 'provider-deleting',
            provider: existingProvider.value
          };
        if (existingProvider.revision !== expectedProviderRevision)
          return {
            applied: false,
            reason: 'provider-revision-conflict',
            provider: existingProvider.value
          };
        if (!providersReferenceSameServer(existingProvider.value, provider))
          return {
            applied: false,
            reason: 'provider-conflict',
            provider: existingProvider.value
          };
        storedProvider = mergeProviderMetadata(existingProvider.value, provider);
        const updated = this.#db
          .prepare(
            `UPDATE providers
             SET json = ?, updated_at = ?, revision = revision + 1
             WHERE id = ? AND revision = ? AND deletion_pending = 0`
          )
          .run(
            JSON.stringify(storedProvider),
            storedProvider.updatedAt,
            storedProvider.id,
            expectedProviderRevision
          );
        if (updated.changes !== 1) throw new Error('Locked provider binding update was lost');
      }

      const storedBinding = storedProviderBinding(binding, false);
      this.#db
        .prepare(
          `INSERT INTO provider_bindings(
             id,provider_id,node_id,json,updated_at,revision,deletion_pending
           ) VALUES(?,?,?,?,?,1,0)`
        )
        .run(
          storedBinding.id,
          storedBinding.providerId,
          storedBinding.nodeId,
          JSON.stringify(storedBinding),
          storedBinding.updatedAt
        );
      return {
        applied: true,
        provider: storedProvider,
        binding: { value: storedBinding, revision: 1 }
      };
    });
    return operation.immediate();
  }

  async getProviderBinding(
    id: string,
    options: { includeDeletionPending?: boolean } = {}
  ): Promise<ProviderBinding | undefined> {
    const current = this.#getStoredProviderBinding(id);
    return current && (options.includeDeletionPending || !current.deletionPending)
      ? current.value
      : undefined;
  }
  async getVersionedProviderBinding(
    id: string,
    options: { includeDeletionPending?: boolean } = {}
  ): Promise<VersionedRecord<ProviderBinding> | undefined> {
    const current = this.#getStoredProviderBinding(id);
    return current && (options.includeDeletionPending || !current.deletionPending)
      ? { value: current.value, revision: current.revision }
      : undefined;
  }
  async compareAndSetProviderBinding(
    binding: ProviderBinding,
    expectedRevision: number,
    allowedCurrentStates?: readonly ProviderBinding['state'][]
  ): Promise<AtomicWriteResult<ProviderBinding>> {
    if (binding.deletionPending)
      throw new Error('Provider binding CAS cannot set the internal deletion-pending state');
    const storedBinding = storedProviderBinding(binding, false);
    const stateClause = allowedCurrentStates?.length
      ? ` AND json_extract(json, '$.state') IN (${allowedCurrentStates.map(() => '?').join(', ')})`
      : '';
    const result = this.#db
      .prepare(
        `UPDATE provider_bindings
         SET json = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND deletion_pending = 0
           AND json_extract(json, '$.providerId') = ?
           AND json_extract(json, '$.nodeId') = ?
           AND json_extract(json, '$.secretRef') = ?${stateClause}`
      )
      .run(
        JSON.stringify(storedBinding),
        storedBinding.updatedAt,
        storedBinding.id,
        expectedRevision,
        storedBinding.providerId,
        storedBinding.nodeId,
        storedBinding.secretRef,
        ...(allowedCurrentStates ?? [])
      );
    if (result.changes === 1)
      return {
        applied: true,
        record: { value: storedBinding, revision: expectedRevision + 1 }
      };
    const currentStored = this.#getStoredProviderBinding(binding.id);
    const current = currentStored
      ? { value: currentStored.value, revision: currentStored.revision }
      : undefined;
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.revision !== expectedRevision)
      return { applied: false, reason: 'revision-conflict', current };
    return { applied: false, reason: 'invalid-state', current };
  }
  async listProviderBindings(
    providerId?: string,
    options: { includeDeletionPending?: boolean } = {}
  ): Promise<ProviderBinding[]> {
    const filters = [
      ...(providerId ? ['provider_id = ?'] : []),
      ...(options.includeDeletionPending ? [] : ['deletion_pending = 0'])
    ];
    const rows = this.#db
      .prepare(
        `SELECT json,deletion_pending FROM provider_bindings${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY updated_at DESC`
      )
      .all(...(providerId ? [providerId] : [])) as Array<{
      json: string;
      deletion_pending: number;
    }>;
    return rows.map((row) =>
      storedProviderBinding(JSON.parse(row.json) as ProviderBinding, row.deletion_pending === 1)
    );
  }
  async beginProviderBindingDeletion(
    id: string,
    updatedAt: string
  ): Promise<AtomicWriteResult<ProviderBinding>> {
    const operation = this.#db.transaction((): AtomicWriteResult<ProviderBinding> => {
      const current = this.#getStoredProviderBinding(id);
      if (!current) return { applied: false, reason: 'not-found' };
      const record = { value: current.value, revision: current.revision };
      if (current.deletionPending) return { applied: true, record };
      const pending: ProviderBinding = {
        ...current.value,
        reachable: false,
        state: 'revoked',
        deletionPending: true,
        lastError: BINDING_CLEANUP_PENDING_MESSAGE,
        updatedAt
      };
      const result = this.#db
        .prepare(
          `UPDATE provider_bindings
           SET json=?,updated_at=?,revision=revision + 1,deletion_pending=1
           WHERE id=? AND revision=? AND deletion_pending=0`
        )
        .run(JSON.stringify(pending), updatedAt, id, current.revision);
      if (result.changes !== 1)
        throw new Error('Locked provider binding deletion transition was lost');
      return {
        applied: true,
        record: { value: pending, revision: current.revision + 1 }
      };
    });
    return operation.immediate();
  }
  async finalizeProviderBindingDeletion(
    id: string,
    expectedRevision: number
  ): Promise<AtomicDeleteResult<ProviderBinding>> {
    const operation = this.#db.transaction((): AtomicDeleteResult<ProviderBinding> => {
      const current = this.#getStoredProviderBinding(id);
      if (!current) return { applied: false, reason: 'not-found' };
      const record = { value: current.value, revision: current.revision };
      if (current.revision !== expectedRevision)
        return { applied: false, reason: 'revision-conflict', current: record };
      if (!current.deletionPending)
        return { applied: false, reason: 'invalid-state', current: record };
      const deleted = this.#db
        .prepare('DELETE FROM provider_bindings WHERE id=? AND revision=? AND deletion_pending=1')
        .run(id, expectedRevision);
      if (deleted.changes !== 1) throw new Error('Locked provider binding finalization was lost');
      return { applied: true, deleted: record };
    });
    return operation.immediate();
  }
  async rotateNodeCertificate(
    update: NodeCertificateRotation
  ): Promise<AtomicWriteResult<ClusterNode>> {
    if (update.certificate.nodeId !== update.nodeId || update.certificate.revokedAt !== null)
      throw new Error('Certificate rotation requires a new active certificate for the target node');
    return this.#db.transaction((): AtomicWriteResult<ClusterNode> => {
      const current = this.#getVersioned<ClusterNode>('cluster_nodes', 'id', update.nodeId);
      if (!current) return { applied: false, reason: 'not-found' };
      if (current.revision !== update.expectedRevision)
        return { applied: false, reason: 'revision-conflict', current };
      if (current.value.state === 'revoked')
        return { applied: false, reason: 'invalid-state', current };
      const node: ClusterNode = {
        ...current.value,
        certificateExpiresAt: update.certificate.expiresAt,
        updatedAt: update.updatedAt
      };
      const result = this.#compareAndSetVersioned(
        'cluster_nodes',
        'id',
        update.nodeId,
        node,
        'updated_at',
        update.updatedAt,
        update.expectedRevision,
        ['joining', 'online', 'degraded', 'draining', 'offline']
      );
      if (!result.applied) return result;
      this.#revokeNodeCertificates(update.nodeId, update.updatedAt);
      this.#putNodeCertificate(update.certificate);
      return result;
    })();
  }

  async revokeNode(update: NodeRevocation): Promise<AtomicWriteResult<ClusterNode>> {
    return this.#db.transaction((): AtomicWriteResult<ClusterNode> => {
      const current = this.#getVersioned<ClusterNode>('cluster_nodes', 'id', update.nodeId);
      if (!current) return { applied: false, reason: 'not-found' };
      if (current.revision !== update.expectedRevision)
        return { applied: false, reason: 'revision-conflict', current };
      const node: ClusterNode = {
        ...current.value,
        state: 'revoked',
        updatedAt: update.revokedAt
      };
      const result = this.#compareAndSetVersioned(
        'cluster_nodes',
        'id',
        update.nodeId,
        node,
        'updated_at',
        update.revokedAt,
        update.expectedRevision
      );
      if (!result.applied) return result;
      this.#db
        .prepare(
          `UPDATE provider_bindings
           SET json=json_set(
                 json,
                 '$.reachable',json('false'),
                 '$.state','revoked',
                 '$.deletionPending',CASE WHEN deletion_pending=1 THEN json('true') ELSE json('false') END,
                 '$.lastError',?,
                 '$.updatedAt',?
               ),
               updated_at=?,revision=revision + 1
           WHERE node_id=?`
        )
        .run(NODE_REVOKED_BINDING_MESSAGE, update.revokedAt, update.revokedAt, update.nodeId);
      this.#revokeNodeCertificates(update.nodeId, update.revokedAt);
      return result;
    })();
  }
  async listNodeCertificates(nodeId: string): Promise<NodeCertificateState[]> {
    const rows = this.#db
      .prepare('SELECT json FROM node_certificates WHERE node_id=? ORDER BY created_at DESC')
      .all(nodeId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as NodeCertificateState);
  }
  async putAgentLog(value: AgentLogEntry, retentionRows = 1000): Promise<void> {
    this.#db
      .prepare('INSERT OR REPLACE INTO agent_logs(id,node_id,json,timestamp) VALUES(?,?,?,?)')
      .run(value.id, value.nodeId, JSON.stringify(value), value.timestamp);
    this.#db
      .prepare(
        `DELETE FROM agent_logs WHERE node_id=? AND id NOT IN
      (SELECT id FROM agent_logs WHERE node_id=? ORDER BY timestamp DESC LIMIT ?)`
      )
      .run(value.nodeId, value.nodeId, retentionRows);
  }
  async listAgentLogs(nodeId: string, limit = 200): Promise<AgentLogEntry[]> {
    const rows = this.#db
      .prepare('SELECT json FROM agent_logs WHERE node_id=? ORDER BY timestamp DESC LIMIT ?')
      .all(nodeId, limit) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as AgentLogEntry);
  }
  async putJobLog(value: JobLogEntry, retentionRows = 1000): Promise<void> {
    this.#db
      .prepare(
        'INSERT OR REPLACE INTO job_logs(id,job_id,node_id,json,timestamp) VALUES(?,?,?,?,?)'
      )
      .run(value.id, value.jobId, value.nodeId ?? null, JSON.stringify(value), value.timestamp);
    this.#db
      .prepare(
        `DELETE FROM job_logs WHERE job_id=? AND id NOT IN
      (SELECT id FROM job_logs WHERE job_id=? ORDER BY timestamp DESC LIMIT ?)`
      )
      .run(value.jobId, value.jobId, retentionRows);
  }
  async listJobLogs(jobId: string, limit = 200): Promise<JobLogEntry[]> {
    const rows = this.#db
      .prepare('SELECT json FROM job_logs WHERE job_id=? ORDER BY timestamp DESC LIMIT ?')
      .all(jobId, limit) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as JobLogEntry);
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO audit_events(
          id, category, action, actor_id, target_id, json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`
      )
      .run(
        event.id,
        event.category,
        event.action,
        event.actor.id ?? null,
        event.target?.id ?? null,
        JSON.stringify(event),
        event.occurredAt
      );
  }

  async listAuditEvents(query: AuditQuery = {}): Promise<AuditEvent[]> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.category) {
      clauses.push('category = ?');
      values.push(query.category);
    }
    if (query.actorId) {
      clauses.push('actor_id = ?');
      values.push(query.actorId);
    }
    if (query.targetId) {
      clauses.push('target_id = ?');
      values.push(query.targetId);
    }
    if (query.before) {
      clauses.push('occurred_at < ?');
      values.push(query.before);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 200, 1_000));
    values.push(limit);
    const rows = this.#db
      .prepare(
        `SELECT json FROM audit_events
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY occurred_at DESC
         LIMIT ?`
      )
      .all(...values) as Array<{ json: string }>;
    return rows.map(({ json }) => JSON.parse(json) as AuditEvent);
  }

  close(): void {
    this.#db.close();
  }

  #revokePlaybackGrants(sessionId: string, revokedAt: string): void {
    this.#db
      .prepare(
        `UPDATE playback_grants
         SET json = json_set(json, '$.revokedAt', ?)
         WHERE session_id = ? AND json_extract(json, '$.revokedAt') IS NULL`
      )
      .run(revokedAt, sessionId);
  }

  #putNodeCertificate(value: NodeCertificateState): void {
    this.#db
      .prepare(
        'INSERT INTO node_certificates(serial_number,node_id,json,created_at) VALUES(?,?,?,?)'
      )
      .run(value.serialNumber, value.nodeId, JSON.stringify(value), value.createdAt);
  }

  #revokeNodeCertificates(nodeId: string, revokedAt: string): void {
    this.#db
      .prepare(
        `UPDATE node_certificates
         SET json = json_set(json, '$.revokedAt', ?)
         WHERE node_id = ? AND json_extract(json, '$.revokedAt') IS NULL`
      )
      .run(revokedAt, nodeId);
  }

  #getStoredProvider(id: string): StoredProviderRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT json, revision, deletion_pending
         FROM providers
         WHERE id = ?`
      )
      .get(id) as { json: string; revision: number; deletion_pending: number } | undefined;
    return row
      ? {
          value: JSON.parse(row.json) as ProviderConnection,
          revision: row.revision,
          deletionPending: row.deletion_pending === 1
        }
      : undefined;
  }

  #getStoredProviderBinding(id: string): StoredProviderBindingRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT json,revision,deletion_pending
         FROM provider_bindings
         WHERE id=?`
      )
      .get(id) as { json: string; revision: number; deletion_pending: number } | undefined;
    if (!row) return undefined;
    const deletionPending = row.deletion_pending === 1;
    return {
      value: storedProviderBinding(JSON.parse(row.json) as ProviderBinding, deletionPending),
      revision: row.revision,
      deletionPending
    };
  }

  #providerDependencies(id: string): string[] {
    const sessions = this.#db
      .prepare(
        `SELECT id FROM sessions
         WHERE json_extract(json, '$.source.providerId') = ?
         ORDER BY id`
      )
      .all(id) as Array<{ id: string }>;
    const bindings = this.#db
      .prepare('SELECT id FROM provider_bindings WHERE provider_id = ? ORDER BY id')
      .all(id) as Array<{ id: string }>;
    return [
      ...sessions.map(({ id: sessionId }) => `session:${sessionId}`),
      ...bindings.map(({ id: bindingId }) => `binding:${bindingId}`)
    ];
  }

  #put(
    table: string,
    keyColumn: string,
    key: string,
    entity: StoredEntity | ClusterNode | SegmentJob | ProviderBinding,
    dateColumn: string,
    date: string
  ): void {
    this.#db
      .prepare(
        `INSERT INTO ${table}(${keyColumn}, json, ${dateColumn}) VALUES (?, ?, ?)
         ON CONFLICT(${keyColumn}) DO UPDATE SET json = excluded.json, ${dateColumn} = excluded.${dateColumn}`
      )
      .run(key, JSON.stringify(entity), date);
  }

  #list<T>(table: string, orderBy: string): T[] {
    const rows = this.#db.prepare(`SELECT json FROM ${table} ORDER BY ${orderBy}`).all() as Array<{
      json: string;
    }>;
    return rows.map((row) => JSON.parse(row.json) as T);
  }

  #get<T>(table: string, keyColumn: string, key: string): T | undefined {
    return this.#parseRow<T>(
      this.#db.prepare(`SELECT json FROM ${table} WHERE ${keyColumn} = ?`).get(key)
    );
  }

  #getVersioned<T>(table: string, keyColumn: string, key: string): VersionedRecord<T> | undefined {
    const row = this.#db
      .prepare(`SELECT json, revision FROM ${table} WHERE ${keyColumn} = ?`)
      .get(key) as { json: string; revision: number } | undefined;
    return row ? { value: JSON.parse(row.json) as T, revision: row.revision } : undefined;
  }

  #compareAndSetVersioned<T extends object>(
    table: string,
    keyColumn: string,
    key: string,
    value: T,
    dateColumn: string,
    date: string,
    expectedRevision: number,
    allowedStates?: readonly string[]
  ): AtomicWriteResult<T> {
    const stateClause = allowedStates?.length
      ? ` AND json_extract(json, '$.state') IN (${allowedStates.map(() => '?').join(', ')})`
      : '';
    const result = this.#db
      .prepare(
        `UPDATE ${table}
         SET json = ?, ${dateColumn} = ?, revision = revision + 1
         WHERE ${keyColumn} = ? AND revision = ?${stateClause}`
      )
      .run(JSON.stringify(value), date, key, expectedRevision, ...(allowedStates ?? []));
    if (result.changes === 1)
      return { applied: true, record: { value, revision: expectedRevision + 1 } };
    const current = this.#getVersioned<T>(table, keyColumn, key);
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.revision !== expectedRevision)
      return { applied: false, reason: 'revision-conflict', current };
    return { applied: false, reason: 'invalid-state', current };
  }

  #parseRow<T>(row: unknown): T | undefined {
    if (!row || typeof row !== 'object' || !('json' in row) || typeof row.json !== 'string')
      return undefined;
    return JSON.parse(row.json) as T;
  }
}
