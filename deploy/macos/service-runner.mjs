// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFile, rename, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const [entrypoint, logPath, rawMaxBytes = '10485760', rawKeepFiles = '8'] = process.argv.slice(2);
const maxBytes = Number(rawMaxBytes);
const keepFiles = Number(rawKeepFiles);

if (!entrypoint || !logPath || !Number.isSafeInteger(maxBytes) || maxBytes < 1024)
  throw new Error('Usage: service-runner.mjs <entrypoint> <log-path> [max-bytes] [keep-files]');
if (!Number.isSafeInteger(keepFiles) || keepFiles < 1 || keepFiles > 100)
  throw new Error('Log retention must be between 1 and 100 files');

let queuedWrite = Promise.resolve();

async function rotateIfNeeded(nextBytes) {
  const currentBytes = await stat(logPath).then(
    (value) => value.size,
    () => 0
  );
  if (currentBytes === 0 || currentBytes + nextBytes <= maxBytes) return;
  await unlink(`${logPath}.${keepFiles}`).catch(() => undefined);
  for (let index = keepFiles - 1; index >= 1; index -= 1) {
    await rename(`${logPath}.${index}`, `${logPath}.${index + 1}`).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
  await rename(logPath, `${logPath}.1`).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

function write(chunk) {
  queuedWrite = queuedWrite
    .then(async () => {
      await rotateIfNeeded(chunk.length);
      await appendFile(logPath, chunk, { mode: 0o600 });
    })
    .catch((error) => {
      process.stderr.write(`VRRelay log write failed: ${error.message}\n`);
    });
}

const child = spawn(process.execPath, [entrypoint], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', write);
child.stderr.on('data', write);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  });
}

child.once('error', async (error) => {
  write(Buffer.from(`VRRelay service could not start: ${error.message}\n`));
  await queuedWrite;
  process.exit(1);
});
child.once('exit', async (code, signal) => {
  await queuedWrite;
  process.exit(code ?? (signal ? 1 : 0));
});
