// SPDX-License-Identifier: GPL-3.0-or-later
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { access, mkdir, rm, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CachedObject,
  JobLogEntry,
  LiveChannel,
  MediaItem,
  NodeRole,
  PlaybackGrant,
  Profile,
  ProviderConnection,
  RelaySession,
  SegmentJob,
  SessionRuntimeStats,
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
import { pacedReadable, type VodProducerSourcePacing } from './vod-source-pacing.js';
import { SessionJobCoordinator } from './session-jobs.js';
import { estimateVodProducerBufferMs, VodProducerCoordinator } from './vod-producer-coordinator.js';

const MAX_ATOMIC_WRITE_ATTEMPTS = 5;
const VIEWER_WINDOW_MS = 30_000;
const RUNTIME_TRAFFIC_WINDOW_MS = 30_000;
const RUNTIME_SNAPSHOT_TTL_MS = 90_000;
const RUNTIME_ACTIVE_SNAPSHOT_MS = 10_000;
const EDGE_GRANT_PREFIX = 'eg1';
const EDGE_GRANT_SIGNING_KEY = 'playback.edge_grant_signing_key';
const SESSION_SOURCE_CREDENTIAL_PENDING_PREFIX = 'session.sourceCredential.pending.';

interface EdgePlaybackGrantPayload {
  v: 1;
  kind: 'edge-playback';
  sessionId: string;
  grantHash: string;
  edgeNodeId: string;
  issuedAt: string;
  expiresAt: string | null;
}

interface RuntimeSample {
  value: number;
  observedAtMs: number;
}

interface LocalSessionRuntime {
  ingress: RuntimeSample[];
  egress: RuntimeSample[];
  production: Array<RuntimeSample & { wallSeconds: number }>;
  sourceRequests: RuntimeSample[];
  sourceConnectionCount: number;
  cacheHits: number;
  cacheMisses: number;
  lastSegmentPublishedAtMs?: number;
  lastSnapshotAtMs: number;
}

interface SessionRuntimeSnapshot {
  v: 1;
  sessionId: string;
  nodeId: string;
  observedAtMs: number;
  sourceIngressMbps: number;
  viewerEgressMbps: number;
  sourceConnectionCount: number;
  sourceRequestsLast30s: number;
  cacheHits: number;
  cacheMisses: number;
  transcodeRealtimeFactor?: number;
}

interface ActiveSourceRequest {
  id: string;
  range?: string;
  producerGeneration?: number;
  startedAtMs: number;
}

function hmacBase64Url(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function combineAbortSignals(
  requestSignal: AbortSignal | undefined,
  producerSignal: AbortSignal | undefined
): AbortSignal | undefined {
  if (requestSignal && producerSignal) return AbortSignal.any([requestSignal, producerSignal]);
  return requestSignal ?? producerSignal;
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

const LANGUAGE_ALIASES: Record<string, string> = {
  ar: 'ara',
  cs: 'ces',
  da: 'dan',
  de: 'deu',
  el: 'ell',
  en: 'eng',
  es: 'spa',
  fi: 'fin',
  fr: 'fra',
  he: 'heb',
  hu: 'hun',
  it: 'ita',
  ja: 'jpn',
  ko: 'kor',
  nl: 'nld',
  no: 'nor',
  pl: 'pol',
  pt: 'por',
  ro: 'ron',
  ru: 'rus',
  sv: 'swe',
  th: 'tha',
  tr: 'tur',
  uk: 'ukr',
  vi: 'vie',
  zh: 'zho'
};

function normalizeLanguage(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-');
}

function audioLanguageMatches(
  trackLanguage: string | undefined,
  preferredLanguage: string
): boolean {
  if (!trackLanguage) return false;
  const preferred = normalizeLanguage(preferredLanguage);
  const actual = normalizeLanguage(trackLanguage);
  const preferredBase = preferred.split('-', 1)[0] ?? preferred;
  const actualBase = actual.split('-', 1)[0] ?? actual;
  return (
    preferred === actual ||
    preferredBase === actualBase ||
    LANGUAGE_ALIASES[preferredBase] === actualBase ||
    LANGUAGE_ALIASES[actualBase] === preferredBase
  );
}

function selectDefaultAudioTrack(item: MediaItem, preferredLanguage = 'eng'): string | undefined {
  const tracks = item.audioTracks ?? [];
  return (
    tracks.find((track) => audioLanguageMatches(track.language, preferredLanguage))?.id ??
    tracks.find((track) => track.isDefault)?.id ??
    tracks[0]?.id
  );
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
  vodProducerBufferLowWatermarkMs?: number;
  vodProducerBufferHighWatermarkMs?: number;
  vodProducerMaxCatchupRate?: number;
  vodProducerMaxConcurrent?: number;
  vodProducerMaxPerProvider?: number;
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
    {
      source: ResolvedSource;
      provider: MediaProvider;
      expiresAt: number;
      sessionId?: string;
      pacing?: VodProducerSourcePacing;
      producerSignal?: AbortSignal;
      producerGeneration?: number;
    }
  >();
  readonly #waiters: Array<() => void> = [];
  readonly #viewers = new Map<string, Map<string, number>>();
  readonly #activity = new Map<string, number>();
  readonly #egressSamples: Array<{ bytes: number; observedAt: number }> = [];
  readonly #sessionRuntime = new Map<string, LocalSessionRuntime>();
  readonly #activeSourceRequests = new Map<string, Map<string, ActiveSourceRequest>>();
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
    if (infrastructure.clusterRepository && infrastructure.coordination && transcoder.produceVod)
      this.#producers = new VodProducerCoordinator(
        infrastructure.clusterRepository,
        infrastructure.coordination,
        infrastructure.objectStore,
        transcoder,
        this.#cache,
        {
          getSession: (id) => this.repository.getSession(id),
          acquire: (signal) => this.#acquire(signal),
          prepare: (session, profile, startSegmentIndex, signal, pacing, generation) =>
            this.#prepareVodProducer(
              session,
              profile,
              startSegmentIndex,
              signal,
              pacing,
              generation
            ),
          released: (sessionId) => {
            this.#release();
            this.#ephemeralSourceCredentials.delete(sessionId);
            this.#deleteSourceGrants(sessionId);
          },
          published: (sessionId, _segmentIndex, mediaDurationSeconds, observedAtMs) =>
            this.#recordProduction(sessionId, mediaDurationSeconds, observedAtMs)
        },
        {
          cacheDir: options.cacheDir,
          nodeId: options.nodeId ?? 'standalone',
          idleTimeoutMs: options.vodProducerIdleTimeoutMs ?? 60_000,
          bufferLowWatermarkMs: options.vodProducerBufferLowWatermarkMs ?? 30_000,
          bufferHighWatermarkMs: options.vodProducerBufferHighWatermarkMs ?? 60_000,
          maxCatchupRate: options.vodProducerMaxCatchupRate ?? 2,
          maxConcurrentProducers: Math.min(
            options.vodProducerMaxConcurrent ?? options.maxWorkers,
            options.maxWorkers
          ),
          maxConcurrentProducersPerProvider: Math.min(
            options.vodProducerMaxPerProvider ?? options.maxWorkers,
            options.maxWorkers
          )
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
    const profile = await this.repository.getProfile(input.profileId);
    if (!profile) throw new NotFoundError('Profile was not found');
    const id = randomUUID();
    const token = opaqueToken();
    const now = new Date().toISOString();
    let durationSeconds: number | undefined;
    let liveChannelRevision: number | undefined;
    let name = input.name;
    let resolvedSource = input.kind === 'vod' ? input.source : undefined;
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
      if (!input.source.audioTrackId) {
        const audioTrackId = selectDefaultAudioTrack(item, profile.audio.defaultLanguage ?? 'eng');
        if (audioTrackId) resolvedSource = { ...input.source, audioTrackId };
      }
    } else {
      if (profile.delivery.method !== 'hls' || profile.delivery.playlistType !== 'live')
        throw new ConflictError('Live sessions require a live HLS profile');
      liveChannelRevision = await this.#claimLiveNormalizationProfile(input.liveChannelId, profile);
    }
    const path = input.kind === 'live' ? 'live.m3u8' : 'index.m3u8';
    const session: RelaySession = {
      id,
      name: name ?? 'Untitled relay',
      kind: input.kind,
      ...(input.kind === 'vod'
        ? { source: resolvedSource!, durationSeconds }
        : { liveChannelId: input.liveChannelId }),
      profileId: profile.profileId,
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
      lastPlaybackActivityAt: now,
      deletionPending: false,
      createdAt: now,
      updatedAt: now
    };
    const expiresAt = input.playbackTtlSeconds
      ? new Date(Date.now() + input.playbackTtlSeconds * 1_000).toISOString()
      : null;
    const pendingSourceCredential =
      context && input.kind === 'vod'
        ? {
            settingKey: this.#sessionSourceCredentialPendingKey(id),
            secretRef: this.#sessionSourceSecretRef(id),
            credential: JSON.stringify({
              accessToken: context.providerAccessToken!,
              userId: context.providerUserId!
            })
          }
        : undefined;
    if (pendingSourceCredential) {
      // Persist only the deterministic secret reference before writing the
      // credential. A crash or failed cleanup can then be reconciled without
      // placing provider credentials in the repository.
      await this.repository.putSetting(
        pendingSourceCredential.settingKey,
        pendingSourceCredential.secretRef
      );
      try {
        await this.secrets.put(
          pendingSourceCredential.secretRef,
          pendingSourceCredential.credential
        );
      } catch (error) {
        await this.#reconcilePendingSessionSourceCredential(id).catch(() => undefined);
        throw error;
      }
    }
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
      // The commit acknowledgement can be ambiguous. Re-read durable state:
      // retain a credential for a committed session, delete a proven orphan,
      // and leave the pending index untouched if the read itself fails.
      if (pendingSourceCredential)
        await this.#reconcilePendingSessionSourceCredential(id).catch(() => undefined);
      throw error;
    }
    if (!created.applied) {
      if (pendingSourceCredential)
        await this.#reconcilePendingSessionSourceCredential(id).catch(() => undefined);
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
    if (pendingSourceCredential)
      await this.repository
        .deleteSetting(pendingSourceCredential.settingKey)
        .catch(() => undefined);
    this.events.publish(event('session.created', { name: session.name, kind: session.kind }, id));
    return session;
  }

  async #claimLiveNormalizationProfile(channelId: string, profile: Profile): Promise<number> {
    let stored = await this.repository.getVersionedLiveChannel(channelId);
    if (!stored) throw new NotFoundError('Live channel was not found');
    if (!stored.value.normalize) return stored.revision;
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const channel = stored.value;
      const claimedId = channel.normalizationProfileId;
      if (claimedId) {
        if (claimedId !== profile.profileId)
          throw new ConflictError(
            'Live channel already has a different normalization profile; create a separate channel for that profile'
          );
        return stored.revision;
      }
      const result = await this.repository.compareAndSetLiveChannel(
        {
          ...channel,
          normalizationProfileId: profile.profileId
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

  async listRuntimeStats(sessions?: RelaySession[]): Promise<SessionRuntimeStats[]> {
    const listed = sessions ?? (await this.list());
    return Promise.all(listed.map((session) => this.runtimeStats(session)));
  }

  async runtimeStats(session: RelaySession): Promise<SessionRuntimeStats> {
    const now = Date.now();
    const producer = await this.#producers?.get(session.id);
    const profile = await this.repository.getProfile(session.profileId);
    let viewerCount = session.viewers;
    if (this.infrastructure.coordination)
      viewerCount = await this.infrastructure.coordination
        .countViewers({
          sessionId: session.id,
          observedAtMs: now,
          windowMs: VIEWER_WINDOW_MS
        })
        .then((viewers) => viewers.totalViewers)
        .catch(() => session.viewers);
    const snapshots = await this.#runtimeSnapshots(session.id);
    const activeSnapshots = snapshots.filter(
      (snapshot) => now - snapshot.observedAtMs <= RUNTIME_ACTIVE_SNAPSHOT_MS
    );
    const sourceIngressMbps = activeSnapshots.reduce(
      (total, snapshot) => total + snapshot.sourceIngressMbps,
      0
    );
    const viewerEgressMbps = activeSnapshots.reduce(
      (total, snapshot) => total + snapshot.viewerEgressMbps,
      0
    );
    const sourceConnectionCount = activeSnapshots.reduce(
      (total, snapshot) => total + (snapshot.sourceConnectionCount ?? 0),
      0
    );
    const sourceRequestsLast30s = activeSnapshots.reduce(
      (total, snapshot) => total + (snapshot.sourceRequestsLast30s ?? 0),
      0
    );
    const cacheHits = snapshots.reduce((total, snapshot) => total + snapshot.cacheHits, 0);
    const cacheMisses = snapshots.reduce((total, snapshot) => total + snapshot.cacheMisses, 0);
    const transcodeRealtimeFactor = activeSnapshots
      .map((snapshot) => snapshot.transcodeRealtimeFactor)
      .find((factor): factor is number => factor !== undefined);
    const segmentDuration = profile?.delivery.segmentDuration ?? 0;
    const currentAttempt = producer?.workerHistory.at(-1);
    const playbackAnchorSegmentIndex =
      producer?.playbackAnchorSegmentIndex ?? producer?.startSegmentIndex ?? 0;
    const playbackAnchorAtMs = producer?.playbackAnchorAt
      ? Date.parse(producer.playbackAnchorAt)
      : currentAttempt
        ? Date.parse(currentAttempt.startedAt)
        : Number.NaN;
    const bufferSeconds = producer
      ? estimateVodProducerBufferMs({
          playbackAnchorSegmentIndex,
          lastPublishedSegmentIndex: producer.lastPublishedSegmentIndex,
          segmentDurationSeconds: segmentDuration,
          playbackAnchorAtMs,
          observedAtMs: now
        }) / 1_000
      : 0;
    const producerActive =
      producer && ['starting', 'running', 'switching'].includes(producer.state);
    const activity: SessionRuntimeStats['activity'] =
      session.state === 'stopped'
        ? 'stopped'
        : session.state === 'error' || producer?.state === 'failed'
          ? 'error'
          : viewerCount > 0 || producerActive
            ? 'streaming'
            : 'ready';
    const cacheRequests = cacheHits + cacheMisses;
    return {
      sessionId: session.id,
      activity,
      viewers: viewerCount,
      viewerWindowSeconds: VIEWER_WINDOW_MS / 1_000,
      ...(producer
        ? {
            producerState: producer.state,
            ...(producer.ownerNodeId ? { sourceWorkerId: producer.ownerNodeId } : {}),
            generation: producer.generation,
            demandedSegmentIndex: producer.demandedSegmentIndex,
            ...(producer.lastPublishedSegmentIndex === undefined
              ? {}
              : { lastPublishedSegmentIndex: producer.lastPublishedSegmentIndex }),
            ...(producer.bufferState ? { bufferState: producer.bufferState } : {}),
            demandAgeMs: Math.max(0, now - Date.parse(producer.lastDemandAt))
          }
        : {}),
      bufferSeconds,
      ...(transcodeRealtimeFactor === undefined ? {} : { transcodeRealtimeFactor }),
      sourceConnectionCount,
      sourceRequestsLast30s,
      sourceIngressMbps,
      viewerEgressMbps,
      cacheHits,
      cacheMisses,
      cacheHitRatio: cacheRequests ? cacheHits / cacheRequests : null,
      ...(session.lastPlaybackActivityAt
        ? { lastPlaybackActivityAt: session.lastPlaybackActivityAt }
        : {}),
      observedAt: new Date(now).toISOString()
    };
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
        if (session.deletionPending)
          throw new ConflictError('Session deletion is already in progress');
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
    if (input.state === 'stopped') {
      // Stop must fence the durable HLS producer immediately.  Keeping the
      // session credential permits an explicit VOD resume to create one fresh
      // generation, but a stopped session must not continue sourcing media.
      await this.#stopSessionProducer(updated);
      this.#ephemeralSourceCredentials.delete(id);
      this.#deleteSourceGrants(id);
      if (this.#activity.has(id))
        await this.#reportActivity(updated, 0, 'stop').catch(() => undefined);
    }
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
    if ((this.options.roles ?? ['controller']).includes('controller'))
      recovered += await this.#recoverPendingSessionSourceCredentials();
    for (const session of await this.repository.listSessionDeletionPending()) {
      await this.#finalizeSessionDeletion(session);
      recovered += 1;
    }
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
    if (session.deletionPending) {
      await this.#finalizeSessionDeletion(session);
      return;
    }
    const begun = await this.repository.beginSessionDeletion(id, {
      observedAt: new Date().toISOString()
    });
    if (!begun.applied) {
      if (begun.reason === 'not-found') throw new NotFoundError('Session was not found');
      throw new ConflictError('Session deletion conflicted with another update; try again');
    }
    await this.#finalizeSessionDeletion(begun.record.value);
  }

  async deleteIfInactive(id: string, inactiveBefore: string): Promise<boolean> {
    const begun = await this.repository.beginSessionDeletion(id, {
      observedAt: new Date().toISOString(),
      inactiveBefore,
      requireUnpinned: true
    });
    if (!begun.applied) {
      if (begun.reason === 'not-found' || begun.reason === 'invalid-state') return false;
      throw new ConflictError('Session expiry conflicted with another update');
    }
    await this.#finalizeSessionDeletion(begun.record.value);
    return true;
  }

  async recordPlaybackActivity(
    sessionId: string,
    observedAt = new Date().toISOString()
  ): Promise<void> {
    const observedAtMs = Date.parse(observedAt);
    if (!Number.isFinite(observedAtMs)) throw new Error('Playback activity time is invalid');
    await this.repository.touchSessionPlaybackActivity(
      sessionId,
      observedAt,
      new Date(observedAtMs - 60_000).toISOString()
    );
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
      profile.profileId,
      `${index}.${extension}`
    );
    const contentKey = this.#cache.contentKey(session, profile, index);
    try {
      await access(destination);
      const now = new Date();
      await utimes(destination, now, now);
      this.#recordCacheRequest('disk', 'hit');
      this.#recordSessionCache(session.id, true);
      this.events.publish(event('cache.hit', { segment: index }, session.id));
      return destination;
    } catch {
      this.#recordCacheRequest('disk', 'miss');
    }
    if (await this.#cache.restoreObject(contentKey, destination)) {
      this.#recordSessionCache(session.id, true);
      this.events.publish(
        event('cache.hit', { segment: index, layer: 'object-store' }, session.id)
      );
      return destination;
    }
    if (this.#isEdgeOnly()) {
      this.#recordSessionCache(session.id, false);
      await this.#requestOrigin(token, index, signal);
      if (await this.#cache.restoreObject(contentKey, destination)) return destination;
      throw new Error('Origin completed the segment request but no object was published');
    }
    const roles = this.options.roles ?? ['controller', 'source-worker', 'ingest-origin', 'edge'];
    if (this.#producers && roles.includes('source-worker')) {
      this.#recordSessionCache(session.id, false);
      await this.#producers.ensure(session, profile, index, signal);
      if (await this.#cache.restoreObject(contentKey, destination)) return destination;
      throw new Error('Persistent producer completed the segment request without publishing it');
    }
    const key = destination;
    this.#recordSessionCache(session.id, false);
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
    const directory = join(this.options.cacheDir, 'vod', session.id, profile.profileId);
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
    const effectiveSignal = combineAbortSignals(signal, grant.producerSignal);
    const source = grant.sessionId
      ? await this.#openTrackedSource(
          grant.sessionId,
          grant.provider,
          grant.source,
          range,
          effectiveSignal,
          grant.producerGeneration
        )
      : await grant.provider.openSource(grant.source, range, effectiveSignal);
    return {
      ...source,
      ...(grant.pacing
        ? { stream: pacedReadable(source.stream, grant.pacing, effectiveSignal) }
        : {}),
      ...(grant.sessionId ? { sessionId: grant.sessionId } : {})
    };
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
      const profile = await this.repository.getProfile(session.profileId);
      if (!profile) throw new NotFoundError('Profile was not found');
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
    segmentIndex?: number,
    playbackDiscontinuity = false
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
          windowMs: VIEWER_WINDOW_MS,
          ...(playbackDiscontinuity ? { playbackDiscontinuity: true } : {})
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

  recordIngress(bytes: number, sessionId?: string): void {
    if (!Number.isFinite(bytes) || bytes <= 0 || !sessionId) return;
    this.#recordRuntimeTraffic(sessionId, 'ingress', bytes);
  }

  recordEgress(bytes: number, sessionId?: string): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.#egressSamples.push({ bytes, observedAt: Date.now() });
    this.#pruneEgressSamples(Date.now());
    this.infrastructure.metrics?.increment('egress_bytes_total', {}, bytes);
    this.infrastructure.metrics?.gauge('egress_mbps', this.egressMbps(), { window: '30s' });
    if (sessionId) this.#recordRuntimeTraffic(sessionId, 'egress', bytes);
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

  async #finalizeSessionDeletion(session: RelaySession): Promise<void> {
    await this.#stopSessionProducer(session);
    if (this.#activity.has(session.id))
      await this.#reportActivity(session, 0, 'stop').catch(() => undefined);
    this.#ephemeralSourceCredentials.delete(session.id);
    this.#deleteSourceGrants(session.id);
    // The durable deletion fence and grant revocation happen before producer
    // cleanup, while the source credential remains available until every
    // producer has been asked to stop.
    if (session.ownerId) await this.#deleteSessionSourceCredential(session.id);
    await this.repository.deleteSessionAndRevokePlaybackGrants(session.id);
    await rm(join(this.options.cacheDir, 'vod', session.id), { recursive: true, force: true });
    this.#activity.delete(session.id);
    this.#sessionRuntime.delete(session.id);
    this.#activeSourceRequests.delete(session.id);
    this.#viewers.delete(session.id);
    this.events.publish(event('session.deleted', { name: session.name }, session.id));
  }

  async #stopSessionProducer(session: RelaySession): Promise<void> {
    // Read durable ownership before stopping or deleting credentials. A
    // failed-over producer is not necessarily on the assigned worker.
    const producer =
      (await this.#producers?.get(session.id)) ??
      (await this.infrastructure.clusterRepository?.getVodProducer(session.id));
    await this.#producers?.stop(session.id);
    const ownerNodeId = producer?.ownerNodeId ?? session.assignedNodeId;
    if (ownerNodeId && ownerNodeId !== this.options.nodeId)
      await this.infrastructure.dispatcher
        ?.stopProducer?.(ownerNodeId, session.id)
        .catch(() => undefined);
  }

  async #generateSegment(
    session: RelaySession,
    profile: Profile,
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
          source: this.#proxySource(source, provider, session.id),
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
        codec: profile.video.codec
      });
      this.infrastructure.metrics?.observe(
        'segment_generation_seconds',
        (Date.now() - workerStartedAt) / 1_000,
        { delivery: profile.delivery.segmentType, codec: profile.video.codec }
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
    profile: Profile,
    startSegmentIndex: number,
    signal: AbortSignal,
    pacing: VodProducerSourcePacing,
    producerGeneration: number
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
      source: this.#proxySource(source, provider, session.id, pacing, signal, producerGeneration),
      profile,
      startSegmentIndex,
      startSeconds,
      duration: session.durationSeconds - startSeconds,
      initialReadBurstSeconds: (this.options.vodProducerBufferHighWatermarkMs ?? 60_000) / 1_000,
      readRate: this.options.vodProducerMaxCatchupRate ?? 2,
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

  async viewerIdentity(ip: string, userAgent: string | undefined): Promise<string> {
    return createHmac('sha256', await this.#getViewerSalt())
      .update(ip)
      .update('\0')
      .update((userAgent ?? 'unknown').slice(0, 256))
      .digest('hex');
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
    if (!edgeGrant) {
      if (this.#isEdgeOnly())
        throw new UnauthorizedError('An edge-scoped playback link is required');
      return this.#validPlaybackGrant(hashToken(token));
    }
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

  async #playback(token: string): Promise<{ session: RelaySession; profile: Profile }> {
    const grant = await this.#resolvePlaybackGrant(token);
    const session = await this.repository.getSession(grant.sessionId);
    if (!session) throw new NotFoundError('Session was not found');
    if (session.state === 'stopped') throw new ConflictError('Session is stopped');
    const profile = await this.repository.getProfile(session.profileId);
    if (!profile) throw new NotFoundError('Profile was not found');
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

  #sessionSourceCredentialPendingKey(sessionId: string): string {
    return `${SESSION_SOURCE_CREDENTIAL_PENDING_PREFIX}${sessionId}`;
  }

  async #reconcilePendingSessionSourceCredential(sessionId: string): Promise<void> {
    const session = await this.repository.getSession(sessionId);
    const retainsCredential = session?.kind === 'vod' && Boolean(session.ownerId);
    if (!retainsCredential) await this.secrets.delete(this.#sessionSourceSecretRef(sessionId));
    await this.repository.deleteSetting(this.#sessionSourceCredentialPendingKey(sessionId));
  }

  async #recoverPendingSessionSourceCredentials(): Promise<number> {
    const records = await this.repository.listSettingsByPrefix(
      SESSION_SOURCE_CREDENTIAL_PENDING_PREFIX
    );
    for (const { key, value } of records) {
      const sessionId = key.slice(SESSION_SOURCE_CREDENTIAL_PENDING_PREFIX.length);
      if (!sessionId || value !== this.#sessionSourceSecretRef(sessionId))
        throw new Error(`Invalid pending session source credential metadata: ${key}`);
      await this.#reconcilePendingSessionSourceCredential(sessionId);
    }
    return records.length;
  }

  async #deleteSessionSourceCredential(sessionId: string): Promise<void> {
    await this.secrets.delete(this.#sessionSourceSecretRef(sessionId));
    await this.repository.deleteSetting(this.#sessionSourceCredentialPendingKey(sessionId));
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
    sessionId?: string,
    pacing?: VodProducerSourcePacing,
    producerSignal?: AbortSignal,
    producerGeneration?: number
  ): ResolvedSource {
    const token = opaqueToken();
    this.#sourceGrants.set(token, {
      source,
      provider,
      // A persistent producer may legitimately outlive an ordinary source
      // grant. Its opaque loopback grant is instead bounded by the producer
      // signal and removed on release/lease loss.
      expiresAt: producerSignal ? Number.MAX_SAFE_INTEGER : Date.now() + 15 * 60_000,
      ...(sessionId ? { sessionId } : {}),
      ...(pacing ? { pacing } : {}),
      ...(producerSignal ? { producerSignal } : {}),
      ...(producerGeneration !== undefined ? { producerGeneration } : {})
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

  #localRuntime(sessionId: string): LocalSessionRuntime {
    const existing = this.#sessionRuntime.get(sessionId);
    if (existing) return existing;
    const created: LocalSessionRuntime = {
      ingress: [],
      egress: [],
      production: [],
      sourceRequests: [],
      sourceConnectionCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      lastSnapshotAtMs: 0
    };
    this.#sessionRuntime.set(sessionId, created);
    return created;
  }

  #recordRuntimeTraffic(sessionId: string, direction: 'ingress' | 'egress', bytes: number): void {
    const now = Date.now();
    const runtime = this.#localRuntime(sessionId);
    runtime[direction].push({ value: bytes, observedAtMs: now });
    this.#pruneRuntime(runtime, now);
    this.#publishRuntimeSnapshot(sessionId, runtime, now);
  }

  #recordSourceRequest(sessionId: string): void {
    const now = Date.now();
    const runtime = this.#localRuntime(sessionId);
    runtime.sourceRequests.push({ value: 1, observedAtMs: now });
    this.#pruneRuntime(runtime, now);
    this.infrastructure.metrics?.increment('vod_source_requests_total');
    this.#publishRuntimeSnapshot(sessionId, runtime, now);
  }

  #setSourceConnectionCount(sessionId: string, count: number): void {
    const runtime = this.#localRuntime(sessionId);
    runtime.sourceConnectionCount = Math.max(0, count);
    this.infrastructure.metrics?.gauge(
      'vod_source_connections_active',
      runtime.sourceConnectionCount
    );
    this.#publishRuntimeSnapshot(sessionId, runtime, Date.now());
  }

  #recordSessionCache(sessionId: string, hit: boolean): void {
    const roles = this.options.roles ?? ['controller', 'source-worker', 'ingest-origin', 'edge'];
    if (!roles.includes('edge')) return;
    const now = Date.now();
    const runtime = this.#localRuntime(sessionId);
    if (hit) runtime.cacheHits += 1;
    else runtime.cacheMisses += 1;
    this.#publishRuntimeSnapshot(sessionId, runtime, now);
  }

  #recordProduction(sessionId: string, mediaSeconds: number, observedAtMs: number): void {
    const runtime = this.#localRuntime(sessionId);
    if (runtime.lastSegmentPublishedAtMs !== undefined) {
      const wallSeconds = Math.max(
        0.001,
        (observedAtMs - runtime.lastSegmentPublishedAtMs) / 1_000
      );
      if (wallSeconds * 1_000 <= RUNTIME_TRAFFIC_WINDOW_MS)
        runtime.production.push({ value: mediaSeconds, wallSeconds, observedAtMs });
    }
    runtime.lastSegmentPublishedAtMs = observedAtMs;
    this.#pruneRuntime(runtime, observedAtMs);
    this.#publishRuntimeSnapshot(sessionId, runtime, observedAtMs);
  }

  #pruneRuntime(runtime: LocalSessionRuntime, now: number): void {
    const cutoff = now - RUNTIME_TRAFFIC_WINDOW_MS;
    for (const samples of [
      runtime.ingress,
      runtime.egress,
      runtime.production,
      runtime.sourceRequests
    ])
      while (samples[0] && samples[0].observedAtMs <= cutoff) samples.shift();
  }

  #runtimeSnapshot(
    sessionId: string,
    runtime: LocalSessionRuntime,
    now: number
  ): SessionRuntimeSnapshot {
    this.#pruneRuntime(runtime, now);
    const mbps = (samples: RuntimeSample[]) =>
      (samples.reduce((total, sample) => total + sample.value, 0) * 8) /
      (RUNTIME_TRAFFIC_WINDOW_MS / 1_000) /
      1_000_000;
    const mediaSeconds = runtime.production.reduce((total, sample) => total + sample.value, 0);
    const wallSeconds = runtime.production.reduce((total, sample) => total + sample.wallSeconds, 0);
    return {
      v: 1,
      sessionId,
      nodeId: this.options.nodeId ?? 'standalone',
      observedAtMs: now,
      sourceIngressMbps: mbps(runtime.ingress),
      viewerEgressMbps: mbps(runtime.egress),
      sourceConnectionCount: runtime.sourceConnectionCount,
      sourceRequestsLast30s: runtime.sourceRequests.length,
      cacheHits: runtime.cacheHits,
      cacheMisses: runtime.cacheMisses,
      ...(wallSeconds > 0 ? { transcodeRealtimeFactor: mediaSeconds / wallSeconds } : {})
    };
  }

  #publishRuntimeSnapshot(sessionId: string, runtime: LocalSessionRuntime, now: number): void {
    if (!this.infrastructure.coordination || now - runtime.lastSnapshotAtMs < 1_000) return;
    runtime.lastSnapshotAtMs = now;
    const snapshot = this.#runtimeSnapshot(sessionId, runtime, now);
    void this.infrastructure.coordination
      .set(
        `session-runtime:${sessionId}:${snapshot.nodeId}`,
        JSON.stringify(snapshot),
        RUNTIME_SNAPSHOT_TTL_MS
      )
      .catch(() => undefined);
  }

  async #runtimeSnapshots(sessionId: string): Promise<SessionRuntimeSnapshot[]> {
    const now = Date.now();
    const local = this.#sessionRuntime.get(sessionId);
    const localNodeId = this.options.nodeId ?? 'standalone';
    const snapshots = local ? [this.#runtimeSnapshot(sessionId, local, now)] : [];
    if (!this.infrastructure.coordination || !this.infrastructure.clusterRepository)
      return snapshots;
    const nodes = await this.infrastructure.clusterRepository.listNodes().catch(() => undefined);
    if (!nodes) return snapshots;
    const nodeIds = new Set(
      nodes.map((node) => node.id).filter((nodeId) => nodeId !== localNodeId)
    );
    const stored = await Promise.all(
      [...nodeIds].map((nodeId) =>
        this.infrastructure
          .coordination!.get(`session-runtime:${sessionId}:${nodeId}`)
          .catch(() => undefined)
      )
    );
    for (const value of stored) {
      if (!value) continue;
      try {
        const parsed = JSON.parse(value) as SessionRuntimeSnapshot;
        if (
          parsed.v === 1 &&
          parsed.sessionId === sessionId &&
          typeof parsed.nodeId === 'string' &&
          parsed.nodeId.length > 0 &&
          Number.isFinite(parsed.observedAtMs) &&
          Number.isFinite(parsed.sourceIngressMbps) &&
          parsed.sourceIngressMbps >= 0 &&
          Number.isFinite(parsed.viewerEgressMbps) &&
          parsed.viewerEgressMbps >= 0 &&
          (parsed.sourceConnectionCount === undefined ||
            (Number.isInteger(parsed.sourceConnectionCount) &&
              parsed.sourceConnectionCount >= 0)) &&
          (parsed.sourceRequestsLast30s === undefined ||
            (Number.isInteger(parsed.sourceRequestsLast30s) &&
              parsed.sourceRequestsLast30s >= 0)) &&
          Number.isInteger(parsed.cacheHits) &&
          parsed.cacheHits >= 0 &&
          Number.isInteger(parsed.cacheMisses) &&
          parsed.cacheMisses >= 0 &&
          (parsed.transcodeRealtimeFactor === undefined ||
            (Number.isFinite(parsed.transcodeRealtimeFactor) &&
              parsed.transcodeRealtimeFactor >= 0))
        )
          snapshots.push(parsed);
      } catch {
        // Runtime snapshots are short-lived hints; malformed entries are ignored.
      }
    }
    return snapshots;
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

  async #openTrackedSource(
    sessionId: string,
    provider: MediaProvider,
    source: ResolvedSource,
    range: string | undefined,
    signal: AbortSignal | undefined,
    producerGeneration?: number
  ): Promise<SourceResponse> {
    const sourceRequestId = randomUUID();
    const request: ActiveSourceRequest = {
      id: sourceRequestId,
      ...(range ? { range } : {}),
      ...(producerGeneration !== undefined ? { producerGeneration } : {}),
      startedAtMs: Date.now()
    };
    const requests =
      this.#activeSourceRequests.get(sessionId) ?? new Map<string, ActiveSourceRequest>();
    requests.set(sourceRequestId, request);
    this.#activeSourceRequests.set(sessionId, requests);
    this.#recordSourceRequest(sessionId);
    this.#setSourceConnectionCount(sessionId, requests.size);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      requests.delete(sourceRequestId);
      if (requests.size === 0) this.#activeSourceRequests.delete(sessionId);
      this.#setSourceConnectionCount(sessionId, requests.size);
    };
    try {
      const response = await provider.openSource(source, range, signal);
      response.stream.once('end', finish);
      response.stream.once('close', finish);
      response.stream.once('error', finish);
      return {
        ...response,
        sourceRequestId,
        ...(producerGeneration !== undefined ? { producerGeneration } : {})
      };
    } catch (error) {
      finish();
      throw error;
    }
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
