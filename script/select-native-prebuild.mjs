// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const targetPattern = /^(darwin|linux|linuxmusl|win32)-(arm64|x64)\.node$/;

const [runtimeRoot, target] = process.argv.slice(2);
if (!runtimeRoot || !targetPattern.test(`${target}.node`)) {
  console.error(
    'Usage: select-native-prebuild.mjs <runtime-root> <darwin|linux|linuxmusl|win32>-<arm64|x64>'
  );
  process.exit(2);
}

const prebuildDirectory = resolve(runtimeRoot, 'node_modules', 'better-sqlite3', 'prebuilds');
const expectedFile = `${target}.node`;
const entries = await readdir(prebuildDirectory, { withFileTypes: true });
const nativeFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.node'))
  .map((entry) => entry.name);

if (!nativeFiles.includes(expectedFile)) {
  throw new Error(`better-sqlite3 does not contain the required ${target} prebuild`);
}

const unknownFiles = nativeFiles.filter((file) => !targetPattern.test(file));
if (unknownFiles.length > 0) {
  throw new Error(`Unrecognised better-sqlite3 prebuilds: ${unknownFiles.join(', ')}`);
}

const foreignFiles = nativeFiles.filter((file) => file !== expectedFile);
await Promise.all(foreignFiles.map((file) => unlink(resolve(prebuildDirectory, file))));
console.log(
  `Selected better-sqlite3 ${target} prebuild; removed ${foreignFiles.length} foreign binaries`
);
