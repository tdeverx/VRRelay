// SPDX-License-Identifier: GPL-3.0-or-later
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishFileAtomically, withFileMutation } from './file-secret-storage.js';
import { EncryptedFileSecretStore } from './secret-stores.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vrrelay-secret-store-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('file-backed secret storage', () => {
  it('serializes a path across instances and keeps the queue usable after a rejected mutation', async () => {
    const path = join(await temporaryDirectory(), 'secrets.json');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];

    const first = withFileMutation(path, async () => {
      order.push('first-entered');
      entered.resolve();
      await release.promise;
      order.push('first-failed');
      throw new Error('simulated mutation failure');
    });
    const firstResult = first.then(
      () => 'resolved',
      (error: unknown) => (error as Error).message
    );
    await entered.promise;

    let secondEntered = false;
    const second = withFileMutation(path, async () => {
      secondEntered = true;
      order.push('second-entered');
    });
    await Promise.resolve();
    expect(secondEntered).toBe(false);

    release.resolve();
    expect(await firstResult).toBe('simulated mutation failure');
    await second;
    await expect(
      withFileMutation(path, async () => {
        order.push('third-entered');
        return 'ready';
      })
    ).resolves.toBe('ready');
    expect(order).toEqual(['first-entered', 'first-failed', 'second-entered', 'third-entered']);
  });

  it('preserves concurrent encrypted puts and deletes across store instances', async () => {
    const directory = await temporaryDirectory();
    await mkdir(directory, { recursive: true, mode: 0o755 });
    if (process.platform !== 'win32') await chmod(directory, 0o755);
    const path = join(directory, 'secrets.json');
    const stores = [
      new EncryptedFileSecretStore(path, 'correct horse battery staple one'),
      new EncryptedFileSecretStore(path, 'correct horse battery staple one')
    ];
    const entries = Array.from(
      { length: 32 },
      (_, index) => [`secret-${index}`, `value-${index}`] as const
    );

    await Promise.all(
      entries.map(([ref, value], index) => stores[index % stores.length]!.put(ref, value))
    );
    await Promise.all(
      entries.map(async ([ref, value], index) => {
        await expect(stores[(index + 1) % stores.length]!.get(ref)).resolves.toBe(value);
      })
    );

    await Promise.all([
      ...entries
        .filter((_, index) => index % 2 === 0)
        .map(([ref], index) => stores[index % stores.length]!.delete(ref)),
      ...Array.from({ length: 16 }, (_, index) =>
        stores[index % stores.length]!.put(`replacement-${index}`, `replacement-value-${index}`)
      )
    ]);
    await Promise.all(
      entries
        .filter((_, index) => index % 2 === 1)
        .map(([ref, value]) => expect(stores[0]!.get(ref)).resolves.toBe(value))
    );
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        expect(stores[1]!.get(`replacement-${index}`)).resolves.toBe(`replacement-value-${index}`)
      )
    );

    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(directory)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('secures the temporary file before rename and the destination after publication', async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, 'state.json');
    const calls: string[] = [];

    await publishFileAtomically(destination, '{"ready":true}', {
      directoryMode: 0o700,
      fileMode: 0o600,
      secureTemporary: async (path) => {
        calls.push(`temporary:${basename(path)}`);
        await expect(readFile(path, 'utf8')).resolves.toBe('{"ready":true}');
      },
      secureDestination: async (path) => {
        calls.push(`destination:${basename(path)}`);
        await expect(readFile(path, 'utf8')).resolves.toBe('{"ready":true}');
      }
    });

    expect(calls[0]).toMatch(/^temporary:state\.json\.\d+\.[0-9a-f-]+\.tmp$/);
    expect(calls[1]).toBe('destination:state.json');
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(directory)).toEqual(['state.json']);
  });

  it('keeps the previous file and removes the unique temporary file when publication fails', async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, 'state.json');
    await writeFile(destination, 'stable');

    await expect(
      publishFileAtomically(destination, 'replacement', {
        secureTemporary: async () => {
          throw new Error('simulated ACL failure');
        }
      })
    ).rejects.toThrow('simulated ACL failure');

    await expect(readFile(destination, 'utf8')).resolves.toBe('stable');
    expect(await readdir(directory)).toEqual(['state.json']);
  });
});
