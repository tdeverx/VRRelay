import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type {
  AuditEvent,
  ClusterNode,
  LiveChannel,
  PersonalAccessToken,
  PlaybackGrant,
  ProviderBinding,
  ProviderConnection,
  RelaySession,
  SegmentJob
} from '@vrrelay/domain';
import {
  POSTGRES_MIGRATIONS,
  PostgresRepository,
  assertPostgresSchemaCurrent,
  postgresMigrationChecksum,
  runPostgresMigrations
} from './postgres-repository.js';

const artifact = {
  location: '/backups/vrrelay-before-v3.dump',
  sha256: 'a'.repeat(64),
  createdAt: new Date().toISOString()
};

function provider(id: string, baseUrl: string, secretRef: string): ProviderConnection {
  const now = new Date().toISOString();
  return {
    id,
    type: 'jellyfin',
    name: `Provider ${id}`,
    baseUrl,
    authMode: 'user_token',
    secretRef,
    capabilities: ['search'],
    healthy: true,
    createdAt: now,
    updatedAt: now
  };
}

function binding(id: string, providerId: string, nodeId: string): ProviderBinding {
  const now = new Date().toISOString();
  return {
    id,
    providerId,
    nodeId,
    secretRef: `provider-binding:${id}`,
    reachable: true,
    state: 'healthy',
    deletionPending: false,
    validatedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

type FakePostgresColumn = [
  tableName: string,
  columnName: string,
  udtName: string,
  isNullable: 'YES' | 'NO',
  columnDefault: string | null
];

function column(
  tableName: string,
  columnName: string,
  udtName: string,
  isNullable: 'YES' | 'NO' = 'NO',
  columnDefault: string | null = null
): FakePostgresColumn {
  return [tableName, columnName, udtName, isNullable, columnDefault];
}

async function finalizeBindingDeletion(repository: PostgresRepository, id: string): Promise<void> {
  const deleting = await repository.beginProviderBindingDeletion(id, new Date().toISOString());
  if (!deleting.applied) throw new Error(`Binding ${id} deletion did not begin`);
  const finalized = await repository.finalizeProviderBindingDeletion(id, deleting.record.revision);
  if (!finalized.applied) throw new Error(`Binding ${id} deletion did not finalize`);
}

class FakeMigrationClient {
  readonly events: string[] = [];
  applied = [1, 2];
  migrationMetadata = false;
  readonly migrationRecords = new Map<number, { name: string | null; checksum: string | null }>();
  existingSchema = true;
  requiredTables = [
    'schema_migrations',
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
    'provider_bindings',
    'node_certificates',
    'agent_logs',
    'audit_events'
  ];
  requiredColumns: FakePostgresColumn[] = [
    column('schema_migrations', 'version', 'int4'),
    column('schema_migrations', 'name', 'text', 'YES'),
    column('schema_migrations', 'checksum', 'text', 'YES'),
    column('schema_migrations', 'applied_at', 'timestamptz'),
    column('providers', 'id', 'text'),
    column('providers', 'document', 'jsonb'),
    column('providers', 'updated_at', 'timestamptz'),
    column('providers', 'revision', 'int4', 'NO', '1'),
    column('providers', 'deletion_pending', 'bool', 'NO', 'false'),
    column('profiles', 'profile_id', 'text'),
    column('profiles', 'revision', 'int4'),
    column('profiles', 'document', 'jsonb'),
    column('profiles', 'created_at', 'timestamptz'),
    column('sessions', 'id', 'text'),
    column('sessions', 'document', 'jsonb'),
    column('sessions', 'updated_at', 'timestamptz'),
    column('sessions', 'revision', 'int4', 'NO', '1'),
    column('playback_grants', 'token_hash', 'text'),
    column('playback_grants', 'session_id', 'text'),
    column('playback_grants', 'document', 'jsonb'),
    column('playback_grants', 'created_at', 'timestamptz'),
    column('live_channels', 'id', 'text'),
    column('live_channels', 'document', 'jsonb'),
    column('live_channels', 'created_at', 'timestamptz'),
    column('live_channels', 'revision', 'int4', 'NO', '1'),
    column('compatibility_results', 'id', 'text'),
    column('compatibility_results', 'document', 'jsonb'),
    column('compatibility_results', 'tested_at', 'timestamptz'),
    column('personal_tokens', 'id', 'text'),
    column('personal_tokens', 'token_hash', 'text'),
    column('personal_tokens', 'document', 'jsonb'),
    column('personal_tokens', 'created_at', 'timestamptz'),
    column('settings', 'key', 'text'),
    column('settings', 'value', 'text'),
    column('settings', 'updated_at', 'timestamptz'),
    column('settings', 'revision', 'int4', 'NO', '1'),
    column('cluster_nodes', 'id', 'text'),
    column('cluster_nodes', 'document', 'jsonb'),
    column('cluster_nodes', 'updated_at', 'timestamptz'),
    column('cluster_nodes', 'revision', 'int4', 'NO', '1'),
    column('segment_jobs', 'id', 'text'),
    column('segment_jobs', 'document', 'jsonb'),
    column('segment_jobs', 'updated_at', 'timestamptz'),
    column('segment_jobs', 'revision', 'int4', 'NO', '1'),
    column('provider_bindings', 'id', 'text'),
    column('provider_bindings', 'provider_id', 'text'),
    column('provider_bindings', 'node_id', 'text'),
    column('provider_bindings', 'document', 'jsonb'),
    column('provider_bindings', 'updated_at', 'timestamptz'),
    column('provider_bindings', 'revision', 'int4', 'NO', '1'),
    column('provider_bindings', 'deletion_pending', 'bool', 'NO', 'false'),
    column('node_certificates', 'serial_number', 'text'),
    column('node_certificates', 'node_id', 'text'),
    column('node_certificates', 'document', 'jsonb'),
    column('node_certificates', 'created_at', 'timestamptz'),
    column('agent_logs', 'id', 'text'),
    column('agent_logs', 'node_id', 'text'),
    column('agent_logs', 'document', 'jsonb'),
    column('agent_logs', 'timestamp', 'timestamptz'),
    column('audit_events', 'id', 'text'),
    column('audit_events', 'category', 'text'),
    column('audit_events', 'action', 'text'),
    column('audit_events', 'actor_id', 'text', 'YES'),
    column('audit_events', 'target_id', 'text', 'YES'),
    column('audit_events', 'document', 'jsonb'),
    column('audit_events', 'occurred_at', 'timestamptz')
  ];
  constraints = [
    ['schema_migrations', 'PRIMARY KEY', ['version']],
    ['providers', 'PRIMARY KEY', ['id']],
    ['profiles', 'PRIMARY KEY', ['profile_id', 'revision']],
    ['sessions', 'PRIMARY KEY', ['id']],
    ['playback_grants', 'PRIMARY KEY', ['token_hash']],
    ['live_channels', 'PRIMARY KEY', ['id']],
    ['compatibility_results', 'PRIMARY KEY', ['id']],
    ['personal_tokens', 'PRIMARY KEY', ['id']],
    ['personal_tokens', 'UNIQUE', ['token_hash']],
    ['settings', 'PRIMARY KEY', ['key']],
    ['cluster_nodes', 'PRIMARY KEY', ['id']],
    ['segment_jobs', 'PRIMARY KEY', ['id']],
    ['provider_bindings', 'PRIMARY KEY', ['id']],
    ['node_certificates', 'PRIMARY KEY', ['serial_number']],
    ['agent_logs', 'PRIMARY KEY', ['id']],
    ['audit_events', 'PRIMARY KEY', ['id']]
  ] as Array<[string, string, string[]]>;
  indexes = [
    ['playback_grants', 'playback_grants_session', ['session_id']],
    ['provider_bindings', 'provider_bindings_provider', ['provider_id']],
    ['provider_bindings', 'provider_bindings_node', ['node_id']],
    ['node_certificates', 'node_certificates_node', ['node_id']],
    ['agent_logs', 'agent_logs_node_time', ['node_id', 'timestamp']],
    ['audit_events', 'audit_events_time', ['occurred_at']],
    ['audit_events', 'audit_events_category_time', ['category', 'occurred_at']],
    ['audit_events', 'audit_events_actor_time', ['actor_id', 'occurred_at']],
    ['audit_events', 'audit_events_target_time', ['target_id', 'occurred_at']]
  ] as Array<[string, string, string[]]>;
  failWhenSqlIncludes: string | undefined;

  markCurrent(): void {
    this.applied = POSTGRES_MIGRATIONS.map(({ version }) => version);
    this.migrationMetadata = true;
    this.migrationRecords.clear();
    for (const { version, name, checksum } of POSTGRES_MIGRATIONS)
      this.migrationRecords.set(version, { name, checksum });
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    const sql = text.replaceAll(/\s+/g, ' ').trim();
    this.events.push(sql);
    if (this.failWhenSqlIncludes && sql.includes(this.failWhenSqlIncludes))
      throw new Error('simulated migration failure');
    if (sql.includes("to_regclass('schema_migrations')"))
      return { rows: [{ name: this.applied.length ? 'schema_migrations' : null }] };
    if (
      sql.startsWith('SELECT column_name FROM information_schema.columns') &&
      sql.includes("table_name = 'schema_migrations'")
    )
      return {
        rows: this.migrationMetadata ? [{ column_name: 'name' }, { column_name: 'checksum' }] : []
      };
    if (sql.startsWith('SELECT version,') && sql.includes('FROM schema_migrations'))
      return {
        rows: this.applied.map((version) => ({
          version,
          ...(this.migrationRecords.get(version) ?? { name: null, checksum: null })
        }))
      };
    if (sql.startsWith('SELECT table_name FROM information_schema.tables'))
      return { rows: this.requiredTables.map((table_name) => ({ table_name })) };
    if (
      sql.startsWith(
        'SELECT table_name,column_name,udt_name,is_nullable,column_default FROM information_schema.columns'
      )
    )
      return {
        rows: this.requiredColumns.map(
          ([table_name, column_name, udt_name, is_nullable, column_default]) => ({
            table_name,
            column_name,
            udt_name,
            is_nullable,
            column_default
          })
        )
      };
    if (sql.startsWith('SELECT tc.table_name,tc.constraint_type'))
      return {
        rows: this.constraints.map(([table_name, constraint_type, columns]) => ({
          table_name,
          constraint_type,
          columns
        }))
      };
    if (sql.startsWith('SELECT table_relation.relname AS table_name'))
      return {
        rows: this.indexes.map(([table_name, index_name, columns]) => ({
          table_name,
          index_name,
          columns
        }))
      };
    if (sql.includes('information_schema.tables'))
      return { rows: [{ present: this.existingSchema }] };
    if (sql === 'ALTER TABLE schema_migrations ADD COLUMN checksum TEXT')
      this.migrationMetadata = true;
    if (sql.startsWith('UPDATE schema_migrations SET name=$1,checksum=$2'))
      this.migrationRecords.set(Number(values?.[2]), {
        name: String(values?.[0]),
        checksum: String(values?.[1])
      });
    if (sql.startsWith('INSERT INTO schema_migrations')) {
      const version = Number(values?.[0]);
      this.applied.push(version);
      this.migrationRecords.set(
        version,
        values?.length === 3
          ? { name: String(values[1]), checksum: String(values[2]) }
          : { name: null, checksum: null }
      );
    }
    return { rows: [] };
  }
}

describe('PostgreSQL repository migrations', () => {
  it('defines an immutable contiguous migration history', () => {
    expect(POSTGRES_MIGRATIONS.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: 'core repository' },
      { version: 2, name: 'cluster repository' },
      { version: 3, name: 'atomic revisions and audit log' },
      { version: 4, name: 'atomic live channels' },
      { version: 5, name: 'atomic providers and guarded deletion' },
      { version: 6, name: 'crash-safe provider binding deletion' }
    ]);
    expect(POSTGRES_MIGRATIONS[2]?.statements.join('\n')).toContain(
      'ALTER TABLE sessions ADD COLUMN revision'
    );
    expect(POSTGRES_MIGRATIONS[4]?.statements).toEqual([
      'ALTER TABLE providers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE providers ADD COLUMN deletion_pending BOOLEAN NOT NULL DEFAULT FALSE'
    ]);
    expect(POSTGRES_MIGRATIONS[5]?.statements).toEqual([
      'ALTER TABLE provider_bindings ADD COLUMN deletion_pending BOOLEAN NOT NULL DEFAULT FALSE'
    ]);
    for (const item of POSTGRES_MIGRATIONS) {
      expect(item.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(item.checksum).toBe(postgresMigrationChecksum(item));
    }
  });

  it('holds the advisory lock and verifies a backup before beginning a pending upgrade', async () => {
    const client = new FakeMigrationClient();
    const events = client.events;
    const result = await runPostgresMigrations(client, {
      backupBeforeMigration: async (context) => {
        expect(context).toEqual({
          driver: 'postgres',
          currentVersion: 2,
          targetVersion: 6,
          existingSchema: true
        });
        events.push('BACKUP HOOK');
        return artifact;
      }
    });

    expect(result).toEqual(artifact);
    expect(events[0]).toBe('SELECT pg_advisory_lock($1)');
    expect(events.indexOf('BACKUP HOOK')).toBeLessThan(events.indexOf('BEGIN'));
    expect(events.indexOf('BACKUP HOOK')).toBeLessThan(
      events.findIndex((event) => event.startsWith('ALTER TABLE sessions'))
    );
    expect(client.migrationMetadata).toBe(true);
    expect(
      client.applied.map((version) => ({ version, ...client.migrationRecords.get(version)! }))
    ).toEqual(
      POSTGRES_MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum }))
    );
    expect(events.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
  });

  it('fails closed before schema mutation when a required backup is absent or fails', async () => {
    const missing = new FakeMigrationClient();
    await expect(runPostgresMigrations(missing)).rejects.toThrow(
      'backup is required but no backup hook is configured'
    );
    expect(missing.events).not.toContain('BEGIN');
    expect(missing.events.at(-1)).toBe('SELECT pg_advisory_unlock($1)');

    const failed = new FakeMigrationClient();
    await expect(
      runPostgresMigrations(failed, {
        backupBeforeMigration: async () => {
          throw new Error('pg_dump failed');
        }
      })
    ).rejects.toThrow('pg_dump failed');
    expect(failed.events).not.toContain('BEGIN');
    expect(failed.events.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
  });

  it('rolls back a failed migration and always releases the advisory lock', async () => {
    const client = new FakeMigrationClient();
    client.failWhenSqlIncludes = 'ALTER TABLE cluster_nodes';
    await expect(
      runPostgresMigrations(client, { backupBeforeMigration: async () => artifact })
    ).rejects.toThrow('simulated migration failure');
    expect(client.events).toContain('ROLLBACK');
    expect(client.events).not.toContain('COMMIT');
    expect(client.events.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
  });

  it('rejects migration history from a newer build before backup or mutation', async () => {
    const client = new FakeMigrationClient();
    client.applied = [1, 2, 3, 4, 5, 6, 7];
    let backupCalled = false;
    await expect(
      runPostgresMigrations(client, {
        backupBeforeMigration: async () => {
          backupCalled = true;
          return artifact;
        }
      })
    ).rejects.toThrow('newer than this VRRelay build supports');
    expect(backupCalled).toBe(false);
    expect(client.events).not.toContain('BEGIN');
  });

  it('checks current, missing, incomplete, and malformed schemas without mutation', async () => {
    const current = new FakeMigrationClient();
    current.markCurrent();
    await expect(assertPostgresSchemaCurrent(current)).resolves.toBeUndefined();
    expect(current.events.every((event) => event.startsWith('SELECT'))).toBe(true);

    const missing = new FakeMigrationClient();
    missing.applied = [];
    await expect(assertPostgresSchemaCurrent(missing)).rejects.toThrow('schema is not initialized');
    expect(missing.events.every((event) => event.startsWith('SELECT'))).toBe(true);

    const incomplete = new FakeMigrationClient();
    await expect(assertPostgresSchemaCurrent(incomplete)).rejects.toThrow(
      'version 2; version 6 is required'
    );
    expect(incomplete.events.every((event) => event.startsWith('SELECT'))).toBe(true);

    const gapped = new FakeMigrationClient();
    gapped.applied = [1, 3];
    await expect(assertPostgresSchemaCurrent(gapped)).rejects.toThrow('not a contiguous prefix');
    expect(gapped.events.every((event) => event.startsWith('SELECT'))).toBe(true);

    const malformed = new FakeMigrationClient();
    malformed.markCurrent();
    malformed.requiredTables = malformed.requiredTables.filter((table) => table !== 'audit_events');
    await expect(assertPostgresSchemaCurrent(malformed)).rejects.toThrow(
      'missing required table audit_events'
    );
    expect(malformed.events.every((event) => event.startsWith('SELECT'))).toBe(true);

    const missingColumn = new FakeMigrationClient();
    missingColumn.markCurrent();
    missingColumn.requiredColumns = missingColumn.requiredColumns.filter(
      ([table, column]) => table !== 'providers' || column !== 'deletion_pending'
    );
    await expect(assertPostgresSchemaCurrent(missingColumn)).rejects.toThrow(
      'missing required column providers.deletion_pending'
    );

    const extraColumn = new FakeMigrationClient();
    extraColumn.markCurrent();
    extraColumn.requiredColumns.push(column('sessions', 'tampered', 'text', 'YES'));
    await expect(assertPostgresSchemaCurrent(extraColumn)).rejects.toThrow(
      'unexpected column sessions.tampered'
    );

    const wrongType = new FakeMigrationClient();
    wrongType.markCurrent();
    wrongType.requiredColumns = wrongType.requiredColumns.map((entry) =>
      entry[0] === 'settings' && entry[1] === 'revision'
        ? column('settings', 'revision', 'int8', 'NO', '1')
        : entry
    );
    await expect(assertPostgresSchemaCurrent(wrongType)).rejects.toThrow(
      'column settings.revision has UDT int8; expected int4'
    );

    const wrongNullability = new FakeMigrationClient();
    wrongNullability.markCurrent();
    wrongNullability.requiredColumns = wrongNullability.requiredColumns.map((entry) =>
      entry[0] === 'audit_events' && entry[1] === 'actor_id'
        ? column('audit_events', 'actor_id', 'text', 'NO')
        : entry
    );
    await expect(assertPostgresSchemaCurrent(wrongNullability)).rejects.toThrow(
      'column audit_events.actor_id has nullability NO; expected YES'
    );

    const wrongDefault = new FakeMigrationClient();
    wrongDefault.markCurrent();
    wrongDefault.requiredColumns = wrongDefault.requiredColumns.map((entry) =>
      entry[0] === 'provider_bindings' && entry[1] === 'deletion_pending'
        ? column('provider_bindings', 'deletion_pending', 'bool')
        : entry
    );
    await expect(assertPostgresSchemaCurrent(wrongDefault)).rejects.toThrow(
      'column provider_bindings.deletion_pending has runtime default <none>; expected false'
    );

    const missingConstraint = new FakeMigrationClient();
    missingConstraint.markCurrent();
    missingConstraint.constraints = missingConstraint.constraints.filter(
      ([table, type]) => table !== 'personal_tokens' || type !== 'UNIQUE'
    );
    await expect(assertPostgresSchemaCurrent(missingConstraint)).rejects.toThrow(
      'missing required unique constraint on personal_tokens(token_hash)'
    );

    const malformedIndex = new FakeMigrationClient();
    malformedIndex.markCurrent();
    malformedIndex.indexes = malformedIndex.indexes.map(([table, name, columns]) =>
      name === 'provider_bindings_node' ? ['providers', name, columns] : [table, name, columns]
    );
    await expect(assertPostgresSchemaCurrent(malformedIndex)).rejects.toThrow(
      'missing required index provider_bindings_node(node_id)'
    );
  });

  it('rejects changed definitions and tampered immutable migration history', async () => {
    const changed = POSTGRES_MIGRATIONS.map((item, index) =>
      index === 0 ? { ...item, statements: [...item.statements, 'SELECT 1'] } : item
    );
    await expect(assertPostgresSchemaCurrent(new FakeMigrationClient(), changed)).rejects.toThrow(
      'checksum does not match its immutable definition'
    );

    const tampered = new FakeMigrationClient();
    tampered.markCurrent();
    tampered.migrationRecords.set(1, {
      name: POSTGRES_MIGRATIONS[0]!.name,
      checksum: '0'.repeat(64)
    });
    await expect(assertPostgresSchemaCurrent(tampered)).rejects.toThrow(
      'migration 1 history does not match this build'
    );
  });
});

const postgresUrl = process.env.VRRELAY_TEST_POSTGRES_URL;

describe.runIf(Boolean(postgresUrl))('PostgreSQL repository integration', () => {
  it('rejects exact column-shape tampering in a live PostgreSQL schema', async () => {
    const schema = `vrrelay_schema_tamper_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl! });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const config = { connectionString: postgresUrl!, options: `-c search_path=${schema}` };
    const repository = new PostgresRepository(config);
    const inspection = new Pool(config);
    try {
      await repository.migrate();
      const client = await inspection.connect();
      try {
        const expectTamperRejected = async (sql: string, expected: string): Promise<void> => {
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await expect(assertPostgresSchemaCurrent(client)).rejects.toThrow(expected);
          } finally {
            await client.query('ROLLBACK');
          }
          await expect(assertPostgresSchemaCurrent(client)).resolves.toBeUndefined();
        };

        await expectTamperRejected(
          'ALTER TABLE sessions ADD COLUMN tampered TEXT',
          'unexpected column sessions.tampered'
        );
        await expectTamperRejected(
          'ALTER TABLE settings ALTER COLUMN revision TYPE BIGINT',
          'column settings.revision has UDT int8; expected int4'
        );
        await expectTamperRejected(
          'ALTER TABLE audit_events ALTER COLUMN actor_id SET NOT NULL',
          'column audit_events.actor_id has nullability NO; expected YES'
        );
        await expectTamperRejected(
          'ALTER TABLE provider_bindings ALTER COLUMN deletion_pending DROP DEFAULT',
          'column provider_bindings.deletion_pending has runtime default <none>; expected false'
        );
      } finally {
        client.release();
      }
    } finally {
      await Promise.all([repository.close(), inspection.end()]);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it('upgrades v2 data to revisions and persists CAS plus audit records', async () => {
    const schema = `vrrelay_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl! });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const config = { connectionString: postgresUrl!, options: `-c search_path=${schema}` };
    const legacy = new Pool(config);
    const migrationClient = await legacy.connect();
    try {
      await runPostgresMigrations(
        migrationClient,
        { requireMigrationBackup: false },
        POSTGRES_MIGRATIONS.slice(0, 2)
      );
    } finally {
      migrationClient.release();
    }
    const now = new Date().toISOString();
    const value: RelaySession = {
      id: 'session-a',
      name: 'Session A',
      kind: 'live',
      liveChannelId: 'live-a',
      profileId: 'profile-a',
      profileRevision: 1,
      platformMode: 'pc',
      state: 'active',
      pinned: false,
      reportActivity: false,
      viewers: 0,
      placementPolicy: 'local',
      placementLocked: false,
      outputUrls: { primary: 'https://relay.example/play/session' },
      createdAt: now,
      updatedAt: now
    };
    const node: ClusterNode = {
      id: 'node-a',
      name: 'Node A',
      roles: ['source-worker'],
      region: 'local',
      publicUrl: 'https://node.example',
      state: 'online',
      capabilities: {
        encoders: ['libx264'],
        hardwareDevices: [],
        maxWorkers: 2,
        activeWorkers: 0,
        queuedWorkers: 0,
        cacheBytes: 0,
        cacheLimitBytes: 1_024,
        egressMbps: 0,
        providerIds: []
      },
      weight: 100,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now
    };
    const segmentJob: SegmentJob = {
      id: 'job-a',
      contentKey: 'content/job-a',
      sessionId: value.id,
      segmentIndex: 0,
      state: 'running',
      attempts: 1,
      ownerNodeId: node.id,
      workerHistory: [],
      createdAt: now,
      updatedAt: now
    };
    const legacyProvider = provider(
      'provider-legacy-binding',
      'https://legacy.example/jellyfin',
      'provider:legacy-binding'
    );
    const legacyBinding = binding('binding-legacy', legacyProvider.id, node.id);
    await legacy.query('INSERT INTO sessions(id,document,updated_at) VALUES($1,$2,$3)', [
      value.id,
      value,
      value.updatedAt
    ]);
    await legacy.query('INSERT INTO cluster_nodes(id,document,updated_at) VALUES($1,$2,$3)', [
      node.id,
      node,
      node.updatedAt
    ]);
    await legacy.query('INSERT INTO segment_jobs(id,document,updated_at) VALUES($1,$2,$3)', [
      segmentJob.id,
      segmentJob,
      segmentJob.updatedAt
    ]);
    await legacy.query('INSERT INTO providers(id,document,updated_at) VALUES($1,$2,$3)', [
      legacyProvider.id,
      legacyProvider,
      legacyProvider.updatedAt
    ]);
    await legacy.query(
      `INSERT INTO provider_bindings(id,provider_id,node_id,document,updated_at)
       VALUES($1,$2,$3,$4,$5)`,
      [
        legacyBinding.id,
        legacyBinding.providerId,
        legacyBinding.nodeId,
        legacyBinding,
        legacyBinding.updatedAt
      ]
    );
    let backupCalled = false;
    const repository = new PostgresRepository(config, {
      backupBeforeMigration: async (context) => {
        expect(context).toMatchObject({ currentVersion: 2, targetVersion: 6 });
        const snapshot = await legacy.query('SELECT document FROM sessions WHERE id=$1', [
          value.id
        ]);
        expect(snapshot.rows[0]?.document).toMatchObject({ id: value.id, name: value.name });
        backupCalled = true;
        return artifact;
      }
    });
    const competitor = new PostgresRepository(config);
    try {
      await expect(repository.assertSchemaCurrent()).rejects.toThrow(
        'version 2; version 6 is required'
      );
      expect(
        (await legacy.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(
          ({ version }) => Number(version)
        )
      ).toEqual([1, 2]);
      await repository.migrate();
      await expect(repository.assertSchemaCurrent()).resolves.toBeUndefined();
      expect(backupCalled).toBe(true);
      expect(repository.lastMigrationBackup).toEqual(artifact);
      expect(
        (await legacy.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version'))
          .rows
      ).toEqual(
        POSTGRES_MIGRATIONS.map(({ version, name, checksum }) => ({
          version,
          name,
          checksum
        }))
      );
      expect(
        (
          await legacy.query(
            `SELECT table_name FROM information_schema.columns
             WHERE table_schema=current_schema()
               AND column_name='revision'
               AND table_name=ANY($1::text[])
             ORDER BY table_name`,
            [['live_channels', 'provider_bindings', 'providers', 'settings']]
          )
        ).rows.map(({ table_name }) => table_name)
      ).toEqual(['live_channels', 'provider_bindings', 'providers', 'settings']);
      await expect(
        legacy.query(
          'SELECT document,revision,deletion_pending FROM provider_bindings WHERE id=$1',
          [legacyBinding.id]
        )
      ).resolves.toMatchObject({
        rows: [
          {
            document: { id: legacyBinding.id, providerId: legacyProvider.id },
            revision: 1,
            deletion_pending: false
          }
        ]
      });

      const settingAttempts = await Promise.all([
        repository.putSettingIfAbsent('race.setting', 'first'),
        competitor.putSettingIfAbsent('race.setting', 'second')
      ]);
      expect(settingAttempts.filter(({ inserted }) => inserted)).toHaveLength(1);
      const settingWinner = settingAttempts.find(({ inserted }) => inserted)!.record;
      expect(await competitor.getSetting('race.setting')).toBe(settingWinner.value);
      await expect(
        repository.compareAndSetSetting('race.setting', 'updated', settingWinner.revision)
      ).resolves.toMatchObject({ applied: true, record: { revision: 2, value: 'updated' } });
      await expect(
        competitor.compareAndSetSetting('race.setting', 'stale', settingWinner.revision)
      ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });

      const standaloneProvider = provider(
        'provider-standalone',
        'https://standalone.example/jellyfin',
        'provider:standalone'
      );
      const standaloneRecord = await repository.createProvider(standaloneProvider);
      expect(standaloneRecord.revision).toBe(1);
      const updatedStandalone = {
        ...standaloneProvider,
        name: 'Updated standalone provider',
        updatedAt: new Date().toISOString()
      };
      await expect(
        repository.compareAndSetProvider(updatedStandalone, standaloneRecord.revision)
      ).resolves.toMatchObject({ applied: true, record: { revision: 2 } });
      await expect(
        competitor.compareAndSetProvider(standaloneProvider, standaloneRecord.revision)
      ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
      await expect(
        repository.createProviderBinding(
          updatedStandalone,
          binding('binding-unavailable', standaloneProvider.id, 'missing-node'),
          2
        )
      ).resolves.toMatchObject({ applied: false, reason: 'node-unavailable' });
      const standaloneBinding = binding('binding-standalone', standaloneProvider.id, node.id);
      await expect(
        repository.createProviderBinding(updatedStandalone, standaloneBinding, 2)
      ).resolves.toMatchObject({ applied: true, binding: { revision: 1 } });
      await expect(
        competitor.createProviderBinding(updatedStandalone, standaloneBinding, 2)
      ).resolves.toMatchObject({
        applied: false,
        reason: 'binding-conflict',
        binding: { value: { id: standaloneBinding.id } }
      });
      const bindingDeletingAt = new Date().toISOString();
      const [standaloneBindingDeletion, competingBindingDeletion] = await Promise.all([
        repository.beginProviderBindingDeletion(standaloneBinding.id, bindingDeletingAt),
        competitor.beginProviderBindingDeletion(standaloneBinding.id, bindingDeletingAt)
      ]);
      expect(standaloneBindingDeletion).toMatchObject({
        applied: true,
        record: {
          revision: 2,
          value: { deletionPending: true, state: 'revoked', reachable: false }
        }
      });
      if (!standaloneBindingDeletion.applied)
        throw new Error('Standalone binding deletion did not begin');
      expect(competingBindingDeletion).toEqual(standaloneBindingDeletion);
      await expect(repository.getProviderBinding(standaloneBinding.id)).resolves.toBeUndefined();
      await expect(
        repository.getProviderBinding(standaloneBinding.id, { includeDeletionPending: true })
      ).resolves.toMatchObject({ deletionPending: true });
      await expect(
        competitor.compareAndSetProviderBinding(
          {
            ...standaloneBindingDeletion.record.value,
            deletionPending: false,
            state: 'healthy',
            reachable: true,
            updatedAt: new Date(Date.now() + 2_000).toISOString()
          },
          standaloneBindingDeletion.record.revision
        )
      ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });
      await expect(
        competitor.createProviderBinding(updatedStandalone, standaloneBinding, 3)
      ).resolves.toMatchObject({ applied: false, reason: 'binding-deleting' });
      await expect(repository.beginProviderDeletion(standaloneProvider.id)).resolves.toMatchObject({
        applied: false,
        reason: 'dependency-conflict',
        dependencies: [`binding:${standaloneBinding.id}`]
      });
      await expect(
        repository.finalizeProviderBindingDeletion(
          standaloneBinding.id,
          standaloneBindingDeletion.record.revision - 1
        )
      ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
      await expect(
        repository.finalizeProviderBindingDeletion(
          standaloneBinding.id,
          standaloneBindingDeletion.record.revision
        )
      ).resolves.toMatchObject({ applied: true, deleted: standaloneBindingDeletion.record });
      const standaloneDeletion = await repository.beginProviderDeletion(standaloneProvider.id);
      expect(standaloneDeletion).toMatchObject({ applied: true, record: { revision: 4 } });
      if (!standaloneDeletion.applied)
        throw new Error('Standalone provider deletion did not begin');
      await expect(competitor.beginProviderDeletion(standaloneProvider.id)).resolves.toMatchObject({
        applied: true,
        record: standaloneDeletion.record
      });
      await expect(repository.getProvider(standaloneProvider.id)).resolves.toBeUndefined();
      await expect(repository.getVersionedProvider(standaloneProvider.id)).resolves.toBeUndefined();
      await expect(repository.listProviders()).resolves.toEqual([legacyProvider]);
      await expect(
        repository.compareAndSetProvider(updatedStandalone, standaloneDeletion.record.revision)
      ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });
      await expect(
        repository.finalizeProviderDeletion(
          standaloneProvider.id,
          standaloneDeletion.record.revision
        )
      ).resolves.toMatchObject({ applied: true, deleted: { revision: 4 } });

      const replayProvider = provider(
        'provider-concurrent-replay',
        'https://replay.example/jellyfin',
        'provider:concurrent-replay'
      );
      const replayProviderRecord = await repository.createProvider(replayProvider);
      const replayBinding = binding('binding-concurrent-replay', replayProvider.id, node.id);
      const replayAttempts = await Promise.all([
        repository.createProviderBinding(
          replayProvider,
          replayBinding,
          replayProviderRecord.revision
        ),
        competitor.createProviderBinding(
          replayProvider,
          replayBinding,
          replayProviderRecord.revision
        )
      ]);
      expect(replayAttempts.filter(({ applied }) => applied)).toHaveLength(1);
      expect(replayAttempts.filter(({ applied }) => !applied)).toMatchObject([
        {
          applied: false,
          reason: 'binding-conflict',
          binding: { value: { id: replayBinding.id } }
        }
      ]);
      await finalizeBindingDeletion(repository, replayBinding.id);
      const replayDeletion = await repository.beginProviderDeletion(replayProvider.id);
      if (!replayDeletion.applied) throw new Error('Replay provider deletion did not begin');
      await expect(
        repository.finalizeProviderDeletion(replayProvider.id, replayDeletion.record.revision)
      ).resolves.toMatchObject({ applied: true });

      const providerId = 'provider-race';
      const providerAttempts = await Promise.all([
        repository.createProviderBinding(
          provider(providerId, 'https://one.example/jellyfin', 'provider-binding:one'),
          binding('binding-one', providerId, node.id),
          null
        ),
        competitor.createProviderBinding(
          provider(providerId, 'https://two.example/jellyfin', 'provider-binding:two'),
          binding('binding-two', providerId, node.id),
          null
        )
      ]);
      expect(providerAttempts.filter(({ applied }) => applied)).toHaveLength(1);
      expect(providerAttempts.filter(({ applied }) => !applied)).toMatchObject([
        { applied: false, reason: 'provider-conflict' }
      ]);
      const providerWinner = providerAttempts.find((result) => result.applied);
      if (!providerWinner?.applied) throw new Error('Provider race did not produce a winner');
      await expect(repository.getProvider(providerId)).resolves.toMatchObject({
        baseUrl: providerWinner.provider.baseUrl,
        secretRef: providerWinner.provider.secretRef
      });
      await expect(repository.listProviderBindings(providerId)).resolves.toEqual([
        providerWinner.binding.value
      ]);
      await expect(repository.getVersionedProvider(providerId)).resolves.toMatchObject({
        revision: 1,
        value: { id: providerId }
      });

      const providerVodSession: RelaySession = {
        id: 'provider-vod-session',
        name: 'Provider VOD session',
        kind: 'vod',
        source: { providerId, itemId: 'movie-a' },
        profileId: 'profile-a',
        profileRevision: 1,
        platformMode: 'pc',
        state: 'active',
        durationSeconds: 120,
        pinned: false,
        reportActivity: false,
        viewers: 0,
        placementPolicy: 'local',
        placementLocked: false,
        outputUrls: { primary: 'https://relay.example/play/provider-vod' },
        createdAt: now,
        updatedAt: now
      };
      const providerVodGrant: PlaybackGrant = {
        tokenHash: 'provider-vod-grant',
        sessionId: providerVodSession.id,
        expiresAt: null,
        revokedAt: null,
        createdAt: now
      };
      await expect(
        repository.createSessionWithPlaybackGrant(providerVodSession, providerVodGrant)
      ).resolves.toMatchObject({ applied: true });
      await expect(repository.beginProviderDeletion(providerId)).resolves.toMatchObject({
        applied: false,
        reason: 'dependency-conflict',
        dependencies: [
          `session:${providerVodSession.id}`,
          `binding:${providerWinner.binding.value.id}`
        ]
      });
      await repository.deleteSessionAndRevokePlaybackGrants(providerVodSession.id);
      await finalizeBindingDeletion(repository, providerWinner.binding.value.id);
      const deletion = await repository.beginProviderDeletion(providerId);
      expect(deletion).toMatchObject({ applied: true, record: { revision: 2 } });
      if (!deletion.applied) throw new Error('Provider deletion did not begin');
      const blockedSession = {
        ...providerVodSession,
        id: 'provider-vod-blocked',
        updatedAt: new Date().toISOString()
      };
      const blockedGrant = {
        ...providerVodGrant,
        tokenHash: 'provider-vod-blocked-grant',
        sessionId: blockedSession.id
      };
      await expect(
        repository.createSessionWithPlaybackGrant(blockedSession, blockedGrant)
      ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });
      await expect(repository.getPlaybackGrant(blockedGrant.tokenHash)).resolves.toBeUndefined();
      await expect(repository.finalizeProviderDeletion(providerId, 1)).resolves.toMatchObject({
        applied: false,
        reason: 'revision-conflict'
      });
      await expect(
        repository.finalizeProviderDeletion(providerId, deletion.record.revision)
      ).resolves.toMatchObject({ applied: true, deleted: { revision: 2 } });
      const stored = (await repository.getVersionedSession(value.id))!;
      expect(stored).toMatchObject({ value: { id: value.id, name: value.name }, revision: 1 });
      await expect(repository.getVersionedNode(node.id)).resolves.toMatchObject({
        value: { id: node.id, state: 'online' },
        revision: 1
      });
      await expect(repository.getVersionedSegmentJob(segmentJob.id)).resolves.toMatchObject({
        value: { id: segmentJob.id, state: 'running' },
        revision: 1
      });
      await expect(
        repository.setSessionViewers(value.id, stored.revision, 2, new Date().toISOString())
      ).resolves.toMatchObject({ applied: true, record: { value: { viewers: 2 } } });
      await expect(
        repository.compareAndSetSession(
          { ...value, state: 'stopped', updatedAt: new Date().toISOString() },
          stored.revision
        )
      ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
      const currentSession = (await repository.getVersionedSession(value.id))!;
      await expect(
        repository.compareAndSetSession(
          {
            ...currentSession.value,
            profileRevision: currentSession.value.profileRevision + 1,
            updatedAt: new Date().toISOString()
          },
          currentSession.revision
        )
      ).resolves.toMatchObject({
        applied: false,
        reason: 'invalid-state',
        current: currentSession
      });

      const transactionalSession: RelaySession = {
        ...value,
        id: 'transactional-session',
        name: 'Transactional session',
        updatedAt: new Date().toISOString()
      };
      const grant: PlaybackGrant = {
        tokenHash: 'transactional-grant',
        sessionId: transactionalSession.id,
        expiresAt: null,
        revokedAt: null,
        createdAt: transactionalSession.updatedAt
      };
      const liveChannel: LiveChannel = {
        id: 'live-a',
        name: 'Live A',
        path: 'live-a',
        normalize: false,
        publisherState: 'offline',
        publishTokenHash: 'live-token-hash',
        rtmpUrl: 'rtmp://relay.example/live-a',
        srtUrl: 'srt://relay.example:8890?streamid=publish:live-a',
        whipUrl: 'https://relay.example/live-a/whip',
        createdAt: transactionalSession.createdAt
      };
      const liveRecord = await repository.createLiveChannel(liveChannel);
      await repository.createSessionWithPlaybackGrant(
        transactionalSession,
        grant,
        liveRecord.revision
      );
      await expect(repository.getSession(transactionalSession.id)).resolves.toBeDefined();
      await expect(
        repository.createSessionWithPlaybackGrant(
          { ...transactionalSession, name: 'Replacement session' },
          { ...grant, tokenHash: 'rolled-back-replacement-grant' },
          liveRecord.revision
        )
      ).rejects.toThrow();
      await expect(
        repository.getPlaybackGrant('rolled-back-replacement-grant')
      ).resolves.toBeUndefined();
      await expect(repository.getSession(transactionalSession.id)).resolves.toMatchObject({
        name: transactionalSession.name
      });
      const grantRevokedAt = new Date().toISOString();
      await repository.deleteSessionAndRevokePlaybackGrants(
        transactionalSession.id,
        grantRevokedAt
      );
      await expect(repository.getSession(transactionalSession.id)).resolves.toBeUndefined();
      await expect(repository.getPlaybackGrant(grant.tokenHash)).resolves.toMatchObject({
        revokedAt: grantRevokedAt
      });

      const token: PersonalAccessToken = {
        id: 'token-a',
        name: 'Token A',
        tokenHash: 'token-a-hash',
        scopes: ['sessions:read'],
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now
      };
      const tokenUsedAt = new Date().toISOString();
      await repository.putPersonalToken(token);
      await expect(
        repository.usePersonalToken({
          tokenHash: token.tokenHash,
          usedAt: tokenUsedAt,
          touchBefore: new Date(Date.parse(tokenUsedAt) - 60_000).toISOString()
        })
      ).resolves.toMatchObject({ lastUsedAt: tokenUsedAt, revokedAt: null });
      const tokenRevokedAt = new Date(Date.parse(tokenUsedAt) + 1_000).toISOString();
      await repository.revokePersonalToken(token.id, tokenRevokedAt);
      await expect(
        repository.usePersonalToken({
          tokenHash: token.tokenHash,
          usedAt: new Date(Date.parse(tokenRevokedAt) + 1_000).toISOString(),
          touchBefore: tokenUsedAt
        })
      ).resolves.toBeUndefined();
      await expect(repository.getPersonalToken(token.tokenHash)).resolves.toMatchObject({
        lastUsedAt: tokenUsedAt,
        revokedAt: tokenRevokedAt
      });

      const certificateNode: ClusterNode = {
        ...node,
        id: 'node-certificate',
        name: 'Certificate node'
      };
      const firstCertificate = {
        nodeId: certificateNode.id,
        serialNumber: 'serial-1',
        fingerprintSha256: 'fingerprint-1',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        revokedAt: null,
        createdAt: now
      };
      const initialNode = await repository.createNode(certificateNode, firstCertificate);
      const rotatedAt = new Date().toISOString();
      const secondCertificate = {
        ...firstCertificate,
        serialNumber: 'serial-2',
        fingerprintSha256: 'fingerprint-2',
        createdAt: rotatedAt
      };
      const rotated = await repository.rotateNodeCertificate({
        nodeId: certificateNode.id,
        expectedRevision: initialNode.revision,
        certificate: secondCertificate,
        updatedAt: rotatedAt
      });
      expect(rotated).toMatchObject({ applied: true, record: { value: { state: 'online' } } });
      if (!rotated.applied) throw new Error('PostgreSQL certificate rotation did not apply');
      const nodeRevokedAt = new Date().toISOString();
      const revoked = await repository.revokeNode({
        nodeId: certificateNode.id,
        expectedRevision: rotated.record.revision,
        revokedAt: nodeRevokedAt
      });
      expect(revoked).toMatchObject({ applied: true, record: { value: { state: 'revoked' } } });
      if (!revoked.applied) throw new Error('PostgreSQL node revocation did not apply');
      expect(
        (await repository.listNodeCertificates(certificateNode.id)).every((item) => item.revokedAt)
      ).toBe(true);
      await expect(
        repository.removeNode(certificateNode.id, rotated.record.revision)
      ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
      await expect(
        repository.removeNode(certificateNode.id, revoked.record.revision)
      ).resolves.toMatchObject({ applied: true, deleted: { value: { state: 'revoked' } } });

      const audit: AuditEvent = {
        id: 'audit-a',
        operationId: '00000000-0000-4000-8000-000000000003',
        category: 'session',
        action: 'session.viewer-count',
        outcome: 'success',
        actor: { type: 'system' },
        target: { type: 'session', id: value.id },
        context: { viewers: 2 },
        occurredAt: new Date().toISOString()
      };
      await repository.appendAuditEvent(audit);
      await expect(repository.listAuditEvents({ targetId: value.id })).resolves.toMatchObject([
        { id: audit.id }
      ]);
    } finally {
      await competitor.close();
      await repository.close();
      await legacy.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
