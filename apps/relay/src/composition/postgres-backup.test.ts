// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPostgresMigrationBackup,
  runPgDump,
  type PgDumpInvocation
} from './postgres-backup.js';

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
);

describe('PostgreSQL migration backup', () => {
  it('creates an atomic, restricted, checksummed dump without putting credentials in arguments', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vrrelay-pg-backup-'));
    directories.push(dataDir);
    const postgresUrl = 'postgres://relay:super-secret@database.example/vrrelay';
    let invocation: PgDumpInvocation | undefined;
    const artifact = await createPostgresMigrationBackup(
      {
        dataDir,
        pgDumpPath: '/opt/postgres/bin/pg_dump',
        pgDumpTimeoutMs: 60_000,
        postgresUrl
      },
      { driver: 'postgres', currentVersion: 2, targetVersion: 3, existingSchema: true },
      async (next) => {
        invocation = next;
        const output = next.arguments[next.arguments.indexOf('--file') + 1];
        if (!output) throw new Error('test runner did not receive an output path');
        await writeFile(output, 'deterministic test dump');
      }
    );

    expect(invocation?.executable).toBe('/opt/postgres/bin/pg_dump');
    expect(invocation?.arguments.join(' ')).not.toContain(postgresUrl);
    expect(invocation?.environment.PGDATABASE).toBe(postgresUrl);
    expect(invocation?.timeoutMs).toBe(60_000);
    expect(invocation?.environment.VRRELAY_MASTER_KEY).toBeUndefined();
    expect(artifact.location).toMatch(/postgres-v2-to-v3-.+\.dump$/);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(artifact.location, 'utf8')).toBe('deterministic test dump');
    if (process.platform !== 'win32') {
      expect((await stat(artifact.location)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(artifact.location))).mode & 0o777).toBe(0o700);
    }
  });

  it('removes partial artifacts when pg_dump fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vrrelay-pg-backup-fail-'));
    directories.push(dataDir);
    await expect(
      createPostgresMigrationBackup(
        {
          dataDir,
          pgDumpPath: 'pg_dump',
          pgDumpTimeoutMs: 60_000,
          postgresUrl: 'postgres://localhost/vrrelay'
        },
        { driver: 'postgres', currentVersion: 2, targetVersion: 3, existingSchema: true },
        async (invocation) => {
          const output = invocation.arguments[invocation.arguments.indexOf('--file') + 1];
          if (output) await writeFile(output, 'partial');
          throw new Error('simulated pg_dump failure');
        }
      )
    ).rejects.toThrow('simulated pg_dump failure');

    await expect(stat(join(dataDir, 'migration-backups'))).resolves.toBeDefined();
    expect(
      await import('node:fs/promises').then(({ readdir }) =>
        readdir(join(dataDir, 'migration-backups'))
      )
    ).toEqual([]);
  });

  it('waits for a timed-out child to terminate before rejecting', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vrrelay-pg-backup-timeout-'));
    directories.push(dataDir);
    const cleanupMarker = join(dataDir, 'cleanup-complete');
    await expect(
      runPgDump({
        executable: process.execPath,
        arguments: [
          '-e',
          "process.on('SIGTERM',()=>setTimeout(()=>{require('node:fs').writeFileSync(process.env.VRRELAY_PG_DUMP_TEST_MARKER,'done');process.stderr.write('terminated after cleanup');process.exit(0);},75));setInterval(()=>{},1000)"
        ],
        environment: { PATH: process.env.PATH, VRRELAY_PG_DUMP_TEST_MARKER: cleanupMarker },
        timeoutMs: 500
      })
    ).rejects.toThrow('pg_dump exceeded its 500ms deadline');
    await expect(readFile(cleanupMarker, 'utf8')).resolves.toBe('done');
  });

  it('redacts database credentials from pg_dump failures', async () => {
    const databaseUrl = 'postgres://relay:do-not-log-me@database.example/vrrelay';
    let failure: Error | undefined;
    try {
      await runPgDump({
        executable: process.execPath,
        arguments: ['-e', "process.stderr.write(process.env.PGDATABASE ?? '');process.exit(4)"],
        environment: { PATH: process.env.PATH, PGDATABASE: databaseUrl },
        timeoutMs: 5_000
      });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain('exit code 4');
    expect(failure?.message).not.toContain(databaseUrl);
    expect(failure?.message).not.toContain('do-not-log-me');
  });
});
