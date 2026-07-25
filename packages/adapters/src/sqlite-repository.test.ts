import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AuditEvent,
  ClusterNode,
  JobLogEntry,
  NodeCertificateState,
  PersonalAccessToken,
  PlaybackGrant,
  ProviderBinding,
  ProviderConnection,
  RelaySession,
  SegmentJob
} from '@vrrelay/domain';
import {
  SQLITE_MIGRATIONS,
  SqliteRepository,
  assertSqliteSchemaCurrent,
  runSqliteMigrations,
  sqliteMigrationChecksum,
  type SqliteMigration
} from './sqlite-repository.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
);

async function temporaryDatabase(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vrrelay-db-'));
  dirs.push(dir);
  return { dir, path: join(dir, 'relay.sqlite') };
}

function session(id: string, updatedAt: string): RelaySession {
  return {
    id,
    name: `Session ${id}`,
    kind: 'vod',
    source: { providerId: 'provider-a', itemId: 'item-a' },
    durationSeconds: 60,
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
    createdAt: updatedAt,
    updatedAt
  };
}

function node(id: string, updatedAt: string): ClusterNode {
  return {
    id,
    name: `Node ${id}`,
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
      providerIds: [],
      vodProducerVersion: 1
    },
    weight: 100,
    lastHeartbeatAt: updatedAt,
    createdAt: updatedAt,
    updatedAt
  };
}

function job(id: string, state: SegmentJob['state'], updatedAt: string): SegmentJob {
  return {
    id,
    contentKey: `content/${id}`,
    sessionId: 'session-a',
    segmentIndex: 0,
    state,
    attempts: state === 'queued' ? 0 : 1,
    ...(state === 'leased' || state === 'running' ? { ownerNodeId: 'node-a' } : {}),
    workerHistory: [],
    createdAt: updatedAt,
    updatedAt
  };
}

function jobLog(id: string, jobId: string, timestamp: string): JobLogEntry {
  return {
    id,
    jobId,
    sessionId: 'session-a',
    nodeId: 'node-a',
    level: 'info',
    message: `Log ${id}`,
    context: {},
    timestamp
  };
}

function certificate(
  nodeId: string,
  serialNumber: string,
  createdAt: string
): NodeCertificateState {
  return {
    nodeId,
    serialNumber,
    fingerprintSha256: `fingerprint-${serialNumber}`,
    expiresAt: new Date(Date.parse(createdAt) + 86_400_000).toISOString(),
    revokedAt: null,
    createdAt
  };
}

function migration(version: number, name: string, statements: readonly string[]): SqliteMigration {
  const definition = { version, name, statements };
  return { ...definition, checksum: sqliteMigrationChecksum(definition) };
}

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

describe('SQLite repository migrations', () => {
  it('defines an immutable contiguous migration history', () => {
    expect(SQLITE_MIGRATIONS.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: 'core repository' },
      { version: 2, name: 'cluster repository' },
      { version: 3, name: 'atomic revisions and audit log' },
      { version: 4, name: 'atomic live channels' },
      { version: 5, name: 'atomic provider lifecycle' },
      { version: 6, name: 'crash-safe provider binding deletion' },
      { version: 7, name: 'bounded job logs' },
      { version: 8, name: 'unified user identities' },
      { version: 9, name: 'durable vod producers' }
    ]);
    expect(SQLITE_MIGRATIONS[2]?.statements.join('\n')).toContain(
      'ALTER TABLE sessions ADD COLUMN revision'
    );
    for (const item of SQLITE_MIGRATIONS) {
      expect(item.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(item.checksum).toBe(sqliteMigrationChecksum(item));
    }
  });

  it('upgrades the existing development schema with a locked WAL-consistent backup', async () => {
    const { path } = await temporaryDatabase();
    const legacy = new Database(path);
    legacy.pragma('journal_mode = WAL');
    legacy.pragma('wal_autocheckpoint = 0');
    runSqliteMigrations(legacy, SQLITE_MIGRATIONS.slice(0, 2));
    legacy.pragma('wal_checkpoint(TRUNCATE)');
    const now = new Date().toISOString();
    const existing = session('legacy-session', now);
    legacy
      .prepare('INSERT INTO sessions(id,json,updated_at) VALUES(?,?,?)')
      .run(existing.id, JSON.stringify(existing), existing.updatedAt);
    expect((await stat(`${path}-wal`)).size).toBeGreaterThan(0);
    if (process.platform !== 'win32')
      for (const sqlitePath of [path, `${path}-wal`, `${path}-shm`]) await chmod(sqlitePath, 0o644);

    let backupModeDuringCopy: number | undefined;
    const originalBackup = Database.prototype.backup;
    const backupSpy = vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (
      this: Database.Database,
      destinationFile: string,
      options?: Database.BackupOptions
    ) {
      backupModeDuringCopy = (await stat(destinationFile)).mode & 0o777;
      return options
        ? originalBackup.call(this, destinationFile, options)
        : originalBackup.call(this, destinationFile);
    });
    const repository = new SqliteRepository(path);
    if (process.platform !== 'win32')
      for (const sqlitePath of [path, `${path}-wal`, `${path}-shm`])
        expect((await stat(sqlitePath)).mode & 0o777, sqlitePath).toBe(0o600);
    const previousUmask = process.umask(0o022);
    try {
      await repository.migrate();
    } finally {
      process.umask(previousUmask);
      backupSpy.mockRestore();
    }
    const backupPath = repository.lastMigrationBackupPath;
    expect(backupPath).toMatch(
      /\.pre-migration-v2-.+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bak$/
    );
    if (process.platform !== 'win32') {
      expect(backupModeDuringCopy).toBe(0o600);
      expect((await stat(backupPath!)).mode & 0o777).toBe(0o600);
    }
    const backup = new Database(backupPath!, { readonly: true, fileMustExist: true });
    expect(backup.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 }
    ]);
    expect(
      backup
        .prepare('PRAGMA table_info(sessions)')
        .all()
        .some((column) => {
          return (column as { name?: string }).name === 'revision';
        })
    ).toBe(false);
    expect(
      JSON.parse(
        (
          backup.prepare('SELECT json FROM sessions WHERE id=?').get(existing.id) as {
            json: string;
          }
        ).json
      )
    ).toMatchObject({ id: existing.id, name: existing.name });
    backup.close();

    await expect(repository.getVersionedSession(existing.id)).resolves.toMatchObject({
      value: { id: existing.id, name: existing.name },
      revision: 1
    });
    const upgraded = new Database(path, { readonly: true, fileMustExist: true });
    expect(
      upgraded.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all()
    ).toEqual(
      SQLITE_MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum }))
    );
    upgraded.close();
    repository.close();
    legacy.close();
  });

  it('keeps the database and active SQLite sidecars private under a permissive umask', async () => {
    if (process.platform === 'win32') return;
    const { path } = await temporaryDatabase();
    const previousUmask = process.umask(0o022);
    let repository: SqliteRepository | undefined;
    try {
      repository = new SqliteRepository(path);
      await repository.migrate();
      await repository.putSetting('permission.probe', 'written');
      for (const sqlitePath of [path, `${path}-wal`, `${path}-shm`])
        expect((await stat(sqlitePath)).mode & 0o777, sqlitePath).toBe(0o600);
    } finally {
      repository?.close();
      process.umask(previousUmask);
    }
  });

  it('removes a private partial backup when backup creation fails', async () => {
    if (process.platform === 'win32') return;
    const { dir, path } = await temporaryDatabase();
    const legacy = new Database(path);
    runSqliteMigrations(legacy, SQLITE_MIGRATIONS.slice(0, 2));
    legacy.close();

    let backupPath: string | undefined;
    let backupModeDuringCopy: number | undefined;
    const backupSpy = vi
      .spyOn(Database.prototype, 'backup')
      .mockImplementation(async (_destinationFile: string) => {
        backupPath = _destinationFile;
        backupModeDuringCopy = (await stat(_destinationFile)).mode & 0o777;
        await writeFile(_destinationFile, 'partial backup');
        throw new Error('simulated backup failure');
      });
    const repository = new SqliteRepository(path);
    const previousUmask = process.umask(0o022);
    try {
      await expect(repository.migrate()).rejects.toThrow('simulated backup failure');
    } finally {
      process.umask(previousUmask);
      backupSpy.mockRestore();
      repository.close();
    }

    expect(backupModeDuringCopy).toBe(0o600);
    expect(backupPath).toBeDefined();
    await expect(stat(backupPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dir)).filter((name) => name.includes('.pre-migration-'))).toEqual([]);
    const unchanged = new Database(path, { readonly: true, fileMustExist: true });
    expect(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    ).toEqual([{ version: 1 }, { version: 2 }]);
    unchanged.close();
  });

  it('rolls back every statement and version marker when a migration fails', () => {
    const database = new Database(':memory:');
    const first = migration(1, 'base', ['CREATE TABLE stable(id TEXT PRIMARY KEY)']);
    runSqliteMigrations(database, [first]);
    const failing = migration(2, 'failing', [
      'CREATE TABLE transient(id TEXT)',
      'THIS IS NOT VALID SQL'
    ]);

    expect(() => runSqliteMigrations(database, [first, failing])).toThrow();
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transient'")
        .get()
    ).toBeUndefined();
    expect(database.prepare('SELECT version FROM schema_migrations').all()).toEqual([
      { version: 1 }
    ]);
    database.close();
  });

  it('refuses to migrate while another writer owns the database lock', async () => {
    const { path } = await temporaryDatabase();
    const holder = new Database(path);
    const contender = new Database(path);
    contender.pragma('busy_timeout = 1');
    holder.exec('BEGIN IMMEDIATE');
    try {
      expect(() => runSqliteMigrations(contender)).toThrow(/locked/);
      expect(
        contender
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
          .get()
      ).toBeUndefined();
    } finally {
      holder.exec('ROLLBACK');
      contender.close();
      holder.close();
    }
  });

  it('checks schema compatibility without creating or upgrading anything', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await expect(repository.assertSchemaCurrent()).rejects.toThrow('schema is not initialized');
    const inspection = new Database(path, { readonly: true, fileMustExist: true });
    expect(
      inspection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        .get()
    ).toBeUndefined();
    inspection.close();
    repository.close();

    const legacy = new Database(path);
    runSqliteMigrations(legacy, SQLITE_MIGRATIONS.slice(0, 2));
    legacy.close();
    const worker = new SqliteRepository(path);
    await expect(worker.assertSchemaCurrent()).rejects.toThrow('version 2; version 9 is required');
    expect(worker.lastMigrationBackupPath).toBeUndefined();
    const unchanged = new Database(path, { readonly: true, fileMustExist: true });
    expect(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    ).toEqual([{ version: 1 }, { version: 2 }]);
    expect(
      unchanged
        .prepare('PRAGMA table_info(sessions)')
        .all()
        .some((column) => {
          return (column as { name?: string }).name === 'revision';
        })
    ).toBe(false);
    unchanged.close();
    worker.close();

    const gapped = new Database(':memory:');
    gapped.exec(
      'CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'
    );
    gapped
      .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
      .run(2, new Date().toISOString());
    expect(() => assertSqliteSchemaCurrent(gapped)).toThrow('not a contiguous prefix');
    expect(gapped.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 2 }]);
    gapped.close();
  });

  it('rejects a database created by a newer build', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    await expect(repository.assertSchemaCurrent()).resolves.toBeUndefined();
    repository.close();
    const future = new Database(path);
    future
      .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
      .run(10, new Date().toISOString());
    future.close();

    const reopened = new SqliteRepository(path);
    await expect(reopened.assertSchemaCurrent()).rejects.toThrow(
      'newer than this VRRelay build supports'
    );
    await expect(reopened.migrate()).rejects.toThrow('newer than this VRRelay build supports');
    reopened.close();
  });

  it('rejects changed definitions and tampered immutable migration history', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    repository.close();

    const changed = SQLITE_MIGRATIONS.map((item, index) =>
      index === 0 ? { ...item, statements: [...item.statements, 'SELECT 1'] } : item
    );
    const inspection = new Database(path);
    expect(() => assertSqliteSchemaCurrent(inspection, changed)).toThrow(
      'checksum does not match its immutable definition'
    );
    inspection
      .prepare('UPDATE schema_migrations SET name=? WHERE version=?')
      .run('tampered migration', 1);
    expect(() => assertSqliteSchemaCurrent(inspection)).toThrow(
      'migration 1 history does not match this build'
    );
    inspection
      .prepare('UPDATE schema_migrations SET name=?,checksum=? WHERE version=?')
      .run(SQLITE_MIGRATIONS[0]!.name, '0'.repeat(64), 1);
    expect(() => runSqliteMigrations(inspection)).toThrow(
      'migration 1 history does not match this build'
    );
    inspection.close();
  });

  it('rejects a current-version schema with a missing required application column', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    repository.close();

    const malformed = new Database(path);
    malformed.exec(
      'ALTER TABLE compatibility_results RENAME COLUMN tested_at TO tested_at_missing'
    );
    expect(() => assertSqliteSchemaCurrent(malformed)).toThrow(
      'missing required column compatibility_results.tested_at'
    );
    malformed.close();
  });

  it('rejects a current-version schema with a missing required application index', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    repository.close();

    const malformed = new Database(path);
    malformed.exec('DROP INDEX provider_bindings_node');
    expect(() => assertSqliteSchemaCurrent(malformed)).toThrow(
      'missing required index provider_bindings_node'
    );
    malformed.close();
  });

  it.each([
    {
      name: 'unexpected columns',
      tamper: 'ALTER TABLE sessions ADD COLUMN unexpected TEXT',
      expected: 'unexpected column sessions.unexpected'
    },
    {
      name: 'identity types',
      tamper:
        'DROP TABLE sessions; CREATE TABLE sessions(id INTEGER PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1)',
      expected: 'sessions.id must use TEXT with TEXT affinity'
    },
    {
      name: 'JSON storage types',
      tamper:
        'DROP TABLE sessions; CREATE TABLE sessions(id TEXT PRIMARY KEY,json BLOB NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1)',
      expected: 'sessions.json must use TEXT with TEXT affinity'
    },
    {
      name: 'timestamp storage types',
      tamper:
        'DROP TABLE sessions; CREATE TABLE sessions(id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1)',
      expected: 'sessions.updated_at must use TEXT with TEXT affinity'
    },
    {
      name: 'revision storage types',
      tamper:
        'DROP TABLE sessions; CREATE TABLE sessions(id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision TEXT NOT NULL DEFAULT 1)',
      expected: 'sessions.revision must use INTEGER with INTEGER affinity'
    },
    {
      name: 'required JSON nullability',
      tamper:
        'DROP TABLE sessions; CREATE TABLE sessions(id TEXT PRIMARY KEY,json TEXT,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1)',
      expected: 'sessions.json has invalid nullability; expected explicit'
    },
    {
      name: 'revision defaults',
      tamper:
        'DROP TABLE sessions; CREATE TABLE sessions(id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0)',
      expected: 'sessions.revision must use default 1'
    },
    {
      name: 'missing revision defaults',
      tamper:
        'DROP TABLE sessions; CREATE TABLE sessions(id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL)',
      expected: 'sessions.revision must use default 1'
    },
    {
      name: 'provider deletion storage types',
      tamper:
        'DROP TABLE providers; CREATE TABLE providers(id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deletion_pending TEXT NOT NULL DEFAULT 0 CHECK (deletion_pending IN (0,1)))',
      expected: 'providers.deletion_pending must use INTEGER with INTEGER affinity'
    },
    {
      name: 'provider deletion nullability',
      tamper:
        'DROP TABLE providers; CREATE TABLE providers(id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deletion_pending INTEGER DEFAULT 0 CHECK (deletion_pending IN (0,1)))',
      expected: 'providers.deletion_pending has invalid nullability; expected explicit'
    },
    {
      name: 'provider deletion defaults',
      tamper:
        'DROP TABLE providers; CREATE TABLE providers(id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deletion_pending INTEGER NOT NULL DEFAULT 1 CHECK (deletion_pending IN (0,1)))',
      expected: 'providers.deletion_pending must use default 0'
    },
    {
      name: 'provider deletion checks',
      tamper:
        'DROP TABLE providers; CREATE TABLE providers(id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deletion_pending INTEGER NOT NULL DEFAULT 0)',
      expected: 'missing required boolean check on providers.deletion_pending'
    },
    {
      name: 'provider-binding deletion storage types',
      tamper:
        'DROP TABLE provider_bindings; CREATE TABLE provider_bindings(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,node_id TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deletion_pending TEXT NOT NULL DEFAULT 0 CHECK (deletion_pending IN (0,1)))',
      expected: 'provider_bindings.deletion_pending must use INTEGER with INTEGER affinity'
    },
    {
      name: 'provider-binding deletion nullability',
      tamper:
        'DROP TABLE provider_bindings; CREATE TABLE provider_bindings(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,node_id TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deletion_pending INTEGER DEFAULT 0 CHECK (deletion_pending IN (0,1)))',
      expected: 'provider_bindings.deletion_pending has invalid nullability; expected explicit'
    },
    {
      name: 'provider-binding deletion defaults',
      tamper:
        'DROP TABLE provider_bindings; CREATE TABLE provider_bindings(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,node_id TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deletion_pending INTEGER NOT NULL DEFAULT 1 CHECK (deletion_pending IN (0,1)))',
      expected: 'provider_bindings.deletion_pending must use default 0'
    },
    {
      name: 'provider-binding deletion checks',
      tamper:
        'DROP TABLE provider_bindings; CREATE TABLE provider_bindings(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,node_id TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deletion_pending INTEGER NOT NULL DEFAULT 0)',
      expected: 'missing required boolean check on provider_bindings.deletion_pending'
    },
    {
      name: 'nullable audit ownership',
      tamper:
        'DROP TABLE audit_events; CREATE TABLE audit_events(id TEXT PRIMARY KEY,category TEXT NOT NULL,action TEXT NOT NULL,actor_id TEXT NOT NULL,target_id TEXT,json TEXT NOT NULL,occurred_at TEXT NOT NULL)',
      expected: 'audit_events.actor_id has invalid nullability; expected nullable'
    }
  ])('rejects current-version schema drift in $name', async ({ tamper, expected }) => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    repository.close();

    const malformed = new Database(path);
    malformed.exec(tamper);
    expect(() => assertSqliteSchemaCurrent(malformed)).toThrow(expected);
    malformed.close();
  });
});

describe('SQLite repository atomic state', () => {
  it('migrates and preserves provider-neutral records', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const now = new Date().toISOString();
    await repository.createProvider({
      id: 'p1',
      type: 'jellyfin',
      name: 'Library',
      baseUrl: 'https://media.example',
      authMode: 'user_token',
      secretRef: 'secret:p1',
      capabilities: ['search'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    expect((await repository.listProviders())[0]?.name).toBe('Library');
    expect(await repository.getSetting('missing')).toBeUndefined();
    await repository.putSetting('schema.test', 'ok');
    expect(await repository.getSetting('schema.test')).toBe('ok');
    repository.close();
  });

  it('serializes setting initialization and rejects stale setting revisions across connections', async () => {
    const { path } = await temporaryDatabase();
    const first = new SqliteRepository(path);
    await first.migrate();
    const second = new SqliteRepository(path);
    await second.assertSchemaCurrent();

    const attempts = await Promise.all([
      first.putSettingIfAbsent('race.setting', 'first'),
      second.putSettingIfAbsent('race.setting', 'second')
    ]);
    expect(attempts.filter(({ inserted }) => inserted)).toHaveLength(1);
    const winner = attempts.find(({ inserted }) => inserted)!.record;
    expect(await first.getSetting('race.setting')).toBe(winner.value);
    expect(await second.getSetting('race.setting')).toBe(winner.value);

    const updated = await first.compareAndSetSetting('race.setting', 'updated', winner.revision);
    expect(updated).toMatchObject({ applied: true, record: { value: 'updated', revision: 2 } });
    await expect(
      second.compareAndSetSetting('race.setting', 'stale', winner.revision)
    ).resolves.toMatchObject({
      applied: false,
      reason: 'revision-conflict',
      current: { value: 'updated', revision: 2 }
    });
    second.close();
    first.close();
  });

  it('atomically creates provider bindings and rejects competing servers across connections', async () => {
    const { path } = await temporaryDatabase();
    const first = new SqliteRepository(path);
    await first.migrate();
    const second = new SqliteRepository(path);
    await second.assertSchemaCurrent();
    const providerId = 'provider-race';
    const candidates = [
      provider(providerId, 'https://one.example/jellyfin', 'provider-binding:one'),
      provider(providerId, 'https://two.example/jellyfin', 'provider-binding:two')
    ] as const;
    const bindings = [
      binding('binding-one', providerId, 'node-one'),
      binding('binding-two', providerId, 'node-two')
    ] as const;
    await first.createNode(node('node-one', new Date().toISOString()));
    await first.createNode(node('node-two', new Date().toISOString()));

    const results = await Promise.all([
      first.createProviderBinding(candidates[0], bindings[0], null),
      second.createProviderBinding(candidates[1], bindings[1], null)
    ]);
    expect(results.filter(({ applied }) => applied)).toHaveLength(1);
    expect(results.filter(({ applied }) => !applied)).toMatchObject([
      { applied: false, reason: 'provider-conflict' }
    ]);
    const winner = results.find((result) => result.applied);
    if (!winner?.applied) throw new Error('Provider race did not produce a winner');
    expect(await first.getProvider(providerId)).toMatchObject({
      baseUrl: winner.provider.baseUrl,
      secretRef: winner.provider.secretRef
    });
    expect(await second.listProviderBindings(providerId)).toEqual([winner.binding.value]);

    const current = (await first.getVersionedProviderBinding(winner.binding.value.id))!;
    const degraded: ProviderBinding = {
      ...current.value,
      state: 'degraded',
      updatedAt: new Date(Date.now() + 1_000).toISOString()
    };
    await expect(
      first.compareAndSetProviderBinding(degraded, current.revision, ['healthy'])
    ).resolves.toMatchObject({ applied: true, record: { revision: 2 } });
    await expect(
      second.compareAndSetProviderBinding(
        { ...current.value, state: 'revoked', updatedAt: new Date().toISOString() },
        current.revision
      )
    ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
    second.close();
    first.close();
  });

  it('makes provider deletion terminal against stale validation and new VOD work', async () => {
    const { path } = await temporaryDatabase();
    const first = new SqliteRepository(path);
    await first.migrate();
    const second = new SqliteRepository(path);
    await second.assertSchemaCurrent();
    const value = provider('provider-delete', 'https://media.example', 'secret:delete');
    const created = await first.createProvider(value);
    const stale = (await second.getVersionedProvider(value.id))!;
    expect(stale).toEqual(created);

    const deleting = await first.beginProviderDeletion(value.id);
    expect(deleting).toMatchObject({ applied: true, record: { revision: 2 } });
    if (!deleting.applied) throw new Error('Provider deletion did not begin');
    await expect(first.getProvider(value.id)).resolves.toBeUndefined();
    await expect(second.getVersionedProvider(value.id)).resolves.toBeUndefined();
    await expect(first.listProviders()).resolves.not.toContainEqual(value);

    await expect(
      second.compareAndSetProvider(
        { ...stale.value, healthy: false, updatedAt: new Date().toISOString() },
        stale.revision
      )
    ).resolves.toMatchObject({
      applied: false,
      reason: 'revision-conflict',
      current: { revision: deleting.record.revision }
    });
    const rejectedSession = session('provider-delete-session', new Date().toISOString());
    rejectedSession.source = { providerId: value.id, itemId: 'item-a' };
    await expect(
      second.createSessionWithPlaybackGrant(rejectedSession, {
        tokenHash: 'provider-delete-session-grant',
        sessionId: rejectedSession.id,
        expiresAt: null,
        revokedAt: null,
        createdAt: rejectedSession.createdAt
      })
    ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });
    await expect(second.getVersionedSession(rejectedSession.id)).resolves.toBeUndefined();
    await first.createNode(node('provider-delete-worker', new Date().toISOString()));
    await expect(
      second.createProviderBinding(
        { ...value, updatedAt: new Date().toISOString() },
        binding('provider-delete-binding', value.id, 'provider-delete-worker'),
        created.revision
      )
    ).resolves.toMatchObject({ applied: false, reason: 'provider-deleting' });

    await expect(
      first.finalizeProviderDeletion(value.id, deleting.record.revision)
    ).resolves.toMatchObject({ applied: true, deleted: deleting.record });
    await expect(
      second.compareAndSetProvider(
        { ...stale.value, healthy: false, updatedAt: new Date().toISOString() },
        stale.revision
      )
    ).resolves.toMatchObject({ applied: false, reason: 'not-found' });
    second.close();
    first.close();
  });

  it('blocks provider deletion while sessions or bindings depend on it', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const now = new Date().toISOString();

    const sessionProvider = provider(
      'provider-session-dependency',
      'https://session.example',
      'secret:session'
    );
    await repository.createProvider(sessionProvider);
    const dependentSession = session('provider-dependent-session', now);
    dependentSession.source = { providerId: sessionProvider.id, itemId: 'item-a' };
    await expect(
      repository.createSessionWithPlaybackGrant(dependentSession, {
        tokenHash: 'provider-dependent-session-grant',
        sessionId: dependentSession.id,
        expiresAt: null,
        revokedAt: null,
        createdAt: now
      })
    ).resolves.toMatchObject({ applied: true });
    await expect(repository.beginProviderDeletion(sessionProvider.id)).resolves.toMatchObject({
      applied: false,
      reason: 'dependency-conflict',
      dependencies: [`session:${dependentSession.id}`]
    });

    const bindingProvider = provider(
      'provider-binding-dependency',
      'https://binding.example',
      'provider-binding:dependency'
    );
    await repository.createNode(node('binding-worker', now));
    const dependentBinding = binding(
      'provider-dependent-binding',
      bindingProvider.id,
      'binding-worker'
    );
    await expect(
      repository.createProviderBinding(bindingProvider, dependentBinding, null)
    ).resolves.toMatchObject({ applied: true });
    await expect(repository.beginProviderDeletion(bindingProvider.id)).resolves.toMatchObject({
      applied: false,
      reason: 'dependency-conflict',
      dependencies: [`binding:${dependentBinding.id}`]
    });
    repository.close();
  });

  it('keeps binding deletion crash-recoverable and pending rows out of active reads', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const now = new Date().toISOString();
    const worker = node('binding-cleanup-worker', now);
    await repository.createNode(worker);
    const connection = provider(
      'provider-binding-cleanup',
      'https://binding-cleanup.example',
      'provider-binding:cleanup'
    );
    const value = binding('binding-cleanup', connection.id, worker.id);
    const created = await repository.createProviderBinding(connection, value, null);
    if (!created.applied) throw new Error('Provider binding creation did not apply');

    const deletingAt = new Date(Date.now() + 1_000).toISOString();
    const deleting = await repository.beginProviderBindingDeletion(value.id, deletingAt);
    expect(deleting).toMatchObject({
      applied: true,
      record: {
        revision: 2,
        value: {
          state: 'revoked',
          reachable: false,
          deletionPending: true,
          lastError: expect.stringContaining('cleanup is pending')
        }
      }
    });
    if (!deleting.applied) throw new Error('Provider binding deletion did not begin');
    await expect(repository.getProviderBinding(value.id)).resolves.toBeUndefined();
    await expect(repository.listProviderBindings(connection.id)).resolves.toEqual([]);
    await expect(
      repository.getProviderBinding(value.id, { includeDeletionPending: true })
    ).resolves.toMatchObject({ deletionPending: true, state: 'revoked', reachable: false });
    await expect(
      repository.listProviderBindings(connection.id, { includeDeletionPending: true })
    ).resolves.toHaveLength(1);
    await expect(
      repository.beginProviderBindingDeletion(value.id, new Date(Date.now() + 2_000).toISOString())
    ).resolves.toEqual(deleting);
    await expect(
      repository.compareAndSetProviderBinding(
        {
          ...deleting.record.value,
          state: 'healthy',
          reachable: true,
          deletionPending: false,
          updatedAt: new Date(Date.now() + 3_000).toISOString()
        },
        deleting.record.revision
      )
    ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });
    await expect(repository.createProviderBinding(connection, value, null)).resolves.toMatchObject({
      applied: false,
      reason: 'binding-deleting'
    });
    await expect(repository.beginProviderDeletion(connection.id)).resolves.toMatchObject({
      applied: false,
      reason: 'dependency-conflict',
      dependencies: [`binding:${value.id}`]
    });
    await expect(
      repository.finalizeProviderBindingDeletion(value.id, created.binding.revision)
    ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
    await expect(
      repository.finalizeProviderBindingDeletion(value.id, deleting.record.revision)
    ).resolves.toMatchObject({ applied: true, deleted: deleting.record });
    await expect(
      repository.finalizeProviderBindingDeletion(value.id, deleting.record.revision)
    ).resolves.toMatchObject({ applied: false, reason: 'not-found' });
    repository.close();
  });

  it('marks every bound credential unreachable in the node revocation transaction', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const now = new Date().toISOString();
    const worker = node('revoked-binding-worker', now);
    const nodeRecord = await repository.createNode(worker);
    const connection = provider(
      'provider-revoked-binding',
      'https://revoked-binding.example',
      'provider-binding:revoked'
    );
    const value = binding('revoked-binding', connection.id, worker.id);
    await repository.createProviderBinding(connection, value, null);

    const revokedAt = new Date(Date.now() + 1_000).toISOString();
    await expect(
      repository.revokeNode({
        nodeId: worker.id,
        expectedRevision: nodeRecord.revision,
        revokedAt
      })
    ).resolves.toMatchObject({ applied: true, record: { value: { state: 'revoked' } } });
    await expect(
      repository.getProviderBinding(value.id, { includeDeletionPending: true })
    ).resolves.toMatchObject({
      state: 'revoked',
      reachable: false,
      deletionPending: false,
      updatedAt: revokedAt,
      lastError: expect.stringContaining('administrator acknowledgement')
    });
    repository.close();
  });

  it('requires revoked dependency-free nodes for removal and rejects unusable binding targets', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const now = new Date().toISOString();
    const worker = node('removal-worker', now);
    const created = await repository.createNode(worker);
    await expect(repository.removeNode(worker.id, created.revision)).resolves.toMatchObject({
      applied: false,
      reason: 'invalid-state'
    });

    const boundProvider = provider(
      'provider-node-dependency',
      'https://node-dependency.example',
      'provider-binding:node-dependency'
    );
    const bound = binding('node-dependent-binding', boundProvider.id, worker.id);
    await expect(
      repository.createProviderBinding(boundProvider, bound, null)
    ).resolves.toMatchObject({ applied: true });
    const revoked = await repository.revokeNode({
      nodeId: worker.id,
      expectedRevision: created.revision,
      revokedAt: new Date(Date.now() + 1_000).toISOString()
    });
    expect(revoked).toMatchObject({ applied: true, record: { value: { state: 'revoked' } } });
    if (!revoked.applied) throw new Error('Node revocation did not apply');
    await expect(repository.removeNode(worker.id, revoked.record.revision)).resolves.toMatchObject({
      applied: false,
      reason: 'dependency-conflict',
      dependencies: [`binding:${bound.id}`]
    });

    const unusableProvider = provider(
      'provider-unusable-node',
      'https://unusable.example',
      'provider-binding:unusable'
    );
    await expect(
      repository.createProviderBinding(
        unusableProvider,
        binding('binding-revoked-node', unusableProvider.id, worker.id),
        null
      )
    ).resolves.toMatchObject({ applied: false, reason: 'node-unavailable' });
    await expect(
      repository.createProviderBinding(
        unusableProvider,
        binding('binding-missing-node', unusableProvider.id, 'missing-worker'),
        null
      )
    ).resolves.toMatchObject({ applied: false, reason: 'node-unavailable' });
    const edgeOnly: ClusterNode = { ...node('edge-only', now), roles: ['edge'] };
    await repository.createNode(edgeOnly);
    await expect(
      repository.createProviderBinding(
        unusableProvider,
        binding('binding-edge-node', unusableProvider.id, edgeOnly.id),
        null
      )
    ).resolves.toMatchObject({ applied: false, reason: 'node-unavailable' });

    const deletingBinding = await repository.beginProviderBindingDeletion(
      bound.id,
      new Date(Date.now() + 2_000).toISOString()
    );
    if (!deletingBinding.applied) throw new Error('Binding deletion did not begin');
    await repository.finalizeProviderBindingDeletion(bound.id, deletingBinding.record.revision);
    await expect(repository.removeNode(worker.id, revoked.record.revision)).resolves.toMatchObject({
      applied: true,
      deleted: { value: { id: worker.id, state: 'revoked' }, revision: revoked.record.revision }
    });
    await expect(repository.getNode(worker.id)).resolves.toBeUndefined();
    repository.close();
  });

  it('prevents concurrent session and viewer updates from losing state', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const now = new Date().toISOString();
    const initialSession = session('session-a', now);
    await repository.createProvider(provider('provider-a', 'https://media.example', 'secret:a'));
    await repository.createSessionWithPlaybackGrant(initialSession, {
      tokenHash: 'session-a-grant',
      sessionId: initialSession.id,
      expiresAt: null,
      revokedAt: null,
      createdAt: now
    });
    const first = (await repository.getVersionedSession('session-a'))!;
    const stale = (await repository.getVersionedSession('session-a'))!;

    const viewers = await repository.setSessionViewers(
      'session-a',
      first.revision,
      3,
      new Date(Date.now() + 1).toISOString()
    );
    expect(viewers).toMatchObject({ applied: true, record: { revision: 2 } });
    const competing = await repository.compareAndSetSession(
      { ...stale.value, state: 'stopped', updatedAt: new Date(Date.now() + 2).toISOString() },
      stale.revision
    );
    expect(competing).toMatchObject({
      applied: false,
      reason: 'revision-conflict',
      current: { value: { viewers: 3 }, revision: 2 }
    });
    repository.close();
  });

  it('creates sessions with grants and deletes sessions with grant revocation atomically', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const now = new Date().toISOString();
    const value = session('session-grant', now);
    await repository.createProvider(provider('provider-a', 'https://media.example', 'secret:a'));
    const grant: PlaybackGrant = {
      tokenHash: 'grant-hash',
      sessionId: value.id,
      expiresAt: null,
      revokedAt: null,
      createdAt: now
    };

    await repository.createSessionWithPlaybackGrant(value, grant);
    await expect(repository.getSession(value.id)).resolves.toMatchObject({ id: value.id });
    await expect(repository.getPlaybackGrant(grant.tokenHash)).resolves.toMatchObject({
      sessionId: value.id,
      revokedAt: null
    });

    const replacementGrant: PlaybackGrant = {
      ...grant,
      tokenHash: 'replacement-grant'
    };
    await expect(
      repository.createSessionWithPlaybackGrant(
        { ...value, name: 'Replacement session' },
        replacementGrant
      )
    ).rejects.toThrow();
    await expect(repository.getPlaybackGrant(replacementGrant.tokenHash)).resolves.toBeUndefined();
    await expect(repository.getSession(value.id)).resolves.toMatchObject({ name: value.name });

    const duplicateGrantSession = session('duplicate-grant-session', now);
    await expect(
      repository.createSessionWithPlaybackGrant(duplicateGrantSession, {
        ...grant,
        sessionId: duplicateGrantSession.id
      })
    ).rejects.toThrow();
    await expect(repository.getSession(duplicateGrantSession.id)).resolves.toBeUndefined();

    const rejectedGrant: PlaybackGrant = {
      ...grant,
      tokenHash: 'rolled-back-grant',
      sessionId: 'invalid-session'
    };
    const invalidSession = {
      ...session('invalid-session', now),
      updatedAt: null
    } as unknown as RelaySession;
    await expect(
      repository.createSessionWithPlaybackGrant(invalidSession, rejectedGrant)
    ).rejects.toThrow();
    await expect(repository.getPlaybackGrant(rejectedGrant.tokenHash)).resolves.toBeUndefined();

    const revokedAt = new Date(Date.now() + 1_000).toISOString();
    await repository.deleteSessionAndRevokePlaybackGrants(value.id, revokedAt);
    await expect(repository.getSession(value.id)).resolves.toBeUndefined();
    await expect(repository.getPlaybackGrant(grant.tokenHash)).resolves.toMatchObject({
      revokedAt
    });
    repository.close();
  });

  it('never lets a token-use update clear a concurrent revocation', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const createdAt = new Date().toISOString();
    const token = (id: string): PersonalAccessToken => ({
      id,
      name: id,
      tokenHash: `${id}-hash`,
      scopes: ['sessions:read'],
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt
    });
    const usedAt = new Date(Date.now() + 1_000).toISOString();
    const touchBefore = new Date(Date.parse(usedAt) - 60_000).toISOString();
    const revokedAt = new Date(Date.parse(usedAt) + 1_000).toISOString();

    const usedThenRevoked = token('used-then-revoked');
    await repository.putPersonalToken(usedThenRevoked);
    await expect(
      repository.usePersonalToken({ tokenHash: usedThenRevoked.tokenHash, usedAt, touchBefore })
    ).resolves.toMatchObject({ lastUsedAt: usedAt, revokedAt: null });
    await repository.revokePersonalToken(usedThenRevoked.id, revokedAt);
    await expect(repository.getPersonalToken(usedThenRevoked.tokenHash)).resolves.toMatchObject({
      lastUsedAt: usedAt,
      revokedAt
    });

    const revokedThenUsed = token('revoked-then-used');
    await repository.putPersonalToken(revokedThenUsed);
    await repository.revokePersonalToken(revokedThenUsed.id, revokedAt);
    await expect(
      repository.usePersonalToken({ tokenHash: revokedThenUsed.tokenHash, usedAt, touchBefore })
    ).resolves.toBeUndefined();
    await expect(repository.getPersonalToken(revokedThenUsed.tokenHash)).resolves.toMatchObject({
      lastUsedAt: null,
      revokedAt
    });
    repository.close();
  });

  it('keeps drain and revocation durable across heartbeat and maintenance races', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const now = new Date().toISOString();
    await repository.createNode(node('node-a', now));
    const initial = (await repository.getVersionedNode('node-a'))!;
    const drained = await repository.setNodeDrain({
      nodeId: 'node-a',
      expectedRevision: initial.revision,
      draining: true,
      updatedAt: new Date(Date.now() + 1).toISOString()
    });
    expect(drained).toMatchObject({ applied: true, record: { value: { state: 'draining' } } });
    if (!drained.applied) throw new Error('Drain transition did not apply');

    await expect(
      repository.recordNodeHeartbeat({
        nodeId: 'node-a',
        expectedRevision: initial.revision,
        capabilities: initial.value.capabilities,
        reportedState: 'online',
        lastHeartbeatAt: new Date(Date.now() + 2).toISOString(),
        updatedAt: new Date(Date.now() + 2).toISOString()
      })
    ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
    const heartbeat = await repository.recordNodeHeartbeat({
      nodeId: 'node-a',
      expectedRevision: drained.record.revision,
      capabilities: drained.record.value.capabilities,
      reportedState: 'online',
      lastHeartbeatAt: new Date(Date.now() + 3).toISOString(),
      updatedAt: new Date(Date.now() + 3).toISOString()
    });
    expect(heartbeat).toMatchObject({ applied: true, record: { value: { state: 'draining' } } });
    if (!heartbeat.applied) throw new Error('Heartbeat transition did not apply');
    await expect(
      repository.setNodeOperationalState({
        nodeId: 'node-a',
        expectedRevision: heartbeat.record.revision,
        state: 'offline',
        updatedAt: new Date(Date.now() + 4).toISOString()
      })
    ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });

    const revokedAt = new Date(Date.now() + 5).toISOString();
    const revokedResult = await repository.revokeNode({
      nodeId: 'node-a',
      expectedRevision: heartbeat.record.revision,
      revokedAt
    });
    expect(revokedResult).toMatchObject({
      applied: true,
      record: { value: { state: 'revoked' } }
    });
    if (!revokedResult.applied) throw new Error('Node revocation did not apply');
    const revoked = revokedResult.record;
    const revokedHeartbeat = await repository.recordNodeHeartbeat({
      nodeId: 'node-a',
      expectedRevision: revoked.revision,
      capabilities: revoked.value.capabilities,
      reportedState: 'online',
      lastHeartbeatAt: new Date(Date.now() + 6).toISOString(),
      updatedAt: new Date(Date.now() + 6).toISOString()
    });
    expect(revokedHeartbeat).toMatchObject({
      applied: true,
      record: { value: { state: 'revoked' } }
    });
    repository.close();
  });

  it('serializes certificate rotation with drain and terminal node revocation', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const now = new Date().toISOString();
    await repository.createNode(node('node-cert', now), certificate('node-cert', 'serial-1', now));
    const online = (await repository.getVersionedNode('node-cert'))!;
    const drainedAt = new Date(Date.parse(now) + 1_000).toISOString();
    const drained = await repository.setNodeDrain({
      nodeId: 'node-cert',
      expectedRevision: online.revision,
      draining: true,
      updatedAt: drainedAt
    });
    expect(drained).toMatchObject({ applied: true, record: { value: { state: 'draining' } } });
    if (!drained.applied) throw new Error('Drain transition did not apply');

    const rotatedAt = new Date(Date.parse(now) + 2_000).toISOString();
    const nextCertificate = certificate('node-cert', 'serial-2', rotatedAt);
    await expect(
      repository.rotateNodeCertificate({
        nodeId: 'node-cert',
        expectedRevision: online.revision,
        certificate: nextCertificate,
        updatedAt: rotatedAt
      })
    ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
    const rotated = await repository.rotateNodeCertificate({
      nodeId: 'node-cert',
      expectedRevision: drained.record.revision,
      certificate: nextCertificate,
      updatedAt: rotatedAt
    });
    expect(rotated).toMatchObject({
      applied: true,
      record: { value: { state: 'draining', certificateExpiresAt: nextCertificate.expiresAt } }
    });
    if (!rotated.applied) throw new Error('Certificate rotation did not apply');
    expect(await repository.listNodeCertificates('node-cert')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serialNumber: 'serial-1', revokedAt: rotatedAt }),
        expect.objectContaining({ serialNumber: 'serial-2', revokedAt: null })
      ])
    );

    const revokedAt = new Date(Date.parse(now) + 3_000).toISOString();
    const revoked = await repository.revokeNode({
      nodeId: 'node-cert',
      expectedRevision: rotated.record.revision,
      revokedAt
    });
    expect(revoked).toMatchObject({ applied: true, record: { value: { state: 'revoked' } } });
    if (!revoked.applied) throw new Error('Node revocation did not apply');
    expect(
      (await repository.listNodeCertificates('node-cert')).every((item) => item.revokedAt)
    ).toBe(true);
    await expect(
      repository.rotateNodeCertificate({
        nodeId: 'node-cert',
        expectedRevision: revoked.record.revision,
        certificate: certificate('node-cert', 'serial-3', revokedAt),
        updatedAt: revokedAt
      })
    ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });
    expect(
      (await repository.listNodeCertificates('node-cert')).map((item) => item.serialNumber)
    ).not.toContain('serial-3');
    repository.close();
  });

  it('makes job completion and cancellation mutually exclusive', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const now = new Date().toISOString();
    await repository.createSegmentJob(job('job-a', 'running', now));
    const running = (await repository.getVersionedSegmentJob('job-a'))!;
    const completedAt = new Date(Date.now() + 1).toISOString();
    const completed = await repository.completeSegmentJob(
      { ...running.value, state: 'complete', completedAt, updatedAt: completedAt },
      running.revision
    );
    expect(completed).toMatchObject({ applied: true, record: { value: { state: 'complete' } } });
    if (!completed.applied) throw new Error('Completion did not apply');

    const cancelledAt = new Date(Date.now() + 2).toISOString();
    await expect(
      repository.cancelSegmentJob(
        { ...running.value, state: 'cancelled', completedAt: cancelledAt, updatedAt: cancelledAt },
        running.revision
      )
    ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
    await expect(
      repository.cancelSegmentJob(
        {
          ...completed.record.value,
          state: 'cancelled',
          completedAt: cancelledAt,
          updatedAt: cancelledAt
        },
        completed.record.revision
      )
    ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });

    await repository.createSegmentJob(job('job-b', 'running', now));
    const runningB = (await repository.getVersionedSegmentJob('job-b'))!;
    const cancelled = await repository.cancelSegmentJob(
      {
        ...runningB.value,
        state: 'cancelled',
        completedAt: cancelledAt,
        updatedAt: cancelledAt
      },
      runningB.revision
    );
    expect(cancelled).toMatchObject({ applied: true, record: { value: { state: 'cancelled' } } });
    if (!cancelled.applied) throw new Error('Cancellation did not apply');
    await expect(
      repository.compareAndSetSegmentJob(
        { ...runningB.value, state: 'running', updatedAt: new Date().toISOString() },
        runningB.revision,
        ['running']
      )
    ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
    repository.close();
  });

  it('persists append-only audit events and applies bounded filters', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const firstAt = new Date(Date.now() - 1_000).toISOString();
    const secondAt = new Date().toISOString();
    const first: AuditEvent = {
      id: 'audit-1',
      operationId: '00000000-0000-4000-8000-000000000001',
      category: 'authentication',
      action: 'session.login',
      outcome: 'success',
      actor: { type: 'administrator', id: 'admin' },
      target: { type: 'session', id: 'session-a' },
      context: { method: 'password' },
      occurredAt: firstAt
    };
    const second: AuditEvent = {
      id: 'audit-2',
      operationId: '00000000-0000-4000-8000-000000000002',
      category: 'cluster',
      action: 'node.drain',
      outcome: 'success',
      actor: { type: 'administrator', id: 'admin' },
      target: { type: 'node', id: 'node-a' },
      context: { draining: true },
      occurredAt: secondAt
    };
    await repository.appendAuditEvent(first);
    await repository.appendAuditEvent(second);
    await repository.appendAuditEvent(second);

    expect((await repository.listAuditEvents()).map(({ id }) => id)).toEqual([
      'audit-2',
      'audit-1'
    ]);
    await expect(repository.listAuditEvents({ category: 'cluster' })).resolves.toMatchObject([
      { id: 'audit-2' }
    ]);
    await expect(repository.listAuditEvents({ targetId: 'session-a' })).resolves.toMatchObject([
      { id: 'audit-1' }
    ]);
    await expect(repository.listAuditEvents({ before: secondAt })).resolves.toMatchObject([
      { id: 'audit-1' }
    ]);
    repository.close();
  });

  it('retains bounded job logs per segment job', async () => {
    const { path } = await temporaryDatabase();
    const repository = new SqliteRepository(path);
    await repository.migrate();
    const base = Date.now();
    await repository.putJobLog(jobLog('log-1', 'job-a', new Date(base).toISOString()), 2);
    await repository.putJobLog(jobLog('log-2', 'job-a', new Date(base + 1).toISOString()), 2);
    await repository.putJobLog(jobLog('log-3', 'job-a', new Date(base + 2).toISOString()), 2);
    await repository.putJobLog(jobLog('other-job', 'job-b', new Date(base + 3).toISOString()), 2);

    await expect(repository.listJobLogs('job-a', 10)).resolves.toMatchObject([
      { id: 'log-3' },
      { id: 'log-2' }
    ]);
    await expect(repository.listJobLogs('job-a', 1)).resolves.toMatchObject([{ id: 'log-3' }]);
    await expect(repository.listJobLogs('job-b', 10)).resolves.toMatchObject([{ id: 'other-job' }]);
    repository.close();
  });
});
