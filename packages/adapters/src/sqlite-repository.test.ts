import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from './sqlite-repository.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
);

describe('SQLite repository', () => {
  it('migrates and preserves provider-neutral records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-db-'));
    dirs.push(dir);
    const repository = new SqliteRepository(join(dir, 'relay.sqlite'));
    await repository.migrate();
    const now = new Date().toISOString();
    await repository.putProvider({
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
  });
});
