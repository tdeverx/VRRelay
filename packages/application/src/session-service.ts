// SPDX-License-Identifier: GPL-3.0-or-later
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, mkdir, rm, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import type {
  CachedObject,
  JobLogEntry,
  LiveChannel,
  MediaItem,
  NodeRole,
  PlaybackGrant,
  ProfileRevision,
  ProviderConnection,
  RelaySession,
  SegmentJob,
  VodProducer
} from '@vrrelay/domain';
import type { CreateSessionRequest } from '@vrrelay/contracts';
import type {
  ClusterRepository,
  CoordinationStore,
  EventBus,
  MediaProvider,
  MetricsSink,
  ObjectStore,
  ProviderRegistry,
  RemoteProviderGateway,
  RemoteSegmentCommand,
  RemoteSegmentDispatcher,
  RemoteSegmentRequester,
  Repository,
  ResolvedSource,
  SecretStore,
  SourceResponse,
  Transcoder
} from './index.js';
import { CapacityError, ConflictError, NotFoundError, UnauthorizedError } from './errors.js';
import { createServiceEvent as event, hashToken, opaqueToken } from './service-helpers.js';
import { SessionCache } from './session-cache.js';
import { SessionJobCoordinator } from './session-jobs.js';
import { VodProducerCoordinator } from './vod-producer-coordinator.js';

const MAX_ATOMIC_WRITE_ATTEMPTS = 5;
const VIEWER_WINDOW_MS = 30_000;
const EDGE_GRANT_PREFIX = 'eg1';
const EDGE_GRANT_SIGNING_KEY = 'playback.edge_grant_signing_key';

interface EdgePlaybackGrantPayload {
  v: 1;
  kind: 'edge-playback';
  sessionId: string;
  grantHash: string;
  edgeNodeId: string;
  issuedAt: string;
  expiresAt: string | null;
}

function hmacBase64Url(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encodeEdgeGrant(payload: EdgePlaybackGrantPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${EDGE_GRANT_PREFIX}.${body}.${hmacBase64Url(secret, body)}`;
}

function parseEdgeGrant(token: string): { body: string; signature: string } | undefined {
  const [prefix, body, signature, extra] = token.split('.');
  if (prefix !== EDGE_GRANT_PREFIX || !body || !signature || extra !== undefined) return undefined;
  return { body, signature };
}

function decodeEdgeGrantBody(body: string): EdgePlaybackGrantPayload {
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    (decoded as EdgePlaybackGrantPayload).v !== 1 ||
    (decoded as EdgePlaybackGrantPayload).kind !== 'edge-playback' ||
    typeof (decoded as EdgePlaybackGrantPayload).sessionId !== 'string' ||
    typeof (decoded as EdgePlaybackGrantPayload).grantHash !== 'string' ||
    typeof (decoded as EdgePlaybackGrantPayload).edgeNodeId !== 'string' ||
    typeof (decoded as EdgePlaybackGrantPayload).issuedAt !== 'string' ||
    !(
      (decoded as EdgePlaybackGrantPayload).expiresAt === null ||
      typeof (decoded as EdgePlaybackGrantPayload).expiresAt === 'string'
    )
  )
    throw new Error('Invalid edge grant payload');
  return decoded as EdgePlaybackGrantPayload;
}

export interface SessionServiceOptions {
  publicUrl: string;
  internalUrl: string;
  cacheDir: string;
  cacheTtlMs: number;
  maxWorkers: number;
  cacheLimitBytes?: number;
  nodeId?: string;
  roles?: NodeRole[];
  jobLogRetentionRows?: number;
  jobLogQueryLimit?: number;
  vodProducerIdleTimeoutMs?: number;
}

export interface SessionServiceInfrastructure {
  objectStore?: ObjectStore;
  coordination?: CoordinationStore;
  clusterRepository?: ClusterRepository;
  metrics?: MetricsSink;
  dispatcher?: RemoteSegmentDispatcher;
  providerGateway?: RemoteProviderGateway;
  ensureRequester?: RemoteSegmentRequester;
}

export interface SessionCreateContext {
  ownerId: string;
  providerAccessToken?: string;
  providerUserId?: string;
}

export class SessionService {
  readonly #inflight = new Map<string, Promise<string>>();
  readonly #sourceGrants = new Map<
    string,
    { source: ResolvedSource; provider: MediaProvider; expiresAt: number; sessionId?: string }
  >();
  readonly #waiters: Array<() => void> = [];
  readonly #viewers = new Map<string, Map<string, number>>();
  readonly #activity = new Map<string, number>();
  readonly #egressSamples: Array<{ bytes: number; observedAt: number }> = [];
  readonly #cache: SessionCache;
  readonly #jobs: SessionJobCoordinator;
  readonly #producers?: VodProducerCoordinator;
  readonly #ephemeralSourceCredentials = new Map<
    string,
    { accessToken: string; providerUserId: string }
  >();
  #viewerSalt: Promise<string> | undefined;
  #activeWorkers = 0;

  constructor(
    private readonly repository: Repository,
    private readonly secrets: SecretStore,
    private readonly providers: ProviderRegistry,
    private readonly transcoder: Transcoder,
    private readonly events: EventBus,
    private readonly options: SessionServiceOptions,
    private readonly infrastructure: SessionServiceInfrastructure = {}
  ) {
    this.#cache = new SessionCache(
      options,
      infrastructure.objectStore,
      infrastructure.metrics,
      events
    );
    this.#jobs = new SessionJobCoordinator(
      repository,
      events,
      options,
      this.#cache,
      infrastructure,
      {
        getSession: (id) => this.get(id),
        generateSegment: (session, profile, index, destination, signal) =>
          this.#generateSegment(session, profile, index, destination, signal),
        remoteCommand: (jobId, session, contentKey, segmentIndex) =>
          this.#remoteSegmentCommand(jobId, session, contentKey, segmentIndex)
      }
    );
    if (infrastructure.clusterRepository && infrastructure.coordination)
      this.#producers = new VodProducerCoordinator(
        infrastructure.clusterRepository,
        infrastructure.coordination,
        infrastructure.objectStore,
        transcoder,
        this.#cache,
        {
          acquire: (signal) => this.#acquire(signal),
          prepare: (session, profile, startSegmentIndex, signal) =>
            this.#prepareVodProducer(session, profile, startSegmentIndex, signal),
          released: (sessionId) => {
            this.#release();
            this.#ephemeralSourceCredentials.delete(sessionId);
            this.#deleteSourceGrants(sessionId);
          }
        },
        {
          cacheDir: options.cacheDir,
          nodeId: options.nodeId ?? 'standalone',
          idleTimeoutMs: options.vodProducerIdleTimeoutMs ?? 60_000
        },
        infrastructure.metrics
      );
  }

  async create(input: CreateSessionRequest, context?: SessionCreateContext): Promise<RelaySession> {
    if (
      context &&
      input.kind === 'vod' &&
      (!context.providerAccessToken || !context.providerUserId)
    )
      throw new ConflictError('User-owned VOD sessions require provider credentials');
    const profile = await this.repository.getProfile(input.profileId, input.profileRevision);
    if (!profile) throw new NotFoundError('Profile revision was not found');
    const id = randomUUID();
    const token = opaqueToken();
    const now = new Date().toISOString();
    let durationSeconds: number | undefined;
    let liveChannelRevision: number | undefined;
    let name = input.name;
    if (input.kind === 'vod') {
      const connection = await this.repository.getProvider(input.source.providerId);
      if (!connection) throw new NotFoundError('Provider connection was not found');
      const sourceConnection = context
        ? { ...connection, userId: context.providerUserId! }
        : connection;
      const remoteNode = context ? undefined : await this.#remoteProviderNode(connection.id);
      const item = remoteNode
        ? await this.infrastructure.providerGateway!.call<MediaItem>(remoteNode, 'provider.item', {
            providerId: connection.id,
            itemId: input.source.itemId
          })
        : await this.providers
            .get(sourceConnection.type)
            .item(
              sourceConnection,
              context?.providerAccessToken ?? (await this.#providerSecret(connection)),
              input.source.itemId
            );
      durationSeconds = item.durationSeconds;
      if (!durationSeconds || durationSeconds <= 0)
        throw new Error('Selected media does not expose a finite duration');
      name ??= item.name;
    } else {
      if (profile.delivery.method !== 'hls' || profile.delivery.playlistType !== 'live')
        throw new ConflictError('Live sessions require a live HLS profile');
      liveChannelRevision = await this.#claimLiveNormalizationProfile(input.liveChannelId, profile);
    }
    const path =
      input.kind === 'live'
        ? 'live.m3u8'
        : profile.delivery.method === 'fragmented_mp4'
          ? 'stream.mp4'
          : 'index.m3u8';
    const session: RelaySession = {
      id,
      name: name ?? 'Untitled relay',
      kind: input.kind,
      ...(input.kind === 'vod'
        ? { source: input.source, durationSeconds }
        : { liveChannelId: input.liveChannelId }),
      profileId: profile.profileId,
      profileRevision: profile.revision,
      platformMode: input.platformMode,
      state: input.kind === 'live' ? 'live' : 'idle',
      pinned: input.pinned,
      reportActivity: input.reportActivity,
      viewers: 0,
      placementPolicy: input.placementPolicy,
      ...(input.preferredNodeId ? { assignedNodeId: input.preferredNodeId } : {}),
      placementLocked: input.placementLocked,
      ...(input.preferredRegion ? { preferredRegion: input.preferredRegion } : {}),
      ...(context ? { ownerId: context.ownerId } : {}),
      outputUrls: { primary: `${this.options.publicUrl}/play/${token}/${path}` },
      createdAt: now,
      updatedAt: now
    };
    const expiresAt = input.playbackTtlSeconds
      ? new Date(Date.now() + input.playbackTtlSeconds * 1_000).toISOString()
      : null;
    if (context && input.kind === 'vod')
      await this.secrets.put(
        this.#sessionSourceSecretRef(id),
        JSON.stringify({
          accessToken: context.providerAccessToken!,
          userId: context.providerUserId!
        })
      );
    let created;
    try {
      created = await this.repository.createSessionWithPlaybackGrant(
        session,
        {
          tokenHash: hashToken(token),
          sessionId: id,
          expiresAt,
          revokedAt: null,
          createdAt: now
        },
        liveChannelRevision
      );
    } catch (error) {
      if (context)
        await this.secrets.delete(this.#sessionSourceSecretRef(id)).catch(() => undefined);
      throw error;
    }
    if (!created.applied) {
      if (context)
        await this.secrets.delete(this.#sessionSourceSecretRef(id)).catch(() => undefined);
      if (session.kind === 'live') {
        if (created.reason === 'not-found') throw new NotFoundError('Live channel was not found');
        throw new ConflictError(
          'Live channel changed while the session was being created; try again'
        );
      }
      if (created.reason === 'not-found')
        throw new NotFoundError('Provider connection was not found');
      if (created.reason === 'invalid-state')
        throw new ConflictError('Provider connection is being deleted');
      throw new ConflictError(
        'Provider connection changed while the session was being created; try again'
      );
    }
    this.events.publish(event('session.created', { name: session.name, kind: session.kind }, id));
    return session;
  }

  async #claimLiveNormalizationProfile(
    channelId: string,
    profile: ProfileRevision
  ): Promise<number> {
    let stored = await this.repository.getVersionedLiveChannel(channelId);
    if (!stored) throw new NotFoundError('Live channel was not found');
    if (!stored.value.normalize) return stored.revision;
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const channel = stored.value;
      const claimedId = channel.normalizationProfileId;
      const claimedRevision = channel.normalizationProfileRevision;
      if (claimedId || claimedRevision) {
        if (claimedId !== profile.profileId || claimedRevision !== profile.revision)
          throw new ConflictError(
            'Live channel already has a different normalization profile; create a separate channel for that profile'
          );
        return stored.revision;
      }
      const result = await this.repository.compareAndSetLiveChannel(
        {
          ...channel,
          normalizationProfileId: profile.profileId,
          normalizationProfileRevision: profile.revision
        },
        stored.revision
      );
      if (result.applied) return result.record.revision;
      if (result.reason === 'not-found') throw new NotFoundError('Live channel was not found');
      stored = result.current ?? (await this.repository.getVersionedLiveChannel(channelId));
      if (!stored) throw new NotFoundError('Live channel was not found');
    }
    throw new ConflictError(
      'Live channel changed while the normalization profile was being selected; try again'
    );
  }

  async list(): Promise<RelaySession[]> {
    return this.repository.listSessions();
  }

  async get(id: string): Promise<RelaySession> {
    const session = await this.repository.getSession(id);
    if (!session) throw new NotFoundError('Session was not found');
    return session;
  }

  async control(
    id: string,
    input: { pinned?: boolean; state?: 'idle' | 'live' | 'stopped' }
  ): Promise<RelaySession> {
    const result = await this.#updateSession(
      id,
      (session) => {
        if (input.state === 'idle' && session.kind !== 'vod')
          throw new ConflictError('Only VOD sessions can resume to idle');
        if (input.state === 'live' && session.kind !== 'live')
          throw new ConflictError('Only live sessions can resume to live');
        return {
          ...session,
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          ...(input.state ? { state: input.state } : {}),
          updatedAt: new Date().toISOString()
        };
      },
      'Session control conflicted with repeated concurrent updates'
    );
    const updated = result.session;
    if (!updated) throw new NotFoundError('Session was not found');
    if (input.state === 'stopped')
      await this.#reportActivity(updated, 0, 'stop').catch(() => undefined);
    this.events.publish(
      event('session.updated', { pinned: updated.pinned, state: updated.state }, id)
    );
    return updated;
  }

  async recover(): Promise<number> {
    let recovered = 0;
    // Remote worker output is always temporary. A process restart means no
    // surviving FFmpeg process owns these directories, so stale files must not
    // be mistaken for completed work.
    await this.#cache.recoverPartials();
    for (const session of await this.repository.listSessions()) {
      if (['queued', 'starting', 'active'].includes(session.state)) {
        const result = await this.#updateSession(
          session.id,
          (current) =>
            ['queued', 'starting', 'active'].includes(current.state)
              ? { ...current, state: 'idle', updatedAt: new Date().toISOString() }
              : undefined,
          'Session recovery conflicted with repeated concurrent updates',
          true
        );
        if (result.applied) recovered += 1;
      }
    }
    recovered += await this.#jobs.recoverExpiredJobs();
    recovered += (await this.#producers?.recoverExpired()) ?? 0;
    return recovered;
  }

  async delete(id: string): Promise<void> {
    const session = await this.repository.getSession(id);
    if (!session) throw new NotFoundError('Session was not found');
    if (session.assignedNodeId)
      await this.infrastructure.dispatcher
        ?.stopProducer?.(session.assignedNodeId, session.id)
        .catch(() => undefined);
    await this.#reportActivity(session, session.durationSeconds ?? 0, 'stop').catch(
      () => undefined
    );
    if (session.ownerId) await this.secrets.delete(this.#sessionSourceSecretRef(id));
    await this.#producers?.stop(id);
    this.#ephemeralSourceCredentials.delete(id);
    await this.repository.deleteSessionAndRevokePlaybackGrants(id);
    await rm(join(this.options.cacheDir, 'vod', id), { recursive: true, force: true });
    this.events.publish(event('session.deleted', { name: session.name }, id));
  }

  async createEdgePlaybackGrant(token: string, edgeNodeId: string): Promise<string> {
    if (parseEdgeGrant(token))
      throw new UnauthorizedError('Edge playback grants cannot be exchanged for another edge');
    const grantHash = hashToken(token);
    const grant = await this.#validPlaybackGrant(grantHash);
    const session = await this.repository.getSession(grant.sessionId);
    if (!session) throw new NotFoundError('Session was not found');
    const secret = await this.#edgeGrantSigningKey(true);
    return encodeEdgeGrant(
      {
        v: 1,
        kind: 'edge-playback',
        sessionId: session.id,
        grantHash,
        edgeNodeId,
        issuedAt: new Date().toISOString(),
        expiresAt: grant.expiresAt
      },
      secret
    );
  }

  async manifest(token: string, segmentBaseUrl?: string): Promise<string> {
    const { session, profile } = await this.#playback(token);
    if (session.kind !== 'vod' || !session.durationSeconds)
      throw new NotFoundError('VOD output was not found');
    if (profile.delivery.method !== 'hls')
      throw new NotFoundError('HLS output is not enabled for this session');
    const segmentDuration = profile.delivery.segmentDuration;
    const count = Math.ceil(session.durationSeconds / segmentDuration);
    const lines = [
      '#EXTM3U',
      `#EXT-X-VERSION:${profile.delivery.segmentType === 'fmp4' ? 7 : 3}`,
      `#EXT-X-TARGETDURATION:${Math.ceil(segmentDuration)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS'
    ];
    if (profile.delivery.segmentType === 'fmp4') {
      lines.push(
        `#EXT-X-MAP:URI="${segmentBaseUrl ? `${segmentBaseUrl}/init.mp4` : 'segment/init.mp4'}"`
      );
    }
    for (let index = 0; index < count; index += 1) {
      const duration = Math.min(segmentDuration, session.durationSeconds - index * segmentDuration);
      const extension = profile.delivery.segmentType === 'fmp4' ? 'm4s' : 'ts';
      lines.push(
        `#EXTINF:${duration.toFixed(3)},`,
        segmentBaseUrl ? `${segmentBaseUrl}/${index}.${extension}` : `segment/${index}.${extension}`
      );
    }
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
  }

  async segment(token: string, index: number, signal?: AbortSignal): Promise<string> {
    const { session, profile } = await this.#playback(token);
    if (session.kind !== 'vod' || !session.source || !session.durationSeconds) {
      throw new NotFoundError('VOD segment was not found');
    }
    const segmentDuration = profile.delivery.segmentDuration;
    const startSeconds = index * segmentDuration;
    if (!Number.isInteger(index) || index < 0 || startSeconds >= session.durationSeconds) {
      throw new NotFoundError('VOD segment was not found');
    }
    const activityEvent = this.#activity.has(session.id)
      ? index === Math.ceil(session.durationSeconds / segmentDuration) - 1
        ? 'stop'
        : 'progress'
      : 'start';
    await this.#reportActivity(session, startSeconds, activityEvent).catch((error) => {
      this.events.publish(
        event(
          'worker.failed',
          {
            activityReporting: true,
            message: error instanceof Error ? error.message : String(error)
          },
          session.id
        )
      );
    });
    const extension = profile.delivery.segmentType === 'fmp4' ? 'm4s' : 'ts';
    const destination = join(
      this.options.cacheDir,
      'vod',
      session.id,
      `${profile.profileId}-r${profile.revision}`,
      `${index}.${extension}`
    );
    const contentKey = this.#cache.contentKey(session, profile, index);
    try {
      await access(destination);
      const now = new Date();
      await utimes(destination, now, now);
      this.#recordCacheRequest('disk', 'hit');
      this.events.publish(event('cache.hit', { segment: index }, session.id));
      return destination;
    } catch {
      this.#recordCacheRequest('disk', 'miss');
    }
    if (await this.#cache.restoreObject(contentKey, destination)) {
      this.events.publish(
        event('cache.hit', { segment: index, layer: 'object-store' }, session.id)
      );
      return destination;
    }
    if (this.#isEdgeOnly()) {
      await this.#requestOrigin(token, index, signal);
      if (await this.#cache.restoreObject(contentKey, destination)) return destination;
      throw new Error('Origin completed the segment request but no object was published');
    }
    const roles = this.options.roles ?? ['controller', 'source-worker', 'ingest-origin', 'edge'];
    if (this.#producers && roles.includes('source-worker')) {
      await this.#producers.ensure(session, profile, index, signal);
      if (await this.#cache.restoreObject(contentKey, destination)) return destination;
      throw new Error('Persistent producer completed the segment request without publishing it');
    }
    const key = destination;
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const job = this.#jobs
      .generateDistributedSegment(session, profile, index, destination, contentKey, signal)
      .finally(() => {
        this.#inflight.delete(key);
      });
    this.#inflight.set(key, job);
    return job;
  }

  async initSegment(token: string, signal?: AbortSignal): Promise<string> {
    const { session, profile } = await this.#playback(token);
    if (profile.delivery.segmentType !== 'fmp4')
      throw new NotFoundError('fMP4 initialization segment was not found');
    const directory = join(
      this.options.cacheDir,
      'vod',
      session.id,
      `${profile.profileId}-r${profile.revision}`
    );
    const path = join(directory, 'init.mp4');
    try {
      await access(path);
      return path;
    } catch {
      /* restore or generate below */
    }
    const initKey = this.#cache.contentKey(session, profile, 0).replace(/\.m4s$/, '.init.mp4');
    if (await this.#cache.restoreObject(initKey, path)) return path;
    await this.segment(token, 0, signal);
    try {
      await access(path);
      return path;
    } catch {
      /* edge may need the uploaded init object */
    }
    if (await this.#cache.restoreObject(initKey, path)) return path;
    throw new NotFoundError('fMP4 initialization segment was not published');
  }

  async playbackSession(token: string): Promise<RelaySession> {
    return (await this.#playback(token)).session;
  }

  async streamFragmentedMp4(token: string, output: Writable, signal?: AbortSignal): Promise<void> {
    const { session, profile } = await this.#playback(token);
    if (session.kind !== 'vod' || !session.source || profile.delivery.method !== 'fragmented_mp4') {
      throw new NotFoundError('Fragmented MP4 output was not found');
    }
    const connection = await this.repository.getProvider(session.source.providerId);
    if (!connection) throw new NotFoundError('Provider connection was not found');
    const credential = await this.#providerCredential(connection, session);
    const provider = this.providers.get(connection.type);
    const source = await provider.resolveSource(
      credential.connection,
      credential.secret,
      session.source,
      signal
    );
    await this.transcoder.streamFragmentedMp4(
      this.#proxySource(source, provider),
      profile,
      output,
      signal
    );
  }

  async openSourceProxy(
    token: string,
    range?: string,
    signal?: AbortSignal
  ): Promise<SourceResponse> {
    const grant = this.#sourceGrants.get(token);
    if (!grant || grant.expiresAt <= Date.now()) {
      this.#sourceGrants.delete(token);
      throw new NotFoundError('Source grant was not found');
    }
    return grant.provider.openSource(grant.source, range, signal);
  }

  async resolveLive(token: string): Promise<LiveChannel> {
    const { session } = await this.#playback(token);
    if (session.kind !== 'live' || !session.liveChannelId)
      throw new NotFoundError('Live output was not found');
    const channel = await this.repository.getLiveChannel(session.liveChannelId);
    if (!channel) throw new NotFoundError('Live channel was not found');
    return channel;
  }

  capacity(): { active: number; limit: number; queued: number } {
    this.#recordWorkerMetrics();
    return {
      active: this.#activeWorkers,
      limit: this.options.maxWorkers,
      queued: this.#waiters.length
    };
  }

  async listJobs(limit = 100): Promise<SegmentJob[]> {
    return this.#jobs.listJobs(limit);
  }

  async listJobLogs(jobId: string, limit?: number): Promise<JobLogEntry[]> {
    return this.#jobs.listLogs(jobId, limit);
  }

  async cancelJob(id: string): Promise<void> {
    return this.#jobs.cancelJob(id);
  }

  async retryJob(id: string): Promise<SegmentJob> {
    return this.#jobs.retryJob(id);
  }

  async executeRemoteSegment(command: RemoteSegmentCommand, signal?: AbortSignal): Promise<void> {
    if (command.sourceCredential)
      this.#ephemeralSourceCredentials.set(command.sessionId, command.sourceCredential);
    try {
      const session = await this.get(command.sessionId);
      const profile = await this.repository.getProfile(session.profileId, session.profileRevision);
      if (!profile) throw new NotFoundError('Profile revision was not found');
      if (profile.delivery.method === 'hls' && this.#producers) {
        await this.#producers.ensure(session, profile, command.segmentIndex, signal);
        return;
      }
      return this.#jobs.executeRemoteSegment(command, signal);
    } finally {
      if (!this.#producers?.isActive(command.sessionId)) {
        this.#ephemeralSourceCredentials.delete(command.sessionId);
        this.#deleteSourceGrants(command.sessionId);
      }
    }
  }

  async listProducers(limit = 100): Promise<VodProducer[]> {
    return (await this.#producers?.list(limit)) ?? [];
  }

  async producer(sessionId: string): Promise<VodProducer | undefined> {
    return this.#producers?.get(sessionId);
  }

  async stopProducer(sessionId: string): Promise<void> {
    await this.#producers?.stop(sessionId);
    this.#ephemeralSourceCredentials.delete(sessionId);
    this.#deleteSourceGrants(sessionId);
  }

  async close(): Promise<void> {
    await this.#producers?.close();
    this.#ephemeralSourceCredentials.clear();
    this.#sourceGrants.clear();
  }

  async drainProducers(): Promise<void> {
    await this.#producers?.drain();
  }

  async cleanupExpiredCache(): Promise<number> {
    const now = Date.now();
    for (const [token, grant] of this.#sourceGrants) {
      if (grant.expiresAt <= now) this.#sourceGrants.delete(token);
    }
    let activeViewers = 0;
    if (this.infrastructure.coordination) {
      for (const session of await this.repository.listSessions()) {
        const { totalViewers } = await this.infrastructure.coordination.countViewers({
          sessionId: session.id,
          observedAtMs: now,
          windowMs: VIEWER_WINDOW_MS
        });
        activeViewers += totalViewers;
        if (session.viewers !== totalViewers) {
          await this.#setSessionViewers(session.id, totalViewers, true);
        }
      }
    } else {
      for (const [sessionId, viewers] of this.#viewers) {
        for (const [viewer, seenAt] of viewers)
          if (now - seenAt > VIEWER_WINDOW_MS) viewers.delete(viewer);
        activeViewers += viewers.size;
        const session = await this.repository.getSession(sessionId);
        if (session && session.viewers !== viewers.size) {
          await this.#setSessionViewers(sessionId, viewers.size, true);
        }
      }
    }
    this.infrastructure.metrics?.gauge('viewers_active', activeViewers);
    return this.#cache.cleanupExpired();
  }

  async cacheInventory(): Promise<CachedObject[]> {
    return this.#cache.inventory();
  }

  async evictCache(filter: {
    sessionId?: string;
    profileId?: string;
    all?: boolean;
  }): Promise<number> {
    return this.#cache.evict(filter);
  }

  async touchViewer(
    token: string,
    viewerIdentity: string,
    segmentIndex?: number
  ): Promise<RelaySession> {
    const { session } = await this.#playback(token);
    const viewer = createHmac('sha256', await this.#getViewerSalt())
      .update(viewerIdentity)
      .digest('hex')
      .slice(0, 20);
    if (this.infrastructure.coordination) {
      const edgeNodeId = this.options.nodeId ?? 'local';
      const aggregation = await this.infrastructure.coordination.recordViewer({
        sessionId: session.id,
        edgeNodeId,
        viewerHash: viewer,
        observedAtMs: Date.now(),
        windowMs: VIEWER_WINDOW_MS
      });
      if (segmentIndex !== undefined)
        await this.infrastructure.coordination.recordSegmentDemand({
          sessionId: session.id,
          viewerHash: viewer,
          segmentIndex,
          observedAtMs: Date.now(),
          windowMs: VIEWER_WINDOW_MS
        });
      if (session.viewers !== aggregation.totalViewers) {
        await this.#setSessionViewers(session.id, aggregation.totalViewers);
        if (aggregation.totalViewers > session.viewers)
          this.events.publish(
            event(
              'viewer.joined',
              {
                viewers: aggregation.totalViewers,
                edgeViewers: aggregation.edgeViewers,
                edgeNodeId
              },
              session.id
            )
          );
      }
      return session;
    }
    const viewers = this.#viewers.get(session.id) ?? new Map<string, number>();
    const joined = !viewers.has(viewer);
    viewers.set(viewer, Date.now());
    this.#viewers.set(session.id, viewers);
    if (joined) {
      await this.#setSessionViewers(session.id, viewers.size);
      this.events.publish(event('viewer.joined', { viewers: viewers.size }, session.id));
    }
    return session;
  }

  recordEgress(bytes: number, _sessionId?: string): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.#egressSamples.push({ bytes, observedAt: Date.now() });
    this.#pruneEgressSamples(Date.now());
    this.infrastructure.metrics?.increment('egress_bytes_total', {}, bytes);
    this.infrastructure.metrics?.gauge('egress_mbps', this.egressMbps(), { window: '30s' });
  }

  egressMbps(now = Date.now(), windowMs = 30_000): number {
    this.#pruneEgressSamples(now, windowMs);
    const bytes = this.#egressSamples.reduce((total, sample) => total + sample.bytes, 0);
    const mbps = (bytes * 8) / (windowMs / 1_000) / 1_000_000;
    if (windowMs === 30_000)
      this.infrastructure.metrics?.gauge('egress_mbps', mbps, { window: '30s' });
    return mbps;
  }

  async cacheUsageBytes(): Promise<number> {
    return this.#cache.usageBytes();
  }

  async #generateSegment(
    session: RelaySession,
    profile: ProfileRevision,
    index: number,
    destination: string,
    signal?: AbortSignal
  ): Promise<string> {
    const workerStartedAt = Date.now();
    await this.#acquire(signal);
    this.events.publish(event('worker.started', { segment: index }, session.id));
    try {
      const connection = await this.repository.getProvider(session.source!.providerId);
      if (!connection) throw new NotFoundError('Provider connection was not found');
      const credential = await this.#providerCredential(connection, session);
      const provider = this.providers.get(connection.type);
      const source = await provider.resolveSource(
        credential.connection,
        credential.secret,
        session.source!,
        signal
      );
      const segmentDuration = profile.delivery.segmentDuration;
      await mkdir(dirname(destination), { recursive: true });
      await this.transcoder.generateSegment(
        {
          source: this.#proxySource(source, provider),
          profile,
          segmentIndex: index,
          startSeconds: index * segmentDuration,
          duration: Math.min(segmentDuration, session.durationSeconds! - index * segmentDuration),
          ...(source.defaultAudio !== undefined ? { audioTrack: source.defaultAudio } : {}),
          ...(source.defaultSubtitle !== undefined ? { subtitleTrack: source.defaultSubtitle } : {})
        },
        destination,
        signal
      );
      await this.#updateSession(
        session.id,
        (current) =>
          current.state === 'stopped'
            ? undefined
            : { ...current, state: 'active', updatedAt: new Date().toISOString() },
        'Worker state update conflicted with repeated concurrent session changes',
        true
      );
      this.infrastructure.metrics?.increment('segments_generated_total', {
        delivery: profile.delivery.segmentType,
        encoder: profile.video.encoder
      });
      this.infrastructure.metrics?.observe(
        'segment_generation_seconds',
        (Date.now() - workerStartedAt) / 1_000,
        { delivery: profile.delivery.segmentType, encoder: profile.video.encoder }
      );
      this.events.publish(event('worker.completed', { segment: index }, session.id));
      return destination;
    } catch (error) {
      this.events.publish(
        event(
          'worker.failed',
          { segment: index, message: error instanceof Error ? error.message : 'Unknown error' },
          session.id
        )
      );
      throw error;
    } finally {
      this.#release();
    }
  }

  async #prepareVodProducer(
    session: RelaySession,
    profile: ProfileRevision,
    startSegmentIndex: number,
    signal: AbortSignal
  ) {
    if (!session.source || !session.durationSeconds)
      throw new NotFoundError('VOD source was not found');
    const connection = await this.repository.getProvider(session.source.providerId);
    if (!connection) throw new NotFoundError('Provider connection was not found');
    const credential = await this.#providerCredential(connection, session);
    const provider = this.providers.get(connection.type);
    const segmentDuration = profile.delivery.segmentDuration;
    const startSeconds = startSegmentIndex * segmentDuration;
    const source = provider.resolveSourceAt
      ? await provider.resolveSourceAt(
          credential.connection,
          credential.secret,
          session.source,
          startSeconds,
          signal
        )
      : await provider.resolveSource(
          credential.connection,
          credential.secret,
          session.source,
          signal
        );
    return {
      source: this.#proxySource(source, provider, session.id),
      profile,
      startSegmentIndex,
      startSeconds,
      duration: session.durationSeconds - startSeconds,
      ...(source.defaultAudio !== undefined ? { audioTrack: source.defaultAudio } : {}),
      ...(source.defaultSubtitle !== undefined ? { subtitleTrack: source.defaultSubtitle } : {})
    };
  }

  async #remoteSegmentCommand(
    jobId: string,
    session: RelaySession,
    contentKey: string,
    segmentIndex: number
  ): Promise<RemoteSegmentCommand> {
    const command: RemoteSegmentCommand = {
      jobId,
      sessionId: session.id,
      contentKey,
      segmentIndex
    };
    if (!session.ownerId) return command;
    const stored = JSON.parse(await this.secrets.get(this.#sessionSourceSecretRef(session.id))) as {
      accessToken?: unknown;
      userId?: unknown;
    };
    if (typeof stored.accessToken !== 'string' || typeof stored.userId !== 'string')
      throw new UnauthorizedError('Session source credential is invalid');
    return {
      ...command,
      sourceCredential: { accessToken: stored.accessToken, providerUserId: stored.userId }
    };
  }

  #isEdgeOnly(): boolean {
    const roles = this.options.roles ?? ['controller', 'source-worker', 'ingest-origin', 'edge'];
    return (
      roles.includes('edge') && !roles.includes('source-worker') && !roles.includes('controller')
    );
  }

  async #requestOrigin(token: string, index: number, signal?: AbortSignal): Promise<void> {
    if (this.infrastructure.ensureRequester)
      return this.infrastructure.ensureRequester.ensure(token, index, signal);
    throw new CapacityError('The edge is not connected to the controller agent channel');
  }

  async #getViewerSalt(): Promise<string> {
    const pending = (this.#viewerSalt ??= (async () => {
      const existing = await this.repository.getSetting('metrics.viewer_salt');
      if (existing) return existing;
      const created = opaqueToken(32);
      return (await this.repository.putSettingIfAbsent('metrics.viewer_salt', created)).record
        .value;
    })());
    try {
      return await pending;
    } catch (error) {
      if (this.#viewerSalt === pending) this.#viewerSalt = undefined;
      throw error;
    }
  }

  async #edgeGrantSigningKey(create: boolean): Promise<string> {
    const existing = await this.repository.getSetting(EDGE_GRANT_SIGNING_KEY);
    if (existing) return existing;
    if (!create) throw new UnauthorizedError('Edge playback link is invalid');
    return (await this.repository.putSettingIfAbsent(EDGE_GRANT_SIGNING_KEY, opaqueToken(32)))
      .record.value;
  }

  async #validPlaybackGrant(tokenHash: string): Promise<PlaybackGrant> {
    const grant = await this.repository.getPlaybackGrant(tokenHash);
    if (
      !grant ||
      grant.revokedAt ||
      (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
    ) {
      throw new UnauthorizedError('Playback link is invalid or expired');
    }
    return grant;
  }

  async #resolvePlaybackGrant(token: string): Promise<PlaybackGrant> {
    const edgeGrant = parseEdgeGrant(token);
    if (!edgeGrant) return this.#validPlaybackGrant(hashToken(token));
    const secret = await this.#edgeGrantSigningKey(false);
    if (!safeEqual(edgeGrant.signature, hmacBase64Url(secret, edgeGrant.body)))
      throw new UnauthorizedError('Edge playback link is invalid');
    let payload: EdgePlaybackGrantPayload;
    try {
      payload = decodeEdgeGrantBody(edgeGrant.body);
    } catch {
      throw new UnauthorizedError('Edge playback link is invalid');
    }
    if (this.#isEdgeOnly() && payload.edgeNodeId !== this.options.nodeId)
      throw new UnauthorizedError('Edge playback link is not valid for this node');
    if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now())
      throw new UnauthorizedError('Playback link is invalid or expired');
    const grant = await this.#validPlaybackGrant(payload.grantHash);
    if (grant.sessionId !== payload.sessionId)
      throw new UnauthorizedError('Edge playback link does not match its session');
    return grant;
  }

  async #playback(token: string): Promise<{ session: RelaySession; profile: ProfileRevision }> {
    const grant = await this.#resolvePlaybackGrant(token);
    const session = await this.repository.getSession(grant.sessionId);
    if (!session) throw new NotFoundError('Session was not found');
    if (session.state === 'stopped') throw new ConflictError('Session is stopped');
    const profile = await this.repository.getProfile(session.profileId, session.profileRevision);
    if (!profile) throw new NotFoundError('Profile revision was not found');
    return { session, profile };
  }

  async #reportActivity(
    session: RelaySession,
    positionSeconds: number,
    activityEvent: 'start' | 'progress' | 'stop'
  ): Promise<void> {
    if (!session.reportActivity || session.kind !== 'vod' || !session.source) return;
    const last = this.#activity.get(session.id) ?? 0;
    if (activityEvent === 'progress' && Date.now() - last < 10_000) return;
    const connection = await this.repository.getProvider(session.source.providerId);
    if (!connection || !connection.capabilities.includes('activity_reporting')) return;
    const remoteNode = session.ownerId ? undefined : await this.#remoteProviderNode(connection.id);
    if (remoteNode) {
      await this.infrastructure.providerGateway!.call(remoteNode, 'provider.activity', {
        providerId: connection.id,
        sessionId: session.id,
        itemId: session.source.itemId,
        positionTicks: Math.round(positionSeconds * 10_000_000),
        paused: activityEvent === 'stop',
        event: activityEvent
      });
      if (activityEvent === 'stop') this.#activity.delete(session.id);
      else this.#activity.set(session.id, Date.now());
      return;
    }
    const credential = await this.#providerCredential(connection, session);
    await this.providers
      .get(connection.type)
      .reportPlayback(credential.connection, credential.secret, {
        sessionId: session.id,
        itemId: session.source.itemId,
        positionTicks: Math.round(positionSeconds * 10_000_000),
        paused: activityEvent === 'stop',
        event: activityEvent
      });
    if (activityEvent === 'stop') this.#activity.delete(session.id);
    else this.#activity.set(session.id, Date.now());
  }

  #sessionSourceSecretRef(sessionId: string): string {
    return `session-source:${sessionId}`;
  }

  async #providerCredential(
    connection: ProviderConnection,
    session: RelaySession
  ): Promise<{ connection: ProviderConnection; secret: string }> {
    if (!session.ownerId) return { connection, secret: await this.#providerSecret(connection) };
    const ephemeral = this.#ephemeralSourceCredentials.get(session.id);
    if (ephemeral)
      return {
        connection: { ...connection, userId: ephemeral.providerUserId },
        secret: ephemeral.accessToken
      };
    const stored = JSON.parse(await this.secrets.get(this.#sessionSourceSecretRef(session.id))) as {
      accessToken?: unknown;
      userId?: unknown;
    };
    if (typeof stored.accessToken !== 'string' || typeof stored.userId !== 'string')
      throw new UnauthorizedError('Session source credential is invalid');
    return {
      connection: { ...connection, userId: stored.userId },
      secret: stored.accessToken
    };
  }

  async #providerSecret(connection: ProviderConnection): Promise<string> {
    const bindings = await this.infrastructure.clusterRepository?.listProviderBindings(
      connection.id
    );
    for (const binding of (bindings ?? []).filter(
      (candidate) => candidate.state === 'healthy' && !candidate.deletionPending
    )) {
      try {
        return await this.secrets.get(binding.secretRef);
      } catch {
        // Only the explicitly bound node can resolve this reference.
      }
    }
    return this.secrets.get(connection.secretRef);
  }

  async #remoteProviderNode(providerId: string): Promise<string | undefined> {
    if (!this.infrastructure.providerGateway) return undefined;
    const bindings =
      (await this.infrastructure.clusterRepository?.listProviderBindings(providerId)) ?? [];
    return bindings.find(
      (binding) =>
        binding.state === 'healthy' &&
        !binding.deletionPending &&
        binding.nodeId !== this.options.nodeId &&
        this.infrastructure.providerGateway!.connected(binding.nodeId)
    )?.nodeId;
  }

  #proxySource(
    source: ResolvedSource,
    provider: MediaProvider,
    sessionId?: string
  ): ResolvedSource {
    const token = opaqueToken();
    this.#sourceGrants.set(token, {
      source,
      provider,
      expiresAt: Date.now() + 15 * 60_000,
      ...(sessionId ? { sessionId } : {})
    });
    return { ...source, url: `${this.options.internalUrl}/internal/source/${token}`, headers: {} };
  }

  #deleteSourceGrants(sessionId: string): void {
    for (const [token, grant] of this.#sourceGrants)
      if (grant.sessionId === sessionId) this.#sourceGrants.delete(token);
  }

  async #acquire(signal?: AbortSignal): Promise<void> {
    if (this.#activeWorkers < this.options.maxWorkers) {
      this.#activeWorkers += 1;
      this.#recordWorkerMetrics();
      return;
    }
    if (this.#waiters.length >= this.options.maxWorkers * 8) {
      this.infrastructure.metrics?.increment('worker_queue_rejections_total', {
        kind: 'transcode'
      });
      throw new CapacityError('Transcode queue is full');
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiters.indexOf(resolve);
        if (index >= 0) this.#waiters.splice(index, 1);
        this.#recordWorkerMetrics();
        reject(signal?.reason ?? new Error('Request was aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      this.#recordWorkerMetrics();
    });
    this.#activeWorkers += 1;
    this.#recordWorkerMetrics();
  }

  #release(): void {
    this.#activeWorkers = Math.max(0, this.#activeWorkers - 1);
    const waiter = this.#waiters.shift();
    this.#recordWorkerMetrics();
    waiter?.();
  }

  #pruneEgressSamples(now: number, windowMs = 30_000): void {
    const cutoff = now - windowMs;
    while (this.#egressSamples[0] && this.#egressSamples[0].observedAt <= cutoff)
      this.#egressSamples.shift();
  }

  #recordCacheRequest(layer: 'disk', outcome: 'hit' | 'miss'): void {
    this.infrastructure.metrics?.increment('cache_requests_total', { layer, outcome });
  }

  #recordWorkerMetrics(): void {
    const active = this.#activeWorkers;
    const limit = Math.max(1, this.options.maxWorkers);
    this.infrastructure.metrics?.gauge('workers_active', active, { kind: 'transcode' });
    this.infrastructure.metrics?.gauge('worker_queue_depth', this.#waiters.length, {
      kind: 'transcode'
    });
    this.infrastructure.metrics?.gauge('worker_pressure_ratio', active / limit, {
      kind: 'transcode'
    });
  }

  async #updateSession(
    sessionId: string,
    update: (session: RelaySession) => RelaySession | undefined,
    conflictMessage: string,
    allowMissing = false
  ): Promise<{ session?: RelaySession; applied: boolean }> {
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.repository.getVersionedSession(sessionId);
      if (!current) {
        if (allowMissing) return { applied: false };
        throw new NotFoundError('Session was not found');
      }
      const updated = update(current.value);
      if (!updated) return { session: current.value, applied: false };
      const result = await this.repository.compareAndSetSession(updated, current.revision);
      if (result.applied) return { session: result.record.value, applied: true };
      if (result.reason === 'not-found') {
        if (allowMissing) return { applied: false };
        throw new NotFoundError('Session was not found');
      }
      if (result.reason === 'invalid-state')
        throw new ConflictError('Session state transition is no longer valid');
    }
    throw new ConflictError(conflictMessage);
  }

  async #setSessionViewers(
    sessionId: string,
    viewers: number,
    allowMissing = false
  ): Promise<RelaySession | undefined> {
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.repository.getVersionedSession(sessionId);
      if (!current) {
        if (allowMissing) return undefined;
        throw new NotFoundError('Session was not found');
      }
      const result = await this.repository.setSessionViewers(
        sessionId,
        current.revision,
        viewers,
        new Date().toISOString()
      );
      if (result.applied) return result.record.value;
      if (result.reason === 'not-found') {
        if (allowMissing) return undefined;
        throw new NotFoundError('Session was not found');
      }
      if (result.reason === 'invalid-state')
        throw new ConflictError('Session viewer update is no longer valid');
    }
    throw new ConflictError('Session viewer update conflicted with repeated concurrent changes');
  }
}
