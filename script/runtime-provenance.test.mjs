// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeProvenance, runtimeVersionMatches } from './runtime-provenance.mjs';

let temporaryDirectory;
afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe('runtime provenance', () => {
  it('matches exact versions without accepting a numeric suffix', () => {
    expect(runtimeVersionMatches('ffmpeg version n8.1.2-22-gabc', '8.1.2')).toBe(true);
    expect(
      runtimeVersionMatches('ffmpeg version n8.1.2-22-g94138f6973', '8.1.2-22-g94138f6973')
    ).toBe(true);
    expect(
      runtimeVersionMatches('ffmpeg version n8.1.2-22-gdeadbeef00', '8.1.2-22-g94138f6973')
    ).toBe(false);
    expect(runtimeVersionMatches('v26.5.0', '26.5.0')).toBe(true);
    expect(runtimeVersionMatches('ffmpeg version 8.1.20', '8.1.2')).toBe(false);
  });

  it('records a bundled binary hash without leaking its source path', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'vrrelay-provenance-'));
    const outputPath = join(temporaryDirectory, 'runtime-provenance.json');
    const manifestPath = join(temporaryDirectory, 'runtime-manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        components: [
          {
            name: 'node',
            version: process.version.slice(1),
            source: 'https://nodejs.org/'
          }
        ]
      })
    );
    const provenance = await createRuntimeProvenance({
      manifestPath,
      outputPath,
      entries: [['node', process.execPath]]
    });
    expect(provenance.components[0]).toMatchObject({
      name: 'node',
      version: process.version.slice(1),
      file: process.platform === 'win32' ? 'node.exe' : 'node'
    });
    expect(provenance.components[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(outputPath, 'utf8')).not.toContain(dirname(process.execPath));
  });
});
