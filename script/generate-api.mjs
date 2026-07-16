// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'apps/web/src/lib/generated/vrrelay-api');
const executable = process.platform === 'win32' ? 'openapi-ts.cmd' : 'openapi-ts';
const compatibilityLoader = new URL('./typescript-compat-loader.mjs', import.meta.url).href;

function generate(target) {
  const result = spawnSync(
    executable,
    [
      '-i',
      'contracts/openapi/vrrelay-v1.yaml',
      '-o',
      target,
      '-p',
      '@hey-api/typescript',
      '@hey-api/sdk',
      '@hey-api/client-fetch'
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${compatibilityLoader}`]
          .filter(Boolean)
          .join(' ')
      },
      stdio: 'inherit',
      shell: process.platform === 'win32'
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`OpenAPI generation exited with status ${result.status}`);
}

async function snapshot(directory) {
  const result = new Map();
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.set(relative(directory, path), await readFile(path));
    }
  }
  await visit(directory);
  return result;
}

if (!process.argv.includes('--check')) {
  await rm(output, { recursive: true, force: true });
  generate(output);
  process.exit(0);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'vrrelay-openapi-'));
try {
  const candidate = resolve(temporaryRoot, 'vrrelay-api');
  generate(candidate);

  const expected = await snapshot(candidate);
  let committed;
  try {
    committed = await snapshot(output);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    committed = new Map();
  }

  const differences = [];
  const paths = [...new Set([...expected.keys(), ...committed.keys()])].sort();
  for (const path of paths) {
    if (!committed.has(path)) differences.push(`missing ${path}`);
    else if (!expected.has(path)) differences.push(`obsolete ${path}`);
    else if (!expected.get(path).equals(committed.get(path))) differences.push(`changed ${path}`);
  }

  if (differences.length) {
    console.error('The committed OpenAPI dashboard client is stale:');
    for (const difference of differences) console.error(`  - ${difference}`);
    console.error('Run `npm run generate:api` and commit the generated files.');
    process.exitCode = 1;
  } else {
    console.log('The committed OpenAPI dashboard client matches the current contract.');
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
