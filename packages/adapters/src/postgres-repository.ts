// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type {
  AuditEvent,
  ClusterNode,
  CompatibilityResult,
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

export interface PostgresMigration {
  version: number;
  name: string;
  checksum: string;
  statements: readonly string[];
}

export function postgresMigrationChecksum(
  migration: Pick<PostgresMigration, 'version' | 'name' | 'statements'>
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

export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
  {
    version: 1,
    name: 'core repository',
    checksum: 'b686d6e695034e4585ec1152f2b46a6d9110a765f08a8ccb7634e2509c1c532d',
    statements: [
      'CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)',
      'CREATE TABLE IF NOT EXISTS profiles(profile_id TEXT NOT NULL, revision INTEGER NOT NULL, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(profile_id, revision))',
      'CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)',
      'CREATE TABLE IF NOT EXISTS playback_grants(token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)',
      'CREATE INDEX IF NOT EXISTS playback_grants_session ON playback_grants(session_id)',
      'CREATE TABLE IF NOT EXISTS live_channels(id TEXT PRIMARY KEY, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)',
      'CREATE TABLE IF NOT EXISTS compatibility_results(id TEXT PRIMARY KEY, document JSONB NOT NULL, tested_at TIMESTAMPTZ NOT NULL)',
      'CREATE TABLE IF NOT EXISTS personal_tokens(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)',
      'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL)'
    ]
  },
  {
    version: 2,
    name: 'cluster repository',
    checksum: '15b485dc75b440db87a46cb31cc7f07cdc14b0b8ea13bf2ce06bc92820aabbb3',
    statements: [
      'CREATE TABLE IF NOT EXISTS cluster_nodes(id TEXT PRIMARY KEY, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)',
      'CREATE TABLE IF NOT EXISTS segment_jobs(id TEXT PRIMARY KEY, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)',
      'CREATE TABLE IF NOT EXISTS provider_bindings(id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, node_id TEXT NOT NULL, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)',
      'CREATE INDEX IF NOT EXISTS provider_bindings_provider ON provider_bindings(provider_id)',
      'CREATE INDEX IF NOT EXISTS provider_bindings_node ON provider_bindings(node_id)',
      'CREATE TABLE IF NOT EXISTS node_certificates(serial_number TEXT PRIMARY KEY, node_id TEXT NOT NULL, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)',
      'CREATE INDEX IF NOT EXISTS node_certificates_node ON node_certificates(node_id)',
      'CREATE TABLE IF NOT EXISTS agent_logs(id TEXT PRIMARY KEY, node_id TEXT NOT NULL, document JSONB NOT NULL, timestamp TIMESTAMPTZ NOT NULL)',
      'CREATE INDEX IF NOT EXISTS agent_logs_node_time ON agent_logs(node_id, timestamp DESC)'
    ]
  },
  {
    version: 3,
    name: 'atomic revisions and audit log',
    checksum: '07e6a4dc87deb911528ca71348125c7fdf9c3f6236187b98c905c2214726f4ba',
    statements: [
      'ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE cluster_nodes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE segment_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE provider_bindings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE schema_migrations ADD COLUMN name TEXT',
      'ALTER TABLE schema_migrations ADD COLUMN checksum TEXT',
      `CREATE TABLE audit_events(
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_id TEXT,
        target_id TEXT,
        document JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL
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
    name: 'atomic providers and guarded deletion',
    checksum: 'b28304013651dcab73ee7162a2b0f13b522194a3b2d3d1fabbdad6d2361fec07',
    statements: [
      'ALTER TABLE providers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE providers ADD COLUMN deletion_pending BOOLEAN NOT NULL DEFAULT FALSE'
    ]
  },
  {
    version: 6,
    name: 'crash-safe provider binding deletion',
    checksum: '95796a88dede83f8f5080df58fa7855195210e81329f3e95331035732d2ce736',
    statements: [
      'ALTER TABLE provider_bindings ADD COLUMN deletion_pending BOOLEAN NOT NULL DEFAULT FALSE'
    ]
  },
  {
    version: 7,
    name: 'bounded job logs',
    checksum: 'a6be0b5c739e2061a3a82531d31c3f898e78df9ff4d10bb36d7c29e8013521ea',
    statements: [
      'CREATE TABLE IF NOT EXISTS job_logs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, node_id TEXT, document JSONB NOT NULL, timestamp TIMESTAMPTZ NOT NULL)',
      'CREATE INDEX IF NOT EXISTS job_logs_job_time ON job_logs(job_id, timestamp DESC)'
    ]
  },
  {
    version: 8,
    name: 'unified user identities',
    checksum: 'f6cf2edc208e6003911bb79da98080f6d0f55125fd1179fe5dbe7c5d80884ae9',
    statements: [
      'CREATE TABLE user_identities(id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, provider_user_id TEXT NOT NULL, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL, revision INTEGER NOT NULL DEFAULT 1, UNIQUE(provider_id, provider_user_id))',
      'CREATE INDEX user_identities_last_seen ON user_identities(updated_at DESC)',
      `INSERT INTO settings(key,value,updated_at,revision)
       SELECT 'auth.signInConfiguration',value,updated_at,revision
       FROM settings WHERE key='portal.configuration'
       ON CONFLICT(key) DO NOTHING`,
      `DELETE FROM settings WHERE key='portal.configuration'`
    ]
  },
  {
    version: 9,
    name: 'durable vod producers',
    checksum: '9fec89ef2f5f3852c9645d65158ef181d33168f40f57456c700c97125b2f2851',
    statements: [
      'CREATE TABLE vod_producers(session_id TEXT PRIMARY KEY, state TEXT NOT NULL, owner_node_id TEXT, document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL, revision INTEGER NOT NULL DEFAULT 1)',
      'CREATE INDEX vod_producers_state_time ON vod_producers(state, updated_at DESC)',
      'CREATE INDEX vod_producers_owner ON vod_producers(owner_node_id)'
    ]
  }
] as const;

const POSTGRES_APPLICATION_TABLES = [
  'providers',
  'profiles',
  'sessions',
  'playback_grants',
  'live_channels',
  'compatibility_results',
  'personal_tokens',
  'settings',
  'cluster_nodes',
  'segment_jobs',
  'vod_producers',
  'provider_bindings',
  'node_certificates',
  'agent_logs',
  'job_logs',
  'audit_events'
] as const;

const POSTGRES_MIGRATION_LOCK = 1_448_233_289;

interface PostgresColumnRequirement {
  udtName: 'bool' | 'int4' | 'jsonb' | 'text' | 'timestamptz';
  nullable: boolean;
  runtimeDefault: '1' | 'false' | null;
}

function requiredPostgresColumn(
  udtName: PostgresColumnRequirement['udtName'],
  nullable = false,
  runtimeDefault: PostgresColumnRequirement['runtimeDefault'] = null
): PostgresColumnRequirement {
  return { udtName, nullable, runtimeDefault };
}

const POSTGRES_REQUIRED_COLUMNS: Readonly<
  Record<string, Readonly<Record<string, PostgresColumnRequirement>>>
> = {
  schema_migrations: {
    version: requiredPostgresColumn('int4'),
    name: requiredPostgresColumn('text', true),
    checksum: requiredPostgresColumn('text', true),
    applied_at: requiredPostgresColumn('timestamptz')
  },
  providers: {
    id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    updated_at: requiredPostgresColumn('timestamptz'),
    revision: requiredPostgresColumn('int4', false, '1'),
    deletion_pending: requiredPostgresColumn('bool', false, 'false')
  },
  profiles: {
    profile_id: requiredPostgresColumn('text'),
    revision: requiredPostgresColumn('int4'),
    document: requiredPostgresColumn('jsonb'),
    created_at: requiredPostgresColumn('timestamptz')
  },
  sessions: {
    id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    updated_at: requiredPostgresColumn('timestamptz'),
    revision: requiredPostgresColumn('int4', false, '1')
  },
  playback_grants: {
    token_hash: requiredPostgresColumn('text'),
    session_id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    created_at: requiredPostgresColumn('timestamptz')
  },
  live_channels: {
    id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    created_at: requiredPostgresColumn('timestamptz'),
    revision: requiredPostgresColumn('int4', false, '1')
  },
  compatibility_results: {
    id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    tested_at: requiredPostgresColumn('timestamptz')
  },
  personal_tokens: {
    id: requiredPostgresColumn('text'),
    token_hash: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    created_at: requiredPostgresColumn('timestamptz')
  },
  user_identities: {
    id: requiredPostgresColumn('text'),
    provider_id: requiredPostgresColumn('text'),
    provider_user_id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    updated_at: requiredPostgresColumn('timestamptz'),
    revision: requiredPostgresColumn('int4', false, '1')
  },
  settings: {
    key: requiredPostgresColumn('text'),
    value: requiredPostgresColumn('text'),
    updated_at: requiredPostgresColumn('timestamptz'),
    revision: requiredPostgresColumn('int4', false, '1')
  },
  cluster_nodes: {
    id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    updated_at: requiredPostgresColumn('timestamptz'),
    revision: requiredPostgresColumn('int4', false, '1')
  },
  segment_jobs: {
    id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    updated_at: requiredPostgresColumn('timestamptz'),
    revision: requiredPostgresColumn('int4', false, '1')
  },
  vod_producers: {
    session_id: requiredPostgresColumn('text'),
    state: requiredPostgresColumn('text'),
    owner_node_id: requiredPostgresColumn('text', true),
    document: requiredPostgresColumn('jsonb'),
    updated_at: requiredPostgresColumn('timestamptz'),
    revision: requiredPostgresColumn('int4', false, '1')
  },
  provider_bindings: {
    id: requiredPostgresColumn('text'),
    provider_id: requiredPostgresColumn('text'),
    node_id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    updated_at: requiredPostgresColumn('timestamptz'),
    revision: requiredPostgresColumn('int4', false, '1'),
    deletion_pending: requiredPostgresColumn('bool', false, 'false')
  },
  node_certificates: {
    serial_number: requiredPostgresColumn('text'),
    node_id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    created_at: requiredPostgresColumn('timestamptz')
  },
  agent_logs: {
    id: requiredPostgresColumn('text'),
    node_id: requiredPostgresColumn('text'),
    document: requiredPostgresColumn('jsonb'),
    timestamp: requiredPostgresColumn('timestamptz')
  },
  job_logs: {
    id: requiredPostgresColumn('text'),
    job_id: requiredPostgresColumn('text'),
    node_id: requiredPostgresColumn('text', true),
    document: requiredPostgresColumn('jsonb'),
    timestamp: requiredPostgresColumn('timestamptz')
  },
  audit_events: {
    id: requiredPostgresColumn('text'),
    category: requiredPostgresColumn('text'),
    action: requiredPostgresColumn('text'),
    actor_id: requiredPostgresColumn('text', true),
    target_id: requiredPostgresColumn('text', true),
    document: requiredPostgresColumn('jsonb'),
    occurred_at: requiredPostgresColumn('timestamptz')
  }
};

const POSTGRES_REQUIRED_CONSTRAINTS = [
  { table: 'schema_migrations', type: 'PRIMARY KEY', columns: ['version'] },
  { table: 'providers', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'profiles', type: 'PRIMARY KEY', columns: ['profile_id', 'revision'] },
  { table: 'sessions', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'playback_grants', type: 'PRIMARY KEY', columns: ['token_hash'] },
  { table: 'live_channels', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'compatibility_results', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'personal_tokens', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'personal_tokens', type: 'UNIQUE', columns: ['token_hash'] },
  { table: 'user_identities', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'user_identities', type: 'UNIQUE', columns: ['provider_id', 'provider_user_id'] },
  { table: 'settings', type: 'PRIMARY KEY', columns: ['key'] },
  { table: 'cluster_nodes', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'segment_jobs', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'vod_producers', type: 'PRIMARY KEY', columns: ['session_id'] },
  { table: 'provider_bindings', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'node_certificates', type: 'PRIMARY KEY', columns: ['serial_number'] },
  { table: 'agent_logs', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'job_logs', type: 'PRIMARY KEY', columns: ['id'] },
  { table: 'audit_events', type: 'PRIMARY KEY', columns: ['id'] }
] as const;

const POSTGRES_REQUIRED_INDEXES: Readonly<
  Record<string, { table: string; columns: readonly string[] }>
> = {
  playback_grants_session: { table: 'playback_grants', columns: ['session_id'] },
  provider_bindings_provider: { table: 'provider_bindings', columns: ['provider_id'] },
  provider_bindings_node: { table: 'provider_bindings', columns: ['node_id'] },
  node_certificates_node: { table: 'node_certificates', columns: ['node_id'] },
  agent_logs_node_time: { table: 'agent_logs', columns: ['node_id', 'timestamp'] },
  job_logs_job_time: { table: 'job_logs', columns: ['job_id', 'timestamp'] },
  vod_producers_state_time: {
    table: 'vod_producers',
    columns: ['state', 'updated_at']
  },
  vod_producers_owner: { table: 'vod_producers', columns: ['owner_node_id'] },
  user_identities_last_seen: { table: 'user_identities', columns: ['updated_at'] },
  audit_events_time: { table: 'audit_events', columns: ['occurred_at'] },
  audit_events_category_time: {
    table: 'audit_events',
    columns: ['category', 'occurred_at']
  },
  audit_events_actor_time: { table: 'audit_events', columns: ['actor_id', 'occurred_at'] },
  audit_events_target_time: { table: 'audit_events', columns: ['target_id', 'occurred_at'] }
};

function postgresColumnList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

function postgresRuntimeDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return `<invalid:${typeof value}>`;
  const normalized = value.replaceAll(/\s+/g, '').toLowerCase();
  if (/^\(?1\)?(?:::(?:int4|integer))?$/.test(normalized)) return '1';
  if (/^\(?false\)?(?:::(?:bool|boolean))?$/.test(normalized)) return 'false';
  return normalized;
}

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

interface PostgresMigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresMigrationBackupContext {
  driver: 'postgres';
  currentVersion: number;
  targetVersion: number;
  existingSchema: boolean;
}

export interface PostgresMigrationBackupArtifact {
  location: string;
  sha256: string;
  createdAt: string;
}

export interface PostgresRepositoryOptions {
  backupBeforeMigration?: (
    context: PostgresMigrationBackupContext
  ) => Promise<PostgresMigrationBackupArtifact>;
  requireMigrationBackup?: boolean;
}

function validatePostgresMigrationDefinitions(migrations: readonly PostgresMigration[]): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1)
      throw new Error('PostgreSQL migration definitions must be contiguous and start at version 1');
    if (!migration.name || migration.statements.length === 0)
      throw new Error(`PostgreSQL migration ${migration.version} is incomplete`);
    if (migration.checksum !== postgresMigrationChecksum(migration))
      throw new Error(
        `PostgreSQL migration ${migration.version} checksum does not match its immutable definition`
      );
  }
}

interface AppliedPostgresMigration {
  version: number;
  name: string | null;
  checksum: string | null;
}

interface PostgresMigrationHistory {
  exists: boolean;
  rows: AppliedPostgresMigration[];
  hasMetadata: boolean;
}

function validatePostgresMigrationHistory(
  history: PostgresMigrationHistory,
  migrations: readonly PostgresMigration[]
): void {
  const latest = migrations.at(-1)?.version ?? 0;
  const future = history.rows.find(({ version }) => version > latest)?.version;
  if (future !== undefined)
    throw new Error(
      `PostgreSQL schema version ${future} is newer than this VRRelay build supports (${latest})`
    );
  for (const [index, applied] of history.rows.entries()) {
    const version = applied.version;
    if (version !== index + 1)
      throw new Error('PostgreSQL migration history is not a contiguous prefix of this build');
    if (history.hasMetadata) {
      const expected = migrations[index];
      if (!expected || applied.name !== expected.name || applied.checksum !== expected.checksum)
        throw new Error(`PostgreSQL migration ${version} history does not match this build`);
    }
  }
  if (!history.hasMetadata && history.rows.some(({ version }) => version >= 3))
    throw new Error('PostgreSQL migration history is missing immutable metadata');
}

async function postgresMigrationHistory(
  client: PostgresMigrationClient
): Promise<PostgresMigrationHistory> {
  const relation = await client.query("SELECT to_regclass('schema_migrations') AS name");
  if (!relation.rows[0]?.name) return { exists: false, rows: [], hasMetadata: false };
  const columns = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'schema_migrations'
       AND column_name = ANY($1::text[])`,
    [['name', 'checksum']]
  );
  const present = new Set(columns.rows.map(({ column_name }) => String(column_name)));
  const hasName = present.has('name');
  const hasChecksum = present.has('checksum');
  if (hasName !== hasChecksum)
    throw new Error('PostgreSQL migration history metadata columns are incomplete');
  const hasMetadata = hasName && hasChecksum;
  const result = await client.query(
    hasMetadata
      ? 'SELECT version,name,checksum FROM schema_migrations ORDER BY version'
      : 'SELECT version,NULL::text AS name,NULL::text AS checksum FROM schema_migrations ORDER BY version'
  );
  return {
    exists: true,
    hasMetadata,
    rows: result.rows.map(({ version, name, checksum }) => ({
      version: Number(version),
      name: typeof name === 'string' ? name : null,
      checksum: typeof checksum === 'string' ? checksum : null
    }))
  };
}

async function postgresHasExistingSchema(client: PostgresMigrationClient): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
    ) AS present`,
    [[...POSTGRES_APPLICATION_TABLES]]
  );
  return result.rows[0]?.present === true;
}

export async function assertPostgresSchemaCurrent(
  client: PostgresMigrationClient,
  migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS
): Promise<void> {
  validatePostgresMigrationDefinitions(migrations);
  const history = await postgresMigrationHistory(client);
  if (!history.exists)
    throw new Error('PostgreSQL schema is not initialized; run migrations on the controller first');
  validatePostgresMigrationHistory(history, migrations);
  const latest = migrations.at(-1)?.version ?? 0;
  if (history.rows.length !== latest)
    throw new Error(
      `PostgreSQL schema is at version ${history.rows.at(-1)?.version ?? 0}; version ${latest} is required`
    );
  const requiredTables = Object.keys(POSTGRES_REQUIRED_COLUMNS);
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [requiredTables]
  );
  const presentTables = new Set(tables.rows.map(({ table_name }) => String(table_name)));
  const missingTable = requiredTables.find((table) => !presentTables.has(table));
  if (missingTable) throw new Error(`PostgreSQL schema is missing required table ${missingTable}`);
  const columns = await client.query(
    `SELECT table_name,column_name,udt_name,is_nullable,column_default
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])`,
    [requiredTables]
  );
  type ActualPostgresColumn = {
    udtName: string;
    nullable: boolean;
    runtimeDefault: string | null;
  };
  const actualColumns = new Map<string, Map<string, ActualPostgresColumn>>();
  for (const { table_name, column_name, udt_name, is_nullable, column_default } of columns.rows) {
    const table = String(table_name);
    const column = String(column_name);
    const tableColumns = actualColumns.get(table) ?? new Map<string, ActualPostgresColumn>();
    tableColumns.set(column, {
      udtName: String(udt_name),
      nullable: String(is_nullable) === 'YES',
      runtimeDefault: postgresRuntimeDefault(column_default)
    });
    actualColumns.set(table, tableColumns);
  }
  for (const [table, requiredColumns] of Object.entries(POSTGRES_REQUIRED_COLUMNS)) {
    const tableColumns = actualColumns.get(table) ?? new Map<string, ActualPostgresColumn>();
    for (const [column, required] of Object.entries(requiredColumns)) {
      const actual = tableColumns.get(column);
      if (!actual)
        throw new Error(`PostgreSQL schema is missing required column ${table}.${column}`);
      if (actual.udtName !== required.udtName)
        throw new Error(
          `PostgreSQL column ${table}.${column} has UDT ${actual.udtName}; expected ${required.udtName}`
        );
      if (actual.nullable !== required.nullable)
        throw new Error(
          `PostgreSQL column ${table}.${column} has nullability ${actual.nullable ? 'YES' : 'NO'}; expected ${required.nullable ? 'YES' : 'NO'}`
        );
      if (actual.runtimeDefault !== required.runtimeDefault)
        throw new Error(
          `PostgreSQL column ${table}.${column} has runtime default ${actual.runtimeDefault ?? '<none>'}; expected ${required.runtimeDefault ?? '<none>'}`
        );
    }
    const unexpectedColumn = [...tableColumns.keys()].find(
      (column) => !(column in requiredColumns)
    );
    if (unexpectedColumn)
      throw new Error(`PostgreSQL schema has unexpected column ${table}.${unexpectedColumn}`);
  }

  const constraints = await client.query(
    `SELECT tc.table_name,tc.constraint_type,
            array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position)::text[] AS columns
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_schema=tc.constraint_schema
      AND kcu.constraint_name=tc.constraint_name
      AND kcu.table_name=tc.table_name
     WHERE tc.constraint_schema=current_schema()
       AND tc.table_name=ANY($1::text[])
       AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
     GROUP BY tc.table_name,tc.constraint_type,tc.constraint_name`,
    [requiredTables]
  );
  const presentConstraints = new Set(
    constraints.rows.map(
      ({ table_name, constraint_type, columns: constrainedColumns }) =>
        `${String(table_name)}:${String(constraint_type)}:${postgresColumnList(constrainedColumns).join(',')}`
    )
  );
  for (const constraint of POSTGRES_REQUIRED_CONSTRAINTS) {
    const key = `${constraint.table}:${constraint.type}:${constraint.columns.join(',')}`;
    if (!presentConstraints.has(key))
      throw new Error(
        `PostgreSQL schema is missing required ${constraint.type.toLowerCase()} constraint on ${constraint.table}(${constraint.columns.join(', ')})`
      );
  }

  const requiredIndexNames = Object.keys(POSTGRES_REQUIRED_INDEXES);
  const indexes = await client.query(
    `SELECT table_relation.relname AS table_name,
            index_relation.relname AS index_name,
            array_agg(attribute.attname::text ORDER BY indexed_column.ordinality)::text[] AS columns
     FROM pg_catalog.pg_index index_definition
     JOIN pg_catalog.pg_class table_relation
       ON table_relation.oid=index_definition.indrelid
     JOIN pg_catalog.pg_namespace table_namespace
       ON table_namespace.oid=table_relation.relnamespace
     JOIN pg_catalog.pg_class index_relation
       ON index_relation.oid=index_definition.indexrelid
     CROSS JOIN LATERAL unnest(index_definition.indkey)
       WITH ORDINALITY AS indexed_column(attribute_number,ordinality)
     JOIN pg_catalog.pg_attribute attribute
       ON attribute.attrelid=table_relation.oid
      AND attribute.attnum=indexed_column.attribute_number
     WHERE table_namespace.nspname=current_schema()
       AND index_relation.relname=ANY($1::text[])
     GROUP BY table_relation.relname,index_relation.relname`,
    [requiredIndexNames]
  );
  const presentIndexes = new Map(
    indexes.rows.map(({ table_name, index_name, columns: indexedColumns }) => [
      String(index_name),
      { table: String(table_name), columns: postgresColumnList(indexedColumns) }
    ])
  );
  for (const [indexName, expected] of Object.entries(POSTGRES_REQUIRED_INDEXES)) {
    const actual = presentIndexes.get(indexName);
    if (
      !actual ||
      actual.table !== expected.table ||
      actual.columns.join(',') !== expected.columns.join(',')
    )
      throw new Error(
        `PostgreSQL schema is missing required index ${indexName}(${expected.columns.join(', ')})`
      );
  }
}

export async function runPostgresMigrations(
  client: PostgresMigrationClient,
  options: PostgresRepositoryOptions = {},
  migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS
): Promise<PostgresMigrationBackupArtifact | undefined> {
  validatePostgresMigrationDefinitions(migrations);
  await client.query('SELECT pg_advisory_lock($1)', [POSTGRES_MIGRATION_LOCK]);
  let inTransaction = false;
  let backupArtifact: PostgresMigrationBackupArtifact | undefined;
  try {
    let history = await postgresMigrationHistory(client);
    validatePostgresMigrationHistory(history, migrations);
    const pending = history.rows.length < migrations.length;
    if (!pending) return undefined;
    const existingSchema = await postgresHasExistingSchema(client);
    if (existingSchema) {
      const backupRequired = options.requireMigrationBackup ?? true;
      if (backupRequired && !options.backupBeforeMigration)
        throw new Error('PostgreSQL migration backup is required but no backup hook is configured');
      backupArtifact = await options.backupBeforeMigration?.({
        driver: 'postgres',
        currentVersion: history.rows.at(-1)?.version ?? 0,
        targetVersion: migrations.at(-1)?.version ?? 0,
        existingSchema
      });
      if (backupRequired && !backupArtifact)
        throw new Error('PostgreSQL migration backup hook did not return an artifact');
      if (
        backupArtifact &&
        (!backupArtifact.location ||
          !/^[a-f0-9]{64}$/.test(backupArtifact.sha256) ||
          !Number.isFinite(Date.parse(backupArtifact.createdAt)))
      )
        throw new Error('PostgreSQL migration backup hook returned an invalid artifact');
    }

    await client.query('BEGIN');
    inTransaction = true;
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)'
    );
    for (const migration of migrations.slice(history.rows.length)) {
      for (const statement of migration.statements) await client.query(statement);
      history = await postgresMigrationHistory(client);
      if (history.hasMetadata) {
        for (const applied of migrations.slice(0, migration.version - 1))
          await client.query(
            `UPDATE schema_migrations
             SET name=$1,checksum=$2
             WHERE version=$3 AND name IS NULL AND checksum IS NULL`,
            [applied.name, applied.checksum, applied.version]
          );
        await client.query(
          `INSERT INTO schema_migrations(version,name,checksum,applied_at)
           VALUES($1,$2,$3,NOW())`,
          [migration.version, migration.name, migration.checksum]
        );
      } else {
        await client.query('INSERT INTO schema_migrations(version, applied_at) VALUES($1, NOW())', [
          migration.version
        ]);
      }
    }
    validatePostgresMigrationHistory(await postgresMigrationHistory(client), migrations);
    await client.query('COMMIT');
    inTransaction = false;
    return backupArtifact;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [POSTGRES_MIGRATION_LOCK]);
  }
}

export class PostgresRepository implements Repository, ClusterRepository, AuditRepository {
  readonly #pool: Pool;
  #lastMigrationBackup: PostgresMigrationBackupArtifact | undefined;

  constructor(
    config: string | PoolConfig,
    private readonly options: PostgresRepositoryOptions = {}
  ) {
    this.#pool = new Pool(typeof config === 'string' ? { connectionString: config } : config);
    // pg emits failures from idle clients on the pool itself. If this event has
    // no listener, a routine database restart terminates the Node process.
    // Active repository operations still reject normally and can be retried by
    // the caller once the pool reconnects.
    this.#pool.on('error', () => undefined);
  }

  async migrate(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      const backup = await runPostgresMigrations(client, this.options);
      if (backup) this.#lastMigrationBackup = backup;
    } finally {
      client.release();
    }
  }

  async assertSchemaCurrent(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await assertPostgresSchemaCurrent(client);
    } finally {
      client.release();
    }
  }

  get lastMigrationBackup(): PostgresMigrationBackupArtifact | undefined {
    return this.#lastMigrationBackup;
  }

  async createProvider(value: ProviderConnection): Promise<VersionedRecord<ProviderConnection>> {
    const result = await this.#pool.query(
      `INSERT INTO providers(id,document,updated_at,revision,deletion_pending)
       VALUES($1,$2,$3,1,FALSE)
       RETURNING revision`,
      [value.id, value, value.updatedAt]
    );
    return { value, revision: Number(result.rows[0]?.revision) };
  }

  async listProviders(): Promise<ProviderConnection[]> {
    return (
      await this.#pool.query(
        'SELECT document FROM providers WHERE deletion_pending=FALSE ORDER BY updated_at DESC'
      )
    ).rows.map((row) => row.document as ProviderConnection);
  }

  async getProvider(id: string): Promise<ProviderConnection | undefined> {
    const result = await this.#pool.query(
      'SELECT document FROM providers WHERE id=$1 AND deletion_pending=FALSE',
      [id]
    );
    return result.rows[0]?.document as ProviderConnection | undefined;
  }

  async getVersionedProvider(id: string): Promise<VersionedRecord<ProviderConnection> | undefined> {
    const result = await this.#pool.query(
      'SELECT document,revision FROM providers WHERE id=$1 AND deletion_pending=FALSE',
      [id]
    );
    const row = result.rows[0] as { document: ProviderConnection; revision: number } | undefined;
    return row ? { value: row.document, revision: row.revision } : undefined;
  }

  async compareAndSetProvider(
    value: ProviderConnection,
    expectedRevision: number
  ): Promise<AtomicWriteResult<ProviderConnection>> {
    const result = await this.#pool.query(
      `UPDATE providers
       SET document=$1,updated_at=$2,revision=revision + 1
       WHERE id=$3 AND revision=$4 AND deletion_pending=FALSE
       RETURNING revision`,
      [value, value.updatedAt, value.id, expectedRevision]
    );
    const revision = result.rows[0]?.revision as number | undefined;
    if (revision !== undefined) return { applied: true, record: { value, revision } };
    const current = await this.#getInternalProvider(value.id);
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.record.revision !== expectedRevision)
      return { applied: false, reason: 'revision-conflict', current: current.record };
    if (current.deletionPending)
      return { applied: false, reason: 'invalid-state', current: current.record };
    return { applied: false, reason: 'invalid-state', current: current.record };
  }

  async beginProviderDeletion(id: string): Promise<AtomicWriteResult<ProviderConnection>> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        'SELECT document,revision,deletion_pending FROM providers WHERE id=$1 FOR UPDATE',
        [id]
      );
      const row = selected.rows[0] as
        { document: ProviderConnection; revision: number; deletion_pending: boolean } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'not-found' };
      }
      const current = { value: row.document, revision: row.revision };
      if (row.deletion_pending) {
        await client.query('ROLLBACK');
        return { applied: true, record: current };
      }
      const dependencies = await this.#providerDependencies(client, id);
      if (dependencies.length > 0) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'dependency-conflict', current, dependencies };
      }
      const updated = await client.query(
        `UPDATE providers
         SET deletion_pending=TRUE,revision=revision + 1
         WHERE id=$1 AND revision=$2 AND deletion_pending=FALSE
         RETURNING revision`,
        [id, row.revision]
      );
      const revision = updated.rows[0]?.revision as number | undefined;
      if (revision === undefined) throw new Error('Locked provider deletion transition was lost');
      await client.query('COMMIT');
      return { applied: true, record: { value: row.document, revision } };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeProviderDeletion(
    id: string,
    expectedRevision: number
  ): Promise<AtomicDeleteResult<ProviderConnection>> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        'SELECT document,revision,deletion_pending FROM providers WHERE id=$1 FOR UPDATE',
        [id]
      );
      const row = selected.rows[0] as
        { document: ProviderConnection; revision: number; deletion_pending: boolean } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'not-found' };
      }
      const current = { value: row.document, revision: row.revision };
      if (row.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'revision-conflict', current };
      }
      if (!row.deletion_pending) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'invalid-state', current };
      }
      const dependencies = await this.#providerDependencies(client, id);
      if (dependencies.length > 0) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'dependency-conflict', current, dependencies };
      }
      const deleted = await client.query(
        `DELETE FROM providers
         WHERE id=$1 AND revision=$2 AND deletion_pending=TRUE
         RETURNING revision`,
        [id, expectedRevision]
      );
      if (deleted.rows.length !== 1) throw new Error('Locked provider deletion was lost');
      await client.query('COMMIT');
      return { applied: true, deleted: current };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async putProfile(value: ProfileRevision): Promise<void> {
    await this.#pool.query(
      'INSERT INTO profiles(profile_id,revision,document,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [value.profileId, value.revision, value, value.createdAt]
    );
  }
  async listProfiles() {
    return this.#list<ProfileRevision>('profiles', 'profile_id, revision DESC');
  }
  async getProfile(id: string, revision?: number): Promise<ProfileRevision | undefined> {
    const result = revision
      ? await this.#pool.query(
          'SELECT document FROM profiles WHERE profile_id=$1 AND revision=$2',
          [id, revision]
        )
      : await this.#pool.query(
          'SELECT document FROM profiles WHERE profile_id=$1 ORDER BY revision DESC LIMIT 1',
          [id]
        );
    return result.rows[0]?.document as ProfileRevision | undefined;
  }

  async createSessionWithPlaybackGrant(
    session: RelaySession,
    grant: PlaybackGrant,
    expectedLiveChannelRevision?: number
  ): Promise<AtomicWriteResult<RelaySession>> {
    if (grant.sessionId !== session.id)
      throw new Error('Playback grant must belong to the session being created');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      if (session.kind === 'vod') {
        if (!session.source?.providerId)
          throw new Error('VOD session creation requires a provider source');
        const selected = await client.query(
          'SELECT deletion_pending FROM providers WHERE id=$1 FOR SHARE',
          [session.source.providerId]
        );
        const provider = selected.rows[0] as { deletion_pending: boolean } | undefined;
        if (!provider) {
          await client.query('ROLLBACK');
          return { applied: false, reason: 'not-found' };
        }
        if (provider.deletion_pending) {
          await client.query('ROLLBACK');
          return { applied: false, reason: 'invalid-state' };
        }
      } else {
        if (!session.liveChannelId || expectedLiveChannelRevision === undefined)
          throw new Error('Live session creation requires an expected live-channel revision');
        const selected = await client.query(
          'SELECT revision FROM live_channels WHERE id=$1 FOR SHARE',
          [session.liveChannelId]
        );
        const revision = selected.rows[0]?.revision as number | undefined;
        if (revision === undefined) {
          await client.query('ROLLBACK');
          return { applied: false, reason: 'not-found' };
        }
        if (revision !== expectedLiveChannelRevision) {
          await client.query('ROLLBACK');
          return { applied: false, reason: 'revision-conflict' };
        }
      }
      await client.query(
        `INSERT INTO playback_grants(token_hash,session_id,document,created_at)
         VALUES($1,$2,$3,$4)`,
        [grant.tokenHash, grant.sessionId, grant, grant.createdAt]
      );
      await client.query(
        'INSERT INTO sessions(id,document,updated_at,revision) VALUES($1,$2,$3,1)',
        [session.id, session, session.updatedAt]
      );
      await client.query('COMMIT');
      return { applied: true, record: { value: session, revision: 1 } };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async listSessions() {
    return this.#list<RelaySession>('sessions', 'updated_at DESC');
  }
  async getSession(id: string) {
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
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await this.#revokePlaybackGrants(client, sessionId, revokedAt);
      await client.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPlaybackGrant(hash: string) {
    return this.#get<PlaybackGrant>('playback_grants', 'token_hash', hash);
  }

  async createLiveChannel(value: LiveChannel): Promise<VersionedRecord<LiveChannel>> {
    const result = await this.#pool.query(
      `INSERT INTO live_channels(id,document,created_at,revision)
       VALUES($1,$2,$3,1)
       RETURNING revision`,
      [value.id, value, value.createdAt]
    );
    return { value, revision: Number(result.rows[0]?.revision) };
  }
  async createLiveChannelWithinCapacity(
    value: LiveChannel,
    limits: { maxTotal: number; maxPerOwner: number }
  ): Promise<LiveChannelCapacityWriteResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('vrrelay:live-channels'))");
      const total = Number(
        (await client.query('SELECT COUNT(*) AS count FROM live_channels')).rows[0]?.count ?? 0
      );
      if (total >= limits.maxTotal) {
        await client.query('ROLLBACK');
        return { created: false, reason: 'installation-limit' };
      }
      if (value.ownerId) {
        const owned = Number(
          (
            await client.query(
              `SELECT COUNT(*) AS count
                 FROM live_channels
                WHERE document->>'ownerId' = $1`,
              [value.ownerId]
            )
          ).rows[0]?.count ?? 0
        );
        if (owned >= limits.maxPerOwner) {
          await client.query('ROLLBACK');
          return { created: false, reason: 'owner-limit' };
        }
      }
      const result = await client.query(
        `INSERT INTO live_channels(id,document,created_at,revision)
         VALUES($1,$2,$3,1)
         RETURNING revision`,
        [value.id, value, value.createdAt]
      );
      await client.query('COMMIT');
      return {
        created: true,
        record: { value, revision: Number(result.rows[0]?.revision) }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listLiveChannels() {
    return this.#list<LiveChannel>('live_channels', 'created_at DESC');
  }
  async getLiveChannel(id: string) {
    return this.#get<LiveChannel>('live_channels', 'id', id);
  }
  async getVersionedLiveChannel(id: string): Promise<VersionedRecord<LiveChannel> | undefined> {
    return this.#getVersioned<LiveChannel>('live_channels', 'id', id);
  }
  async compareAndSetLiveChannel(
    value: LiveChannel,
    expectedRevision: number
  ): Promise<AtomicWriteResult<LiveChannel>> {
    return this.#compareAndSetVersioned(
      'live_channels',
      'id',
      value.id,
      value,
      'created_at',
      value.createdAt,
      expectedRevision
    );
  }
  async deleteLiveChannel(
    id: string,
    expectedRevision: number
  ): Promise<AtomicWriteResult<LiveChannel>> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        'SELECT document,revision FROM live_channels WHERE id=$1 FOR UPDATE',
        [id]
      );
      const row = selected.rows[0] as { document: LiveChannel; revision: number } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'not-found' };
      }
      const current = { value: row.document, revision: row.revision };
      if (row.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'revision-conflict', current };
      }
      if (row.document.publisherState !== 'offline') {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'invalid-state', current };
      }
      const dependent = await client.query(
        `SELECT 1 FROM sessions
         WHERE document->>'liveChannelId'=$1
         LIMIT 1`,
        [id]
      );
      if (dependent.rows.length > 0) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'invalid-state', current };
      }
      const deleted = await client.query(
        'DELETE FROM live_channels WHERE id=$1 AND revision=$2 RETURNING revision',
        [id, expectedRevision]
      );
      if (deleted.rows.length !== 1) throw new Error('Locked live-channel deletion was lost');
      await client.query('COMMIT');
      return { applied: true, record: current };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async putCompatibilityResult(value: CompatibilityResult) {
    await this.#put('compatibility_results', 'id', value.id, value, 'tested_at', value.testedAt);
  }
  async listCompatibilityResults() {
    return this.#list<CompatibilityResult>('compatibility_results', 'tested_at DESC');
  }

  async putPersonalToken(value: PersonalAccessToken): Promise<void> {
    await this.#pool.query(
      'INSERT INTO personal_tokens(id,token_hash,document,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET token_hash=EXCLUDED.token_hash,document=EXCLUDED.document',
      [value.id, value.tokenHash, value, value.createdAt]
    );
  }
  async getPersonalToken(hash: string) {
    return this.#get<PersonalAccessToken>('personal_tokens', 'token_hash', hash);
  }
  async usePersonalToken(update: PersonalTokenUse): Promise<PersonalAccessToken | undefined> {
    const result = await this.#pool.query(
      `UPDATE personal_tokens
       SET document = CASE
         WHEN document->>'lastUsedAt' IS NULL OR document->>'lastUsedAt' <= $2
         THEN jsonb_set(document, '{lastUsedAt}', to_jsonb($3::text), true)
         ELSE document
       END
       WHERE token_hash=$1
         AND document->>'revokedAt' IS NULL
         AND (document->>'expiresAt' IS NULL OR document->>'expiresAt' > $3)
       RETURNING document`,
      [update.tokenHash, update.touchBefore, update.usedAt]
    );
    return result.rows[0]?.document as PersonalAccessToken | undefined;
  }
  async listPersonalTokens() {
    return this.#list<PersonalAccessToken>('personal_tokens', 'created_at DESC');
  }
  async revokePersonalToken(id: string, revokedAt = new Date().toISOString()): Promise<void> {
    await this.#pool.query(
      `UPDATE personal_tokens
       SET document=jsonb_set(document, '{revokedAt}', to_jsonb($2::text), true)
       WHERE id=$1 AND document->>'revokedAt' IS NULL`,
      [id, revokedAt]
    );
  }

  async createUserIdentity(value: UserIdentity): Promise<VersionedRecord<UserIdentity>> {
    const result = await this.#pool.query(
      `INSERT INTO user_identities
       (id,provider_id,provider_user_id,document,updated_at,revision)
       VALUES($1,$2,$3,$4,$5,1) RETURNING revision`,
      [value.id, value.providerId, value.providerUserId, value, value.lastSeenAt]
    );
    return { value, revision: Number(result.rows[0]?.revision) };
  }

  async listUserIdentities(): Promise<Array<VersionedRecord<UserIdentity>>> {
    return (
      await this.#pool.query(
        'SELECT document,revision FROM user_identities ORDER BY updated_at DESC'
      )
    ).rows.map((row) => ({ value: row.document as UserIdentity, revision: Number(row.revision) }));
  }

  async getUserIdentity(id: string): Promise<VersionedRecord<UserIdentity> | undefined> {
    const row = (
      await this.#pool.query('SELECT document,revision FROM user_identities WHERE id=$1', [id])
    ).rows[0] as { document: UserIdentity; revision: number } | undefined;
    return row ? { value: row.document, revision: row.revision } : undefined;
  }

  async compareAndSetUserIdentity(
    value: UserIdentity,
    expectedRevision: number
  ): Promise<AtomicWriteResult<UserIdentity>> {
    const result = await this.#pool.query(
      `UPDATE user_identities SET document=$1,updated_at=$2,revision=revision+1
       WHERE id=$3 AND revision=$4 RETURNING revision`,
      [value, value.lastSeenAt, value.id, expectedRevision]
    );
    const revision = result.rows[0]?.revision as number | undefined;
    if (revision !== undefined) return { applied: true, record: { value, revision } };
    const current = await this.getUserIdentity(value.id);
    return current
      ? { applied: false, reason: 'revision-conflict', current }
      : { applied: false, reason: 'not-found' };
  }

  async compareAndSetUserIdentityPreservingOwner(
    value: UserIdentity,
    expectedRevision: number
  ): Promise<AtomicWriteResult<UserIdentity>> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('vrrelay:user-owners'))");
      const row = (
        await client.query('SELECT document,revision FROM user_identities WHERE id=$1 FOR UPDATE', [
          value.id
        ])
      ).rows[0] as { document: UserIdentity; revision: number } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'not-found' };
      }
      const current = { value: row.document, revision: Number(row.revision) };
      if (current.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'revision-conflict', current };
      }
      if (current.value.roles.includes('owner') && !value.roles.includes('owner')) {
        const ownerCount = Number(
          (
            await client.query(
              `SELECT COUNT(*) AS count
               FROM user_identities
               WHERE document->'roles' ? 'owner'`
            )
          ).rows[0]?.count ?? 0
        );
        if (ownerCount <= 1) {
          await client.query('ROLLBACK');
          return {
            applied: false,
            reason: 'dependency-conflict',
            current,
            dependencies: ['assigned-owner']
          };
        }
      }
      const result = await client.query(
        `UPDATE user_identities
         SET document=$1,updated_at=$2,revision=revision+1
         WHERE id=$3 AND revision=$4
         RETURNING revision`,
        [value, value.lastSeenAt, value.id, expectedRevision]
      );
      const revision = Number(result.rows[0]?.revision);
      if (!Number.isFinite(revision)) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'revision-conflict', current };
      }
      await client.query('COMMIT');
      return { applied: true, record: { value, revision } };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async putSetting(key: string, value: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO settings(key,value,updated_at,revision) VALUES($1,$2,NOW(),1)
       ON CONFLICT(key) DO UPDATE SET
         value=EXCLUDED.value,
         updated_at=NOW(),
         revision=settings.revision + 1`,
      [key, value]
    );
  }
  async getSetting(key: string): Promise<string | undefined> {
    return (await this.#pool.query('SELECT value FROM settings WHERE key=$1', [key])).rows[0]
      ?.value as string | undefined;
  }

  async getVersionedSetting(key: string): Promise<VersionedRecord<string> | undefined> {
    const row = (await this.#pool.query('SELECT value,revision FROM settings WHERE key=$1', [key]))
      .rows[0] as { value: string; revision: number } | undefined;
    return row ? { value: row.value, revision: row.revision } : undefined;
  }

  async putSettingIfAbsent(key: string, value: string): Promise<SettingInsertResult> {
    const result = await this.#pool.query(
      `INSERT INTO settings(key,value,updated_at,revision)
       VALUES($1,$2,NOW(),1)
       ON CONFLICT(key) DO NOTHING
       RETURNING value,revision`,
      [key, value]
    );
    const inserted = result.rows[0] as { value: string; revision: number } | undefined;
    if (inserted)
      return { inserted: true, record: { value: inserted.value, revision: inserted.revision } };
    const record = await this.getVersionedSetting(key);
    if (!record) throw new Error('Setting insert did not produce a readable record');
    return { inserted: false, record };
  }

  async compareAndSetSetting(
    key: string,
    value: string,
    expectedRevision: number
  ): Promise<AtomicWriteResult<string>> {
    const result = await this.#pool.query(
      `UPDATE settings
       SET value=$1,updated_at=NOW(),revision=revision + 1
       WHERE key=$2 AND revision=$3
       RETURNING revision`,
      [value, key, expectedRevision]
    );
    const revision = result.rows[0]?.revision as number | undefined;
    if (revision !== undefined) return { applied: true, record: { value, revision } };
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
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO cluster_nodes(id,document,updated_at,revision) VALUES($1,$2,$3,1)',
        [node.id, node, node.updatedAt]
      );
      if (initialCertificate)
        await client.query(
          `INSERT INTO node_certificates(serial_number,node_id,document,created_at)
           VALUES($1,$2,$3,$4)`,
          [
            initialCertificate.serialNumber,
            initialCertificate.nodeId,
            initialCertificate,
            initialCertificate.createdAt
          ]
        );
      await client.query('COMMIT');
      return { value: node, revision: 1 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async ensureLocalNode(node: ClusterNode): Promise<VersionedRecord<ClusterNode>> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO cluster_nodes(id,document,updated_at,revision)
         VALUES($1,$2,$3,1)
         ON CONFLICT(id) DO NOTHING
         RETURNING revision`,
        [node.id, node, node.updatedAt]
      );
      if (inserted.rows[0]) {
        await client.query('COMMIT');
        return { value: node, revision: Number(inserted.rows[0].revision) };
      }
      const selected = await client.query(
        'SELECT document,revision FROM cluster_nodes WHERE id=$1 FOR UPDATE',
        [node.id]
      );
      const current = selected.rows[0] as { document: ClusterNode; revision: number } | undefined;
      if (!current) throw new Error('Local node upsert did not produce a readable record');
      const state =
        current.document.state === 'draining' || current.document.state === 'revoked'
          ? current.document.state
          : node.state;
      const certificateExpiresAt =
        node.certificateExpiresAt ?? current.document.certificateExpiresAt;
      const ensured: ClusterNode = {
        ...node,
        state,
        createdAt: current.document.createdAt,
        ...(certificateExpiresAt ? { certificateExpiresAt } : {})
      };
      const updated = await client.query(
        `UPDATE cluster_nodes
         SET document=$1,updated_at=$2,revision=revision + 1
         WHERE id=$3 AND revision=$4
         RETURNING revision`,
        [ensured, ensured.updatedAt, node.id, current.revision]
      );
      const revision = updated.rows[0]?.revision as number | undefined;
      if (revision === undefined) throw new Error('Locked local node update was lost');
      await client.query('COMMIT');
      return { value: ensured, revision };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async getNode(id: string) {
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
    const state =
      current.value.state === 'draining' || current.value.state === 'revoked'
        ? current.value.state
        : update.reportedState;
    const node: ClusterNode = {
      ...current.value,
      capabilities: update.capabilities,
      state,
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
  async listNodes() {
    return this.#list<ClusterNode>('cluster_nodes', 'updated_at DESC');
  }

  async removeNode(id: string, expectedRevision: number): Promise<AtomicDeleteResult<ClusterNode>> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        'SELECT document,revision FROM cluster_nodes WHERE id=$1 FOR UPDATE',
        [id]
      );
      const row = selected.rows[0] as { document: ClusterNode; revision: number } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'not-found' };
      }
      const current = { value: row.document, revision: row.revision };
      if (row.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'revision-conflict', current };
      }
      if (row.document.state !== 'revoked') {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'invalid-state', current };
      }
      const bindings = await client.query(
        'SELECT id FROM provider_bindings WHERE node_id=$1 ORDER BY id',
        [id]
      );
      const dependencies = bindings.rows.map(({ id: bindingId }) => `binding:${String(bindingId)}`);
      if (dependencies.length > 0) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'dependency-conflict', current, dependencies };
      }
      const deleted = await client.query(
        'DELETE FROM cluster_nodes WHERE id=$1 AND revision=$2 RETURNING revision',
        [id, expectedRevision]
      );
      if (deleted.rows.length !== 1) throw new Error('Locked node removal was lost');
      await client.query('COMMIT');
      return { applied: true, deleted: current };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async createSegmentJob(job: SegmentJob): Promise<SegmentJobCreateResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO segment_jobs(id,document,updated_at,revision)
         VALUES($1,$2,$3,1)
         ON CONFLICT(id) DO NOTHING
         RETURNING document,revision`,
        [job.id, job, job.updatedAt]
      );
      const insertedRow = inserted.rows[0] as
        { document: SegmentJob; revision: number } | undefined;
      if (insertedRow) {
        await client.query('COMMIT');
        return {
          created: true,
          record: { value: insertedRow.document, revision: insertedRow.revision }
        };
      }
      const selected = await client.query(
        'SELECT document,revision FROM segment_jobs WHERE id=$1 FOR UPDATE',
        [job.id]
      );
      const current = selected.rows[0] as { document: SegmentJob; revision: number } | undefined;
      if (!current) throw new Error('Segment job creation did not produce a readable record');
      await client.query('COMMIT');
      return { created: false, record: { value: current.document, revision: current.revision } };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async getSegmentJob(id: string) {
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
    return (
      await this.#pool.query(
        'SELECT document FROM segment_jobs ORDER BY updated_at DESC LIMIT $1',
        [limit]
      )
    ).rows.map((row) => row.document as SegmentJob);
  }
  async createVodProducer(
    producer: VodProducer
  ): Promise<{ created: boolean; record: VersionedRecord<VodProducer> }> {
    const inserted = await this.#pool.query(
      `INSERT INTO vod_producers(session_id,state,owner_node_id,document,updated_at,revision)
       VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(session_id) DO NOTHING RETURNING document,revision`,
      [
        producer.sessionId,
        producer.state,
        producer.ownerNodeId ?? null,
        producer,
        producer.updatedAt
      ]
    );
    const row = inserted.rows[0] as { document: VodProducer; revision: number } | undefined;
    if (row) return { created: true, record: { value: row.document, revision: row.revision } };
    const record = await this.#getVersioned<VodProducer>(
      'vod_producers',
      'session_id',
      producer.sessionId
    );
    if (!record) throw new Error('VOD producer creation did not produce a readable record');
    return { created: false, record };
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
    return (
      await this.#pool.query(
        'SELECT document FROM vod_producers ORDER BY updated_at DESC LIMIT $1',
        [limit]
      )
    ).rows.map((row) => row.document as VodProducer);
  }
  async compareAndSetVodProducer(
    producer: VodProducer,
    expectedRevision: number,
    allowedCurrentStates: readonly VodProducer['state'][]
  ): Promise<AtomicWriteResult<VodProducer>> {
    if (!allowedCurrentStates.length)
      throw new Error('A VOD producer transition must declare its allowed current states');
    const result = await this.#pool.query(
      `UPDATE vod_producers
       SET state=$1,owner_node_id=$2,document=$3,updated_at=$4,revision=revision+1
       WHERE session_id=$5 AND revision=$6 AND state=ANY($7::text[]) RETURNING revision`,
      [
        producer.state,
        producer.ownerNodeId ?? null,
        producer,
        producer.updatedAt,
        producer.sessionId,
        expectedRevision,
        [...allowedCurrentStates]
      ]
    );
    const revision = result.rows[0]?.revision as number | undefined;
    if (revision !== undefined) return { applied: true, record: { value: producer, revision } };
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
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      let bindingResult = await client.query(
        `SELECT document,revision,deletion_pending
         FROM provider_bindings WHERE id=$1 FOR UPDATE`,
        [binding.id]
      );
      let currentBinding = bindingResult.rows[0] as
        { document: ProviderBinding; revision: number; deletion_pending: boolean } | undefined;
      if (currentBinding) {
        const providerResult = await client.query(
          'SELECT document FROM providers WHERE id=$1 FOR SHARE',
          [provider.id]
        );
        const currentProvider = providerResult.rows[0]?.document as ProviderConnection | undefined;
        await client.query('ROLLBACK');
        return {
          applied: false,
          reason: currentBinding.deletion_pending ? 'binding-deleting' : 'binding-conflict',
          ...(currentProvider ? { provider: currentProvider } : {}),
          binding: {
            value: storedProviderBinding(currentBinding.document, currentBinding.deletion_pending),
            revision: currentBinding.revision
          }
        };
      }

      const nodeResult = await client.query(
        'SELECT document FROM cluster_nodes WHERE id=$1 FOR SHARE',
        [binding.nodeId]
      );
      const node = nodeResult.rows[0]?.document as ClusterNode | undefined;
      if (!node || node.state === 'revoked' || !node.roles.includes('source-worker')) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'node-unavailable' };
      }

      const providerResult = await client.query(
        `SELECT document,revision,deletion_pending
         FROM providers WHERE id=$1 FOR UPDATE`,
        [provider.id]
      );
      let currentProvider = providerResult.rows[0] as
        { document: ProviderConnection; revision: number; deletion_pending: boolean } | undefined;
      let storedProvider: ProviderConnection;

      // A concurrent creator can insert the binding while this transaction is
      // waiting on the provider row. Re-read it after acquiring that lock so a
      // retry observes the committed binding instead of reporting a stale
      // provider revision/conflict.
      bindingResult = await client.query(
        `SELECT document,revision,deletion_pending
         FROM provider_bindings WHERE id=$1 FOR UPDATE`,
        [binding.id]
      );
      currentBinding = bindingResult.rows[0] as
        { document: ProviderBinding; revision: number; deletion_pending: boolean } | undefined;
      if (currentBinding) {
        await client.query('ROLLBACK');
        return {
          applied: false,
          reason: currentBinding.deletion_pending ? 'binding-deleting' : 'binding-conflict',
          ...(currentProvider ? { provider: currentProvider.document } : {}),
          binding: {
            value: storedProviderBinding(currentBinding.document, currentBinding.deletion_pending),
            revision: currentBinding.revision
          }
        };
      }

      if (expectedProviderRevision === null) {
        if (currentProvider) {
          await client.query('ROLLBACK');
          return {
            applied: false,
            reason: currentProvider.deletion_pending ? 'provider-deleting' : 'provider-conflict',
            provider: currentProvider.document
          };
        }
        const insertedProvider = await client.query(
          `INSERT INTO providers(id,document,updated_at,revision,deletion_pending)
           VALUES($1,$2,$3,1,FALSE)
           ON CONFLICT(id) DO NOTHING
           RETURNING revision`,
          [provider.id, provider, provider.updatedAt]
        );
        if (insertedProvider.rows.length !== 1) {
          currentProvider = (
            await client.query(
              `SELECT document,revision,deletion_pending
               FROM providers WHERE id=$1 FOR UPDATE`,
              [provider.id]
            )
          ).rows[0] as
            | { document: ProviderConnection; revision: number; deletion_pending: boolean }
            | undefined;
          bindingResult = await client.query(
            `SELECT document,revision,deletion_pending
             FROM provider_bindings WHERE id=$1 FOR UPDATE`,
            [binding.id]
          );
          currentBinding = bindingResult.rows[0] as
            { document: ProviderBinding; revision: number; deletion_pending: boolean } | undefined;
          await client.query('ROLLBACK');
          if (currentBinding)
            return {
              applied: false,
              reason: currentBinding.deletion_pending ? 'binding-deleting' : 'binding-conflict',
              ...(currentProvider ? { provider: currentProvider.document } : {}),
              binding: {
                value: storedProviderBinding(
                  currentBinding.document,
                  currentBinding.deletion_pending
                ),
                revision: currentBinding.revision
              }
            };
          return {
            applied: false,
            reason: currentProvider?.deletion_pending ? 'provider-deleting' : 'provider-conflict',
            ...(currentProvider ? { provider: currentProvider.document } : {})
          };
        }
        storedProvider = provider;
      } else {
        if (!currentProvider) {
          await client.query('ROLLBACK');
          return { applied: false, reason: 'provider-not-found' };
        }
        if (currentProvider.deletion_pending) {
          await client.query('ROLLBACK');
          return {
            applied: false,
            reason: 'provider-deleting',
            provider: currentProvider.document
          };
        }
        if (currentProvider.revision !== expectedProviderRevision) {
          await client.query('ROLLBACK');
          return {
            applied: false,
            reason: 'provider-revision-conflict',
            provider: currentProvider.document
          };
        }
        if (!providersReferenceSameServer(currentProvider.document, provider)) {
          await client.query('ROLLBACK');
          return {
            applied: false,
            reason: 'provider-conflict',
            provider: currentProvider.document
          };
        }
        storedProvider = mergeProviderMetadata(currentProvider.document, provider);
        const updatedProvider = await client.query(
          `UPDATE providers
           SET document=$1,updated_at=$2,revision=revision + 1
           WHERE id=$3 AND revision=$4 AND deletion_pending=FALSE
           RETURNING revision`,
          [storedProvider, storedProvider.updatedAt, storedProvider.id, expectedProviderRevision]
        );
        if (updatedProvider.rows.length !== 1)
          throw new Error('Locked provider binding update was lost');
      }

      const storedBinding = storedProviderBinding(binding, false);
      const insertedBinding = await client.query(
        `INSERT INTO provider_bindings(
           id,provider_id,node_id,document,updated_at,revision,deletion_pending
         ) VALUES($1,$2,$3,$4,$5,1,FALSE)
         ON CONFLICT(id) DO NOTHING
         RETURNING revision`,
        [
          storedBinding.id,
          storedBinding.providerId,
          storedBinding.nodeId,
          storedBinding,
          storedBinding.updatedAt
        ]
      );
      if (insertedBinding.rows.length !== 1) {
        const replay = await client.query(
          `SELECT document,revision,deletion_pending
           FROM provider_bindings WHERE id=$1 FOR UPDATE`,
          [binding.id]
        );
        const replayBinding = replay.rows[0] as
          { document: ProviderBinding; revision: number; deletion_pending: boolean } | undefined;
        if (!replayBinding) throw new Error('Provider binding conflict was not readable');
        await client.query('ROLLBACK');
        return {
          applied: false,
          reason: replayBinding.deletion_pending ? 'binding-deleting' : 'binding-conflict',
          provider: storedProvider,
          binding: {
            value: storedProviderBinding(replayBinding.document, replayBinding.deletion_pending),
            revision: replayBinding.revision
          }
        };
      }
      await client.query('COMMIT');
      return {
        applied: true,
        provider: storedProvider,
        binding: { value: storedBinding, revision: 1 }
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async getProviderBinding(
    id: string,
    options: { includeDeletionPending?: boolean } = {}
  ): Promise<ProviderBinding | undefined> {
    const current = await this.#getInternalProviderBinding(id);
    return current && (options.includeDeletionPending || !current.deletionPending)
      ? current.record.value
      : undefined;
  }
  async getVersionedProviderBinding(
    id: string,
    options: { includeDeletionPending?: boolean } = {}
  ): Promise<VersionedRecord<ProviderBinding> | undefined> {
    const current = await this.#getInternalProviderBinding(id);
    return current && (options.includeDeletionPending || !current.deletionPending)
      ? current.record
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
    const values: unknown[] = [
      storedBinding,
      storedBinding.updatedAt,
      storedBinding.id,
      expectedRevision,
      storedBinding.providerId,
      storedBinding.nodeId,
      storedBinding.secretRef
    ];
    const stateClause = allowedCurrentStates?.length
      ? " AND document->>'state' = ANY($8::text[])"
      : '';
    if (allowedCurrentStates?.length) values.push([...allowedCurrentStates]);
    const result = await this.#pool.query(
      `UPDATE provider_bindings
       SET document=$1,updated_at=$2,revision=revision + 1
       WHERE id=$3 AND revision=$4 AND deletion_pending=FALSE
         AND document->>'providerId'=$5
         AND document->>'nodeId'=$6
         AND document->>'secretRef'=$7${stateClause}
       RETURNING revision`,
      values
    );
    const revision = result.rows[0]?.revision as number | undefined;
    if (revision !== undefined)
      return { applied: true, record: { value: storedBinding, revision } };
    const internal = await this.#getInternalProviderBinding(binding.id);
    const current = internal?.record;
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.revision !== expectedRevision)
      return { applied: false, reason: 'revision-conflict', current };
    return { applied: false, reason: 'invalid-state', current };
  }
  async listProviderBindings(
    providerId?: string,
    options: { includeDeletionPending?: boolean } = {}
  ): Promise<ProviderBinding[]> {
    const values: unknown[] = [];
    const filters: string[] = [];
    if (providerId) {
      values.push(providerId);
      filters.push(`provider_id=$${values.length}`);
    }
    if (!options.includeDeletionPending) filters.push('deletion_pending=FALSE');
    const result = await this.#pool.query(
      `SELECT document,deletion_pending FROM provider_bindings${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY updated_at DESC`,
      values
    );
    return result.rows.map((row) =>
      storedProviderBinding(row.document as ProviderBinding, Boolean(row.deletion_pending))
    );
  }
  async beginProviderBindingDeletion(
    id: string,
    updatedAt: string
  ): Promise<AtomicWriteResult<ProviderBinding>> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT document,revision,deletion_pending
         FROM provider_bindings WHERE id=$1 FOR UPDATE`,
        [id]
      );
      const row = selected.rows[0] as
        { document: ProviderBinding; revision: number; deletion_pending: boolean } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'not-found' };
      }
      const current = {
        value: storedProviderBinding(row.document, row.deletion_pending),
        revision: row.revision
      };
      if (row.deletion_pending) {
        await client.query('ROLLBACK');
        return { applied: true, record: current };
      }
      const pending: ProviderBinding = {
        ...current.value,
        reachable: false,
        state: 'revoked',
        deletionPending: true,
        lastError: BINDING_CLEANUP_PENDING_MESSAGE,
        updatedAt
      };
      const updated = await client.query(
        `UPDATE provider_bindings
         SET document=$1,updated_at=$2,revision=revision + 1,deletion_pending=TRUE
         WHERE id=$3 AND revision=$4 AND deletion_pending=FALSE
         RETURNING revision`,
        [pending, updatedAt, id, row.revision]
      );
      const revision = updated.rows[0]?.revision as number | undefined;
      if (revision === undefined)
        throw new Error('Locked provider binding deletion transition was lost');
      await client.query('COMMIT');
      return { applied: true, record: { value: pending, revision } };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async finalizeProviderBindingDeletion(
    id: string,
    expectedRevision: number
  ): Promise<AtomicDeleteResult<ProviderBinding>> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT document,revision,deletion_pending
         FROM provider_bindings WHERE id=$1 FOR UPDATE`,
        [id]
      );
      const row = selected.rows[0] as
        { document: ProviderBinding; revision: number; deletion_pending: boolean } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'not-found' };
      }
      const current = {
        value: storedProviderBinding(row.document, row.deletion_pending),
        revision: row.revision
      };
      if (row.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'revision-conflict', current };
      }
      if (!row.deletion_pending) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'invalid-state', current };
      }
      const deleted = await client.query(
        `DELETE FROM provider_bindings
         WHERE id=$1 AND revision=$2 AND deletion_pending=TRUE
         RETURNING revision`,
        [id, expectedRevision]
      );
      if (deleted.rows.length !== 1)
        throw new Error('Locked provider binding finalization was lost');
      await client.query('COMMIT');
      return { applied: true, deleted: current };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async rotateNodeCertificate(
    update: NodeCertificateRotation
  ): Promise<AtomicWriteResult<ClusterNode>> {
    if (update.certificate.nodeId !== update.nodeId || update.certificate.revokedAt !== null)
      throw new Error('Certificate rotation requires a new active certificate for the target node');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        'SELECT document,revision FROM cluster_nodes WHERE id=$1 FOR UPDATE',
        [update.nodeId]
      );
      const row = selected.rows[0] as { document: ClusterNode; revision: number } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'not-found' };
      }
      const current = { value: row.document, revision: row.revision };
      if (row.revision !== update.expectedRevision) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'revision-conflict', current };
      }
      if (row.document.state === 'revoked') {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'invalid-state', current };
      }
      const node: ClusterNode = {
        ...row.document,
        certificateExpiresAt: update.certificate.expiresAt,
        updatedAt: update.updatedAt
      };
      const updated = await client.query(
        `UPDATE cluster_nodes
         SET document=$1,updated_at=$2,revision=revision + 1
         WHERE id=$3 AND revision=$4
         RETURNING revision`,
        [node, update.updatedAt, update.nodeId, update.expectedRevision]
      );
      const revision = updated.rows[0]?.revision as number | undefined;
      if (revision === undefined) throw new Error('Locked node certificate rotation was lost');
      await this.#revokeNodeCertificates(client, update.nodeId, update.updatedAt);
      await client.query(
        `INSERT INTO node_certificates(serial_number,node_id,document,created_at)
         VALUES($1,$2,$3,$4)`,
        [
          update.certificate.serialNumber,
          update.nodeId,
          update.certificate,
          update.certificate.createdAt
        ]
      );
      await client.query('COMMIT');
      return { applied: true, record: { value: node, revision } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async revokeNode(update: NodeRevocation): Promise<AtomicWriteResult<ClusterNode>> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        'SELECT document,revision FROM cluster_nodes WHERE id=$1 FOR UPDATE',
        [update.nodeId]
      );
      const row = selected.rows[0] as { document: ClusterNode; revision: number } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'not-found' };
      }
      const current = { value: row.document, revision: row.revision };
      if (row.revision !== update.expectedRevision) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'revision-conflict', current };
      }
      const node: ClusterNode = {
        ...row.document,
        state: 'revoked',
        updatedAt: update.revokedAt
      };
      const updated = await client.query(
        `UPDATE cluster_nodes
         SET document=$1,updated_at=$2,revision=revision + 1
         WHERE id=$3 AND revision=$4
         RETURNING revision`,
        [node, update.revokedAt, update.nodeId, update.expectedRevision]
      );
      const revision = updated.rows[0]?.revision as number | undefined;
      if (revision === undefined) throw new Error('Locked node revocation was lost');
      await client.query(
        `UPDATE provider_bindings
         SET document=document || jsonb_build_object(
               'reachable',FALSE,
               'state','revoked',
               'deletionPending',deletion_pending,
               'lastError',$1::text,
               'updatedAt',$2::text
             ),
             updated_at=$2::timestamptz,revision=revision + 1
         WHERE node_id=$3`,
        [NODE_REVOKED_BINDING_MESSAGE, update.revokedAt, update.nodeId]
      );
      await this.#revokeNodeCertificates(client, update.nodeId, update.revokedAt);
      await client.query('COMMIT');
      return { applied: true, record: { value: node, revision } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listNodeCertificates(nodeId: string): Promise<NodeCertificateState[]> {
    return (
      await this.#pool.query(
        'SELECT document FROM node_certificates WHERE node_id=$1 ORDER BY created_at DESC',
        [nodeId]
      )
    ).rows.map((row) => row.document as NodeCertificateState);
  }
  async putAgentLog(value: AgentLogEntry, retentionRows = 1000): Promise<void> {
    await this.#pool.query(
      'INSERT INTO agent_logs(id,node_id,document,timestamp) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET node_id=EXCLUDED.node_id, document=EXCLUDED.document, timestamp=EXCLUDED.timestamp',
      [value.id, value.nodeId, value, value.timestamp]
    );
    await this.#pool.query(
      `DELETE FROM agent_logs WHERE node_id=$1 AND id NOT IN
      (SELECT id FROM agent_logs WHERE node_id=$1 ORDER BY timestamp DESC LIMIT $2)`,
      [value.nodeId, retentionRows]
    );
  }
  async listAgentLogs(nodeId: string, limit = 200): Promise<AgentLogEntry[]> {
    return (
      await this.#pool.query(
        'SELECT document FROM agent_logs WHERE node_id=$1 ORDER BY timestamp DESC LIMIT $2',
        [nodeId, limit]
      )
    ).rows.map((row) => row.document as AgentLogEntry);
  }
  async putJobLog(value: JobLogEntry, retentionRows = 1000): Promise<void> {
    await this.#pool.query(
      'INSERT INTO job_logs(id,job_id,node_id,document,timestamp) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET job_id=EXCLUDED.job_id, node_id=EXCLUDED.node_id, document=EXCLUDED.document, timestamp=EXCLUDED.timestamp',
      [value.id, value.jobId, value.nodeId ?? null, value, value.timestamp]
    );
    await this.#pool.query(
      `DELETE FROM job_logs WHERE job_id=$1 AND id NOT IN
      (SELECT id FROM job_logs WHERE job_id=$1 ORDER BY timestamp DESC LIMIT $2)`,
      [value.jobId, retentionRows]
    );
  }
  async listJobLogs(jobId: string, limit = 200): Promise<JobLogEntry[]> {
    return (
      await this.#pool.query(
        'SELECT document FROM job_logs WHERE job_id=$1 ORDER BY timestamp DESC LIMIT $2',
        [jobId, limit]
      )
    ).rows.map((row) => row.document as JobLogEntry);
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    await this.#pool.query(
      `INSERT INTO audit_events(
        id,category,action,actor_id,target_id,document,occurred_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO NOTHING`,
      [
        event.id,
        event.category,
        event.action,
        event.actor.id ?? null,
        event.target?.id ?? null,
        event,
        event.occurredAt
      ]
    );
  }

  async listAuditEvents(query: AuditQuery = {}): Promise<AuditEvent[]> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    const add = (column: string, value: string, operator = '=') => {
      values.push(value);
      clauses.push(`${column}${operator}$${values.length}`);
    };
    if (query.category) add('category', query.category);
    if (query.actorId) add('actor_id', query.actorId);
    if (query.targetId) add('target_id', query.targetId);
    if (query.before) add('occurred_at', query.before, '<');
    const limit = Math.max(1, Math.min(query.limit ?? 200, 1_000));
    values.push(limit);
    const result = await this.#pool.query(
      `SELECT document FROM audit_events
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY occurred_at DESC
       LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => row.document as AuditEvent);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #getInternalProvider(id: string): Promise<
    | {
        record: VersionedRecord<ProviderConnection>;
        deletionPending: boolean;
      }
    | undefined
  > {
    const result = await this.#pool.query(
      'SELECT document,revision,deletion_pending FROM providers WHERE id=$1',
      [id]
    );
    const row = result.rows[0] as
      { document: ProviderConnection; revision: number; deletion_pending: boolean } | undefined;
    return row
      ? {
          record: { value: row.document, revision: row.revision },
          deletionPending: row.deletion_pending
        }
      : undefined;
  }

  async #getInternalProviderBinding(
    id: string,
    client: Pick<PoolClient, 'query'> | Pool = this.#pool
  ): Promise<
    | {
        record: VersionedRecord<ProviderBinding>;
        deletionPending: boolean;
      }
    | undefined
  > {
    const result = await client.query(
      'SELECT document,revision,deletion_pending FROM provider_bindings WHERE id=$1',
      [id]
    );
    const row = result.rows[0] as
      { document: ProviderBinding; revision: number; deletion_pending: boolean } | undefined;
    if (!row) return undefined;
    return {
      record: {
        value: storedProviderBinding(row.document, row.deletion_pending),
        revision: row.revision
      },
      deletionPending: row.deletion_pending
    };
  }

  async #providerDependencies(client: Pick<PoolClient, 'query'>, id: string): Promise<string[]> {
    const sessions = await client.query(
      `SELECT id FROM sessions
       WHERE document->>'kind'='vod'
         AND document#>>'{source,providerId}'=$1
       ORDER BY id`,
      [id]
    );
    const bindings = await client.query(
      'SELECT id FROM provider_bindings WHERE provider_id=$1 ORDER BY id',
      [id]
    );
    return [
      ...sessions.rows.map(({ id: sessionId }) => `session:${String(sessionId)}`),
      ...bindings.rows.map(({ id: bindingId }) => `binding:${String(bindingId)}`)
    ];
  }

  async #revokePlaybackGrants(
    client: Pick<PoolClient, 'query'>,
    sessionId: string,
    revokedAt: string
  ): Promise<void> {
    await client.query(
      `UPDATE playback_grants
       SET document=jsonb_set(document, '{revokedAt}', to_jsonb($2::text), true)
       WHERE session_id=$1 AND document->>'revokedAt' IS NULL`,
      [sessionId, revokedAt]
    );
  }

  async #revokeNodeCertificates(
    client: Pick<PoolClient, 'query'>,
    nodeId: string,
    revokedAt: string
  ): Promise<void> {
    await client.query(
      `UPDATE node_certificates
       SET document=jsonb_set(document, '{revokedAt}', to_jsonb($2::text), true)
       WHERE node_id=$1 AND document->>'revokedAt' IS NULL`,
      [nodeId, revokedAt]
    );
  }

  async #put(
    table: string,
    keyColumn: string,
    key: string,
    document: object,
    dateColumn: string,
    date: string
  ): Promise<void> {
    await this.#pool.query(
      `INSERT INTO ${table}(${keyColumn},document,${dateColumn}) VALUES($1,$2,$3) ON CONFLICT(${keyColumn}) DO UPDATE SET document=EXCLUDED.document,${dateColumn}=EXCLUDED.${dateColumn}`,
      [key, document, date]
    );
  }
  async #get<T>(table: string, keyColumn: string, key: string): Promise<T | undefined> {
    return (await this.#pool.query(`SELECT document FROM ${table} WHERE ${keyColumn}=$1`, [key]))
      .rows[0]?.document as T | undefined;
  }
  async #getVersioned<T>(
    table: string,
    keyColumn: string,
    key: string
  ): Promise<VersionedRecord<T> | undefined> {
    const result = await this.#pool.query(
      `SELECT document,revision FROM ${table} WHERE ${keyColumn}=$1`,
      [key]
    );
    const row = result.rows[0] as { document: T; revision: number } | undefined;
    return row ? { value: row.document, revision: row.revision } : undefined;
  }
  async #compareAndSetVersioned<T extends object>(
    table: string,
    keyColumn: string,
    key: string,
    value: T,
    dateColumn: string,
    date: string,
    expectedRevision: number,
    allowedStates?: readonly string[]
  ): Promise<AtomicWriteResult<T>> {
    const values: unknown[] = [value, date, key, expectedRevision];
    const stateClause = allowedStates?.length ? " AND document->>'state' = ANY($5::text[])" : '';
    if (allowedStates?.length) values.push([...allowedStates]);
    const result = await this.#pool.query(
      `UPDATE ${table}
       SET document=$1,${dateColumn}=$2,revision=revision + 1
       WHERE ${keyColumn}=$3 AND revision=$4${stateClause}
       RETURNING revision`,
      values
    );
    const revision = result.rows[0]?.revision as number | undefined;
    if (revision !== undefined) return { applied: true, record: { value, revision } };
    const current = await this.#getVersioned<T>(table, keyColumn, key);
    if (!current) return { applied: false, reason: 'not-found' };
    if (current.revision !== expectedRevision)
      return { applied: false, reason: 'revision-conflict', current };
    return { applied: false, reason: 'invalid-state', current };
  }
  async #list<T>(table: string, order: string): Promise<T[]> {
    return (await this.#pool.query(`SELECT document FROM ${table} ORDER BY ${order}`)).rows.map(
      (row) => row.document as T
    );
  }
}
