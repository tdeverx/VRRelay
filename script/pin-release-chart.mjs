// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function imageRepository(value) {
  const candidate = String(value ?? '');
  if (!/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(candidate))
    throw new Error('Release chart repository must be a lowercase ghcr.io image repository');
  return candidate;
}

function imageDigest(value) {
  const candidate = String(value ?? '').toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(candidate))
    throw new Error('Release chart image digest must be a SHA-256 OCI digest');
  return candidate;
}

export async function pinReleaseChart(chartDirectory, repository, digest) {
  const valuesPath = resolve(chartDirectory, 'values.yaml');
  const values = await readFile(valuesPath, 'utf8');
  const imageLine =
    /^image: \{ repository: [^,\n]+, tag: '[^'\n]*', digest: '[^'\n]*', pullPolicy: ([A-Za-z]+) \}$/m;
  const match = imageLine.exec(values);
  if (!match) throw new Error('Release chart values contain an unexpected relay image declaration');
  const replacement = `image: { repository: ${imageRepository(repository)}, tag: 'latest', digest: '${imageDigest(digest)}', pullPolicy: ${match[1]} }`;
  const pinned = values.replace(imageLine, replacement);
  if (pinned === values) throw new Error('Release chart relay image was not pinned');
  await writeFile(valuesPath, pinned, 'utf8');
}

async function main() {
  const [, , chartDirectory, repository, digest] = process.argv;
  if (!chartDirectory || !repository || !digest)
    throw new Error(
      'Usage: node script/pin-release-chart.mjs <chart-directory> <repository> <digest>'
    );
  await pinReleaseChart(chartDirectory, repository, digest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
