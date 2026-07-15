// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentLogEntry,
  ClusterNode,
  EdgeRoute,
  NodeCapability,
  NodeRole,
  PlacementPolicy,
  ProfileRevision,
  ProviderBinding
} from '@vrrelay/domain';
import type {
  CertificateAuthority,
  ClusterRepository,
  CoordinationStore,
  EventBus,
  TrafficDirector
} from './index.js';
import { ConflictError, NotFoundError } from './errors.js';
import { opaqueToken } from './services.js';

const JOIN_PREFIX = 'cluster:join:';

interface JoinClaim {
  name: string;
  roles: NodeRole[];
  region: string;
  expiresAt: string;
}

export interface EnrollNodeInput {
  token: string;
  name: string;
  publicUrl: string;
  internalUrl?: string;
  capabilities: NodeCapability;
}

export class BuiltinTrafficDirector implements TrafficDirector {
  readonly kind = 'builtin';

  async selectEdge(
    sessionId: string,
    nodes: readonly ClusterNode[],
    preferredRegion?: string
  ): Promise<ClusterNode | undefined> {
    const eligible = nodes.filter((node) => node.roles.includes('edge') && node.state === 'online');
    if (!eligible.length) return undefined;
    const regional = preferredRegion
      ? eligible.filter((node) => node.region === preferredRegion)
      : [];
    const pool = regional.length ? regional : eligible;
    return [...pool].sort(
      (left, right) => this.#score(sessionId, right) - this.#score(sessionId, left)
    )[0];
  }

  #score(sessionId: string, node: ClusterNode): number {
    const digest = createHash('sha256').update(`${sessionId}:${node.id}`).digest();
    const hash = digest.readUInt32BE(0) / 0xffffffff;
    const workerPressure = node.capabilities.maxWorkers
      ? node.capabilities.activeWorkers / node.capabilities.maxWorkers
      : 0;
    const bandwidthHeadroom = 1 / (1 + node.capabilities.egressMbps / 100);
    const cachePressure = node.capabilities.cacheLimitBytes
      ? Math.min(1, node.capabilities.cacheBytes / node.capabilities.cacheLimitBytes)
      : 0;
    const cacheHeadroom = Math.max(0.25, 1 - cachePressure);
    return (
      hash * node.weight * Math.max(0.05, 1 - workerPressure) * bandwidthHeadroom * cacheHeadroom
    );
  }

  async health() {
    return {
      category: 'routing' as const,
      kind: 'builtin' as const,
      healthy: true,
      message: 'Capacity-aware stable edge hashing',
      checkedAt: new Date().toISOString()
    };
  }
}

export class SwitchableTrafficDirector implements TrafficDirector {
  constructor(private delegate: TrafficDirector) {}

  get kind(): string {
    return this.delegate.kind;
  }

  activate(next: TrafficDirector): void {
    this.delegate = next;
  }

  selectEdge(
    sessionId: string,
    nodes: readonly ClusterNode[],
    preferredRegion?: string
  ): Promise<ClusterNode | undefined> {
    return this.delegate.selectEdge(sessionId, nodes, preferredRegion);
  }

  health() {
    return this.delegate.health();
  }
}

export class ClusterService {
  constructor(
    private readonly repository: ClusterRepository,
    private readonly coordination: CoordinationStore,
    private readonly director: TrafficDirector,
    private readonly events: EventBus,
    private readonly certificates?: CertificateAuthority
  ) {}

  async createJoinToken(input: {
    name: string;
    roles: NodeRole[];
    region: string;
    expiresInSeconds: number;
  }) {
    const token = `vrr_join_${opaqueToken(36)}`;
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1_000).toISOString();
    const claim: JoinClaim = {
      name: input.name,
      roles: input.roles,
      region: input.region,
      expiresAt
    };
    await this.coordination.set(
      `${JOIN_PREFIX}${this.#hash(token)}`,
      JSON.stringify(claim),
      input.expiresInSeconds * 1_000
    );
    return { token, expiresAt };
  }

  async enroll(input: EnrollNodeInput) {
    const key = `${JOIN_PREFIX}${this.#hash(input.token)}`;
    const consumeLease = `${key}:consume`;
    const consumeOwner = randomUUID();
    if (!(await this.coordination.acquire(consumeLease, consumeOwner, 30_000)))
      throw new ConflictError('Join token is invalid, expired, or already used');
    let serialized: string | undefined;
    try {
      serialized = await this.coordination.get(key);
      if (!serialized) throw new ConflictError('Join token is invalid, expired, or already used');
      await this.coordination.delete(key);
    } finally {
      await this.coordination.release(consumeLease, consumeOwner);
    }
    const claim = JSON.parse(serialized) as JoinClaim;
    if (Date.parse(claim.expiresAt) <= Date.now())
      throw new ConflictError('Join token has expired');
    const id = randomUUID();
    const now = new Date().toISOString();
    const certificate = await this.#issueCertificate(id);
    const node: ClusterNode = {
      id,
      name: input.name || claim.name,
      roles: claim.roles,
      region: claim.region,
      publicUrl: input.publicUrl,
      ...(input.internalUrl ? { internalUrl: input.internalUrl } : {}),
      state: 'online',
      capabilities: input.capabilities,
      weight: 100,
      ...(certificate ? { certificateExpiresAt: certificate.expiresAt } : {}),
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now
    };
    await this.repository.putNode(node);
    this.events.publish({
      version: 1,
      id: randomUUID(),
      type: 'node.joined',
      timestamp: now,
      payload: { nodeId: id, name: node.name, roles: node.roles }
    });
    return { node, certificate };
  }

  async rotateCertificate(id: string) {
    const node = await this.repository.getNode(id);
    if (!node || node.state === 'revoked')
      throw new NotFoundError('Active cluster node was not found');
    const rotatedAt = new Date().toISOString();
    for (const previous of await this.repository.listNodeCertificates(id)) {
      if (!previous.revokedAt)
        await this.repository.putNodeCertificate({ ...previous, revokedAt: rotatedAt });
    }
    const certificate = await this.#issueCertificate(id);
    if (!certificate) throw new ConflictError('Cluster certificate authority is not configured');
    await this.repository.putNode({
      ...node,
      certificateExpiresAt: certificate.expiresAt,
      updatedAt: new Date().toISOString()
    });
    return certificate;
  }

  async certificateAuthority(): Promise<string | undefined> {
    return this.certificates?.caCertificate();
  }

  async revoke(id: string): Promise<ClusterNode> {
    const node = await this.repository.getNode(id);
    if (!node) throw new NotFoundError('Cluster node was not found');
    const now = new Date().toISOString();
    for (const certificate of await this.repository.listNodeCertificates(id)) {
      if (!certificate.revokedAt)
        await this.repository.putNodeCertificate({ ...certificate, revokedAt: now });
    }
    const revoked: ClusterNode = { ...node, state: 'revoked', updatedAt: now };
    await this.repository.putNode(revoked);
    await this.coordination.publish(
      'cluster:revocations',
      JSON.stringify({ nodeId: id, revokedAt: now })
    );
    this.events.publish({
      version: 1,
      id: randomUUID(),
      type: 'node.offline',
      timestamp: now,
      payload: { nodeId: id, revoked: true }
    });
    return revoked;
  }

  async certificateIsActive(
    nodeId: string,
    serialNumber: string,
    fingerprintSha256?: string
  ): Promise<boolean> {
    const node = await this.repository.getNode(nodeId);
    if (!node || node.state === 'revoked') return false;
    const normalize = (value: string) =>
      value.replaceAll(':', '').toLowerCase().replace(/^0+/, '') || '0';
    const expected = normalize(serialNumber);
    const certificate = (await this.repository.listNodeCertificates(nodeId)).find((item) =>
      fingerprintSha256
        ? item.fingerprintSha256 === fingerprintSha256.toLowerCase()
        : normalize(item.serialNumber) === expected
    );
    return Boolean(
      certificate && !certificate.revokedAt && Date.parse(certificate.expiresAt) > Date.now()
    );
  }

  async putBinding(binding: ProviderBinding): Promise<void> {
    await this.repository.putProviderBinding(binding);
  }
  async bindings(providerId?: string): Promise<ProviderBinding[]> {
    return this.repository.listProviderBindings(providerId);
  }
  async removeBinding(id: string): Promise<void> {
    await this.repository.deleteProviderBinding(id);
  }
  async logs(nodeId: string, limit = 200): Promise<AgentLogEntry[]> {
    return this.repository.listAgentLogs(nodeId, limit);
  }
  async recordLog(entry: AgentLogEntry): Promise<void> {
    await this.repository.putAgentLog(entry);
  }

  async registerLocal(
    input: Omit<ClusterNode, 'createdAt' | 'updatedAt' | 'lastHeartbeatAt'>
  ): Promise<ClusterNode> {
    const existing = await this.repository.getNode(input.id);
    const now = new Date().toISOString();
    const node: ClusterNode = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      lastHeartbeatAt: now,
      updatedAt: now
    };
    await this.repository.putNode(node);
    return node;
  }

  async heartbeat(
    id: string,
    capabilities: NodeCapability,
    state: 'online' | 'degraded' | 'draining'
  ): Promise<ClusterNode> {
    const node = await this.repository.getNode(id);
    if (!node) throw new NotFoundError('Cluster node was not found');
    const now = new Date().toISOString();
    const updated = { ...node, state, capabilities, lastHeartbeatAt: now, updatedAt: now };
    await this.repository.putNode(updated);
    return updated;
  }

  async drain(id: string, draining: boolean): Promise<ClusterNode> {
    const node = await this.repository.getNode(id);
    if (!node) throw new NotFoundError('Cluster node was not found');
    const updated: ClusterNode = {
      ...node,
      state: draining ? 'draining' : 'online',
      updatedAt: new Date().toISOString()
    };
    await this.repository.putNode(updated);
    this.events.publish({
      version: 1,
      id: randomUUID(),
      type: 'node.draining',
      timestamp: updated.updatedAt,
      payload: { nodeId: id, draining }
    });
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.repository.deleteNode(id);
  }

  async list(): Promise<ClusterNode[]> {
    const nodes = await this.repository.listNodes();
    const degradedBefore = Date.now() - 45_000;
    const staleBefore = Date.now() - 90_000;
    return Promise.all(
      nodes.map(async (node) => {
        if (
          node.state !== 'revoked' &&
          Date.parse(node.lastHeartbeatAt) < staleBefore &&
          node.state !== 'offline'
        ) {
          const offline: ClusterNode = {
            ...node,
            state: 'offline',
            updatedAt: new Date().toISOString()
          };
          await this.repository.putNode(offline);
          return offline;
        }
        if (node.state === 'online' && Date.parse(node.lastHeartbeatAt) < degradedBefore) {
          const degraded: ClusterNode = {
            ...node,
            state: 'degraded',
            updatedAt: new Date().toISOString()
          };
          await this.repository.putNode(degraded);
          return degraded;
        }
        return node;
      })
    );
  }

  async selectEdge(sessionId: string, preferredRegion?: string): Promise<EdgeRoute | undefined> {
    const node = await this.director.selectEdge(sessionId, await this.list(), preferredRegion);
    if (!node) return undefined;
    const route: EdgeRoute = {
      sessionId,
      nodeId: node.id,
      publicUrl: node.publicUrl,
      reason:
        preferredRegion && node.region === preferredRegion
          ? 'preferred-region'
          : 'healthy-capacity',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
    };
    this.events.publish({
      version: 1,
      id: randomUUID(),
      type: 'route.selected',
      timestamp: new Date().toISOString(),
      sessionId,
      payload: route
    });
    return route;
  }

  async previewPlacement(input: {
    policy: PlacementPolicy;
    providerId?: string;
    profile: ProfileRevision;
    preferredNodeId?: string;
    preferredRegion?: string;
  }): Promise<{ node?: ClusterNode; reason: string }> {
    const nodes = (await this.list()).filter(
      (node) => node.state === 'online' && node.roles.includes('source-worker')
    );
    const compatible = nodes.filter(
      (node) =>
        node.capabilities.encoders.includes(input.profile.video.encoder) &&
        (!input.providerId || node.capabilities.providerIds.includes(input.providerId))
    );
    if (input.preferredNodeId) {
      const requested = compatible.find((node) => node.id === input.preferredNodeId);
      if (!requested) return { reason: 'preferred-node-unavailable' };
      return { node: requested, reason: 'preferred-node' };
    }
    const regional = input.preferredRegion
      ? compatible.filter((node) => node.region === input.preferredRegion)
      : [];
    const pool = regional.length ? regional : compatible;
    const node = pool.sort(
      (a, b) =>
        a.capabilities.activeWorkers / Math.max(1, a.capabilities.maxWorkers) -
        b.capabilities.activeWorkers / Math.max(1, b.capabilities.maxWorkers)
    )[0];
    return node
      ? { node, reason: regional.length ? 'preferred-region' : `${input.policy}-capacity` }
      : { reason: 'no-compatible-source-worker' };
  }

  #hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  async #issueCertificate(nodeId: string) {
    if (!this.certificates) return undefined;
    const certificate = await this.certificates.issue(`node:${nodeId}`, 7 * 24 * 60 * 60_000);
    await this.repository.putNodeCertificate({
      nodeId,
      serialNumber: certificate.serialNumber,
      fingerprintSha256: certificate.fingerprintSha256,
      expiresAt: certificate.expiresAt,
      revokedAt: null,
      createdAt: new Date().toISOString()
    });
    return certificate;
  }
}
