// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const versionArguments = new Map([
  ['node', ['--version']],
  ['ffmpeg', ['-hide_banner', '-version']],
  ['mediamtx', ['--version']],
  ['electron', ['--version']]
]);

export function runtimeVersionMatches(output, expectedVersion) {
  const escaped = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9])v?${escaped}(?![0-9])`, 'i').test(output);
}

async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) =>
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolvePromise)
      .on('error', reject)
  );
  return hash.digest('hex');
}

export async function createRuntimeProvenance({ manifestPath, outputPath, entries }) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const components = new Map(manifest.components.map((component) => [component.name, component]));
  const result = [];
  for (const [name, path] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    const component = components.get(name);
    if (!component) throw new Error(`Runtime component is not declared: ${name}`);
    let versionOutput;
    const args = versionArguments.get(name);
    if (args) {
      const execution = await execFileAsync(path, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000
      });
      versionOutput = `${execution.stdout}\n${execution.stderr}`.trim().split(/\r?\n/, 1)[0];
      if (!runtimeVersionMatches(versionOutput, component.version))
        throw new Error(
          `${name} reports ${JSON.stringify(versionOutput)}; expected ${component.version}`
        );
    }
    result.push({
      name,
      version: component.version,
      file: basename(path),
      sha256: await sha256(path),
      source: component.source,
      ...(versionOutput ? { versionOutput } : {})
    });
  }
  const provenance = { schemaVersion: 1, components: result };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

async function cli() {
  const args = process.argv.slice(2);
  if (args[0] !== '--output' || !args[1] || args.length < 3)
    throw new Error(
      'Usage: node script/runtime-provenance.mjs --output <file> <component>=<binary> [...]'
    );
  const entries = args.slice(2).map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1 || separator === entry.length - 1)
      throw new Error(`Invalid runtime entry: ${entry}`);
    return [entry.slice(0, separator), resolve(entry.slice(separator + 1))];
  });
  const provenance = await createRuntimeProvenance({
    manifestPath: resolve('deploy/runtime-manifest.json'),
    outputPath: resolve(args[1]),
    entries
  });
  for (const component of provenance.components)
    console.log(`${component.name} ${component.version}: ${component.sha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await cli();
