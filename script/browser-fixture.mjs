// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateRoot = resolve(root, 'tmp/browser-e2e');
const dataDirectory = resolve(stateRoot, 'data');
const cacheDirectory = resolve(stateRoot, 'cache');

await rm(stateRoot, { recursive: true, force: true });
await mkdir(dataDirectory, { recursive: true });
await mkdir(cacheDirectory, { recursive: true });

const relay = spawn(process.execPath, ['apps/relay/dist/main.js'], {
  cwd: root,
  env: {
    ...process.env,
    VRRELAY_ENVIRONMENT: 'development',
    VRRELAY_LISTEN_ADDR: '127.0.0.1:18200',
    VRRELAY_AGENT_LISTEN_ADDR: '127.0.0.1:18201',
    VRRELAY_PUBLIC_URL: 'http://127.0.0.1:18200',
    VRRELAY_DATA_DIR: dataDirectory,
    VRRELAY_CACHE_DIR: cacheDirectory,
    VRRELAY_REPOSITORY_DRIVER: 'sqlite',
    VRRELAY_COORDINATION_DRIVER: 'memory',
    VRRELAY_OBJECT_STORE_DRIVER: 'local',
    VRRELAY_SECRET_BACKEND: 'encrypted-file',
    VRRELAY_MASTER_KEY: randomBytes(32).toString('base64url'),
    VRRELAY_LOG_LEVEL: 'warn'
  },
  stdio: 'inherit'
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  relay.kill('SIGTERM');
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
relay.once('error', (error) => {
  console.error('Browser fixture could not start the relay:', error);
  process.exitCode = 1;
});
relay.once('exit', (code, signal) => {
  if (!stopping && (code ?? (signal ? 1 : 0)) !== 0) {
    process.exitCode = code ?? 1;
  }
  process.exit();
});

await new Promise(() => {});
