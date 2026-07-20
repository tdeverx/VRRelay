// SPDX-License-Identifier: GPL-3.0-or-later
import type { BackendStatus, ClusterNode } from '@vrrelay/domain';
import type { EdgeSelectionContext, TrafficDirector } from '@vrrelay/application';

interface WebhookTrafficDirectorOptions {
  endpoint: string;
  token?: string;
  timeoutMs?: number;
}

interface WebhookResponse {
  healthy?: boolean;
  message?: string;
  nodeId?: string;
}

export class WebhookTrafficDirector implements TrafficDirector {
  readonly kind = 'webhook';
  readonly #timeoutMs: number;

  constructor(private readonly options: WebhookTrafficDirectorOptions) {
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async selectEdge(
    contextInput: EdgeSelectionContext | string,
    nodes: readonly ClusterNode[],
    legacyPreferredRegion?: string
  ): Promise<ClusterNode | undefined> {
    const context: EdgeSelectionContext =
      typeof contextInput === 'string'
        ? {
            sessionId: contextInput,
            affinityKey: contextInput,
            ...(legacyPreferredRegion ? { preferredRegion: legacyPreferredRegion } : {})
          }
        : contextInput;
    const eligible = nodes.filter((node) => node.roles.includes('edge') && node.state === 'online');
    if (!eligible.length) return undefined;
    const response = await this.#request({
      type: 'select-edge',
      sessionId: context.sessionId,
      affinityKey: context.affinityKey,
      ...(context.viewerRegion ? { viewerRegion: context.viewerRegion } : {}),
      ...(context.preferredRegion ? { preferredRegion: context.preferredRegion } : {}),
      candidates: eligible.map((node) => ({
        id: node.id,
        region: node.region,
        publicUrl: node.publicUrl,
        weight: node.weight,
        capacity: {
          activeWorkers: node.capabilities.activeWorkers,
          maxWorkers: node.capabilities.maxWorkers,
          cacheBytes: node.capabilities.cacheBytes,
          cacheLimitBytes: node.capabilities.cacheLimitBytes,
          egressMbps: node.capabilities.egressMbps
        }
      }))
    });
    const selected = eligible.find((node) => node.id === response.nodeId);
    if (!selected) throw new Error('Routing webhook returned an ineligible or unknown edge');
    return selected;
  }

  async health(): Promise<BackendStatus> {
    try {
      const response = await this.#request({ type: 'health' });
      return {
        category: 'routing',
        kind: 'webhook',
        healthy: response.healthy === true,
        message:
          response.message ??
          (response.healthy === true
            ? 'Routing webhook reachable'
            : 'Routing webhook health response did not confirm readiness'),
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        category: 'routing',
        kind: 'webhook',
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString()
      };
    }
  }

  async #request(body: object): Promise<WebhookResponse> {
    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`Routing webhook returned HTTP ${response.status}`);
    const payload = (await response.json()) as WebhookResponse;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('Routing webhook returned invalid JSON');
    return payload;
  }
}
