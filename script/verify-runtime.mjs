import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const manifest = JSON.parse(
  await readFile(new URL('../deploy/runtime-manifest.json', import.meta.url), 'utf8')
);
const expected = new Map();
for (const component of manifest.components) {
  for (const artifact of Object.values(component.artifacts))
    expected.set(artifact.file, artifact.sha256);
}
if (!process.argv[2]) throw new Error('Usage: node script/verify-runtime.mjs <artifact> [...]');
for (const file of process.argv.slice(2)) {
  const wanted = expected.get(basename(file));
  if (!wanted) throw new Error(`Artifact is not pinned: ${basename(file)}`);
  const hash = createHash('sha256');
  await new Promise((resolve, reject) =>
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject)
  );
  const actual = hash.digest('hex');
  if (actual !== wanted) throw new Error(`SHA-256 mismatch for ${basename(file)}: ${actual}`);
  console.log(`${basename(file)}: verified`);
}
