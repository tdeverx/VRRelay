// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, rm, writeFile } from 'node:fs/promises';

const paths = [
  'dist',
  '.cache',
  'coverage',
  'apps/macos/.build',
  'apps/relay/dist',
  'apps/relay/public',
  'apps/web/.svelte-kit',
  'apps/web/build',
  'apps/windows/dist',
  'packages/adapters/dist',
  'packages/application/dist',
  'packages/contracts/dist',
  'packages/domain/dist'
];

const root = new URL('..', import.meta.url);
await Promise.all(paths.map((path) => rm(new URL(path, root), { recursive: true, force: true })));
const publicDirectory = new URL('../apps/relay/public/', import.meta.url);
await mkdir(publicDirectory, { recursive: true });
await writeFile(new URL('.gitkeep', publicDirectory), '');
