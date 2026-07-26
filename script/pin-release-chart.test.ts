// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pinReleaseChart } from './pin-release-chart.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('release Helm chart pinning', () => {
  it('pins the authoritative OCI repository and digest without changing the mutable fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-release-chart-'));
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'values.yaml'),
      "image: { repository: ghcr.io/example/old, tag: 'latest', digest: '', pullPolicy: IfNotPresent }\ncontroller: { enabled: true }\n"
    );

    const digest = `sha256:${'a'.repeat(64)}`;
    await pinReleaseChart(directory, 'ghcr.io/example/vrrelay', digest);

    await expect(readFile(join(directory, 'values.yaml'), 'utf8')).resolves.toContain(
      `image: { repository: ghcr.io/example/vrrelay, tag: 'latest', digest: '${digest}', pullPolicy: IfNotPresent }`
    );
  });

  it.each([
    ['ghcr.io/Example/vrrelay', `sha256:${'a'.repeat(64)}`],
    ['ghcr.io/example/vrrelay', 'sha256:abc']
  ])('rejects an invalid immutable image reference', async (repository, digest) => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-release-chart-invalid-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'values.yaml'),
      "image: { repository: ghcr.io/example/old, tag: 'latest', digest: '', pullPolicy: IfNotPresent }\n"
    );

    await expect(pinReleaseChart(directory, repository, digest)).rejects.toThrow();
  });
});
