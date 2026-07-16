// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PostgresMigrationBackupArtifact,
  PostgresMigrationBackupContext
} from '@vrrelay/adapters';
import type { RelayConfig } from '../config.js';

export interface PgDumpInvocation {
  executable: string;
  arguments: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type PgDumpRunner = (invocation: PgDumpInvocation) => Promise<void>;

export async function runPgDump(invocation: PgDumpInvocation): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    let forceKill: NodeJS.Timeout | undefined;
    let timedOut = false;
    let settled = false;
    const child = spawn(invocation.executable, invocation.arguments, {
      env: invocation.environment,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (error) reject(error);
      else resolve();
    };
    const redact = (message: string) => {
      let safe = message;
      const databaseUrl = invocation.environment.PGDATABASE;
      if (databaseUrl) {
        safe = safe.replaceAll(databaseUrl, '[redacted database URL]');
        try {
          const password = decodeURIComponent(new URL(databaseUrl).password);
          if (password) safe = safe.replaceAll(password, '[redacted]');
        } catch {
          // Invalid URLs are rejected by PostgreSQL; do not risk echoing the value here.
        }
      }
      return safe.replaceAll(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgres://[redacted]@');
    };
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 8_192) stderr += String(chunk).slice(0, 8_192 - stderr.length);
    });
    child.once('error', (error) => finish(new Error(`Could not start pg_dump: ${error.message}`)));
    child.once('close', (code, signal) => {
      const detail = redact(stderr.trim());
      if (timedOut)
        return finish(
          new Error(
            `pg_dump exceeded its ${invocation.timeoutMs}ms deadline${detail ? `: ${detail}` : ''}`
          )
        );
      if (code === 0) return finish();
      finish(
        new Error(
          `${signal ? `pg_dump was terminated by ${signal}` : `pg_dump failed with exit code ${code ?? 'unknown'}`}${detail ? `: ${detail}` : ''}`
        )
      );
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5_000);
      forceKill.unref();
    }, invocation.timeoutMs);
    timeout.unref();
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path))
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return hash.digest('hex');
}

export async function createPostgresMigrationBackup(
  config: Pick<RelayConfig, 'dataDir' | 'pgDumpPath' | 'pgDumpTimeoutMs' | 'postgresUrl'>,
  context: PostgresMigrationBackupContext,
  runner: PgDumpRunner = runPgDump
): Promise<PostgresMigrationBackupArtifact> {
  if (!config.postgresUrl) throw new Error('VRRELAY_POSTGRES_URL is required for PostgreSQL');
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replaceAll(/[:.]/g, '-');
  const directory = join(config.dataDir, 'migration-backups');
  const filename = `postgres-v${context.currentVersion}-to-v${context.targetVersion}-${stamp}-${randomUUID().slice(0, 8)}.dump`;
  const destination = join(directory, filename);
  const temporary = `${destination}.part`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LD_LIBRARY_PATH',
    'DYLD_LIBRARY_PATH',
    'PGSSLROOTCERT',
    'PGSSLCERT',
    'PGSSLKEY',
    'PGSSLMODE'
  ]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  environment.PGDATABASE = config.postgresUrl;
  environment.PGAPPNAME = 'VRRelay migration backup';

  try {
    await runner({
      executable: config.pgDumpPath,
      arguments: ['--format=custom', '--no-owner', '--no-acl', '--file', temporary],
      environment,
      timeoutMs: config.pgDumpTimeoutMs
    });
    const info = await stat(temporary);
    if (!info.isFile() || info.size === 0)
      throw new Error('pg_dump did not produce a non-empty backup artifact');
    await chmod(temporary, 0o600);
    // Windows requires a writable handle for FlushFileBuffers, which backs
    // FileHandle.sync(). The dump is already complete before this point.
    const file = await open(temporary, 'r+');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    const sha256 = await sha256File(temporary);
    await rename(temporary, destination);
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    return { location: destination, sha256, createdAt };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function postgresMigrationBackupHook(
  config: Pick<RelayConfig, 'dataDir' | 'pgDumpPath' | 'pgDumpTimeoutMs' | 'postgresUrl'>
): (context: PostgresMigrationBackupContext) => Promise<PostgresMigrationBackupArtifact> {
  return (context) => createPostgresMigrationBackup(config, context);
}
