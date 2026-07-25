// SPDX-License-Identifier: GPL-3.0-or-later
import { fetchWithTimeout } from './fetch-timeout.js';
import { liveOriginSourceUrl } from './live-origin.js';

interface ManagedPath {
  operation: Promise<void>;
  ready: boolean;
  lastUsedAt: number;
}

export interface LiveEdgePathManagerOptions {
  originUrl?: string;
  apiUrl: string;
  readToken: string;
  srtPassphrase?: string;
  staleAfterMs?: number;
  cleanupIntervalMs?: number;
}

/**
 * Owns MediaMTX's dynamic edge paths. Concurrent viewers share setup, failed
 * pulls are reconfigured once, and paths that have not served a request for a
 * bounded interval are removed from both MediaMTX and application memory.
 */
export class LiveEdgePathManager {
  readonly #paths = new Map<string, ManagedPath>();
  readonly #cleanup: NodeJS.Timeout | undefined;

  constructor(private readonly options: LiveEdgePathManagerOptions) {
    if (!options.originUrl) {
      this.#cleanup = undefined;
      return;
    }
    this.#cleanup = setInterval(
      () => void this.pruneStale().catch(() => undefined),
      options.cleanupIntervalMs ?? 5 * 60_000
    );
    this.#cleanup.unref();
  }

  async fetchHls(path: string, url: string): Promise<Response> {
    await this.ensure(path);
    let response = await fetchWithTimeout(url, { headers: this.#readHeaders() }, 10_000);
    if (response.ok && response.body) return response;
    await response.body?.cancel();
    if (!this.options.originUrl)
      return fetchWithTimeout(url, { headers: this.#readHeaders() }, 10_000);
    await this.#delete(path);
    await this.ensure(path);
    response = await fetchWithTimeout(url, { headers: this.#readHeaders() }, 10_000);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      await this.#delete(path);
    }
    return response;
  }

  async ensure(path: string): Promise<void> {
    const originUrl = this.options.originUrl;
    if (!originUrl) return;
    const existing = this.#paths.get(path);
    if (existing) {
      existing.lastUsedAt = Date.now();
      await existing.operation;
      if (existing.ready && this.#paths.get(path) === existing) return;
      return this.ensure(path);
    }
    const entry: ManagedPath = {
      operation: Promise.resolve(),
      ready: false,
      lastUsedAt: Date.now()
    };
    entry.operation = this.#configure(path, originUrl).then(() => {
      entry.ready = true;
    });
    this.#paths.set(path, entry);
    try {
      await entry.operation;
    } catch (error) {
      if (this.#paths.get(path) === entry) this.#paths.delete(path);
      throw error;
    }
  }

  close(): void {
    if (this.#cleanup) clearInterval(this.#cleanup);
  }

  async pruneStale(): Promise<void> {
    const staleBefore = Date.now() - (this.options.staleAfterMs ?? 30 * 60_000);
    for (const [path, entry] of this.#paths) {
      if (!entry.ready || entry.lastUsedAt > staleBefore) continue;
      await this.#delete(path);
    }
  }

  async #delete(path: string): Promise<void> {
    const existing = this.#paths.get(path);
    if (existing && !existing.ready) return existing.operation;
    const entry: ManagedPath = existing ?? {
      operation: Promise.resolve(),
      ready: false,
      lastUsedAt: Date.now()
    };
    const wasReady = entry.ready;
    entry.ready = false;
    if (!existing) this.#paths.set(path, entry);
    entry.operation = entry.operation.then(async () => {
      const endpoint = `${this.options.apiUrl.replace(/\/$/, '')}/v3/config/paths/delete`;
      const response = await fetchWithTimeout(
        `${endpoint}/${encodeURIComponent(path)}`,
        { method: 'DELETE' },
        5_000
      );
      if (!response.ok && response.status !== 404 && response.status !== 400)
        throw new Error(`MediaMTX path delete failed (${response.status})`);
    });
    try {
      await entry.operation;
      if (this.#paths.get(path) === entry) this.#paths.delete(path);
    } catch (error) {
      if (this.#paths.get(path) === entry) {
        if (wasReady) {
          entry.ready = true;
          entry.operation = Promise.resolve();
        } else {
          this.#paths.delete(path);
        }
      }
      throw error;
    }
  }

  async #configure(path: string, originUrl: string): Promise<void> {
    const endpoint = `${this.options.apiUrl.replace(/\/$/, '')}/v3/config/paths`;
    const body = JSON.stringify({
      source: liveOriginSourceUrl(
        originUrl,
        path,
        this.options.readToken,
        this.options.srtPassphrase
      ),
      sourceOnDemand: true,
      sourceOnDemandCloseAfter: '30s'
    });
    const add = await fetchWithTimeout(
      `${endpoint}/add/${encodeURIComponent(path)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      },
      5_000
    );
    if (add.ok) return;
    if (add.status !== 400) throw new Error(`MediaMTX path add failed (${add.status})`);
    const replace = await fetchWithTimeout(
      `${endpoint}/replace/${encodeURIComponent(path)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      },
      5_000
    );
    if (!replace.ok) throw new Error(`MediaMTX path replace failed (${replace.status})`);
  }

  #readHeaders(): { Authorization: string } {
    return {
      Authorization: `Basic ${Buffer.from(`vrrelay-read:${this.options.readToken}`).toString('base64')}`
    };
  }
}
