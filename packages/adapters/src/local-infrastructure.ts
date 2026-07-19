// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open as openFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BackendStatus, CachedObject } from '@vrrelay/domain';
import type { CoordinationStore, ObjectStore, ObjectStorePutOptions } from '@vrrelay/application';
import { withFileMutation } from './file-secret-storage.js';

function status(
  category: BackendStatus['category'],
  kind: BackendStatus['kind'],
  healthy: boolean,
  message?: string
): BackendStatus {
  return {
    category,
    kind,
    healthy,
    ...(message ? { message } : {}),
    checkedAt: new Date().toISOString()
  };
}

export class LocalObjectStore implements ObjectStore {
  readonly kind = 'local';

  constructor(private readonly root: string) {}

  async put(key: string, source: Readable, options: ObjectStorePutOptions): Promise<CachedObject> {
    const paths = this.#paths(key);
    return withFileMutation(paths.metadata, async () => {
      await mkdir(paths.directory, { recursive: true });
      const temporary = `${paths.content}.${process.pid}.${randomUUID()}.part`;
      const hash = createHash('sha256');
      const hasher = new Transform({
        transform(chunk, _encoding, callback) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          hash.update(bytes);
          callback(null, bytes);
        }
      });
      try {
        await pipeline(source, hasher, createWriteStream(temporary, { mode: 0o600 }));
        const sha256 = hash.digest('hex');
        if (options.sha256 && options.sha256 !== sha256)
          throw new Error(`Object content hash mismatch for ${key}`);
        await rename(temporary, paths.content);
        const info = await stat(paths.content);
        const now = new Date().toISOString();
        const object: CachedObject = {
          key,
          size: info.size,
          contentType: options.contentType,
          etag: sha256,
          sha256,
          expiresAt: options.expiresAt ?? null,
          createdAt: now,
          lastAccessedAt: now
        };
        await this.#writeMetadata(paths.metadata, object);
        return object;
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
  }

  async stat(key: string): Promise<CachedObject | undefined> {
    const paths = this.#paths(key);
    return withFileMutation(paths.metadata, () => this.#readMetadata(paths));
  }

  async open(key: string) {
    const paths = this.#paths(key);
    return withFileMutation(paths.metadata, async () => {
      const object = await this.#readMetadata(paths);
      if (!object) return undefined;
      const file = await openFile(paths.content, 'r');
      try {
        const touched = { ...object, lastAccessedAt: new Date().toISOString() };
        await this.#writeMetadata(paths.metadata, touched);
        return file.createReadStream();
      } catch (error) {
        await file.close();
        throw error;
      }
    });
  }

  async delete(key: string): Promise<void> {
    const paths = this.#paths(key);
    await withFileMutation(paths.metadata, () => this.#deleteObject(paths));
  }

  async #readMetadata(paths: { content: string; metadata: string }) {
    try {
      const object = JSON.parse(await readFile(paths.metadata, 'utf8')) as CachedObject;
      if (object.expiresAt && Date.parse(object.expiresAt) <= Date.now()) {
        await this.#deleteObject(paths);
        return undefined;
      }
      return object;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async #deleteObject(paths: { content: string; metadata: string }): Promise<void> {
    await Promise.all([rm(paths.content, { force: true }), rm(paths.metadata, { force: true })]);
  }

  async health(): Promise<BackendStatus> {
    try {
      await mkdir(this.root, { recursive: true });
      return status('object-store', 'local', true);
    } catch (error) {
      return status(
        'object-store',
        'local',
        false,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  #paths(key: string) {
    const digest = createHash('sha256').update(key).digest('hex');
    const directory = join(this.root, digest.slice(0, 2), digest.slice(2, 4));
    return {
      directory,
      content: join(directory, digest),
      metadata: join(directory, `${digest}.json`)
    };
  }

  async #writeMetadata(path: string, object: CachedObject): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.part`;
    try {
      await writeFile(temporary, JSON.stringify(object), { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

interface StoredValue {
  value: string;
  expiresAt: number;
}
interface Lease {
  owner: string;
  expiresAt: number;
}
type ViewerSet = Map<string, number>;
interface SegmentDemand {
  segmentIndex: number;
  observedAtMs: number;
}

export class MemoryCoordinationStore implements CoordinationStore {
  readonly kind = 'local';
  readonly #leases = new Map<string, Lease>();
  readonly #values = new Map<string, StoredValue>();
  readonly #listeners = new Map<string, Set<(payload: string) => void>>();
  readonly #viewers = new Map<string, ViewerSet>();
  readonly #segmentDemands = new Map<string, Map<string, SegmentDemand>>();

  async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const existing = this.#leases.get(key);
    if (existing && existing.expiresAt > Date.now() && existing.owner !== owner) return false;
    this.#leases.set(key, { owner, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async renew(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const existing = this.#leases.get(key);
    if (!existing || existing.owner !== owner || existing.expiresAt <= Date.now()) return false;
    existing.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async release(key: string, owner: string): Promise<void> {
    if (this.#leases.get(key)?.owner === owner) this.#leases.delete(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.#values.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async get(key: string): Promise<string | undefined> {
    const stored = this.#values.get(key);
    if (!stored) return undefined;
    if (stored.expiresAt <= Date.now()) {
      this.#values.delete(key);
      return undefined;
    }
    return stored.value;
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }

  async recordViewer(input: {
    sessionId: string;
    edgeNodeId: string;
    viewerHash: string;
    observedAtMs: number;
    windowMs: number;
  }): Promise<{ edgeViewers: number; totalViewers: number }> {
    const cutoff = input.observedAtMs - input.windowMs;
    const edgeKey = `viewers:${input.sessionId}:edge:${input.edgeNodeId}`;
    const totalKey = `viewers:${input.sessionId}:total`;
    const edge = this.#viewerSet(edgeKey);
    const total = this.#viewerSet(totalKey);
    edge.set(input.viewerHash, input.observedAtMs);
    total.set(input.viewerHash, input.observedAtMs);
    this.#pruneViewers(edgeKey, edge, cutoff);
    this.#pruneViewers(totalKey, total, cutoff);
    return { edgeViewers: edge.size, totalViewers: total.size };
  }

  async countViewers(input: {
    sessionId: string;
    observedAtMs: number;
    windowMs: number;
  }): Promise<{ totalViewers: number }> {
    const totalKey = `viewers:${input.sessionId}:total`;
    const total = this.#viewers.get(totalKey);
    if (!total) return { totalViewers: 0 };
    this.#pruneViewers(totalKey, total, input.observedAtMs - input.windowMs);
    return { totalViewers: total.size };
  }

  async recordSegmentDemand(input: {
    sessionId: string;
    viewerHash: string;
    segmentIndex: number;
    observedAtMs: number;
    windowMs: number;
  }): Promise<void> {
    const demands = this.#segmentDemands.get(input.sessionId) ?? new Map<string, SegmentDemand>();
    demands.set(input.viewerHash, {
      segmentIndex: input.segmentIndex,
      observedAtMs: input.observedAtMs
    });
    const cutoff = input.observedAtMs - input.windowMs;
    for (const [viewerHash, demand] of demands)
      if (demand.observedAtMs < cutoff) demands.delete(viewerHash);
    if (demands.size) this.#segmentDemands.set(input.sessionId, demands);
    else this.#segmentDemands.delete(input.sessionId);
  }

  async listSegmentDemands(input: {
    sessionId: string;
    observedAtMs: number;
    windowMs: number;
  }): Promise<Array<{ viewerHash: string; segmentIndex: number; observedAtMs: number }>> {
    const demands = this.#segmentDemands.get(input.sessionId);
    if (!demands) return [];
    const cutoff = input.observedAtMs - input.windowMs;
    const recent = [];
    for (const [viewerHash, demand] of demands) {
      if (demand.observedAtMs < cutoff) demands.delete(viewerHash);
      else recent.push({ viewerHash, ...demand });
    }
    if (!demands.size) this.#segmentDemands.delete(input.sessionId);
    return recent;
  }

  async publish(channel: string, payload: string): Promise<void> {
    for (const listener of this.#listeners.get(channel) ?? []) listener(payload);
  }

  async subscribe(
    channel: string,
    listener: (payload: string) => void
  ): Promise<() => Promise<void>> {
    const listeners = this.#listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(channel, listeners);
    return async () => {
      listeners.delete(listener);
    };
  }

  async health(): Promise<BackendStatus> {
    return status('coordination', 'local', true);
  }

  #viewerSet(key: string): ViewerSet {
    const existing = this.#viewers.get(key);
    if (existing) return existing;
    const created = new Map<string, number>();
    this.#viewers.set(key, created);
    return created;
  }

  #pruneViewers(key: string, viewers: ViewerSet, cutoff: number): void {
    for (const [viewer, observedAt] of viewers) {
      if (observedAt <= cutoff) viewers.delete(viewer);
    }
    if (!viewers.size) this.#viewers.delete(key);
  }
}
