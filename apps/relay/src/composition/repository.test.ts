// SPDX-License-Identifier: GPL-3.0-or-later
import { chmod, mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createRepository } from './repository.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('repository composition', () => {
  it.skipIf(process.platform === 'win32')(
    'restricts the application data directory before opening SQLite',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'vrrelay-repository-'));
      directories.push(root);
      const dataDir = join(root, 'data');
      await mkdir(dataDir, { mode: 0o755 });
      await chmod(dataDir, 0o755);
      const config = loadConfig({ VRRELAY_DATA_DIR: dataDir });

      const repository = createRepository(config);
      try {
        expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
        await expect(stat(join(dataDir, 'vrrelay.sqlite3'))).resolves.toBeDefined();
      } finally {
        repository.close();
      }
    }
  );
});
