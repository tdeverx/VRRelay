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
  AgentLogEntry
} from '@vrrelay/domain';
import type { CatalogQuery, RelayEvent } from '@vrrelay/contracts';

export interface ProviderCredentials {
  username?: string;
  password?: string;
  apiKey?: string;
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
    signal?: AbortSignal
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
  putNode(node: ClusterNode): Promise<void>;
  getNode(id: string): Promise<ClusterNode | undefined>;
  listNodes(): Promise<ClusterNode[]>;
  deleteNode(id: string): Promise<void>;
  putSegmentJob(job: SegmentJob): Promise<void>;
  getSegmentJob(id: string): Promise<SegmentJob | undefined>;
  listSegmentJobs(limit?: number): Promise<SegmentJob[]>;
  putProviderBinding(binding: ProviderBinding): Promise<void>;
  getProviderBinding(id: string): Promise<ProviderBinding | undefined>;
  listProviderBindings(providerId?: string): Promise<ProviderBinding[]>;
  deleteProviderBinding(id: string): Promise<void>;
  putNodeCertificate(certificate: NodeCertificateState): Promise<void>;
  listNodeCertificates(nodeId: string): Promise<NodeCertificateState[]>;
  putAgentLog(entry: AgentLogEntry): Promise<void>;
  listAgentLogs(nodeId: string, limit?: number): Promise<AgentLogEntry[]>;
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

export interface CertificateBundle {
  certificatePem: string;
  privateKeyPem: string;
  caCertificatePem: string;
  expiresAt: string;
  serialNumber: string;
  fingerprintSha256: string;
}

export { SwitchableMetricsExporter } from './metrics-exporter.js';

export interface CertificateAuthority {
  issue(
    commonName: string,
    ttlMs: number,
    dnsNames?: readonly string[]
  ): Promise<CertificateBundle>;
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
  putProvider(provider: ProviderConnection): Promise<void>;
  listProviders(): Promise<ProviderConnection[]>;
  getProvider(id: string): Promise<ProviderConnection | undefined>;
  deleteProvider(id: string): Promise<void>;
  putProfile(profile: ProfileRevision): Promise<void>;
  listProfiles(): Promise<ProfileRevision[]>;
  getProfile(id: string, revision?: number): Promise<ProfileRevision | undefined>;
  putSession(session: RelaySession): Promise<void>;
  listSessions(): Promise<RelaySession[]>;
  getSession(id: string): Promise<RelaySession | undefined>;
  deleteSession(id: string): Promise<void>;
  putPlaybackGrant(grant: PlaybackGrant): Promise<void>;
  getPlaybackGrant(tokenHash: string): Promise<PlaybackGrant | undefined>;
  revokePlaybackGrants(sessionId: string): Promise<void>;
  putLiveChannel(channel: LiveChannel): Promise<void>;
  listLiveChannels(): Promise<LiveChannel[]>;
  getLiveChannel(id: string): Promise<LiveChannel | undefined>;
  deleteLiveChannel(id: string): Promise<void>;
  putCompatibilityResult(result: CompatibilityResult): Promise<void>;
  listCompatibilityResults(): Promise<CompatibilityResult[]>;
  putPersonalToken(token: PersonalAccessToken): Promise<void>;
  getPersonalToken(tokenHash: string): Promise<PersonalAccessToken | undefined>;
  listPersonalTokens(): Promise<PersonalAccessToken[]>;
  revokePersonalToken(id: string): Promise<void>;
  putSetting(key: string, value: string): Promise<void>;
  getSetting(key: string): Promise<string | undefined>;
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
