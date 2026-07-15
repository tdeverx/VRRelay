// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentLogEntry,
  ClusterNode,
  EdgeRoute,
  NodeCapability,
  NodeCertificateState,
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
  MetricsSink,
  SignedCertificate,
  TrafficDirector
} from './index.js';
import { ConflictError, NotFoundError } from './errors.js';
import { opaqueToken } from './services.js';

const JOIN_PREFIX = 'cluster:join:';
const JOIN_CONSUME_LEASE_MS = 60_000;
const JOIN_ENROLLMENT_RETRY_MS = 5 * 60_000;
const MAX_ATOMIC_WRITE_ATTEMPTS = 5;
const DEFAULT_AGENT_LOG_RETENTION_ROWS = 1000;
const DEFAULT_AGENT_LOG_QUERY_LIMIT = 200;

interface JoinEnrollmentClaim {
  csrSha256: string;
  node: ClusterNode;
  certificate: SignedCertificate;
  status: 'pending' | 'completed';
}

interface JoinClaim {
  name: string;
  roles: NodeRole[];
  region: string;
  expiresAt: string;
  enrollment?: JoinEnrollmentClaim;
}

export interface EnrollNodeInput {
  token: string;
  name: string;
  publicUrl: string;
  internalUrl?: string;
  capabilities: NodeCapability;
  csrPem: string;
}

export interface ClusterServiceOptions {
  agentLogRetentionRows?: number;
  agentLogQueryLimit?: number;
  metrics?: MetricsSink;
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

export interface StaticTrafficDirectorOptions {
  nodeId?: string;
  region?: string;
}

export class StaticTrafficDirector implements TrafficDirector {
  readonly kind = 'static';

  constructor(private readonly options: StaticTrafficDirectorOptions = {}) {}

  async selectEdge(
    _sessionId: string,
    nodes: readonly ClusterNode[],
    preferredRegion?: string
  ): Promise<ClusterNode | undefined> {
    const eligible = nodes.filter((node) => node.roles.includes('edge') && node.state === 'online');
    if (!eligible.length) return undefined;

    if (this.options.nodeId) {
      const selected = eligible.find((node) => node.id === this.options.nodeId);
      if (!selected) return undefined;
      if (this.options.region && selected.region !== this.options.region) return undefined;
      if (preferredRegion && selected.region !== preferredRegion) return undefined;
      return selected;
    }

    const configuredRegion = this.options.region
      ? eligible.filter((node) => node.region === this.options.region)
      : [];
    const requestedRegion = preferredRegion
      ? eligible.filter((node) => node.region === preferredRegion)
      : [];
    const pool = configuredRegion.length
      ? configuredRegion
      : requestedRegion.length
        ? requestedRegion
        : eligible;
    return [...pool].sort(
      (left, right) => right.weight - left.weight || left.id.localeCompare(right.id)
    )[0];
  }

  async health() {
    const target =
      this.options.nodeId && this.options.region
        ? `node ${this.options.nodeId} in ${this.options.region}`
        : this.options.nodeId
          ? `node ${this.options.nodeId}`
          : this.options.region
            ? `region ${this.options.region}`
            : 'the first eligible edge';
    return {
      category: 'routing' as const,
      kind: 'static' as const,
      healthy: true,
      message: `Static routing targets ${target}`,
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
    private readonly certificates?: CertificateAuthority,
    private readonly options: ClusterServiceOptions = {}
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
    if (!this.certificates)
      throw new ConflictError('Cluster certificate authority is not configured');
    const key = `${JOIN_PREFIX}${this.#hash(input.token)}`;
    const consumeLease = `${key}:consume`;
    const consumeOwner = randomUUID();
    if (!(await this.coordination.acquire(consumeLease, consumeOwner, JOIN_CONSUME_LEASE_MS)))
      throw new ConflictError('Join token is invalid, expired, or already used');
    try {
      const serialized = await this.coordination.get(key);
      if (!serialized) throw new ConflictError('Join token is invalid, expired, or already used');
      const claim = JSON.parse(serialized) as JoinClaim;
      const csrSha256 = this.#hash(input.csrPem);
      let enrollment = claim.enrollment;

      if (enrollment) {
        if (enrollment.csrSha256 !== csrSha256)
          throw new ConflictError('Join token is invalid, expired, or already used');
      } else {
        if (Date.parse(claim.expiresAt) <= Date.now())
          throw new ConflictError('Join token has expired');
        const id = randomUUID();
        const now = new Date().toISOString();
        const certificate = await this.certificates.signCsr(
          `node:${id}`,
          input.csrPem,
          7 * 24 * 60 * 60_000
        );
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
          certificateExpiresAt: certificate.expiresAt,
          lastHeartbeatAt: now,
          createdAt: now,
          updatedAt: now
        };
        enrollment = {
          csrSha256,
          node,
          certificate,
          status: 'pending'
        };
        await this.#storeJoinClaim(
          key,
          { ...claim, enrollment },
          Math.max(JOIN_ENROLLMENT_RETRY_MS, Date.parse(claim.expiresAt) - Date.now())
        );
      }

      let created = await this.#reconcileEnrollment(enrollment);
      if (!created) {
        if (enrollment.status === 'completed')
          throw new ConflictError('Join token is invalid, expired, or already used');
        try {
          created = (
            await this.repository.createNode(
              enrollment.node,
              this.#certificateState(
                enrollment.node.id,
                enrollment.certificate,
                enrollment.node.createdAt
              )
            )
          ).value;
        } catch (error) {
          created = await this.#reconcileEnrollment(enrollment);
          if (!created) throw error;
        }
      }

      if (enrollment.status === 'pending') {
        enrollment = { ...enrollment, status: 'completed' };
        await this.#storeJoinClaim(key, { ...claim, enrollment }, JOIN_ENROLLMENT_RETRY_MS);
        this.events.publish({
          version: 1,
          id: randomUUID(),
          type: 'node.joined',
          timestamp: enrollment.node.createdAt,
          payload: { nodeId: created.id, name: created.name, roles: created.roles }
        });
      }

      return { node: created, certificate: enrollment.certificate };
    } finally {
      await this.coordination.release(consumeLease, consumeOwner);
    }
  }

  async signNodeCertificate(id: string, csrPem: string): Promise<SignedCertificate> {
    const initial = await this.repository.getVersionedNode(id);
    if (!initial || initial.value.state === 'revoked')
      throw new NotFoundError('Active cluster node was not found');
    if (!this.certificates)
      throw new ConflictError('Cluster certificate authority is not configured');
    return this.certificates.signCsr(`node:${id}`, csrPem, 7 * 24 * 60 * 60_000);
  }

  async activateNodeCertificate(
    id: string,
    certificate: SignedCertificate
  ): Promise<SignedCertificate> {
    const rotatedAt = new Date().toISOString();
    const certificateState = this.#certificateState(id, certificate, rotatedAt);
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.repository.getVersionedNode(id);
      if (!current || current.value.state === 'revoked')
        throw new NotFoundError('Active cluster node was not found');
      const result = await this.repository.rotateNodeCertificate({
        nodeId: id,
        expectedRevision: current.revision,
        certificate: certificateState,
        updatedAt: rotatedAt
      });
      if (result.applied) return certificate;
      if (result.reason === 'not-found')
        throw new NotFoundError('Active cluster node was not found');
      if (result.reason === 'invalid-state')
        throw new NotFoundError('Active cluster node was not found');
    }
    throw new ConflictError(
      'Cluster certificate rotation conflicted with repeated concurrent updates'
    );
  }

  async certificateAuthority(): Promise<string | undefined> {
    return this.certificates?.caCertificate();
  }

  async revoke(id: string): Promise<ClusterNode> {
    const now = new Date().toISOString();
    let revoked: ClusterNode | undefined;
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.repository.getVersionedNode(id);
      if (!current) throw new NotFoundError('Cluster node was not found');
      const result = await this.repository.revokeNode({
        nodeId: id,
        expectedRevision: current.revision,
        revokedAt: now
      });
      if (result.applied) {
        revoked = result.record.value;
        break;
      }
      if (result.reason === 'not-found') throw new NotFoundError('Cluster node was not found');
    }
    if (!revoked)
      throw new ConflictError(
        'Cluster node revocation conflicted with repeated concurrent updates'
      );
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

  async bindings(providerId?: string): Promise<ProviderBinding[]> {
    return this.repository.listProviderBindings(providerId, { includeDeletionPending: true });
  }

  async beginBindingDeletion(id: string) {
    const updatedAt = new Date().toISOString();
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.repository.beginProviderBindingDeletion(id, updatedAt);
        if (result.applied) return result.record;
        if (result.reason === 'not-found') return undefined;
        if (result.reason === 'invalid-state')
          throw new ConflictError('Provider binding deletion is not allowed in its current state');
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof Error) throw lastError;
    if (lastError !== undefined)
      throw new Error('Provider binding deletion failed', { cause: lastError });
    throw new ConflictError(
      'Provider binding deletion conflicted with repeated concurrent updates'
    );
  }

  async finalizeBindingDeletion(id: string, initialRevision: number): Promise<void> {
    let expectedRevision = initialRevision;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.repository.finalizeProviderBindingDeletion(id, expectedRevision);
        if (result.applied || result.reason === 'not-found') return;
        if (result.reason === 'invalid-state')
          throw new ConflictError('Provider binding deletion is not pending');
      } catch (error) {
        lastError = error;
      }
      try {
        const pending = await this.beginBindingDeletion(id);
        if (!pending) return;
        expectedRevision = pending.revision;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof Error) throw lastError;
    if (lastError !== undefined)
      throw new Error('Provider binding deletion failed', { cause: lastError });
    throw new ConflictError(
      'Provider binding deletion conflicted with repeated concurrent updates'
    );
  }
  async logs(nodeId: string, limit = this.#agentLogQueryLimit()): Promise<AgentLogEntry[]> {
    return this.repository.listAgentLogs(
      nodeId,
      Math.min(this.#agentLogQueryLimit(), Math.max(1, Math.floor(limit)))
    );
  }
  async recordLog(entry: AgentLogEntry): Promise<void> {
    await this.repository.putAgentLog(entry, this.#agentLogRetentionRows());
    this.events.publish({
      version: 1,
      id: entry.id,
      type: 'node.log',
      timestamp: entry.timestamp,
      payload: {
        nodeId: entry.nodeId,
        level: entry.level,
        message: entry.message,
        context: entry.context
      }
    });
  }

  async registerLocal(
    input: Omit<ClusterNode, 'createdAt' | 'updatedAt' | 'lastHeartbeatAt'>
  ): Promise<ClusterNode> {
    const now = new Date().toISOString();
    const node: ClusterNode = {
      ...input,
      createdAt: now,
      lastHeartbeatAt: now,
      updatedAt: now
    };
    const stored = (await this.repository.ensureLocalNode(node)).value;
    this.#recordNodeCapabilityMetrics(stored);
    return stored;
  }

  async heartbeat(
    id: string,
    capabilities: NodeCapability,
    state: 'online' | 'degraded' | 'draining'
  ): Promise<ClusterNode> {
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.repository.getVersionedNode(id);
      if (!current) throw new NotFoundError('Cluster node was not found');
      if (current.value.state === 'revoked') return current.value;
      const now = new Date().toISOString();
      const result = await this.repository.recordNodeHeartbeat({
        nodeId: id,
        expectedRevision: current.revision,
        capabilities,
        reportedState: state,
        lastHeartbeatAt: now,
        updatedAt: now
      });
      if (result.applied) {
        this.#recordNodeCapabilityMetrics(result.record.value);
        return result.record.value;
      }
      if (result.reason === 'not-found') throw new NotFoundError('Cluster node was not found');
      if (result.reason === 'invalid-state') return result.current?.value ?? current.value;
    }
    throw new ConflictError('Cluster node heartbeat conflicted with repeated concurrent updates');
  }

  async drain(id: string, draining: boolean): Promise<ClusterNode> {
    let updated: ClusterNode | undefined;
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.repository.getVersionedNode(id);
      if (!current) throw new NotFoundError('Cluster node was not found');
      const result = await this.repository.setNodeDrain({
        nodeId: id,
        expectedRevision: current.revision,
        draining,
        updatedAt: new Date().toISOString()
      });
      if (result.applied) {
        updated = result.record.value;
        break;
      }
      if (result.reason === 'not-found') throw new NotFoundError('Cluster node was not found');
      if (result.reason === 'invalid-state')
        throw new ConflictError('A revoked cluster node cannot change drain state');
    }
    if (!updated)
      throw new ConflictError('Cluster node drain conflicted with repeated concurrent updates');
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
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.repository.getVersionedNode(id);
      if (!current) throw new NotFoundError('Cluster node was not found');
      if (current.value.state !== 'revoked')
        throw new ConflictError('Revoke the cluster node before removing it');
      const result = await this.repository.removeNode(id, current.revision);
      if (result.applied) return;
      if (result.reason === 'not-found') throw new NotFoundError('Cluster node was not found');
      if (result.reason === 'invalid-state')
        throw new ConflictError('Revoke the cluster node before removing it');
      if (result.reason === 'dependency-conflict')
        throw new ConflictError('Delete every provider binding for this node before removing it');
    }
    throw new ConflictError('Cluster node removal conflicted with repeated concurrent updates');
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
          return (
            (await this.#setOperationalState(
              (id) =>
                id.state !== 'revoked' &&
                id.state !== 'draining' &&
                id.state !== 'offline' &&
                Date.parse(id.lastHeartbeatAt) < staleBefore
                  ? 'offline'
                  : undefined,
              node.id
            )) ?? node
          );
        }
        if (node.state === 'online' && Date.parse(node.lastHeartbeatAt) < degradedBefore) {
          return (
            (await this.#setOperationalState(
              (id) =>
                id.state === 'online' && Date.parse(id.lastHeartbeatAt) < degradedBefore
                  ? 'degraded'
                  : undefined,
              node.id
            )) ?? node
          );
        }
        return node;
      })
    );
  }

  async get(id: string): Promise<ClusterNode | undefined> {
    return this.repository.getNode(id);
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

  async #storeJoinClaim(key: string, claim: JoinClaim, ttlMs: number): Promise<void> {
    const serialized = JSON.stringify(claim);
    try {
      await this.coordination.set(key, serialized, Math.max(1, ttlMs));
    } catch (error) {
      // A coordination write may commit and still report a transport failure.
      // Re-read before surfacing the error so a retry never generates a second
      // identity for an enrollment state that was already published.
      const current = await this.coordination.get(key).catch(() => undefined);
      if (current !== serialized) throw error;
    }
  }

  async #reconcileEnrollment(enrollment: JoinEnrollmentClaim): Promise<ClusterNode | undefined> {
    const current = await this.repository.getVersionedNode(enrollment.node.id);
    if (!current) return undefined;
    const certificate = (await this.repository.listNodeCertificates(enrollment.node.id)).find(
      (candidate) =>
        candidate.serialNumber === enrollment.certificate.serialNumber &&
        candidate.fingerprintSha256.toLowerCase() ===
          enrollment.certificate.fingerprintSha256.toLowerCase()
    );
    if (
      !certificate ||
      certificate.revokedAt ||
      certificate.expiresAt !== enrollment.certificate.expiresAt ||
      current.value.createdAt !== enrollment.node.createdAt
    )
      throw new ConflictError('Join token is invalid, expired, or already used');
    return current.value;
  }

  #agentLogRetentionRows(): number {
    return Math.max(
      1,
      Math.floor(this.options.agentLogRetentionRows ?? DEFAULT_AGENT_LOG_RETENTION_ROWS)
    );
  }

  #agentLogQueryLimit(): number {
    return Math.max(
      1,
      Math.floor(this.options.agentLogQueryLimit ?? DEFAULT_AGENT_LOG_QUERY_LIMIT)
    );
  }

  #recordNodeCapabilityMetrics(node: ClusterNode): void {
    this.options.metrics?.gauge('cluster_node_egress_mbps', node.capabilities.egressMbps, {
      node_id: node.id,
      node_region: node.region
    });
  }

  #hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  async #setOperationalState(
    selectState: (node: ClusterNode) => 'online' | 'degraded' | 'offline' | undefined,
    nodeId: string
  ): Promise<ClusterNode | undefined> {
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.repository.getVersionedNode(nodeId);
      if (!current) return undefined;
      const state = selectState(current.value);
      if (!state) return current.value;
      const result = await this.repository.setNodeOperationalState({
        nodeId,
        expectedRevision: current.revision,
        state,
        updatedAt: new Date().toISOString()
      });
      if (result.applied) return result.record.value;
      if (result.reason === 'not-found') return undefined;
      if (result.reason === 'invalid-state') return result.current?.value ?? current.value;
    }
    throw new ConflictError('Cluster node maintenance conflicted with repeated concurrent updates');
  }

  #certificateState(
    nodeId: string,
    certificate: SignedCertificate,
    createdAt: string
  ): NodeCertificateState {
    return {
      nodeId,
      serialNumber: certificate.serialNumber,
      fingerprintSha256: certificate.fingerprintSha256,
      expiresAt: certificate.expiresAt,
      revokedAt: null,
      createdAt
    };
  }
}
