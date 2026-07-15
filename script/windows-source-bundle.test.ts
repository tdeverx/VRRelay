// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSourceBundleManifest,
  expectedWindowsSource,
  readArchiveManifest
} from './windows-source-bundle.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const working = await mkdtemp(join(tmpdir(), 'vrrelay-source-bundle-'));
  temporaryDirectories.push(working);
  const source = join(working, 'vrrelay-windows-source');
  await mkdir(join(source, 'build-recipe'), { recursive: true });
  await mkdir(join(source, 'dependency-sources'), { recursive: true });
  await writeFile(join(source, 'build-recipe', 'build.sh'), '#!/bin/sh\n');
  await writeFile(join(source, 'dependency-sources', 'ffmpeg.tar.xz'), 'fixture source');
  await createSourceBundleManifest(source, join(source, 'SOURCE-BUNDLE.json'), '1782826542');
  const archive = join(working, 'source.tar.xz');
  execFileSync('tar', ['-cJf', archive, '-C', working, 'vrrelay-windows-source']);
  return { archive, source };
}

describe('FFmpeg corresponding-source bundle', () => {
  it('records and verifies the exact runtime build recipe', async () => {
    const { archive } = await fixture();
    const manifest = readArchiveManifest(archive);

    expect(manifest.recipe).toEqual(expectedWindowsSource);
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
      'build-recipe/build.sh',
      'dependency-sources/ffmpeg.tar.xz'
    ]);
    expect(manifest.createdAt).toBe('2026-06-30T13:35:42.000Z');
  });

  it('rejects a recipe that differs from the runtime manifest', async () => {
    const { archive, source } = await fixture();
    const manifestPath = join(source, 'SOURCE-BUNDLE.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.recipe.coveredArtifacts['linux-x64'].ffmpegCommit = '0'.repeat(40);
    await writeFile(manifestPath, JSON.stringify(manifest));
    execFileSync('tar', ['-cJf', archive, '-C', join(source, '..'), 'vrrelay-windows-source']);

    expect(() => readArchiveManifest(archive)).toThrow(/coveredArtifacts/);
  });
});
