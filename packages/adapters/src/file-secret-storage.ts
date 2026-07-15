// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const mutationQueues = new Map<string, Promise<void>>();

export interface AtomicFilePublicationOptions {
  directoryMode?: number;
  fileMode?: number;
  secureTemporary?: (path: string) => Promise<void>;
  secureDestination?: (path: string) => Promise<void>;
}

/**
 * Serializes every in-process owner of one file path. Deployments must still
 * assign a writable secret-file path to exactly one service process; atomic
 * rename provides crash consistency, but this queue is not a cross-process lock.
 */
export async function withFileMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  mutationQueues.set(key, settled);
  try {
    return await result;
  } finally {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  }
}

export async function publishFileAtomically(
  destination: string,
  contents: string,
  options: AtomicFilePublicationOptions = {}
): Promise<void> {
  const directory = dirname(destination);
  await mkdir(directory, {
    recursive: true,
    ...(options.directoryMode === undefined ? {} : { mode: options.directoryMode })
  });
  if (process.platform !== 'win32' && options.directoryMode !== undefined)
    await chmod(directory, options.directoryMode);

  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', options.fileMode ?? 0o600);
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    if (process.platform !== 'win32' && options.fileMode !== undefined)
      await chmod(temporary, options.fileMode);
    await options.secureTemporary?.(temporary);
    await rename(temporary, destination);
    if (process.platform !== 'win32' && options.fileMode !== undefined)
      await chmod(destination, options.fileMode);
    await options.secureDestination?.(destination);

    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
