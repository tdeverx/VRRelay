// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CachedObject, ProfileRevision, RelaySession } from '@vrrelay/domain';
import type { EventBus, MetricsSink, ObjectStore } from './index.js';
import { createServiceEvent as event } from './service-helpers.js';

export interface SessionCacheOptions {
  cacheDir: string;
  cacheTtlMs: number;
  cacheLimitBytes?: number;
}

export interface CacheEvictionFilter {
  sessionId?: string;
  profileId?: string;
  all?: boolean;
}

class CacheRestoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheRestoreValidationError';
  }
}

const OBJECT_REFERENCE_SUFFIX = '.vrrelay-object.json';

function objectReferencePath(path: string): string {
  return `${path}${OBJECT_REFERENCE_SUFFIX}`;
}

function secondsSince(startedAt: number): number {
  return (Date.now() - startedAt) / 1_000;
}

async function removePartialFiles(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return removePartialFiles(path);
      if (entry.name.includes('.part')) await rm(path, { force: true });
    })
  );
}

export class SessionCache {
  constructor(
    private readonly options: SessionCacheOptions,
    private readonly objectStore: ObjectStore | undefined,
    private readonly metrics: MetricsSink | undefined,
    private readonly events: EventBus
  ) {}

  async recoverPartials(): Promise<void> {
    await rm(join(this.options.cacheDir, 'worker'), { recursive: true, force: true });
    await removePartialFiles(join(this.options.cacheDir, 'vod'));
  }

  async publishObject(
    session: RelaySession,
    profile: ProfileRevision,
    index: number,
    destination: string,
    contentKey: string
  ): Promise<void> {
    const protectedPaths = [destination];
    try {
      if (!this.objectStore) return;
      const segmentSha256 = await this.#fileSha256(destination);
      await this.#objectOperation('put', () =>
        this.objectStore!.put(contentKey, createReadStream(destination), {
          contentType: profile.delivery.segmentType === 'fmp4' ? 'video/iso.segment' : 'video/mp2t',
          expiresAt: new Date(Date.now() + this.options.cacheTtlMs).toISOString(),
          sha256: segmentSha256,
          metadata: {
            sessionId: session.id,
            profileId: profile.profileId,
            revision: String(profile.revision)
          }
        })
      );
      await this.#writeObjectReference(destination, [contentKey]);
      if (profile.delivery.segmentType === 'fmp4') {
        const initPath = join(dirname(destination), 'init.mp4');
        protectedPaths.push(initPath);
        const initSha256 = await this.#fileSha256(initPath);
        const initKey = contentKey.replace(/\.m4s$/, '.init.mp4');
        await this.#objectOperation('put', () =>
          this.objectStore!.put(initKey, createReadStream(initPath), {
            contentType: 'video/mp4',
            expiresAt: new Date(Date.now() + this.options.cacheTtlMs).toISOString(),
            sha256: initSha256,
            metadata: {
              sessionId: session.id,
              profileId: profile.profileId,
              revision: String(profile.revision),
              initialization: 'true'
            }
          })
        );
        await this.#writeObjectReference(initPath, [initKey]);
      }
      this.events.publish(event('storage.uploaded', { contentKey, segment: index }, session.id));
    } finally {
      await this.cleanupExpired(protectedPaths);
    }
  }

  contentKey(session: RelaySession, profile: ProfileRevision, index: number): string {
    const source = session.source!;
    const identity = JSON.stringify({
      providerId: source.providerId,
      itemId: source.itemId,
      versionId: source.versionId,
      fingerprint: source.sourceFingerprint,
      audio: source.audioTrackId,
      subtitle: source.subtitleTrackId,
      profile: profile.profileId,
      revision: profile.revision,
      index,
      duration: profile.delivery.segmentDuration
    });
    const extension = profile.delivery.segmentType === 'fmp4' ? 'm4s' : 'ts';
    return `vod/${createHash('sha256').update(identity).digest('hex')}.${extension}`;
  }

  async restoreObject(contentKey: string, destination: string): Promise<boolean> {
    const objectStore = this.objectStore;
    if (!objectStore) return false;
    const startedAt = Date.now();
    const object = await this.#objectOperation('stat', () => objectStore.stat(contentKey));
    if (!object) {
      this.#recordCacheRequest('object_store', 'miss');
      this.#recordObjectRestore(startedAt, 'miss');
      return false;
    }
    const source = await this.#objectOperation('open', () => objectStore.open(contentKey));
    if (!source) {
      this.#recordCacheRequest('object_store', 'miss');
      this.#recordObjectRestore(startedAt, 'miss');
      return false;
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${randomUUID()}.part`;
    const hash = createHash('sha256');
    const hasher = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        hash.update(bytes);
        callback(null, bytes);
      }
    });
    try {
      await pipeline(source, hasher, createWriteStream(temporary));
      const info = await stat(temporary);
      if (info.size !== object.size)
        throw new CacheRestoreValidationError(`Cached object size mismatch for ${contentKey}`);
      const sha256 = hash.digest('hex');
      if (object.sha256 && sha256 !== object.sha256)
        throw new CacheRestoreValidationError(`Cached object hash mismatch for ${contentKey}`);
      await rename(temporary, destination);
      await this.#writeObjectReference(destination, [contentKey]);
      await this.cleanupExpired([destination]);
      this.#recordCacheRequest('object_store', 'hit');
      this.#recordObjectRestore(startedAt, 'success');
    } catch (error) {
      await rm(temporary, { force: true });
      if (error instanceof CacheRestoreValidationError) {
        await this.#objectOperation('delete', () => objectStore.delete(contentKey));
        this.#recordCacheRequest('object_store', 'miss');
        this.#recordObjectRestore(startedAt, 'invalidated');
        this.metrics?.increment('object_errors_total', {
          operation: 'restore',
          kind: 'validation'
        });
        this.events.publish(
          event('storage.invalidated', {
            contentKey,
            reason: error.message.includes('hash') ? 'hash_mismatch' : 'size_mismatch'
          })
        );
        return false;
      }
      this.#recordObjectRestore(startedAt, 'error');
      this.metrics?.increment('object_errors_total', { operation: 'restore', kind: 'error' });
      throw error;
    }
    return true;
  }

  async cleanupExpired(protectedPaths: readonly string[] = []): Promise<number> {
    const protectedSet = new Set(protectedPaths);
    const now = Date.now();
    const root = join(this.options.cacheDir, 'vod');
    let removed = 0;
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const visit = async (path: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await visit(child);
        else if (entry.name.endsWith(OBJECT_REFERENCE_SUFFIX)) {
          try {
            await stat(child.slice(0, -OBJECT_REFERENCE_SUFFIX.length));
          } catch {
            await rm(child, { force: true });
          }
        } else {
          const info = await stat(child);
          if (!protectedSet.has(child) && now - info.mtimeMs > this.options.cacheTtlMs) {
            await this.#removeLocalObject(child);
            removed += 1;
          } else files.push({ path: child, size: info.size, mtimeMs: info.mtimeMs });
        }
      }
    };
    await visit(root);
    const limit = this.options.cacheLimitBytes;
    if (limit) {
      let total = files.reduce((sum, file) => sum + file.size, 0);
      for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
        if (total <= limit) break;
        if (protectedSet.has(file.path)) continue;
        await this.#removeLocalObject(file.path);
        total -= file.size;
        removed += 1;
      }
      this.metrics?.gauge('cache_bytes', total, { layer: 'disk' });
    }
    if (removed) this.events.publish(event('cache.evicted', { count: removed }));
    return removed;
  }

  async inventory(): Promise<CachedObject[]> {
    const root = join(this.options.cacheDir, 'vod');
    const items: CachedObject[] = [];
    const visit = async (path: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await visit(child);
        else if (!entry.name.endsWith('.part') && !entry.name.endsWith(OBJECT_REFERENCE_SUFFIX)) {
          const info = await stat(child);
          const key = child
            .slice(root.length + 1)
            .split('\\')
            .join('/');
          items.push({
            key,
            size: info.size,
            contentType: entry.name.endsWith('.m4s')
              ? 'video/iso.segment'
              : entry.name.endsWith('.mp4')
                ? 'video/mp4'
                : 'video/mp2t',
            expiresAt: new Date(info.mtimeMs + this.options.cacheTtlMs).toISOString(),
            createdAt: info.birthtime.toISOString(),
            lastAccessedAt: info.mtime.toISOString()
          });
        }
      }
    };
    await visit(root);
    return items.sort((left, right) => right.lastAccessedAt.localeCompare(left.lastAccessedAt));
  }

  async evict(filter: CacheEvictionFilter): Promise<number> {
    if (!filter.all && !filter.sessionId && !filter.profileId)
      throw new Error('A cache eviction scope is required');
    const inventory = await this.inventory();
    let removed = 0;
    for (const object of inventory) {
      const [sessionId, profileDirectory] = object.key.split('/');
      if (!filter.all && filter.sessionId && sessionId !== filter.sessionId) continue;
      if (!filter.all && filter.profileId && !profileDirectory?.startsWith(`${filter.profileId}-r`))
        continue;
      const path = join(this.options.cacheDir, 'vod', object.key);
      const objectStoreKeys = await this.#readObjectReference(path);
      await this.#removeLocalObject(path);
      for (const key of objectStoreKeys)
        if (this.objectStore)
          await this.#objectOperation('delete', () => this.objectStore!.delete(key));
      removed += 1;
    }
    if (removed) this.events.publish(event('cache.evicted', { count: removed, ...filter }));
    return removed;
  }

  async usageBytes(): Promise<number> {
    return (await this.inventory()).reduce((total, object) => total + object.size, 0);
  }

  async #fileSha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      hash.update(bytes);
    }
    return hash.digest('hex');
  }

  async #writeObjectReference(path: string, keys: readonly string[]): Promise<void> {
    const reference = objectReferencePath(path);
    const temporary = `${reference}.${process.pid}.${randomUUID()}.part`;
    try {
      await writeFile(temporary, JSON.stringify({ keys: [...new Set(keys)] }), { mode: 0o600 });
      await rename(temporary, reference);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #readObjectReference(path: string): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(objectReferencePath(path), 'utf8')) as {
        keys?: unknown;
      };
      return Array.isArray(parsed.keys)
        ? parsed.keys.filter((key): key is string => typeof key === 'string')
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async #removeLocalObject(path: string): Promise<void> {
    await Promise.all([rm(path, { force: true }), rm(objectReferencePath(path), { force: true })]);
  }

  #recordCacheRequest(layer: 'disk' | 'object_store', outcome: 'hit' | 'miss'): void {
    this.metrics?.increment('cache_requests_total', { layer, outcome });
  }

  #recordObjectRestore(
    startedAt: number,
    outcome: 'success' | 'miss' | 'invalidated' | 'error'
  ): void {
    this.metrics?.increment('object_restores_total', { outcome });
    this.metrics?.observe('object_restore_seconds', secondsSince(startedAt), { outcome });
  }

  async #objectOperation<T>(
    operation: 'put' | 'stat' | 'open' | 'delete',
    run: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await run();
      this.metrics?.increment('object_operations_total', { operation, outcome: 'success' });
      this.metrics?.observe('object_operation_seconds', secondsSince(startedAt), {
        operation,
        outcome: 'success'
      });
      return result;
    } catch (error) {
      this.metrics?.increment('object_operations_total', { operation, outcome: 'error' });
      this.metrics?.observe('object_operation_seconds', secondsSince(startedAt), {
        operation,
        outcome: 'error'
      });
      this.metrics?.increment('object_errors_total', { operation, kind: 'error' });
      throw error;
    }
  }
}
