// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  LiveChannel,
  PublicLiveChannel,
  MediaItem,
  ProfileRevision,
  ProviderConnection,
  PublicProviderConnection,
  RelaySession,
  SegmentJob,
  NodeRole,
  ProviderBinding,
  CachedObject
} from '@vrrelay/domain';
import { publicLiveChannel, publicProvider } from '@vrrelay/domain';
import type {
  CatalogQuery,
  CreateLiveChannelRequest,
  CreateProfileRevisionRequest,
  CreateProviderRequest,
  CreateSessionRequest,
  RelayEvent
} from '@vrrelay/contracts';
import type {
  EventBus,
  MediaProvider,
  MediaCapabilities,
  ProviderRegistry,
  Repository,
  SecretStore,
  Transcoder,
  ResolvedSource,
  SourceResponse,
  ObjectStore,
  CoordinationStore,
  ClusterRepository,
  MetricsSink,
  LiveNormalizer,
  RemoteSegmentDispatcher,
  RemoteSegmentCommand,
  RemoteProviderGateway,
  RemoteSegmentRequester
} from './index.js';
import type { PlaybackEvent } from './index.js';
import { CapacityError, ConflictError, NotFoundError, UnauthorizedError } from './errors.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function event(
  type: RelayEvent['type'],
  payload: Record<string, unknown>,
  sessionId?: string
): RelayEvent {
  return {
    version: 1,
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
    payload
  };
}

async function removePartialFiles(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return removePartialFiles(path);
      if (entry.name.includes('.part')) await rm(path, { force: true });
    })
  );
}

function finishLatestAttempt(
  job: SegmentJob,
  state: 'complete' | 'failed' | 'cancelled',
  errorMessage?: string
): SegmentJob {
  const workerHistory = [...(job.workerHistory ?? [])];
  const latest = workerHistory.at(-1);
  if (latest?.state === 'running')
    workerHistory[workerHistory.length - 1] = {
      ...latest,
      state,
      completedAt: new Date().toISOString(),
      ...(errorMessage ? { errorMessage } : {})
    };
  return { ...job, workerHistory };
}

export class ProviderService {
  constructor(
    private readonly repository: Repository & Partial<ClusterRepository>,
    private readonly secrets: SecretStore,
    private readonly providers: ProviderRegistry,
    private readonly options: { nodeId?: string; remote?: RemoteProviderGateway } = {}
  ) {}

  async create(
    input: CreateProviderRequest & { normalizedBaseUrl: string; securityNotice?: string }
  ): Promise<PublicProviderConnection> {
    const adapter = this.providers.get(input.type);
    const identity = await adapter.authenticate(input.normalizedBaseUrl, {
      ...(input.authMode === 'api_key'
        ? { apiKey: input.apiKey! }
        : { username: input.username!, password: input.password! })
    });
    const id = randomUUID();
    const now = new Date().toISOString();
    const connection: ProviderConnection = {
      id,
      type: input.type,
      name: input.name,
      baseUrl: input.normalizedBaseUrl,
      authMode: input.authMode,
      secretRef: `provider:${id}`,
      ...(identity.userId ? { userId: identity.userId } : {}),
      ...(identity.username ? { username: identity.username } : {}),
      serverName: identity.serverName,
      serverVersion: identity.serverVersion,
      capabilities: [...adapter.capabilities],
      healthy: true,
      ...(input.securityNotice ? { securityNotice: input.securityNotice } : {}),
      createdAt: now,
      updatedAt: now
    };
    await this.secrets.put(connection.secretRef, identity.accessToken);
    try {
      await this.repository.putProvider(connection);
    } catch (error) {
      await this.secrets.delete(connection.secretRef);
      throw error;
    }
    return publicProvider(connection);
  }

  async list(): Promise<PublicProviderConnection[]> {
    return (await this.repository.listProviders()).map(publicProvider);
  }

  async delete(providerId: string): Promise<void> {
    const connection = await this.#connection(providerId);
    const dependentSessions = (await this.repository.listSessions()).filter(
      (session) => session.kind === 'vod' && session.source?.providerId === providerId
    );
    if (dependentSessions.length > 0)
      throw new ConflictError('Delete relay sessions that use this provider first');
    const bindings = await this.repository.listProviderBindings?.(providerId);
    if ((bindings?.length ?? 0) > 0)
      throw new ConflictError('Delete every node binding for this provider first');

    // If secret removal fails, retain the visible provider record so an
    // administrator can retry instead of silently orphaning a credential.
    await this.secrets.delete(connection.secretRef);
    await this.repository.deleteProvider(providerId);
  }

  async createBinding(
    input: CreateProviderRequest & { normalizedBaseUrl: string; securityNotice?: string },
    nodeId: string,
    providerId: string = randomUUID(),
    bindingId: string = randomUUID()
  ): Promise<{ provider: PublicProviderConnection; binding: ProviderBinding }> {
    const adapter = this.providers.get(input.type);
    const identity = await adapter.authenticate(
      input.normalizedBaseUrl,
      input.authMode === 'api_key'
        ? { apiKey: input.apiKey! }
        : { username: input.username!, password: input.password! }
    );
    const now = new Date().toISOString();
    const secretRef = `provider-binding:${bindingId}`;
    const existing = await this.repository.getProvider(providerId);
    if (
      existing &&
      (existing.type !== input.type ||
        existing.baseUrl.replace(/\/$/, '') !== input.normalizedBaseUrl.replace(/\/$/, ''))
    ) {
      throw new ConflictError('Failover bindings must reference the same provider server');
    }
    const authenticated: ProviderConnection = {
      id: providerId,
      type: input.type,
      name: input.name,
      baseUrl: input.normalizedBaseUrl,
      authMode: input.authMode,
      secretRef,
      ...(identity.userId ? { userId: identity.userId } : {}),
      ...(identity.username ? { username: identity.username } : {}),
      serverName: identity.serverName,
      serverVersion: identity.serverVersion,
      capabilities: [...adapter.capabilities],
      healthy: true,
      ...(input.securityNotice ? { securityNotice: input.securityNotice } : {}),
      createdAt: now,
      updatedAt: now
    };
    // A provider is shared cluster metadata, while every binding secret is node-local.
    // Preserve the original reference in the shared record and resolve the actual
    // secret through this node's binding for all provider operations below.
    const connection: ProviderConnection = existing
      ? {
          ...existing,
          name: input.name,
          healthy: true,
          serverName: identity.serverName,
          serverVersion: identity.serverVersion,
          capabilities: [...adapter.capabilities],
          ...(identity.userId ? { userId: identity.userId } : {}),
          ...(identity.username ? { username: identity.username } : {}),
          updatedAt: now
        }
      : authenticated;
    const binding: ProviderBinding = {
      id: bindingId,
      providerId,
      nodeId,
      secretRef,
      reachable: true,
      state: 'healthy',
      validatedAt: now,
      createdAt: now,
      updatedAt: now
    };
    await this.secrets.put(secretRef, identity.accessToken);
    try {
      await this.repository.putProvider(connection);
      await this.repository.putProviderBinding?.(binding);
    } catch (error) {
      await this.secrets.delete(secretRef);
      throw error;
    }
    return { provider: publicProvider(connection), binding };
  }

  async removeBinding(bindingId: string): Promise<void> {
    const bindings = await this.repository.listProviderBindings?.();
    const binding = bindings?.find((candidate) => candidate.id === bindingId);
    if (!binding) throw new NotFoundError('Provider binding was not found');
    await this.secrets.delete(binding.secretRef);
  }

  async browse(
    providerId: string,
    query: CatalogQuery
  ): Promise<{ items: MediaItem[]; total: number }> {
    const connection = await this.#connection(providerId);
    const remote = await this.#remoteBinding(providerId);
    if (remote)
      return this.options.remote!.call(remote.nodeId, 'provider.browse', { providerId, query });
    const secret = await this.secrets.get(await this.#localSecretRef(connection));
    return this.providers.get(connection.type).browse(connection, secret, query);
  }

  async item(providerId: string, itemId: string): Promise<MediaItem> {
    const connection = await this.#connection(providerId);
    const remote = await this.#remoteBinding(providerId);
    if (remote)
      return this.options.remote!.call(remote.nodeId, 'provider.item', { providerId, itemId });
    const secret = await this.secrets.get(await this.#localSecretRef(connection));
    return this.providers.get(connection.type).item(connection, secret, itemId);
  }

  async validate(providerId: string): Promise<void> {
    const connection = await this.#connection(providerId);
    const remote = await this.#remoteBinding(providerId);
    if (remote) {
      await this.options.remote!.call(remote.nodeId, 'provider.validate', { providerId });
      return;
    }
    const secret = await this.secrets.get(await this.#localSecretRef(connection));
    await this.providers.get(connection.type).validate(connection, secret);
    await this.repository.putProvider({
      ...connection,
      healthy: true,
      updatedAt: new Date().toISOString()
    });
  }

  async reportActivity(providerId: string, event: PlaybackEvent): Promise<void> {
    const connection = await this.#connection(providerId);
    const secret = await this.secrets.get(await this.#localSecretRef(connection));
    await this.providers.get(connection.type).reportPlayback(connection, secret, event);
  }

  async #connection(id: string): Promise<ProviderConnection> {
    const connection = await this.repository.getProvider(id);
    if (!connection) throw new NotFoundError('Provider connection was not found');
    return connection;
  }

  async #remoteBinding(providerId: string): Promise<ProviderBinding | undefined> {
    if (!this.options.remote || !this.repository.listProviderBindings) return undefined;
    const bindings = await this.repository.listProviderBindings(providerId);
    const remote = bindings.find(
      (binding) =>
        binding.state === 'healthy' &&
        binding.nodeId !== this.options.nodeId &&
        this.options.remote!.connected(binding.nodeId)
    );
    return remote;
  }

  async #localSecretRef(connection: ProviderConnection): Promise<string> {
    if (!this.repository.listProviderBindings) return connection.secretRef;
    const bindings = await this.repository.listProviderBindings(connection.id);
    const candidates = [
      ...bindings.filter(
        (binding) => binding.nodeId === this.options.nodeId && binding.state === 'healthy'
      ),
      ...bindings.filter(
        (binding) => binding.nodeId !== this.options.nodeId && binding.state === 'healthy'
      )
    ];
    // Enrollment can replace a node's bootstrap ID with a controller-issued ID.
    // The secret backend is the authority for locality: only the worker that
    // received this binding can resolve its reference.
    for (const binding of candidates) {
      try {
        await this.secrets.get(binding.secretRef);
        return binding.secretRef;
      } catch {
        // This binding belongs to a different node.
      }
    }
    return connection.secretRef;
  }
}

export class ProfileService {
  constructor(private readonly repository: Repository) {}

  async seed(capabilities: MediaCapabilities): Promise<void> {
    if ((await this.repository.listProfiles()).length > 0) return;
    const available = new Set(
      capabilities.encoders.filter((encoder) => encoder.available).map((encoder) => encoder.name)
    );
    const h264Encoder =
      ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'libx264'].find(
        (encoder) => available.has(encoder)
      ) ?? 'libx264';
    const hardwareMode = h264Encoder.includes('videotoolbox')
      ? 'videotoolbox'
      : h264Encoder.includes('nvenc')
        ? 'nvenc'
        : h264Encoder.includes('qsv')
          ? 'qsv'
          : h264Encoder.includes('amf')
            ? 'amf'
            : h264Encoder.includes('vaapi')
              ? 'vaapi'
              : 'software';
    const now = new Date().toISOString();
    const base: Omit<
      ProfileRevision,
      'profileId' | 'revision' | 'name' | 'description' | 'platform' | 'state' | 'createdAt'
    > = {
      video: {
        codec: 'h264',
        encoder: h264Encoder,
        hardwareMode,
        decodeMode: 'auto',
        profile: 'high',
        level: '4.1',
        pixelFormat: 'yuv420p',
        width: 1920,
        height: 1080,
        frameRate: 30,
        bitrateKbps: 8_000,
        maxrateKbps: 8_500,
        bufferKbps: 17_000,
        preset: 'veryfast',
        gop: 120,
        bFrames: 0
      },
      audio: { codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48_000, bitrateKbps: 192 },
      delivery: {
        method: 'hls',
        container: 'mpegts',
        segmentType: 'mpegts',
        segmentDuration: 4,
        playlistType: 'vod',
        latencyMode: 'standard'
      },
      processing: { toneMap: false, burnSubtitles: false, passthrough: 'never', maxWorkers: 2 }
    };
    const profiles: ProfileRevision[] = [
      {
        ...base,
        profileId: 'universal-h264-hls-vod',
        revision: 1,
        name: 'Universal H.264 / AAC HLS',
        description: 'Finite MPEG-TS HLS VOD baseline for PC and Quest testing.',
        platform: 'universal',
        state: 'experimental',
        createdAt: now
      },
      {
        ...base,
        profileId: 'pc-h264-hls-vod',
        revision: 1,
        name: 'PC H.264 1080p',
        description: 'Higher-bitrate PC-oriented HLS VOD output.',
        platform: 'pc',
        state: 'experimental',
        video: { ...base.video, bitrateKbps: 12_000, maxrateKbps: 13_000, bufferKbps: 26_000 },
        createdAt: now
      },
      {
        ...base,
        profileId: 'quest-h264-hls-vod',
        revision: 1,
        name: 'Quest H.264 720p',
        description: 'Conservative Quest-oriented H.264/AAC profile.',
        platform: 'quest',
        state: 'experimental',
        video: {
          ...base.video,
          width: 1280,
          height: 720,
          bitrateKbps: 4_000,
          maxrateKbps: 4_500,
          bufferKbps: 9_000
        },
        createdAt: now
      },
      {
        ...base,
        profileId: 'h264-live-hls',
        revision: 1,
        name: 'H.264 / AAC Live HLS',
        description: 'Standard-latency HLS output for OBS live channels.',
        platform: 'universal',
        state: 'experimental',
        delivery: { ...base.delivery, playlistType: 'live' },
        createdAt: now
      },
      {
        ...base,
        profileId: 'universal-h264-fmp4-hls-vod',
        revision: 1,
        name: 'Universal H.264 / AAC fMP4 HLS',
        description: 'Experimental finite fMP4 HLS VOD output.',
        platform: 'universal',
        state: 'experimental',
        delivery: { ...base.delivery, container: 'fmp4', segmentType: 'fmp4' },
        createdAt: now
      },
      {
        ...base,
        profileId: 'fragmented-mp4',
        revision: 1,
        name: 'Fragmented MP4',
        description: 'Experimental direct fragmented MP4 for Unity-player compatibility testing.',
        platform: 'pc',
        state: 'experimental',
        delivery: {
          method: 'fragmented_mp4',
          container: 'mp4',
          segmentType: 'none',
          segmentDuration: 4,
          playlistType: 'vod',
          latencyMode: 'standard'
        },
        createdAt: now
      }
    ];
    for (const profile of profiles) await this.repository.putProfile(profile);
  }

  async list(): Promise<ProfileRevision[]> {
    return this.repository.listProfiles();
  }

  async createRevision(input: CreateProfileRevisionRequest): Promise<ProfileRevision> {
    const profileId = input.profileId ?? randomUUID();
    const previous = await this.repository.getProfile(profileId);
    const profile: ProfileRevision = {
      ...input,
      profileId,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: new Date().toISOString()
    };
    await this.repository.putProfile(profile);
    return profile;
  }
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

export class SessionService {
  readonly #inflight = new Map<string, Promise<string>>();
  readonly #sourceGrants = new Map<
    string,
    { source: ResolvedSource; provider: MediaProvider; expiresAt: number }
  >();
  readonly #waiters: Array<() => void> = [];
  readonly #viewers = new Map<string, Map<string, number>>();
  readonly #activity = new Map<string, number>();
  readonly #jobControllers = new Map<string, AbortController>();
  readonly #egressSamples: Array<{ bytes: number; observedAt: number }> = [];
  #viewerSalt?: Promise<string>;
  #activeWorkers = 0;

  constructor(
    private readonly repository: Repository,
    private readonly secrets: SecretStore,
    private readonly providers: ProviderRegistry,
    private readonly transcoder: Transcoder,
    private readonly events: EventBus,
    private readonly options: SessionServiceOptions,
    private readonly infrastructure: SessionServiceInfrastructure = {}
  ) {}

  async create(input: CreateSessionRequest): Promise<RelaySession> {
    const profile = await this.repository.getProfile(input.profileId, input.profileRevision);
    if (!profile) throw new NotFoundError('Profile revision was not found');
    const id = randomUUID();
    const token = opaqueToken();
    const now = new Date().toISOString();
    let durationSeconds: number | undefined;
    let name = input.name;
    if (input.kind === 'vod') {
      const connection = await this.repository.getProvider(input.source.providerId);
      if (!connection) throw new NotFoundError('Provider connection was not found');
      const remoteNode = await this.#remoteProviderNode(connection.id);
      const item = remoteNode
        ? await this.infrastructure.providerGateway!.call<MediaItem>(remoteNode, 'provider.item', {
            providerId: connection.id,
            itemId: input.source.itemId
          })
        : await this.providers
            .get(connection.type)
            .item(connection, await this.#providerSecret(connection), input.source.itemId);
      durationSeconds = item.durationSeconds;
      if (!durationSeconds || durationSeconds <= 0)
        throw new Error('Selected media does not expose a finite duration');
      name ??= item.name;
    } else {
      const channel = await this.repository.getLiveChannel(input.liveChannelId);
      if (!channel) throw new NotFoundError('Live channel was not found');
      if (profile.delivery.method !== 'hls' || profile.delivery.playlistType !== 'live')
        throw new ConflictError('Live sessions require a live HLS profile');
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
      outputUrls: { primary: `${this.options.publicUrl}/play/${token}/${path}` },
      createdAt: now,
      updatedAt: now
    };
    const expiresAt = input.playbackTtlSeconds
      ? new Date(Date.now() + input.playbackTtlSeconds * 1_000).toISOString()
      : null;
    await this.repository.putPlaybackGrant({
      tokenHash: hashToken(token),
      sessionId: id,
      expiresAt,
      revokedAt: null,
      createdAt: now
    });
    await this.repository.putSession(session);
    this.events.publish(event('session.created', { name: session.name, kind: session.kind }, id));
    return session;
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
    input: { pinned?: boolean; state?: 'idle' | 'stopped' }
  ): Promise<RelaySession> {
    const session = await this.get(id);
    const updated: RelaySession = {
      ...session,
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.state ? { state: input.state } : {}),
      updatedAt: new Date().toISOString()
    };
    await this.repository.putSession(updated);
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
    await rm(join(this.options.cacheDir, 'worker'), { recursive: true, force: true });
    await removePartialFiles(join(this.options.cacheDir, 'vod'));
    for (const session of await this.repository.listSessions()) {
      if (['queued', 'starting', 'active'].includes(session.state)) {
        await this.repository.putSession({
          ...session,
          state: 'idle',
          updatedAt: new Date().toISOString()
        });
        recovered += 1;
      }
    }
    const clusterRepository = this.infrastructure.clusterRepository;
    if (clusterRepository) {
      const now = Date.now();
      for (const job of await clusterRepository.listSegmentJobs(1_000)) {
        if (
          ['leased', 'running'].includes(job.state) &&
          (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= now)
        ) {
          await clusterRepository.putSegmentJob({
            ...job,
            state: 'queued',
            ownerNodeId: undefined,
            leaseExpiresAt: undefined,
            errorMessage: undefined,
            updatedAt: new Date().toISOString()
          });
          recovered += 1;
        }
      }
    }
    return recovered;
  }

  async delete(id: string): Promise<void> {
    const session = await this.repository.getSession(id);
    if (!session) throw new NotFoundError('Session was not found');
    await this.#reportActivity(session, session.durationSeconds ?? 0, 'stop').catch(
      () => undefined
    );
    await this.repository.revokePlaybackGrants(id);
    await this.repository.deleteSession(id);
    await rm(join(this.options.cacheDir, 'vod', id), { recursive: true, force: true });
    this.events.publish(event('session.deleted', { name: session.name }, id));
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
    const contentKey = this.#contentKey(session, profile, index);
    try {
      await access(destination);
      const now = new Date();
      await utimes(destination, now, now);
      this.events.publish(event('cache.hit', { segment: index }, session.id));
      return destination;
    } catch {
      // Cache miss.
    }
    if (await this.#restoreObject(contentKey, destination)) {
      this.infrastructure.metrics?.increment('cache_hits_total', { layer: 'object_store' });
      this.events.publish(
        event('cache.hit', { segment: index, layer: 'object-store' }, session.id)
      );
      return destination;
    }
    if (this.#isEdgeOnly()) {
      await this.#requestOrigin(token, index, signal);
      if (await this.#restoreObject(contentKey, destination)) return destination;
      throw new Error('Origin completed the segment request but no object was published');
    }
    const key = destination;
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const job = this.#generateDistributedSegment(
      session,
      profile,
      index,
      destination,
      contentKey,
      signal
    ).finally(() => {
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
    const initKey = this.#contentKey(session, profile, 0).replace(/\.m4s$/, '.init.mp4');
    if (await this.#restoreObject(initKey, path)) return path;
    await this.segment(token, 0, signal);
    try {
      await access(path);
      return path;
    } catch {
      /* edge may need the uploaded init object */
    }
    if (await this.#restoreObject(initKey, path)) return path;
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
    const secret = await this.#providerSecret(connection);
    const provider = this.providers.get(connection.type);
    const source = await provider.resolveSource(connection, secret, session.source, signal);
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
    return {
      active: this.#activeWorkers,
      limit: this.options.maxWorkers,
      queued: this.#waiters.length
    };
  }

  async listJobs(limit = 100): Promise<SegmentJob[]> {
    const jobs = (await this.infrastructure.clusterRepository?.listSegmentJobs(limit)) ?? [];
    return jobs.map((job) => ({ ...job, workerHistory: job.workerHistory ?? [] }));
  }

  async cancelJob(id: string): Promise<void> {
    const repository = this.infrastructure.clusterRepository;
    const job = await repository?.getSegmentJob(id);
    if (!repository || !job || ['complete', 'failed', 'cancelled'].includes(job.state)) return;
    this.#jobControllers.get(id)?.abort(new Error('Job cancelled'));
    if (job.ownerNodeId && job.ownerNodeId !== this.options.nodeId)
      await this.infrastructure.dispatcher?.cancel(job.ownerNodeId, id);
    await repository.putSegmentJob({
      ...finishLatestAttempt(job, 'cancelled', 'Cancelled by an administrator'),
      state: 'cancelled',
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString()
    });
  }

  async retryJob(id: string): Promise<SegmentJob> {
    const repository = this.infrastructure.clusterRepository;
    const job = await repository?.getSegmentJob(id);
    if (!repository || !job) throw new NotFoundError('Segment job was not found');
    if (!['failed', 'cancelled'].includes(job.state))
      throw new ConflictError('Only failed or cancelled segment jobs can be retried');
    const session = await this.get(job.sessionId);
    if (session.kind !== 'vod' || !session.source || !session.durationSeconds)
      throw new ConflictError('The segment job no longer references a retryable VOD session');
    const profile = await this.repository.getProfile(session.profileId, session.profileRevision);
    if (!profile) throw new NotFoundError('Profile revision was not found');
    const expectedKey = this.#contentKey(session, profile, job.segmentIndex);
    if (expectedKey !== job.contentKey)
      throw new ConflictError('The segment job does not match the immutable session revision');
    const extension = profile.delivery.segmentType === 'fmp4' ? 'm4s' : 'ts';
    const destination = join(
      this.options.cacheDir,
      'vod',
      session.id,
      `${profile.profileId}-r${profile.revision}`,
      `${job.segmentIndex}.${extension}`
    );
    await rm(destination, { force: true });
    await repository.putSegmentJob({
      ...job,
      state: 'queued',
      attempts: 0,
      ownerNodeId: undefined,
      leaseExpiresAt: undefined,
      completedAt: undefined,
      errorMessage: undefined,
      updatedAt: new Date().toISOString()
    });
    await this.#generateDistributedSegment(
      session,
      profile,
      job.segmentIndex,
      destination,
      job.contentKey
    );
    return (await repository.getSegmentJob(id))!;
  }

  async executeRemoteSegment(command: RemoteSegmentCommand, signal?: AbortSignal): Promise<void> {
    const session = await this.get(command.sessionId);
    if (session.kind !== 'vod' || !session.source || !session.durationSeconds)
      throw new NotFoundError('VOD session was not found');
    const profile = await this.repository.getProfile(session.profileId, session.profileRevision);
    if (!profile) throw new NotFoundError('Profile revision was not found');
    const expectedKey = this.#contentKey(session, profile, command.segmentIndex);
    if (expectedKey !== command.contentKey)
      throw new UnauthorizedError('Segment content key did not match the immutable session');
    const extension = profile.delivery.segmentType === 'fmp4' ? 'm4s' : 'ts';
    const destination = join(
      this.options.cacheDir,
      'worker',
      command.jobId,
      `${command.segmentIndex}.${extension}`
    );
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error('Remote job aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    this.#jobControllers.set(command.jobId, controller);
    try {
      await this.#generateSegment(
        session,
        profile,
        command.segmentIndex,
        destination,
        controller.signal
      );
      await this.#publishObject(
        session,
        profile,
        command.segmentIndex,
        destination,
        command.contentKey
      );
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#jobControllers.delete(command.jobId);
      await rm(join(this.options.cacheDir, 'worker', command.jobId), {
        recursive: true,
        force: true
      });
    }
  }

  async cleanupExpiredCache(): Promise<number> {
    const now = Date.now();
    for (const [token, grant] of this.#sourceGrants) {
      if (grant.expiresAt <= now) this.#sourceGrants.delete(token);
    }
    for (const [sessionId, viewers] of this.#viewers) {
      for (const [viewer, seenAt] of viewers) if (now - seenAt > 30_000) viewers.delete(viewer);
      const session = await this.repository.getSession(sessionId);
      if (session && session.viewers !== viewers.size) {
        await this.repository.putSession({
          ...session,
          viewers: viewers.size,
          updatedAt: new Date().toISOString()
        });
      }
      this.infrastructure.metrics?.gauge('viewers_active', viewers.size, { session: sessionId });
    }
    const root = join(this.options.cacheDir, 'vod');
    let removed = 0;
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const visit = async (path: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await visit(child);
        else {
          const info = await stat(child);
          if (now - info.mtimeMs > this.options.cacheTtlMs) {
            await rm(child, { force: true });
            removed += 1;
          } else files.push({ path: child, size: info.size, mtimeMs: info.mtimeMs });
        }
      }
    };
    await visit(root);
    const limit = this.options.cacheLimitBytes;
    if (limit) {
      let total = files.reduce((sum, file) => sum + file.size, 0);
      for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
        if (total <= limit) break;
        await rm(file.path, { force: true });
        total -= file.size;
        removed += 1;
      }
      this.infrastructure.metrics?.gauge('cache_bytes', total, { layer: 'disk' });
    }
    if (removed) this.events.publish(event('cache.evicted', { count: removed }));
    return removed;
  }

  async cacheInventory(): Promise<CachedObject[]> {
    const root = join(this.options.cacheDir, 'vod');
    const items: CachedObject[] = [];
    const visit = async (path: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await visit(child);
        else if (!entry.name.endsWith('.part')) {
          const info = await stat(child);
          const key = child
            .slice(root.length + 1)
            .split('\\')
            .join('/');
          items.push({
            key,
            size: info.size,
            contentType: entry.name.endsWith('.m4s')
              ? 'video/iso.segment'
              : entry.name.endsWith('.mp4')
                ? 'video/mp4'
                : 'video/mp2t',
            expiresAt: new Date(info.mtimeMs + this.options.cacheTtlMs).toISOString(),
            createdAt: info.birthtime.toISOString(),
            lastAccessedAt: info.mtime.toISOString()
          });
        }
      }
    };
    await visit(root);
    return items.sort((left, right) => right.lastAccessedAt.localeCompare(left.lastAccessedAt));
  }

  async evictCache(filter: {
    sessionId?: string;
    profileId?: string;
    all?: boolean;
  }): Promise<number> {
    if (!filter.all && !filter.sessionId && !filter.profileId)
      throw new Error('A cache eviction scope is required');
    const inventory = await this.cacheInventory();
    let removed = 0;
    for (const object of inventory) {
      const [sessionId, profileDirectory] = object.key.split('/');
      if (!filter.all && filter.sessionId && sessionId !== filter.sessionId) continue;
      if (!filter.all && filter.profileId && !profileDirectory?.startsWith(`${filter.profileId}-r`))
        continue;
      await rm(join(this.options.cacheDir, 'vod', object.key), { force: true });
      removed += 1;
    }
    if (removed) this.events.publish(event('cache.evicted', { count: removed, ...filter }));
    return removed;
  }

  async touchViewer(token: string, viewerIdentity: string): Promise<RelaySession> {
    const { session } = await this.#playback(token);
    const viewers = this.#viewers.get(session.id) ?? new Map<string, number>();
    const viewer = createHmac('sha256', await this.#getViewerSalt())
      .update(viewerIdentity)
      .digest('hex')
      .slice(0, 20);
    const joined = !viewers.has(viewer);
    viewers.set(viewer, Date.now());
    this.#viewers.set(session.id, viewers);
    if (joined) {
      await this.repository.putSession({
        ...session,
        viewers: viewers.size,
        updatedAt: new Date().toISOString()
      });
      this.events.publish(event('viewer.joined', { viewers: viewers.size }, session.id));
    }
    return session;
  }

  recordEgress(bytes: number, sessionId?: string): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.#egressSamples.push({ bytes, observedAt: Date.now() });
    this.#pruneEgressSamples(Date.now());
    this.infrastructure.metrics?.increment(
      'egress_bytes_total',
      { session: sessionId ?? 'unattributed' },
      bytes
    );
  }

  egressMbps(now = Date.now(), windowMs = 30_000): number {
    this.#pruneEgressSamples(now, windowMs);
    const bytes = this.#egressSamples.reduce((total, sample) => total + sample.bytes, 0);
    return (bytes * 8) / (windowMs / 1_000) / 1_000_000;
  }

  async cacheUsageBytes(): Promise<number> {
    return (await this.cacheInventory()).reduce((total, object) => total + object.size, 0);
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
      const secret = await this.#providerSecret(connection);
      const provider = this.providers.get(connection.type);
      const source = await provider.resolveSource(connection, secret, session.source!, signal);
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
      await this.repository.putSession({
        ...session,
        state: 'active',
        updatedAt: new Date().toISOString()
      });
      this.infrastructure.metrics?.increment('segments_generated_total', {
        profile: profile.profileId
      });
      this.infrastructure.metrics?.observe(
        'segment_generation_seconds',
        (Date.now() - workerStartedAt) / 1_000,
        { profile: profile.profileId, encoder: profile.video.encoder }
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

  async #generateDistributedSegment(
    session: RelaySession,
    profile: ProfileRevision,
    index: number,
    destination: string,
    contentKey: string,
    signal?: AbortSignal
  ): Promise<string> {
    const coordination = this.infrastructure.coordination;
    const owner = `${this.options.nodeId ?? 'standalone'}:${randomUUID()}`;
    const leaseKey = `segment:${contentKey}`;
    if (coordination && !(await coordination.acquire(leaseKey, owner, 120_000))) {
      this.infrastructure.metrics?.increment('segment_lease_contention_total');
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw signal.reason ?? new Error('Segment request was aborted');
        if (await this.#restoreObject(contentKey, destination)) return destination;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new CapacityError('Timed out waiting for another node to publish the segment');
    }
    const now = new Date().toISOString();
    const jobId = createHash('sha256').update(contentKey).digest('hex');
    const previousJob = await this.infrastructure.clusterRepository?.getSegmentJob(jobId);
    let job: SegmentJob = {
      id: jobId,
      contentKey,
      sessionId: session.id,
      segmentIndex: index,
      state: 'running',
      attempts: previousJob?.attempts ?? 0,
      ownerNodeId: session.assignedNodeId ?? this.options.nodeId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      startedAt: now,
      workerHistory: previousJob?.workerHistory ?? [],
      createdAt: previousJob?.createdAt ?? now,
      updatedAt: now
    };
    await this.infrastructure.clusterRepository?.putSegmentJob(job);
    this.events.publish(
      event('job.leased', { jobId: job.id, contentKey, nodeId: this.options.nodeId }, session.id)
    );
    const leaseController = new AbortController();
    const forwardAbort = () =>
      leaseController.abort(signal?.reason ?? new Error('Segment request aborted'));
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const renew = coordination
      ? setInterval(() => {
          void coordination
            .renew(leaseKey, owner, 120_000)
            .then(async (renewed) => {
              if (!renewed)
                return leaseController.abort(new Error('Distributed segment lease was lost'));
              job = {
                ...job,
                leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
                updatedAt: new Date().toISOString()
              };
              await this.infrastructure.clusterRepository?.putSegmentJob(job);
            })
            .catch((error) => leaseController.abort(error));
        }, 30_000)
      : undefined;
    renew?.unref();
    try {
      const candidates = await this.#remoteCandidates(session, profile);
      if (candidates.length) {
        let failure: unknown;
        const candidatePool = session.placementLocked ? candidates.slice(0, 1) : candidates;
        const remainingAttempts = Math.max(0, 3 - job.attempts);
        if (!remainingAttempts)
          throw new CapacityError('Segment job exhausted its automatic retry limit');
        for (let attemptIndex = 0; attemptIndex < remainingAttempts; attemptIndex += 1) {
          const remoteNode = candidatePool[attemptIndex % candidatePool.length]!;
          const attempt = job.attempts + 1;
          job = {
            ...job,
            ownerNodeId: remoteNode,
            attempts: attempt,
            workerHistory: [
              ...job.workerHistory,
              { attempt, nodeId: remoteNode, state: 'running', startedAt: new Date().toISOString() }
            ],
            updatedAt: new Date().toISOString()
          };
          await this.infrastructure.clusterRepository?.putSegmentJob(job);
          try {
            await this.infrastructure.dispatcher!.dispatch(
              remoteNode,
              { jobId: job.id, sessionId: session.id, contentKey, segmentIndex: index },
              leaseController.signal
            );
            if (!(await this.#restoreObject(contentKey, destination)))
              throw new Error('Worker completed without publishing the segment object');
            job = finishLatestAttempt(job, 'complete');
            await this.infrastructure.clusterRepository?.putSegmentJob({
              ...job,
              updatedAt: new Date().toISOString()
            });
            failure = undefined;
            break;
          } catch (error) {
            failure = error;
            job = finishLatestAttempt(
              job,
              'failed',
              error instanceof Error ? error.message : String(error)
            );
            await this.infrastructure.clusterRepository?.putSegmentJob({
              ...job,
              updatedAt: new Date().toISOString()
            });
          }
        }
        if (failure)
          throw failure instanceof Error ? failure : new Error('Remote segment job failed');
      } else {
        if (
          !(
            this.options.roles ?? ['controller', 'source-worker', 'ingest-origin', 'edge']
          ).includes('source-worker')
        )
          throw new CapacityError('No source worker was assigned to this segment');
        if (job.attempts >= 3)
          throw new CapacityError('Segment job exhausted its automatic retry limit');
        const attempt = job.attempts + 1;
        job = {
          ...job,
          attempts: attempt,
          ownerNodeId: this.options.nodeId,
          workerHistory: [
            ...job.workerHistory,
            {
              attempt,
              nodeId: this.options.nodeId ?? 'standalone',
              state: 'running',
              startedAt: new Date().toISOString()
            }
          ],
          updatedAt: new Date().toISOString()
        };
        await this.infrastructure.clusterRepository?.putSegmentJob(job);
        try {
          await this.#generateSegment(session, profile, index, destination, leaseController.signal);
          await this.#publishObject(session, profile, index, destination, contentKey);
          job = finishLatestAttempt(job, 'complete');
        } catch (error) {
          job = finishLatestAttempt(
            job,
            'failed',
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      }
      const completedAt = new Date().toISOString();
      await this.infrastructure.clusterRepository?.putSegmentJob({
        ...job,
        state: 'complete',
        leaseExpiresAt: undefined,
        completedAt,
        updatedAt: completedAt
      });
      this.events.publish(event('job.completed', { jobId: job.id }, session.id));
      await coordination?.publish('segments', JSON.stringify({ contentKey, state: 'complete' }));
      return destination;
    } catch (error) {
      this.infrastructure.metrics?.increment('segment_jobs_failed_total', {
        profile: profile.profileId
      });
      await this.infrastructure.clusterRepository?.putSegmentJob({
        ...job,
        state: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      });
      this.events.publish(
        event(
          'job.failed',
          { jobId: job.id, message: error instanceof Error ? error.message : String(error) },
          session.id
        )
      );
      throw error;
    } finally {
      if (renew) clearInterval(renew);
      signal?.removeEventListener('abort', forwardAbort);
      await coordination?.release(leaseKey, owner);
    }
  }

  async #remoteCandidates(session: RelaySession, profile: ProfileRevision): Promise<string[]> {
    const dispatcher = this.infrastructure.dispatcher;
    const repository = this.infrastructure.clusterRepository;
    if (!dispatcher || !repository || !session.source) return [];
    const bindings = await repository.listProviderBindings(session.source.providerId);
    const nodes = await repository.listNodes();
    const compatible = nodes.filter(
      (node) =>
        node.roles.includes('source-worker') &&
        node.state === 'online' &&
        node.capabilities.encoders.includes(profile.video.encoder) &&
        bindings.some((binding) => binding.nodeId === node.id && binding.state === 'healthy') &&
        dispatcher.connected(node.id)
    );
    return compatible
      .sort((left, right) => {
        if (left.id === session.assignedNodeId) return -1;
        if (right.id === session.assignedNodeId) return 1;
        if (session.preferredRegion && left.region !== right.region)
          return left.region === session.preferredRegion ? -1 : 1;
        return (
          left.capabilities.activeWorkers / Math.max(1, left.capabilities.maxWorkers) -
          right.capabilities.activeWorkers / Math.max(1, right.capabilities.maxWorkers)
        );
      })
      .map((node) => node.id);
  }

  async #publishObject(
    session: RelaySession,
    profile: ProfileRevision,
    index: number,
    destination: string,
    contentKey: string
  ): Promise<void> {
    if (!this.infrastructure.objectStore) return;
    const segmentSha256 = await this.#fileSha256(destination);
    await this.infrastructure.objectStore.put(contentKey, createReadStream(destination), {
      contentType: profile.delivery.segmentType === 'fmp4' ? 'video/iso.segment' : 'video/mp2t',
      expiresAt: new Date(Date.now() + this.options.cacheTtlMs).toISOString(),
      sha256: segmentSha256,
      metadata: {
        sessionId: session.id,
        profileId: profile.profileId,
        revision: String(profile.revision)
      }
    });
    if (profile.delivery.segmentType === 'fmp4') {
      const initPath = join(dirname(destination), 'init.mp4');
      const initSha256 = await this.#fileSha256(initPath);
      await this.infrastructure.objectStore.put(
        contentKey.replace(/\.m4s$/, '.init.mp4'),
        createReadStream(initPath),
        {
          contentType: 'video/mp4',
          expiresAt: new Date(Date.now() + this.options.cacheTtlMs).toISOString(),
          sha256: initSha256,
          metadata: {
            sessionId: session.id,
            profileId: profile.profileId,
            revision: String(profile.revision),
            initialization: 'true'
          }
        }
      );
    }
    this.events.publish(event('storage.uploaded', { contentKey, segment: index }, session.id));
  }

  #contentKey(session: RelaySession, profile: ProfileRevision, index: number): string {
    const source = session.source!;
    const identity = JSON.stringify({
      providerId: source.providerId,
      itemId: source.itemId,
      versionId: source.versionId,
      fingerprint: source.sourceFingerprint,
      audio: source.audioTrackId,
      subtitle: source.subtitleTrackId,
      profile: profile.profileId,
      revision: profile.revision,
      index,
      duration: profile.delivery.segmentDuration
    });
    const extension = profile.delivery.segmentType === 'fmp4' ? 'm4s' : 'ts';
    return `vod/${createHash('sha256').update(identity).digest('hex')}.${extension}`;
  }

  async #restoreObject(contentKey: string, destination: string): Promise<boolean> {
    const object = await this.infrastructure.objectStore?.stat(contentKey);
    if (!object) return false;
    const source = await this.infrastructure.objectStore?.open(contentKey);
    if (!source) return false;
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${randomUUID()}.part`;
    const hash = createHash('sha256');
    const hasher = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        hash.update(bytes);
        callback(null, bytes);
      }
    });
    try {
      await pipeline(source, hasher, createWriteStream(temporary));
      const info = await stat(temporary);
      if (info.size !== object.size)
        throw new Error(`Cached object size mismatch for ${contentKey}`);
      const sha256 = hash.digest('hex');
      if (object.sha256 && sha256 !== object.sha256)
        throw new Error(`Cached object hash mismatch for ${contentKey}`);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return true;
  }

  async #fileSha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      hash.update(bytes);
    }
    return hash.digest('hex');
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
    this.#viewerSalt ??= (async () => {
      const existing = await this.repository.getSetting('metrics.viewer_salt');
      if (existing) return existing;
      const created = opaqueToken(32);
      await this.repository.putSetting('metrics.viewer_salt', created);
      return created;
    })();
    return this.#viewerSalt;
  }

  async #playback(token: string): Promise<{ session: RelaySession; profile: ProfileRevision }> {
    const grant = await this.repository.getPlaybackGrant(hashToken(token));
    if (
      !grant ||
      grant.revokedAt ||
      (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
    ) {
      throw new UnauthorizedError('Playback link is invalid or expired');
    }
    const session = await this.repository.getSession(grant.sessionId);
    if (!session) throw new NotFoundError('Session was not found');
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
    const remoteNode = await this.#remoteProviderNode(connection.id);
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
    const secret = await this.#providerSecret(connection);
    await this.providers.get(connection.type).reportPlayback(connection, secret, {
      sessionId: session.id,
      itemId: session.source.itemId,
      positionTicks: Math.round(positionSeconds * 10_000_000),
      paused: activityEvent === 'stop',
      event: activityEvent
    });
    if (activityEvent === 'stop') this.#activity.delete(session.id);
    else this.#activity.set(session.id, Date.now());
  }

  async #providerSecret(connection: ProviderConnection): Promise<string> {
    const bindings = await this.infrastructure.clusterRepository?.listProviderBindings(
      connection.id
    );
    for (const binding of (bindings ?? []).filter((candidate) => candidate.state === 'healthy')) {
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
        binding.nodeId !== this.options.nodeId &&
        this.infrastructure.providerGateway!.connected(binding.nodeId)
    )?.nodeId;
  }

  #proxySource(source: ResolvedSource, provider: MediaProvider): ResolvedSource {
    const token = opaqueToken();
    this.#sourceGrants.set(token, { source, provider, expiresAt: Date.now() + 15 * 60_000 });
    return { ...source, url: `${this.options.internalUrl}/internal/source/${token}`, headers: {} };
  }

  async #acquire(signal?: AbortSignal): Promise<void> {
    if (this.#activeWorkers < this.options.maxWorkers) {
      this.#activeWorkers += 1;
      return;
    }
    if (this.#waiters.length >= this.options.maxWorkers * 8)
      throw new CapacityError('Transcode queue is full');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiters.indexOf(resolve);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal?.reason ?? new Error('Request was aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
    this.#activeWorkers += 1;
  }

  #release(): void {
    this.#activeWorkers = Math.max(0, this.#activeWorkers - 1);
    this.#waiters.shift()?.();
  }

  #pruneEgressSamples(now: number, windowMs = 30_000): void {
    const cutoff = now - windowMs;
    while (this.#egressSamples[0] && this.#egressSamples[0].observedAt <= cutoff)
      this.#egressSamples.shift();
  }
}

export interface LiveServiceOptions {
  publicUrl: string;
  rtmpUrl: string;
  srtUrl: string;
  whipUrl: string;
  hlsUrl: string;
  internalRtspUrl: string;
  backupRtmpUrl?: string;
  backupSrtUrl?: string;
  allowUnauthenticatedInternalRead?: boolean;
}

export interface PublisherConnectionDetails {
  publishToken: string;
  rtmpUrl: string;
  srtUrl: string;
  whipUrl: string;
  backupRtmpUrl?: string;
  backupSrtUrl?: string;
}

function removePublisherCredential(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('user');
  parsed.searchParams.delete('pass');
  parsed.searchParams.delete('token');
  const streamId = parsed.searchParams.get('streamid');
  if (streamId?.startsWith('publish:')) {
    const [action, path] = streamId.split(':');
    parsed.searchParams.set('streamid', `${action}:${path}`);
  }
  return parsed.toString();
}

function sanitizeLiveChannel(channel: LiveChannel): LiveChannel {
  return {
    ...channel,
    rtmpUrl: removePublisherCredential(channel.rtmpUrl),
    srtUrl: removePublisherCredential(channel.srtUrl),
    whipUrl: removePublisherCredential(channel.whipUrl),
    ...(channel.backupRtmpUrl
      ? { backupRtmpUrl: removePublisherCredential(channel.backupRtmpUrl) }
      : {}),
    ...(channel.backupSrtUrl
      ? { backupSrtUrl: removePublisherCredential(channel.backupSrtUrl) }
      : {})
  };
}

export class LiveService {
  constructor(
    private readonly repository: Repository,
    private readonly options: LiveServiceOptions,
    private readonly normalizer?: LiveNormalizer,
    private readonly events?: EventBus
  ) {}

  async create(
    input: CreateLiveChannelRequest
  ): Promise<{ channel: PublicLiveChannel; publisher: PublisherConnectionDetails }> {
    const id = randomUUID();
    const path = `live-${opaqueToken(10)}`;
    const ingestPath = input.normalize ? `${path}-ingest` : path;
    const publishToken = opaqueToken(24);
    const user = 'vrrelay-publish';
    const publisher: PublisherConnectionDetails = {
      publishToken,
      rtmpUrl: `${this.options.rtmpUrl}/${ingestPath}?user=${user}&pass=${publishToken}`,
      srtUrl: `${this.options.srtUrl}?streamid=publish:${ingestPath}:${user}:${publishToken}&pkt_size=1316`,
      whipUrl: `${this.options.whipUrl}/${ingestPath}/whip?token=${publishToken}`,
      ...(this.options.backupRtmpUrl
        ? {
            backupRtmpUrl: `${this.options.backupRtmpUrl}/${ingestPath}?user=${user}&pass=${publishToken}`
          }
        : {}),
      ...(this.options.backupSrtUrl
        ? {
            backupSrtUrl: `${this.options.backupSrtUrl}?streamid=publish:${ingestPath}:${user}:${publishToken}&pkt_size=1316`
          }
        : {})
    };
    const channel: LiveChannel = {
      id,
      name: input.name,
      path,
      ...(input.normalize ? { ingestPath } : {}),
      normalize: input.normalize,
      publisherState: 'offline',
      publishTokenHash: hashToken(publishToken),
      rtmpUrl: `${this.options.rtmpUrl}/${ingestPath}`,
      srtUrl: `${this.options.srtUrl}?streamid=publish:${ingestPath}`,
      whipUrl: `${this.options.whipUrl}/${ingestPath}/whip`,
      ...(this.options.backupRtmpUrl
        ? {
            backupRtmpUrl: `${this.options.backupRtmpUrl}/${ingestPath}`
          }
        : {}),
      ...(this.options.backupSrtUrl
        ? {
            backupSrtUrl: `${this.options.backupSrtUrl}?streamid=publish:${ingestPath}`
          }
        : {}),
      createdAt: new Date().toISOString()
    };
    await this.repository.putLiveChannel(channel);
    return { channel: publicLiveChannel(channel), publisher };
  }

  async list(): Promise<PublicLiveChannel[]> {
    return (await this.repository.listLiveChannels()).map((channel) =>
      publicLiveChannel(sanitizeLiveChannel(channel))
    );
  }

  async delete(channelId: string): Promise<void> {
    const channel = await this.repository.getLiveChannel(channelId);
    if (!channel) throw new NotFoundError('Live channel was not found');
    if (channel.publisherState !== 'offline')
      throw new ConflictError('Stop the OBS publisher before deleting this live channel');
    if (
      (await this.repository.listSessions()).some((session) => session.liveChannelId === channelId)
    )
      throw new ConflictError('Delete live playback sessions that use this channel first');
    if (this.normalizer?.running(channelId)) await this.normalizer.stop(channelId);
    await this.repository.deleteLiveChannel(channelId);
    this.events?.publish(event('live.channel.deleted', { channelId, name: channel.name }));
  }

  async scrubPersistedPublisherCredentials(): Promise<void> {
    for (const channel of await this.repository.listLiveChannels()) {
      const sanitized = sanitizeLiveChannel(channel);
      if (JSON.stringify(sanitized) !== JSON.stringify(channel))
        await this.repository.putLiveChannel(sanitized);
    }
  }

  async reconcilePublisherPaths(readyPaths: ReadonlySet<string>): Promise<void> {
    for (const channel of await this.repository.listLiveChannels()) {
      const ingestPath = channel.ingestPath ?? channel.path;
      const online = readyPaths.has(ingestPath);
      const state = online ? 'online' : 'offline';
      if (channel.publisherState !== state) {
        const updated: LiveChannel = {
          ...channel,
          publisherState: state,
          publisherUpdatedAt: new Date().toISOString()
        };
        await this.repository.putLiveChannel(updated);
        this.events?.publish(
          event(online ? 'live.publisher.connected' : 'live.publisher.disconnected', {
            channelId: channel.id,
            path: channel.path
          })
        );
      }
      if (!channel.normalize || !this.normalizer) continue;
      if (online && !this.normalizer.running(channel.id)) {
        await this.normalizer.start(
          channel.id,
          `${this.options.internalRtspUrl}/${ingestPath}`,
          `${this.options.internalRtspUrl}/${channel.path}`
        );
      } else if (!online && this.normalizer.running(channel.id)) {
        await this.normalizer.stop(channel.id);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.normalizer) return;
    for (const channel of await this.repository.listLiveChannels())
      await this.normalizer.stop(channel.id);
  }

  async authorizeMediaMtx(
    input: {
      action: string;
      path: string;
      protocol?: string | undefined;
      user?: string | undefined;
      password?: string | undefined;
      token?: string | undefined;
    },
    readToken: string
  ): Promise<boolean> {
    if (input.action === 'read' || input.action === 'playback') {
      if (
        this.options.allowUnauthenticatedInternalRead &&
        !input.user &&
        !input.password &&
        !input.token
      )
        return true;
      return (
        input.user === 'vrrelay-read' && (input.password === readToken || input.token === readToken)
      );
    }
    if (input.action !== 'publish') return false;
    const channels = await this.repository.listLiveChannels();
    // FFmpeg reads and republishes over the private RTSP listener. The bundled
    // deployments never expose this listener publicly; allowing only RTSP and
    // only a generated normalized-output path avoids placing a reusable secret
    // in FFmpeg's process arguments.
    if (
      this.options.allowUnauthenticatedInternalRead &&
      input.protocol === 'rtsp' &&
      !input.user &&
      !input.password &&
      !input.token
    ) {
      return channels.some((channel) => channel.normalize && channel.path === input.path);
    }
    if (input.user !== 'vrrelay-publish') return false;
    const channel = channels.find(
      (candidate) => (candidate.ingestPath ?? candidate.path) === input.path
    );
    const supplied = input.password ?? input.token ?? '';
    return Boolean(channel && supplied && hashToken(supplied) === channel.publishTokenHash);
  }
}
