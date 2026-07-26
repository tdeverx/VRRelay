// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories = [];
const script = resolve(import.meta.dirname, 'select-native-prebuild.mjs');

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('native prebuild selection', () => {
  it('keeps only the requested platform binary', async () => {
    const runtime = await mkdtemp(resolve(tmpdir(), 'vrrelay-native-prebuild-'));
    temporaryDirectories.push(runtime);
    const prebuilds = resolve(runtime, 'node_modules', 'better-sqlite3', 'prebuilds');
    await mkdir(prebuilds, { recursive: true });
    await Promise.all(
      ['darwin-arm64.node', 'linux-x64.node', 'win32-x64.node', 'README.md'].map((file) =>
        writeFile(resolve(prebuilds, file), file)
      )
    );

    const result = spawnSync(process.execPath, [script, runtime, 'darwin-arm64'], {
      encoding: 'utf8'
    });

    expect(result.status, result.stderr).toBe(0);
    expect((await readdir(prebuilds)).sort()).toEqual(['README.md', 'darwin-arm64.node']);
  });

  it('fails closed when the requested binary is absent', async () => {
    const runtime = await mkdtemp(resolve(tmpdir(), 'vrrelay-native-prebuild-'));
    temporaryDirectories.push(runtime);
    const prebuilds = resolve(runtime, 'node_modules', 'better-sqlite3', 'prebuilds');
    await mkdir(prebuilds, { recursive: true });
    await writeFile(resolve(prebuilds, 'linux-x64.node'), 'linux');

    const result = spawnSync(process.execPath, [script, runtime, 'win32-x64'], {
      encoding: 'utf8'
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not contain the required win32-x64 prebuild');
  });
});
