// SPDX-License-Identifier: GPL-3.0-or-later
import { Redis } from 'ioredis';
import type { BackendStatus } from '@vrrelay/domain';
import type { CoordinationStore } from '@vrrelay/application';

export class RedisCoordinationStore implements CoordinationStore {
  readonly kind = 'valkey';
  readonly #client: Redis;
  readonly #subscriber: Redis;
  readonly #listeners = new Map<string, Set<(payload: string) => void>>();

  constructor(url: string) {
    this.#client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.#subscriber = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    // Command promises still reject to their callers and health() reports the
    // outage. Listeners prevent ioredis from treating expected reconnect errors
    // as unhandled EventEmitter errors during a Valkey restart.
    this.#client.on('error', () => undefined);
    this.#subscriber.on('error', () => undefined);
    this.#subscriber.on('message', (channel: string, payload: string) => {
      for (const listener of this.#listeners.get(channel) ?? []) listener(payload);
    });
  }

  async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    return (await this.#client.set(`lease:${key}`, owner, 'PX', ttlMs, 'NX')) === 'OK';
  }
  async renew(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const result = await this.#client.eval(
      "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end",
      1,
      `lease:${key}`,
      owner,
      ttlMs
    );
    return result === 1;
  }
  async release(key: string, owner: string): Promise<void> {
    await this.#client.eval(
      "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      1,
      `lease:${key}`,
      owner
    );
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.#client.set(key, value, 'PX', ttlMs);
  }
  async get(key: string): Promise<string | undefined> {
    return (await this.#client.get(key)) ?? undefined;
  }
  async delete(key: string): Promise<void> {
    await this.#client.del(key);
  }
  async recordViewer(input: {
    sessionId: string;
    edgeNodeId: string;
    viewerHash: string;
    observedAtMs: number;
    windowMs: number;
  }): Promise<{ edgeViewers: number; totalViewers: number }> {
    const cutoff = input.observedAtMs - input.windowMs;
    const retentionMs = input.windowMs * 2;
    const edgeKey = `viewers:${input.sessionId}:edge:${input.edgeNodeId}`;
    const totalKey = `viewers:${input.sessionId}:total`;
    await Promise.all([
      this.#client.zadd(edgeKey, input.observedAtMs, input.viewerHash),
      this.#client.zadd(totalKey, input.observedAtMs, input.viewerHash)
    ]);
    await Promise.all([
      this.#client.zremrangebyscore(edgeKey, '-inf', cutoff),
      this.#client.zremrangebyscore(totalKey, '-inf', cutoff),
      this.#client.pexpire(edgeKey, retentionMs),
      this.#client.pexpire(totalKey, retentionMs)
    ]);
    const [edgeViewers, totalViewers] = await Promise.all([
      this.#client.zcard(edgeKey),
      this.#client.zcard(totalKey)
    ]);
    return { edgeViewers, totalViewers };
  }
  async countViewers(input: {
    sessionId: string;
    observedAtMs: number;
    windowMs: number;
  }): Promise<{ totalViewers: number }> {
    const totalKey = `viewers:${input.sessionId}:total`;
    await this.#client.zremrangebyscore(totalKey, '-inf', input.observedAtMs - input.windowMs);
    const totalViewers = await this.#client.zcard(totalKey);
    if (totalViewers === 0) await this.#client.del(totalKey);
    return { totalViewers };
  }
  async recordSegmentDemand(input: {
    sessionId: string;
    viewerHash: string;
    segmentIndex: number;
    observedAtMs: number;
    windowMs: number;
  }): Promise<void> {
    const timeKey = `segment-demands:${input.sessionId}:time`;
    const valueKey = `segment-demands:${input.sessionId}:value`;
    const retentionMs = input.windowMs * 2;
    await this.#client.eval(
      `local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[4])
       if #expired > 0 then
         for _, member in ipairs(expired) do
           redis.call('ZREM', KEYS[1], member)
           redis.call('HDEL', KEYS[2], member)
         end
       end
       redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
       redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
       redis.call('PEXPIRE', KEYS[1], ARGV[5])
       redis.call('PEXPIRE', KEYS[2], ARGV[5])
       return 1`,
      2,
      timeKey,
      valueKey,
      input.viewerHash,
      input.observedAtMs,
      input.segmentIndex,
      input.observedAtMs - input.windowMs,
      retentionMs
    );
  }
  async listSegmentDemands(input: {
    sessionId: string;
    observedAtMs: number;
    windowMs: number;
  }): Promise<Array<{ viewerHash: string; segmentIndex: number; observedAtMs: number }>> {
    const timeKey = `segment-demands:${input.sessionId}:time`;
    const valueKey = `segment-demands:${input.sessionId}:value`;
    const cutoff = input.observedAtMs - input.windowMs;
    const expired = await this.#client.zrangebyscore(timeKey, '-inf', cutoff);
    if (expired.length)
      await this.#client
        .multi()
        .zrem(timeKey, ...expired)
        .hdel(valueKey, ...expired)
        .exec();
    const rows = await this.#client.zrangebyscore(
      timeKey,
      cutoff,
      '+inf',
      'WITHSCORES',
      'LIMIT',
      0,
      10_000
    );
    const viewers: string[] = [];
    const observed = new Map<string, number>();
    for (let index = 0; index < rows.length; index += 2) {
      const viewerHash = rows[index]!;
      viewers.push(viewerHash);
      observed.set(viewerHash, Number(rows[index + 1]));
    }
    if (!viewers.length) return [];
    const values = await this.#client.hmget(valueKey, ...viewers);
    return viewers.flatMap((viewerHash, index) => {
      const segmentIndex = Number(values[index]);
      return Number.isInteger(segmentIndex) && segmentIndex >= 0
        ? [{ viewerHash, segmentIndex, observedAtMs: observed.get(viewerHash)! }]
        : [];
    });
  }
  async publish(channel: string, payload: string): Promise<void> {
    await this.#client.publish(channel, payload);
  }
  async subscribe(
    channel: string,
    listener: (payload: string) => void
  ): Promise<() => Promise<void>> {
    const listeners = this.#listeners.get(channel) ?? new Set();
    if (!listeners.size) await this.#subscriber.subscribe(channel);
    listeners.add(listener);
    this.#listeners.set(channel, listeners);
    return async () => {
      listeners.delete(listener);
      if (!listeners.size) await this.#subscriber.unsubscribe(channel);
    };
  }
  async health(): Promise<BackendStatus> {
    try {
      if (this.#client.status === 'wait') await this.#client.connect();
      await this.#client.ping();
      return {
        category: 'coordination',
        kind: 'valkey',
        healthy: true,
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        category: 'coordination',
        kind: 'valkey',
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString()
      };
    }
  }
  async close(): Promise<void> {
    await Promise.all([this.#client.quit(), this.#subscriber.quit()]);
  }
}
