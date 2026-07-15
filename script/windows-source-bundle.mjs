// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeManifest = JSON.parse(
  await readFile(resolve(root, 'deploy/runtime-manifest.json'), 'utf8')
);
const ffmpeg = runtimeManifest.components.find((component) => component.name === 'ffmpeg');
const windowsArtifact = ffmpeg?.artifacts?.['windows-x64'];
const coveredTargets = ['linux-x64', 'linux-arm64', 'windows-x64'];

export const expectedWindowsSource = Object.freeze({
  binaryFile: windowsArtifact?.file,
  binarySha256: windowsArtifact?.sha256,
  ...windowsArtifact?.buildRecipe,
  coveredArtifacts: Object.fromEntries(
    coveredTargets.map((target) => {
      const artifact = ffmpeg?.artifacts?.[target];
      return [
        target,
        {
          binaryFile: artifact?.file,
          binarySha256: artifact?.sha256,
          ...artifact?.buildRecipe
        }
      ];
    })
  )
});

function assertExpectedRecipe(recipe) {
  for (const [key, expected] of Object.entries(expectedWindowsSource)) {
    const actual = recipe?.[key];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`FFmpeg source bundle ${key} does not match the runtime manifest`);
    }
  }
}

async function sourceFiles(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(path, base)));
    else if (entry.isFile() && entry.name !== 'SOURCE-BUNDLE.json') {
      const metadata = await stat(path);
      const sha256 = await new Promise((resolveHash, reject) => {
        const hash = createHash('sha256');
        createReadStream(path)
          .on('data', (chunk) => hash.update(chunk))
          .on('error', reject)
          .on('end', () => resolveHash(hash.digest('hex')));
      });
      result.push({
        path: relative(base, path).split(sep).join('/'),
        size: metadata.size,
        sha256
      });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export async function createSourceBundleManifest(directory, output, createdAt) {
  const files = await sourceFiles(directory);
  if (!files.length) throw new Error('FFmpeg source bundle contains no source files');
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date(createdAt ? Number(createdAt) * 1_000 : Date.now()).toISOString(),
    recipe: expectedWindowsSource,
    files
  };
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

export function readArchiveManifest(archive) {
  const entries = execFileSync('tar', ['-tJf', archive], { encoding: 'utf8' }).trim().split('\n');
  const manifestEntry = entries.find((entry) => entry.endsWith('/SOURCE-BUNDLE.json'));
  if (!manifestEntry) throw new Error('FFmpeg source archive has no SOURCE-BUNDLE.json');
  const manifest = JSON.parse(
    execFileSync('tar', ['-xJOf', archive, manifestEntry], { encoding: 'utf8' })
  );
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported Windows source bundle schema');
  assertExpectedRecipe(manifest.recipe);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0)
    throw new Error('Windows source bundle manifest has no files');
  const prefix = manifestEntry.slice(0, -'SOURCE-BUNDLE.json'.length);
  const archivedFiles = new Set(entries);
  for (const file of manifest.files) {
    if (
      typeof file.path !== 'string' ||
      file.path.startsWith('/') ||
      file.path.includes('..') ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !archivedFiles.has(`${prefix}${file.path}`)
    ) {
      throw new Error(`Invalid or absent Windows source bundle file: ${file.path}`);
    }
  }
  return manifest;
}

async function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === '--create' && first && second) {
    await createSourceBundleManifest(first, second, process.env.SOURCE_DATE_EPOCH);
    return;
  }
  if (command === '--verify' && first) {
    const manifest = readArchiveManifest(first);
    console.log(
      `Verified ${basename(first)} (${manifest.files.length} corresponding-source files)`
    );
    return;
  }
  throw new Error(
    'Usage: windows-source-bundle.mjs --create <directory> <manifest> | --verify <archive.tar.xz>'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
