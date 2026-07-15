// SPDX-License-Identifier: GPL-3.0-or-later
import type { Readable, Writable } from 'node:stream';
import type {
  BackendStatus,
  CachedObject,
  ClusterNode,
  CompatibilityResult,
  LiveChannel,
  MediaItem,
  MediaSourceRef,
  PersonalAccessToken,
  PlaybackGrant,
  ProfileRevision,
  ProviderCapability,
  ProviderConnection,
  ProviderType,
  RelaySession,
  SegmentJob,
  ProviderBinding,
  NodeCertificateState,
  AgentLogEntry,
  AuditCategory,
  AuditEvent,
  NodeCapability
} from '@vrrelay/domain';
import type { CatalogQuery, RelayEvent } from '@vrrelay/contracts';

export interface ProviderCredentials {
  username?: string;
  password?: string;
  apiKey?: string;
}

export interface ProviderTransportPolicy {
  allowPublicHttp: boolean;
}

export interface ProviderIdentity {
  userId?: string;
  username?: string;
  accessToken: string;
  serverName: string;
  serverVersion: string;
}

export interface ResolvedSource {
  url: string;
  headers: Record<string, string>;
  durationSeconds: number;
  fingerprint: string;
  container?: string;
  defaultAudio?: number;
  defaultSubtitle?: number;
  allowPublicHttp?: boolean;
}

export interface SourceResponse {
  stream: Readable;
  status: number;
  headers: Record<string, string>;
}

export interface PlaybackEvent {
  sessionId: string;
  itemId: string;
  positionTicks: number;
  paused: boolean;
  event: 'start' | 'progress' | 'stop';
}

export interface MediaProvider {
  readonly type: ProviderType;
  readonly capabilities: readonly ProviderCapability[];
  authenticate(
    baseUrl: string,
    credentials: ProviderCredentials,
    signal?: AbortSignal,
    transportPolicy?: ProviderTransportPolicy
  ): Promise<ProviderIdentity>;
  validate(connection: ProviderConnection, secret: string, signal?: AbortSignal): Promise<void>;
  browse(
    connection: ProviderConnection,
    secret: string,
    query: CatalogQuery,
    signal?: AbortSignal
  ): Promise<{ items: MediaItem[]; total: number }>;
  item(
    connection: ProviderConnection,
    secret: string,
    itemId: string,
    signal?: AbortSignal
  ): Promise<MediaItem>;
  resolveSource(
    connection: ProviderConnection,
    secret: string,
    source: MediaSourceRef,
    signal?: AbortSignal
  ): Promise<ResolvedSource>;
  openSource(source: ResolvedSource, range?: string, signal?: AbortSignal): Promise<SourceResponse>;
  reportPlayback(
    connection: ProviderConnection,
    secret: string,
    event: PlaybackEvent,
    signal?: AbortSignal
  ): Promise<void>;
}

export interface ProviderRegistry {
  register(provider: MediaProvider): void;
  get(type: ProviderType): MediaProvider;
}

export interface SecretStore {
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}

export interface ObjectStorePutOptions {
  contentType: string;
  expiresAt?: string | null;
  sha256?: string;
  metadata?: Record<string, string>;
}

export interface ObjectStore {
  readonly kind: string;
  put(key: string, source: Readable, options: ObjectStorePutOptions): Promise<CachedObject>;
  stat(key: string): Promise<CachedObject | undefined>;
  open(key: string): Promise<Readable | undefined>;
  delete(key: string): Promise<void>;
  health(): Promise<BackendStatus>;
}

export interface CoordinationStore {
  readonly kind: string;
  acquire(key: string, owner: string, ttlMs: number): Promise<boolean>;
  renew(key: string, owner: string, ttlMs: number): Promise<boolean>;
  release(key: string, owner: string): Promise<void>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, listener: (payload: string) => void): Promise<() => Promise<void>>;
  health(): Promise<BackendStatus>;
}

export interface ClusterRepository {
  createNode(
    node: ClusterNode,
    initialCertificate?: NodeCertificateState
  ): Promise<VersionedRecord<ClusterNode>>;
  ensureLocalNode(node: ClusterNode): Promise<VersionedRecord<ClusterNode>>;
  getNode(id: string): Promise<ClusterNode | undefined>;
  listNodes(): Promise<ClusterNode[]>;
  removeNode(id: string, expectedRevision: number): Promise<AtomicDeleteResult<ClusterNode>>;
  createSegmentJob(job: SegmentJob): Promise<SegmentJobCreateResult>;
  getSegmentJob(id: string): Promise<SegmentJob | undefined>;
  listSegmentJobs(limit?: number): Promise<SegmentJob[]>;
  createProviderBinding(
    provider: ProviderConnection,
    binding: ProviderBinding,
    expectedProviderRevision: number | null
  ): Promise<ProviderBindingCreateResult>;
  getProviderBinding(
    id: string,
    options?: ProviderBindingReadOptions
  ): Promise<ProviderBinding | undefined>;
  getVersionedProviderBinding(
    id: string,
    options?: ProviderBindingReadOptions
  ): Promise<VersionedRecord<ProviderBinding> | undefined>;
  compareAndSetProviderBinding(
    binding: ProviderBinding,
    expectedRevision: number,
    allowedCurrentStates?: readonly ProviderBinding['state'][]
  ): Promise<AtomicWriteResult<ProviderBinding>>;
  listProviderBindings(
    providerId?: string,
    options?: ProviderBindingReadOptions
  ): Promise<ProviderBinding[]>;
  beginProviderBindingDeletion(
    id: string,
    updatedAt: string
  ): Promise<AtomicWriteResult<ProviderBinding>>;
  finalizeProviderBindingDeletion(
    id: string,
    expectedRevision: number
  ): Promise<AtomicDeleteResult<ProviderBinding>>;
  listNodeCertificates(nodeId: string): Promise<NodeCertificateState[]>;
  rotateNodeCertificate(update: NodeCertificateRotation): Promise<AtomicWriteResult<ClusterNode>>;
  revokeNode(update: NodeRevocation): Promise<AtomicWriteResult<ClusterNode>>;
  putAgentLog(entry: AgentLogEntry): Promise<void>;
  listAgentLogs(nodeId: string, limit?: number): Promise<AgentLogEntry[]>;
  getVersionedNode(id: string): Promise<VersionedRecord<ClusterNode> | undefined>;
  recordNodeHeartbeat(update: NodeHeartbeatUpdate): Promise<AtomicWriteResult<ClusterNode>>;
  setNodeDrain(update: NodeDrainUpdate): Promise<AtomicWriteResult<ClusterNode>>;
  setNodeOperationalState(
    update: NodeOperationalStateUpdate
  ): Promise<AtomicWriteResult<ClusterNode>>;
  getVersionedSegmentJob(id: string): Promise<VersionedRecord<SegmentJob> | undefined>;
  compareAndSetSegmentJob(
    job: SegmentJob,
    expectedRevision: number,
    allowedCurrentStates: readonly SegmentJob['state'][]
  ): Promise<AtomicWriteResult<SegmentJob>>;
  completeSegmentJob(
    job: SegmentJob,
    expectedRevision: number
  ): Promise<AtomicWriteResult<SegmentJob>>;
  cancelSegmentJob(
    job: SegmentJob,
    expectedRevision: number
  ): Promise<AtomicWriteResult<SegmentJob>>;
}

export interface VersionedRecord<T> {
  value: T;
  revision: number;
}

export type AtomicWriteFailureReason =
  'not-found' | 'revision-conflict' | 'invalid-state' | 'dependency-conflict';

export type AtomicWriteResult<T> =
  | { applied: true; record: VersionedRecord<T> }
  | {
      applied: false;
      reason: AtomicWriteFailureReason;
      current?: VersionedRecord<T>;
      dependencies?: readonly string[];
    };

export type AtomicDeleteResult<T> =
  | { applied: true; deleted: VersionedRecord<T> }
  | {
      applied: false;
      reason: AtomicWriteFailureReason;
      current?: VersionedRecord<T>;
      dependencies?: readonly string[];
    };

export type ProviderBindingCreateResult =
  | {
      applied: true;
      provider: ProviderConnection;
      binding: VersionedRecord<ProviderBinding>;
    }
  | {
      applied: false;
      reason:
        | 'provider-conflict'
        | 'provider-not-found'
        | 'provider-revision-conflict'
        | 'provider-deleting'
        | 'binding-deleting'
        | 'node-unavailable'
        | 'binding-conflict';
      provider?: ProviderConnection;
      binding?: VersionedRecord<ProviderBinding>;
    };

export interface ProviderBindingReadOptions {
  includeDeletionPending?: boolean;
}

export interface SettingInsertResult {
  inserted: boolean;
  record: VersionedRecord<string>;
}

export interface SegmentJobCreateResult {
  created: boolean;
  record: VersionedRecord<SegmentJob>;
}

export interface NodeHeartbeatUpdate {
  nodeId: string;
  expectedRevision: number;
  capabilities: NodeCapability;
  reportedState: 'online' | 'degraded' | 'draining';
  lastHeartbeatAt: string;
  updatedAt: string;
  certificateExpiresAt?: string;
}

export interface NodeDrainUpdate {
  nodeId: string;
  expectedRevision: number;
  draining: boolean;
  updatedAt: string;
}

export interface NodeOperationalStateUpdate {
  nodeId: string;
  expectedRevision: number;
  state: 'online' | 'degraded' | 'offline';
  updatedAt: string;
}

export interface NodeCertificateRotation {
  nodeId: string;
  expectedRevision: number;
  certificate: NodeCertificateState;
  updatedAt: string;
}

export interface NodeRevocation {
  nodeId: string;
  expectedRevision: number;
  revokedAt: string;
}

export interface PersonalTokenUse {
  tokenHash: string;
  usedAt: string;
  touchBefore: string;
}

export interface AuditQuery {
  category?: AuditCategory;
  actorId?: string;
  targetId?: string;
  before?: string;
  limit?: number;
}

export interface AuditRepository {
  appendAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(query?: AuditQuery): Promise<AuditEvent[]>;
}

export interface TrafficDirector {
  readonly kind: string;
  selectEdge(
    sessionId: string,
    nodes: readonly ClusterNode[],
    preferredRegion?: string
  ): Promise<ClusterNode | undefined>;
  health(): Promise<BackendStatus>;
}

export interface MetricsSink {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
  render(): Promise<string>;
  contentType: string;
}

export interface MetricsExporter {
  readonly kind: string;
  health(): Promise<BackendStatus>;
  start(): void;
  stop(): Promise<void>;
}

export interface SignedCertificate {
  certificatePem: string;
  caCertificatePem: string;
  expiresAt: string;
  serialNumber: string;
  fingerprintSha256: string;
}

export interface CertificateBundle extends SignedCertificate {
  privateKeyPem: string;
}

export { SwitchableMetricsExporter } from './metrics-exporter.js';

export interface CertificateAuthority {
  issue(
    commonName: string,
    ttlMs: number,
    dnsNames?: readonly string[]
  ): Promise<CertificateBundle>;
  signCsr(
    commonName: string,
    csrPem: string,
    ttlMs: number,
    dnsNames?: readonly string[]
  ): Promise<SignedCertificate>;
  caCertificate(): Promise<string>;
}

export interface RemoteSegmentCommand {
  jobId: string;
  sessionId: string;
  contentKey: string;
  segmentIndex: number;
}

export interface RemoteSegmentDispatcher {
  connected(nodeId: string): boolean;
  dispatch(nodeId: string, command: RemoteSegmentCommand, signal?: AbortSignal): Promise<void>;
  cancel(nodeId: string, jobId: string): Promise<void>;
}

export interface RemoteProviderGateway {
  connected(nodeId: string): boolean;
  call<T>(
    nodeId: string,
    operation:
      | 'provider.bind'
      | 'provider.unbind'
      | 'provider.browse'
      | 'provider.item'
      | 'provider.validate'
      | 'provider.activity',
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T>;
}

export interface RemoteSegmentRequester {
  ensure(token: string, segmentIndex: number, signal?: AbortSignal): Promise<void>;
}

export interface Repository {
  migrate(): Promise<void>;
  assertSchemaCurrent(): Promise<void>;
  createProvider(provider: ProviderConnection): Promise<VersionedRecord<ProviderConnection>>;
  listProviders(): Promise<ProviderConnection[]>;
  getProvider(id: string): Promise<ProviderConnection | undefined>;
  getVersionedProvider(id: string): Promise<VersionedRecord<ProviderConnection> | undefined>;
  compareAndSetProvider(
    provider: ProviderConnection,
    expectedRevision: number
  ): Promise<AtomicWriteResult<ProviderConnection>>;
  beginProviderDeletion(id: string): Promise<AtomicWriteResult<ProviderConnection>>;
  finalizeProviderDeletion(
    id: string,
    expectedRevision: number
  ): Promise<AtomicDeleteResult<ProviderConnection>>;
  putProfile(profile: ProfileRevision): Promise<void>;
  listProfiles(): Promise<ProfileRevision[]>;
  getProfile(id: string, revision?: number): Promise<ProfileRevision | undefined>;
  createSessionWithPlaybackGrant(
    session: RelaySession,
    grant: PlaybackGrant,
    expectedLiveChannelRevision?: number
  ): Promise<AtomicWriteResult<RelaySession>>;
  listSessions(): Promise<RelaySession[]>;
  getSession(id: string): Promise<RelaySession | undefined>;
  getVersionedSession(id: string): Promise<VersionedRecord<RelaySession> | undefined>;
  compareAndSetSession(
    session: RelaySession,
    expectedRevision: number
  ): Promise<AtomicWriteResult<RelaySession>>;
  setSessionViewers(
    sessionId: string,
    expectedRevision: number,
    viewers: number,
    updatedAt: string
  ): Promise<AtomicWriteResult<RelaySession>>;
  deleteSessionAndRevokePlaybackGrants(sessionId: string, revokedAt?: string): Promise<void>;
  getPlaybackGrant(tokenHash: string): Promise<PlaybackGrant | undefined>;
  createLiveChannel(channel: LiveChannel): Promise<VersionedRecord<LiveChannel>>;
  listLiveChannels(): Promise<LiveChannel[]>;
  getLiveChannel(id: string): Promise<LiveChannel | undefined>;
  getVersionedLiveChannel(id: string): Promise<VersionedRecord<LiveChannel> | undefined>;
  compareAndSetLiveChannel(
    channel: LiveChannel,
    expectedRevision: number
  ): Promise<AtomicWriteResult<LiveChannel>>;
  deleteLiveChannel(id: string, expectedRevision: number): Promise<AtomicWriteResult<LiveChannel>>;
  putCompatibilityResult(result: CompatibilityResult): Promise<void>;
  listCompatibilityResults(): Promise<CompatibilityResult[]>;
  putPersonalToken(token: PersonalAccessToken): Promise<void>;
  getPersonalToken(tokenHash: string): Promise<PersonalAccessToken | undefined>;
  usePersonalToken(update: PersonalTokenUse): Promise<PersonalAccessToken | undefined>;
  listPersonalTokens(): Promise<PersonalAccessToken[]>;
  revokePersonalToken(id: string, revokedAt?: string): Promise<void>;
  putSetting(key: string, value: string): Promise<void>;
  getSetting(key: string): Promise<string | undefined>;
  getVersionedSetting(key: string): Promise<VersionedRecord<string> | undefined>;
  putSettingIfAbsent(key: string, value: string): Promise<SettingInsertResult>;
  compareAndSetSetting(
    key: string,
    value: string,
    expectedRevision: number
  ): Promise<AtomicWriteResult<string>>;
}

export interface EncoderCapability {
  name: string;
  codec: string;
  hardware: boolean;
  available: boolean;
  reason?: string;
}

export interface MediaCapabilities {
  ffmpegVersion: string;
  encoders: EncoderCapability[];
  muxers: string[];
  filters: string[];
  pixelFormats: string[];
}

export interface SegmentRequest {
  source: ResolvedSource;
  profile: ProfileRevision;
  segmentIndex: number;
  startSeconds: number;
  duration: number;
  audioTrack?: number;
  subtitleTrack?: number;
}

export interface Transcoder {
  discover(signal?: AbortSignal): Promise<MediaCapabilities>;
  generateSegment(
    request: SegmentRequest,
    destination: string,
    signal?: AbortSignal
  ): Promise<void>;
  streamFragmentedMp4(
    source: ResolvedSource,
    profile: ProfileRevision,
    output: Writable,
    signal?: AbortSignal
  ): Promise<void>;
}

export interface LiveNormalizer {
  start(
    channelId: string,
    sourceUrl: string,
    destinationUrl: string,
    signal?: AbortSignal
  ): Promise<void>;
  stop(channelId: string): Promise<void>;
  running(channelId: string): boolean;
}

export interface EventBus {
  publish(event: RelayEvent): void;
  subscribe(listener: (event: RelayEvent) => void): () => void;
  recent(limit?: number): RelayEvent[];
}

export class InMemoryEventBus implements EventBus {
  readonly #listeners = new Set<(event: RelayEvent) => void>();
  readonly #events: RelayEvent[] = [];

  publish(event: RelayEvent): void {
    this.#events.unshift(event);
    this.#events.splice(500);
    for (const listener of this.#listeners) listener(event);
  }

  subscribe(listener: (event: RelayEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  recent(limit = 50): RelayEvent[] {
    return this.#events.slice(0, limit);
  }
}

export class DefaultProviderRegistry implements ProviderRegistry {
  readonly #providers = new Map<ProviderType, MediaProvider>();

  register(provider: MediaProvider): void {
    this.#providers.set(provider.type, provider);
  }

  get(type: ProviderType): MediaProvider {
    const provider = this.#providers.get(type);
    if (!provider) throw new Error(`Provider adapter is not registered: ${type}`);
    return provider;
  }
}

export * from './errors.js';
export * from './services.js';
export * from './cluster-service.js';
export * from './audit-service.js';
