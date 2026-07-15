// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
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
    if (!this.objectStore) return;
    const segmentSha256 = await this.#fileSha256(destination);
    await this.objectStore.put(contentKey, createReadStream(destination), {
      contentType: profile.delivery.segmentType === 'fmp4' ? 'video/iso.segment' : 'video/mp2t',
      expiresAt: new Date(Date.now() + this.options.cacheTtlMs).toISOString(),
      sha256: segmentSha256,
      metadata: {
        sessionId: session.id,
        profileId: profile.profileId,
        revision: String(profile.revision)
      }
    });
    if (profile.delivery.segmentType === 'fmp4') {
      const initPath = join(dirname(destination), 'init.mp4');
      const initSha256 = await this.#fileSha256(initPath);
      await this.objectStore.put(
        contentKey.replace(/\.m4s$/, '.init.mp4'),
        createReadStream(initPath),
        {
          contentType: 'video/mp4',
          expiresAt: new Date(Date.now() + this.options.cacheTtlMs).toISOString(),
          sha256: initSha256,
          metadata: {
            sessionId: session.id,
            profileId: profile.profileId,
            revision: String(profile.revision),
            initialization: 'true'
          }
        }
      );
    }
    this.events.publish(event('storage.uploaded', { contentKey, segment: index }, session.id));
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
    const object = await objectStore.stat(contentKey);
    if (!object) return false;
    const source = await objectStore.open(contentKey);
    if (!source) return false;
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
    } catch (error) {
      await rm(temporary, { force: true });
      if (error instanceof CacheRestoreValidationError) {
        await objectStore.delete(contentKey);
        this.events.publish(
          event('storage.invalidated', {
            contentKey,
            reason: error.message.includes('hash') ? 'hash_mismatch' : 'size_mismatch'
          })
        );
        return false;
      }
      throw error;
    }
    return true;
  }

  async cleanupExpired(): Promise<number> {
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
        else {
          const info = await stat(child);
          if (now - info.mtimeMs > this.options.cacheTtlMs) {
            await rm(child, { force: true });
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
        await rm(file.path, { force: true });
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
        else if (!entry.name.endsWith('.part')) {
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
      await rm(join(this.options.cacheDir, 'vod', object.key), { force: true });
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
}
