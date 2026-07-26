import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateProfileRevisionRequest } from '@vrrelay/contracts';
import {
  DefaultProviderRegistry,
  InMemoryEventBus,
  type MediaProvider,
  type LiveNormalizer,
  type ObjectStore,
  type RemoteProviderGateway,
  type RemoteSegmentDispatcher,
  type SecretStore,
  type SegmentRequest,
  type Transcoder
} from './index.js';
import {
  MemoryCoordinationStore,
  MemorySecretStore,
  PrometheusMetricsSink,
  SqliteRepository
} from '@vrrelay/adapters';
import type {
  BackendStatus,
  CachedObject,
  ClusterNode,
  ProfileRevision,
  RelaySession,
  VodProducer
} from '@vrrelay/domain';
import { LiveService, ProfileService, ProviderService, SessionService } from './services.js';

const dirs: string[] = [];
const repositories: SqliteRepository[] = [];
const mediaCapabilities = {
  ffmpegVersion: 'test',
  encoders: [{ name: 'libx264', codec: 'h264', hardware: false, available: true }],
  muxers: ['hls', 'mpegts'],
  filters: [],
  pixelFormats: ['yuv420p']
};

function trackRepository<T extends SqliteRepository>(repository: T): T {
  repositories.push(repository);
  return repository;
}

afterEach(async () => {
  for (const repository of repositories.splice(0).reverse()) repository.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const provider: MediaProvider = {
  type: 'jellyfin',
  capabilities: ['search', 'direct_source'],
  authenticate: async () => {
    throw new Error();
  },
  validate: async () => {},
  browse: async () => ({ items: [], total: 0 }),
  item: async (c, _s, id) => ({
    id,
    providerId: c.id,
    name: 'Finite film',
    kind: 'Movie',
    durationSeconds: 10
  }),
  resolveSource: async () => ({
    url: 'https://source.invalid/file',
    headers: {},
    durationSeconds: 10,
    fingerprint: 'v1'
  }),
  openSource: async () => {
    throw new Error();
  },
  reportPlayback: async () => {}
};

class CapturingLiveNormalizer implements LiveNormalizer {
  readonly starts: Array<{
    channelId: string;
    sourceUrl: string;
    destinationUrl: string;
    profile: ProfileRevision;
  }> = [];
  readonly runningChannels = new Set<string>();

  async start(
    channelId: string,
    _ownerId: string | undefined,
    sourceUrl: string,
    destinationUrl: string,
    profile: ProfileRevision
  ): Promise<void> {
    this.starts.push({ channelId, sourceUrl, destinationUrl, profile });
    this.runningChannels.add(channelId);
  }

  async stop(channelId: string): Promise<void> {
    this.runningChannels.delete(channelId);
  }

  running(channelId: string): boolean {
    return this.runningChannels.has(channelId);
  }
}

class TrackingSecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];

  async put(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async get(ref: string): Promise<string> {
    const value = this.values.get(ref);
    if (value === undefined) throw new Error('Secret not found');
    return value;
  }

  async delete(ref: string): Promise<void> {
    this.deleted.push(ref);
    this.values.delete(ref);
  }

  refs(): string[] {
    return [...this.values.keys()];
  }
}

class MutableMemoryObjectStore implements ObjectStore {
  readonly kind = 'local';
  readonly deleted: string[] = [];
  readonly #objects = new Map<string, { object: CachedObject; body: Buffer }>();

  keys(): string[] {
    return [...this.#objects.keys()];
  }

  corrupt(key: string, replacement: string): void {
    const stored = this.#objects.get(key);
    if (!stored) throw new Error(`Missing object ${key}`);
    stored.body = Buffer.from(replacement);
  }

  async put(
    key: string,
    source: Readable,
    options: Parameters<ObjectStore['put']>[2]
  ): Promise<CachedObject> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const now = new Date().toISOString();
    const sha256 = options.sha256 ?? createHash('sha256').update(body).digest('hex');
    const object: CachedObject = {
      key,
      size: body.byteLength,
      contentType: options.contentType,
      sha256,
      expiresAt: options.expiresAt ?? null,
      createdAt: now,
      lastAccessedAt: now
    };
    this.#objects.set(key, { object, body });
    return object;
  }

  async stat(key: string): Promise<CachedObject | undefined> {
    return this.#objects.get(key)?.object;
  }

  async open(key: string): Promise<Readable | undefined> {
    const stored = this.#objects.get(key);
    return stored ? Readable.from(stored.body) : undefined;
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.#objects.delete(key);
  }

  async health(): Promise<BackendStatus> {
    return {
      category: 'object-store',
      kind: 'local',
      healthy: true,
      checkedAt: new Date().toISOString()
    };
  }
}

function providerBindingRegistry(): DefaultProviderRegistry {
  const registry = new DefaultProviderRegistry();
  registry.register({
    ...provider,
    authenticate: async (_baseUrl, credentials) => ({
      accessToken: `token-${credentials.username ?? credentials.apiKey ?? 'unknown'}`,
      userId: 'fixture-user',
      username: credentials.username ?? 'fixture-user',
      serverName: 'Fixture',
      serverVersion: '1.0.0'
    })
  });
  return registry;
}

function providerBindingInput(username: string) {
  return {
    type: 'jellyfin' as const,
    name: 'Fixture',
    baseUrl: 'https://fixture.invalid',
    normalizedBaseUrl: 'https://fixture.invalid',
    authMode: 'user_token' as const,
    username,
    password: 'fixture-password',
    allowPublicHttp: false
  };
}

function sourceWorkerNode(id: string): ClusterNode {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    roles: ['source-worker'],
    region: 'local',
    publicUrl: `https://${id}.invalid`,
    state: 'online' as const,
    capabilities: {
      encoders: ['libx264'],
      hardwareDevices: [],
      maxWorkers: 2,
      activeWorkers: 0,
      queuedWorkers: 0,
      cacheBytes: 0,
      cacheLimitBytes: null,
      egressMbps: 0,
      providerIds: [],
      vodProducerVersion: 1
    },
    weight: 100,
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now
  };
}

class SessionConflictRepository extends SqliteRepository {
  #viewersBeforeNextSessionUpdate: number | undefined;
  #stopBeforeNextViewerUpdate = false;
  #viewerSaltFailures = 0;

  injectViewersBeforeNextSessionUpdate(viewers: number): void {
    this.#viewersBeforeNextSessionUpdate = viewers;
  }

  injectStopBeforeNextViewerUpdate(): void {
    this.#stopBeforeNextViewerUpdate = true;
  }

  injectViewerSaltFailure(): void {
    this.#viewerSaltFailures += 1;
  }

  override async getSetting(key: string): Promise<string | undefined> {
    if (key === 'metrics.viewer_salt' && this.#viewerSaltFailures > 0) {
      this.#viewerSaltFailures -= 1;
      throw new Error('simulated viewer salt outage');
    }
    return super.getSetting(key);
  }

  override async compareAndSetSession(
    session: Parameters<SqliteRepository['compareAndSetSession']>[0],
    expectedRevision: number
  ) {
    const viewers = this.#viewersBeforeNextSessionUpdate;
    if (viewers !== undefined) {
      this.#viewersBeforeNextSessionUpdate = undefined;
      const current = (await this.getVersionedSession(session.id))!;
      await super.setSessionViewers(
        session.id,
        current.revision,
        viewers,
        new Date().toISOString()
      );
      return {
        applied: false as const,
        reason: 'revision-conflict' as const,
        current: (await this.getVersionedSession(session.id))!
      };
    }
    return super.compareAndSetSession(session, expectedRevision);
  }

  override async setSessionViewers(
    sessionId: string,
    expectedRevision: number,
    viewers: number,
    updatedAt: string
  ) {
    if (this.#stopBeforeNextViewerUpdate) {
      this.#stopBeforeNextViewerUpdate = false;
      const current = (await this.getVersionedSession(sessionId))!;
      await super.compareAndSetSession(
        { ...current.value, state: 'stopped', updatedAt: new Date().toISOString() },
        current.revision
      );
      return {
        applied: false as const,
        reason: 'revision-conflict' as const,
        current: (await this.getVersionedSession(sessionId))!
      };
    }
    return super.setSessionViewers(sessionId, expectedRevision, viewers, updatedAt);
  }
}

type ProfileInputOverrides = Omit<
  Partial<CreateProfileRevisionRequest>,
  'video' | 'audio' | 'delivery' | 'processing'
> & {
  video?: Partial<CreateProfileRevisionRequest['video']>;
  audio?: Partial<CreateProfileRevisionRequest['audio']>;
  delivery?: Partial<CreateProfileRevisionRequest['delivery']>;
  processing?: Partial<CreateProfileRevisionRequest['processing']>;
};

function profileInput(overrides: ProfileInputOverrides = {}): CreateProfileRevisionRequest {
  const base: CreateProfileRevisionRequest = {
    name: 'Profile experiment',
    platform: 'universal',
    state: 'experimental',
    video: {
      codec: 'h264',
      encoder: 'libx264',
      hardwareMode: 'software',
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
    audio: {
      codec: 'aac',
      channels: 2,
      layout: 'stereo',
      sampleRate: 48_000,
      bitrateKbps: 192
    },
    delivery: {
      method: 'hls',
      container: 'mpegts',
      segmentType: 'mpegts',
      segmentDuration: 4,
      playlistType: 'vod',
      latencyMode: 'standard'
    },
    processing: {
      toneMap: false,
      burnSubtitles: false,
      passthrough: 'never',
      maxWorkers: 2
    }
  };
  return {
    ...base,
    ...overrides,
    video: { ...base.video, ...(overrides.video ?? {}) },
    audio: { ...base.audio, ...(overrides.audio ?? {}) },
    delivery: { ...base.delivery, ...(overrides.delivery ?? {}) },
    processing: { ...base.processing, ...(overrides.processing ?? {}) }
  };
}

async function ownedVodSessionFixture(
  repository: SqliteRepository,
  secrets: SecretStore,
  directory: string
) {
  await repository.migrate();
  const now = new Date().toISOString();
  const providerId = 'provider-session-source-pending';
  const ownerId = 'owner-session-source-pending';
  const providerUserId = 'user-session-source-pending';
  await repository.createProvider({
    id: providerId,
    type: 'jellyfin',
    name: 'Pending source credential provider',
    baseUrl: 'https://media.invalid',
    authMode: 'user_token',
    secretRef: 'provider:session-source-pending',
    capabilities: ['search', 'direct_source'],
    healthy: true,
    createdAt: now,
    updatedAt: now
  });
  await repository.createUserIdentity({
    id: ownerId,
    providerId,
    providerUserId,
    displayName: 'Pending credential owner',
    roles: ['user'],
    allowedProfileIds: ['universal-h264-hls-vod'],
    defaultProfileId: 'universal-h264-hls-vod',
    firstSeenAt: now,
    lastSeenAt: now
  });
  await new ProfileService(repository).seed(mediaCapabilities);
  const registry = new DefaultProviderRegistry();
  registry.register(provider);
  const service = new SessionService(
    repository,
    secrets,
    registry,
    {
      discover: async () => mediaCapabilities,
      generateSegment: async () => {}
    },
    new InMemoryEventBus(),
    {
      publicUrl: 'https://relay.invalid',
      internalUrl: 'http://127.0.0.1:8099',
      cacheDir: join(directory, 'cache'),
      cacheTtlMs: 60_000,
      maxWorkers: 1
    }
  );
  return {
    service,
    create: () =>
      service.create(
        {
          kind: 'vod',
          source: { providerId, itemId: 'movie' },
          profileId: 'universal-h264-hls-vod',
          profileRevision: 1,
          platformMode: 'universal',
          pinned: false,
          reportActivity: false,
          placementPolicy: 'local',
          placementLocked: false,
          playbackTtlSeconds: null
        },
        {
          ownerId,
          providerAccessToken: 'user-source-access-token',
          providerUserId
        }
      )
  };
}

describe('profile lifecycle', () => {
  it('prefers an available hardware encoder for the built-in profiles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-profile-portable-seed-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const service = new ProfileService(repo, {
      ...mediaCapabilities,
      encoders: [
        { name: 'h264_videotoolbox', codec: 'h264', hardware: true, available: true },
        ...mediaCapabilities.encoders
      ]
    });

    await service.seed();

    expect(await service.list()).toHaveLength(5);
    expect(
      (await service.list()).every(
        (seeded) =>
          seeded.video.encoder === 'h264_videotoolbox' &&
          seeded.video.hardwareMode === 'videotoolbox'
      )
    ).toBe(true);
  });

  it('uses a supported forced encoder for all built-in profiles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-profile-forced-encoder-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const service = new ProfileService(
      repo,
      {
        ...mediaCapabilities,
        encoders: [
          { name: 'h264_videotoolbox', codec: 'h264', hardware: true, available: true },
          ...mediaCapabilities.encoders
        ]
      },
      'libx264'
    );

    await service.seed();

    expect(
      (await service.list()).every(
        (seeded) => seeded.video.encoder === 'libx264' && seeded.video.hardwareMode === 'software'
      )
    ).toBe(true);
  });

  it('rejects a forced encoder that is unavailable on the relay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-profile-unavailable-encoder-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const service = new ProfileService(repo, mediaCapabilities, 'h264_videotoolbox');

    await expect(service.seed()).rejects.toThrow(/forced encoder is not available/);
  });

  it('moves seeded profiles to a newly forced encoder after a policy change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-profile-encoder-change-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const capabilities = {
      ...mediaCapabilities,
      encoders: [
        { name: 'h264_videotoolbox', codec: 'h264', hardware: true, available: true },
        ...mediaCapabilities.encoders
      ]
    };

    await new ProfileService(repo, capabilities).seed();
    await new ProfileService(repo, capabilities, 'libx264').seed();

    expect(await repo.getProfile('universal-h264-hls-vod')).toMatchObject({
      revision: 2,
      video: { encoder: 'libx264', hardwareMode: 'software' }
    });
  });

  it('keeps an untouched hardware-accelerated built-in profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-profile-portable-migration-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const createdAt = new Date().toISOString();
    await repo.putProfile({
      ...profileInput({
        name: 'Universal H.264 / AAC HLS',
        video: { encoder: 'h264_videotoolbox', hardwareMode: 'videotoolbox' }
      }),
      profileId: 'universal-h264-hls-vod',
      revision: 1,
      description: 'Finite MPEG-TS HLS VOD baseline for PC and Quest testing.',
      createdAt
    });
    const service = new ProfileService(repo, {
      ...mediaCapabilities,
      encoders: [
        { name: 'h264_videotoolbox', codec: 'h264', hardware: true, available: true },
        ...mediaCapabilities.encoders
      ]
    });

    await service.seed();

    await expect(repo.getProfile('universal-h264-hls-vod')).resolves.toMatchObject({
      revision: 1,
      video: { encoder: 'h264_videotoolbox', hardwareMode: 'videotoolbox' }
    });
    await expect(repo.getProfile('universal-h264-hls-vod', 1)).resolves.toMatchObject({
      revision: 1,
      video: { encoder: 'h264_videotoolbox', hardwareMode: 'videotoolbox' }
    });
  });

  it('accepts implemented HLS profile shapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-profile-implemented-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const service = new ProfileService(repo, mediaCapabilities);

    await expect(service.createRevision(profileInput())).resolves.toMatchObject({
      profileId: expect.any(String),
      revision: 1,
      delivery: { method: 'hls', container: 'mpegts', segmentType: 'mpegts' }
    });
  });

  it.each([
    ['manual verified state', { state: 'verified' }, /must start as experimental/],
    ['RTSP delivery', { delivery: { method: 'rtsp' } }, /RTSP and HTTP MPEG-TS/],
    ['HTTP MPEG-TS delivery', { delivery: { method: 'mpegts_http' } }, /RTSP and HTTP MPEG-TS/],
    ['low-latency delivery', { delivery: { latencyMode: 'low' } }, /Low-latency/],
    ['HLS event playlist', { delivery: { playlistType: 'event' } }, /event playlists/],
    [
      'mismatched HLS segment shape',
      { delivery: { container: 'fmp4', segmentType: 'mpegts' } },
      /matching MPEG-TS or fMP4/
    ],
    [
      'direct fragmented MP4 delivery',
      {
        delivery: {
          method: 'fragmented_mp4',
          container: 'mp4',
          segmentType: 'none',
          playlistType: 'vod'
        }
      } as unknown as ProfileInputOverrides,
      /Direct fragmented MP4/
    ],
    [
      'schema-only passthrough policy',
      { processing: { passthrough: 'compatible' } },
      /Passthrough policy/
    ]
  ] as Array<[string, ProfileInputOverrides, RegExp]>)(
    'rejects unsupported %s profile revisions',
    async (_name, overrides, expected) => {
      const dir = await mkdtemp(join(tmpdir(), 'vrrelay-profile-rejected-'));
      dirs.push(dir);
      const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
      await repo.migrate();
      const service = new ProfileService(repo, mediaCapabilities);

      await expect(service.createRevision(profileInput(overrides))).rejects.toThrow(expected);
      await expect(repo.listProfiles()).resolves.toEqual([]);
    }
  );

  it.each([
    [
      'encoder',
      { video: { encoder: 'h264_nvenc', hardwareMode: 'nvenc' } },
      /video encoder is not available/
    ],
    ['pixel format', { video: { pixelFormat: 'yuv444p' } }, /pixel format is not available/]
  ] as Array<[string, ProfileInputOverrides, RegExp]>)(
    'rejects a profile whose %s was not discovered',
    async (_name, overrides, expected) => {
      const dir = await mkdtemp(join(tmpdir(), 'vrrelay-profile-capability-'));
      dirs.push(dir);
      const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
      await repo.migrate();
      const service = new ProfileService(repo, mediaCapabilities);

      await expect(service.createRevision(profileInput(overrides))).rejects.toThrow(expected);
      await expect(repo.listProfiles()).resolves.toEqual([]);
    }
  );
});

describe('VOD relay service', () => {
  it('dispatches Stop to the durable remote producer owner after failover', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-remote-stop-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'remote-stop-provider',
      type: 'jellyfin',
      name: 'Remote stop fixture',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 'remote-stop-secret',
      capabilities: ['direct_source'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const session: RelaySession = {
      id: 'remote-stop-session',
      name: 'Remote stop fixture',
      kind: 'vod',
      source: {
        providerId: 'remote-stop-provider',
        itemId: 'movie',
        versionId: 'version-1'
      },
      profileId: 'remote-stop-profile',
      profileRevision: 1,
      platformMode: 'universal',
      state: 'idle',
      durationSeconds: 120,
      pinned: false,
      reportActivity: false,
      viewers: 0,
      placementPolicy: 'auto',
      assignedNodeId: 'source-worker-a',
      placementLocked: false,
      outputUrls: {
        primary: 'https://relay.example/play/remote-stop-fixture/index.m3u8'
      },
      createdAt: now,
      updatedAt: now
    };
    expect(
      (
        await repo.createSessionWithPlaybackGrant(session, {
          tokenHash: 'remote-stop-grant',
          sessionId: session.id,
          expiresAt: null,
          revokedAt: null,
          createdAt: now
        })
      ).applied
    ).toBe(true);
    const producer: VodProducer = {
      id: session.id,
      sessionId: session.id,
      ownerNodeId: 'source-worker-b',
      generation: 2,
      state: 'running',
      demandedSegmentIndex: 0,
      startSegmentIndex: 0,
      playbackAnchorSegmentIndex: 0,
      playbackAnchorAt: now,
      lastDemandAt: now,
      workerHistory: [
        {
          generation: 2,
          nodeId: 'source-worker-b',
          state: 'running',
          startSegmentIndex: 0,
          startedAt: now
        }
      ],
      createdAt: now,
      updatedAt: now
    };
    expect((await repo.createVodProducer(producer)).created).toBe(true);
    const stopProducer = vi.fn<NonNullable<RemoteSegmentDispatcher['stopProducer']>>(
      async () => undefined
    );
    const dispatcher: RemoteSegmentDispatcher = {
      connected: () => true,
      dispatch: async () => undefined,
      stopProducer,
      cancel: async () => undefined
    };
    const service = new SessionService(
      repo,
      new MemorySecretStore(),
      new DefaultProviderRegistry(),
      {
        discover: async () => ({
          ffmpegVersion: 'test',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => undefined
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 1_000,
        maxWorkers: 1,
        nodeId: 'controller-a',
        roles: ['controller']
      },
      { clusterRepository: repo, dispatcher }
    );

    await expect(service.control(session.id, { state: 'stopped' })).resolves.toMatchObject({
      state: 'stopped'
    });
    expect(stopProducer).toHaveBeenCalledOnce();
    expect(stopProducer).toHaveBeenCalledWith('source-worker-b', session.id);
  });

  it('recovers an orphan source credential after immediate cleanup fails once', async () => {
    class RejectedSessionRepository extends SqliteRepository {
      override async createSessionWithPlaybackGrant(
        _session: Parameters<SqliteRepository['createSessionWithPlaybackGrant']>[0],
        _grant: Parameters<SqliteRepository['createSessionWithPlaybackGrant']>[1],
        _expectedLiveChannelRevision?: number
      ) {
        return { applied: false as const, reason: 'not-found' as const };
      }
    }
    class FailOnceSecretStore extends TrackingSecretStore {
      #failed = false;

      override async delete(ref: string): Promise<void> {
        if (!this.#failed && ref.startsWith('session-source:')) {
          this.#failed = true;
          throw new Error('simulated source credential cleanup outage');
        }
        await super.delete(ref);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-source-orphan-'));
    dirs.push(dir);
    const repo = trackRepository(new RejectedSessionRepository(join(dir, 'db.sqlite')));
    const secrets = new FailOnceSecretStore();
    const fixture = await ownedVodSessionFixture(repo, secrets, dir);

    await expect(fixture.create()).rejects.toThrow('Provider connection was not found');
    const [pending] = await repo.listSettingsByPrefix('session.sourceCredential.pending.');
    expect(pending).toBeDefined();
    expect(pending!.value).toMatch(/^session-source:/);
    expect(pending!.value).not.toContain('user-source-access-token');
    await expect(secrets.get(pending!.value)).resolves.toContain('user-source-access-token');
    await expect(repo.listSessions()).resolves.toEqual([]);

    await expect(fixture.service.recover()).resolves.toBe(1);
    await expect(repo.listSettingsByPrefix('session.sourceCredential.pending.')).resolves.toEqual(
      []
    );
    await expect(secrets.get(pending!.value)).rejects.toThrow('Secret not found');
  });

  it('clears a failed pending-index cleanup without deleting an active session credential', async () => {
    class FailOncePendingDeleteRepository extends SqliteRepository {
      #failed = false;

      override async deleteSetting(key: string): Promise<void> {
        if (!this.#failed && key.startsWith('session.sourceCredential.pending.')) {
          this.#failed = true;
          throw new Error('simulated pending-index cleanup outage');
        }
        await super.deleteSetting(key);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-source-active-'));
    dirs.push(dir);
    const repo = trackRepository(new FailOncePendingDeleteRepository(join(dir, 'db.sqlite')));
    const secrets = new TrackingSecretStore();
    const fixture = await ownedVodSessionFixture(repo, secrets, dir);

    const session = await fixture.create();
    const secretRef = `session-source:${session.id}`;
    await expect(repo.listSettingsByPrefix('session.sourceCredential.pending.')).resolves.toEqual([
      { key: `session.sourceCredential.pending.${session.id}`, value: secretRef }
    ]);
    await expect(secrets.get(secretRef)).resolves.toContain('user-source-access-token');

    await expect(fixture.service.recover()).resolves.toBe(1);
    await expect(repo.getSession(session.id)).resolves.toMatchObject({ id: session.id });
    await expect(secrets.get(secretRef)).resolves.toContain('user-source-access-token');
    expect(secrets.deleted).not.toContain(secretRef);
    await expect(repo.listSettingsByPrefix('session.sourceCredential.pending.')).resolves.toEqual(
      []
    );
  });

  it('retains a committed source credential when commit acknowledgement and reconciliation fail', async () => {
    class AmbiguousSessionCommitRepository extends SqliteRepository {
      #failNextSessionRead = false;

      override async createSessionWithPlaybackGrant(
        session: Parameters<SqliteRepository['createSessionWithPlaybackGrant']>[0],
        grant: Parameters<SqliteRepository['createSessionWithPlaybackGrant']>[1],
        expectedLiveChannelRevision?: number
      ) {
        const result = await super.createSessionWithPlaybackGrant(
          session,
          grant,
          expectedLiveChannelRevision
        );
        if (result.applied) {
          this.#failNextSessionRead = true;
          throw new Error('simulated lost session commit acknowledgement');
        }
        return result;
      }

      override async getSession(id: string): Promise<RelaySession | undefined> {
        if (this.#failNextSessionRead) {
          this.#failNextSessionRead = false;
          throw new Error('simulated reconciliation read outage');
        }
        return super.getSession(id);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-source-ambiguous-'));
    dirs.push(dir);
    const repo = trackRepository(new AmbiguousSessionCommitRepository(join(dir, 'db.sqlite')));
    const secrets = new TrackingSecretStore();
    const fixture = await ownedVodSessionFixture(repo, secrets, dir);

    await expect(fixture.create()).rejects.toThrow('simulated lost session commit acknowledgement');
    const [session] = await repo.listSessions();
    expect(session).toBeDefined();
    const secretRef = `session-source:${session!.id}`;
    await expect(secrets.get(secretRef)).resolves.toContain('user-source-access-token');
    expect(secrets.deleted).not.toContain(secretRef);
    await expect(repo.listSettingsByPrefix('session.sourceCredential.pending.')).resolves.toEqual([
      { key: `session.sourceCredential.pending.${session!.id}`, value: secretRef }
    ]);

    await expect(fixture.service.recover()).resolves.toBe(1);
    await expect(repo.getSession(session!.id)).resolves.toMatchObject({ id: session!.id });
    await expect(secrets.get(secretRef)).resolves.toContain('user-source-access-token');
    expect(secrets.deleted).not.toContain(secretRef);
    await expect(repo.listSettingsByPrefix('session.sourceCredential.pending.')).resolves.toEqual(
      []
    );
  });

  it.each([
    ['not-found', 'Provider connection was not found'],
    ['invalid-state', 'Provider connection is being deleted']
  ] as const)(
    'maps an atomic provider %s failure without mentioning live channels',
    async (reason, expectedMessage) => {
      class ProviderFailureRepository extends SqliteRepository {
        override async createSessionWithPlaybackGrant(
          session: Parameters<SqliteRepository['createSessionWithPlaybackGrant']>[0],
          grant: Parameters<SqliteRepository['createSessionWithPlaybackGrant']>[1],
          expectedLiveChannelRevision?: number
        ) {
          if (session.kind === 'vod') return { applied: false as const, reason };
          return super.createSessionWithPlaybackGrant(session, grant, expectedLiveChannelRevision);
        }
      }

      const dir = await mkdtemp(join(tmpdir(), `vrrelay-vod-provider-${reason}-`));
      dirs.push(dir);
      const repo = trackRepository(new ProviderFailureRepository(join(dir, 'db.sqlite')));
      await repo.migrate();
      const now = new Date().toISOString();
      await repo.createProvider({
        id: 'provider-atomic-failure',
        type: 'jellyfin',
        name: 'Fixture provider',
        baseUrl: 'https://media.invalid',
        authMode: 'user_token',
        secretRef: 'provider:atomic-failure',
        capabilities: ['search', 'direct_source'],
        healthy: true,
        createdAt: now,
        updatedAt: now
      });
      await new ProfileService(repo).seed({
        ffmpegVersion: 'test',
        encoders: [{ name: 'libx264', codec: 'h264', hardware: false, available: true }],
        muxers: ['mpegts'],
        filters: [],
        pixelFormats: ['yuv420p']
      });
      const secrets = new MemorySecretStore();
      await secrets.put('provider:atomic-failure', 'access-token');
      const registry = new DefaultProviderRegistry();
      registry.register(provider);
      const service = new SessionService(
        repo,
        secrets,
        registry,
        {
          discover: async () => ({
            ffmpegVersion: 'test',
            encoders: [],
            muxers: [],
            filters: [],
            pixelFormats: []
          }),
          generateSegment: async () => {}
        },
        new InMemoryEventBus(),
        {
          publicUrl: 'https://relay.example',
          internalUrl: 'http://127.0.0.1:8099',
          cacheDir: join(dir, 'cache'),
          cacheTtlMs: 1_000,
          maxWorkers: 1
        }
      );

      let failure: unknown;
      try {
        await service.create({
          kind: 'vod',
          source: { providerId: 'provider-atomic-failure', itemId: 'movie' },
          profileId: 'universal-h264-hls-vod',
          profileRevision: 1,
          platformMode: 'universal',
          pinned: false,
          reportActivity: false,
          placementPolicy: 'local',
          placementLocked: false,
          playbackTtlSeconds: null
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(expectedMessage);
      expect((failure as Error).message).not.toMatch(/live channel/i);
    }
  );

  it('pins the profile default audio language when a VOD source has multiple tracks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-audio-language-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'p-audio-language',
      type: 'jellyfin',
      name: 'Fixture',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 'audio-language-secret',
      capabilities: ['search', 'direct_source'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const secrets = new MemorySecretStore();
    await secrets.put('audio-language-secret', 'token');
    const languageProvider: MediaProvider = {
      ...provider,
      item: async (connection, _secret, id) => ({
        id,
        providerId: connection.id,
        name: 'Multilingual film',
        kind: 'Movie',
        durationSeconds: 120,
        audioTracks: [
          {
            id: 'audio-eng',
            index: 0,
            kind: 'audio',
            title: 'English',
            language: 'eng',
            isDefault: true
          },
          {
            id: 'audio-jpn',
            index: 1,
            kind: 'audio',
            title: 'Japanese',
            language: 'ja'
          }
        ]
      })
    };
    const registry = new DefaultProviderRegistry();
    registry.register(languageProvider);
    const profiles = new ProfileService(repo, mediaCapabilities);
    const selectedProfile = await profiles.createRevision(
      profileInput({
        profileId: 'language-profile',
        audio: { defaultLanguage: 'jpn' }
      })
    );
    const service = new SessionService(
      repo,
      secrets,
      registry,
      {
        discover: async () => ({
          ffmpegVersion: 'test',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => {}
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 1_000,
        maxWorkers: 1
      }
    );

    const session = await service.create({
      kind: 'vod',
      source: { providerId: 'p-audio-language', itemId: 'movie' },
      profileId: selectedProfile.profileId,
      profileRevision: selectedProfile.revision,
      platformMode: 'universal',
      pinned: false,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    expect(session.source?.audioTrackId).toBe('audio-jpn');

    const explicit = await service.create({
      kind: 'vod',
      source: { providerId: 'p-audio-language', itemId: 'movie', audioTrackId: 'audio-eng' },
      profileId: selectedProfile.profileId,
      profileRevision: selectedProfile.revision,
      platformMode: 'universal',
      pinned: false,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    expect(explicit.source?.audioTrackId).toBe('audio-eng');
  });

  it('reports upstream source requests and active connection state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-source-stats-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'p-source-stats',
      type: 'jellyfin',
      name: 'Fixture',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 'source-stats-secret',
      capabilities: ['search', 'direct_source'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const secrets = new MemorySecretStore();
    await secrets.put('source-stats-secret', 'token');
    const sourceProvider: MediaProvider = {
      ...provider,
      openSource: async () => ({
        status: 200,
        headers: {},
        stream: Readable.from([Buffer.from('source')])
      })
    };
    const registry = new DefaultProviderRegistry();
    registry.register(sourceProvider);
    const selectedProfile = await new ProfileService(repo, mediaCapabilities).createRevision(
      profileInput({ profileId: 'source-stats-profile' })
    );
    let service!: SessionService;
    const transcoder: Transcoder = {
      discover: async () => ({
        ffmpegVersion: 'test',
        encoders: [],
        muxers: [],
        filters: [],
        pixelFormats: []
      }),
      generateSegment: async (request, destination) => {
        const grantToken = request.source.url.split('/internal/source/')[1];
        if (!grantToken) throw new Error('Missing source grant');
        const response = await service.openSourceProxy(grantToken);
        const chunks: Buffer[] = [];
        for await (const chunk of response.stream)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.concat(chunks));
      }
    };
    service = new SessionService(repo, secrets, registry, transcoder, new InMemoryEventBus(), {
      publicUrl: 'https://relay.example',
      internalUrl: 'http://127.0.0.1:8099',
      cacheDir: join(dir, 'cache'),
      cacheTtlMs: 1_000,
      maxWorkers: 1
    });
    const session = await service.create({
      kind: 'vod',
      source: { providerId: 'p-source-stats', itemId: 'movie' },
      profileId: selectedProfile.profileId,
      profileRevision: selectedProfile.revision,
      platformMode: 'universal',
      pinned: false,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    const token = session.outputUrls.primary!.split('/play/')[1]!.split('/')[0]!;
    await service.segment(token, 0);
    await expect(service.runtimeStats(session)).resolves.toMatchObject({
      sourceConnectionCount: 0,
      sourceRequestsLast30s: 1
    });
  });

  it('falls back to one-segment generation when persistent VOD production is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-producer-fallback-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'p-producer-fallback',
      type: 'jellyfin',
      name: 'Fixture',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 'producer-fallback-secret',
      capabilities: ['search', 'direct_source'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const secrets = new MemorySecretStore();
    await secrets.put('producer-fallback-secret', 'token');
    const registry = new DefaultProviderRegistry();
    registry.register(provider);
    const selectedProfile = await new ProfileService(repo, mediaCapabilities).createRevision(
      profileInput({ profileId: 'producer-fallback-profile' })
    );
    const service = new SessionService(
      repo,
      secrets,
      registry,
      {
        discover: async () => mediaCapabilities,
        generateSegment: async (_request, destination) => {
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, 'fallback-segment');
        }
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 1_000,
        maxWorkers: 1
      },
      {
        objectStore: new MutableMemoryObjectStore(),
        coordination: new MemoryCoordinationStore(),
        clusterRepository: repo
      }
    );
    const session = await service.create({
      kind: 'vod',
      source: { providerId: 'p-producer-fallback', itemId: 'movie' },
      profileId: selectedProfile.profileId,
      profileRevision: selectedProfile.revision,
      platformMode: 'universal',
      pinned: false,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    const token = session.outputUrls.primary!.split('/play/')[1]!.split('/')[0]!;
    await expect(service.segment(token, 0)).resolves.toMatch(/0\.ts$/);
  });

  it('keeps concurrent source ranges alive until their own request or producer signal ends', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-source-ranges-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'p-source-ranges',
      type: 'jellyfin',
      name: 'Fixture',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 'source-ranges-secret',
      capabilities: ['search', 'direct_source'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const secrets = new MemorySecretStore();
    await secrets.put('source-ranges-secret', 'token');
    const opened: Array<{ range?: string; signal?: AbortSignal }> = [];
    const streams: PassThrough[] = [];
    const sourceProvider: MediaProvider = {
      ...provider,
      openSource: async (_source, range, signal) => {
        const stream = new PassThrough();
        opened.push({ ...(range ? { range } : {}), ...(signal ? { signal } : {}) });
        streams.push(stream);
        signal?.addEventListener('abort', () => stream.destroy(signal.reason), { once: true });
        return { status: 206, headers: {}, stream };
      }
    };
    const registry = new DefaultProviderRegistry();
    registry.register(sourceProvider);
    const selectedProfile = await new ProfileService(repo, mediaCapabilities).createRevision(
      profileInput({ profileId: 'source-ranges-profile' })
    );
    let service!: SessionService;
    const transcoder: Transcoder = {
      discover: async () => ({
        ffmpegVersion: 'test',
        encoders: [],
        muxers: [],
        filters: [],
        pixelFormats: []
      }),
      generateSegment: async (request, destination, signal) => {
        const grantToken = request.source.url.split('/internal/source/')[1];
        if (!grantToken) throw new Error('Missing source grant');
        const response = await service.openSourceProxy(
          grantToken,
          `bytes=${request.segmentIndex * 10}-`,
          signal
        );
        expect(response.sourceRequestId).toMatch(/^[0-9a-f-]{36}$/);
        const chunks: Buffer[] = [];
        for await (const chunk of response.stream)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.concat(chunks));
      }
    };
    service = new SessionService(repo, secrets, registry, transcoder, new InMemoryEventBus(), {
      publicUrl: 'https://relay.example',
      internalUrl: 'http://127.0.0.1:8099',
      cacheDir: join(dir, 'cache'),
      cacheTtlMs: 1_000,
      maxWorkers: 2
    });
    const session = await service.create({
      kind: 'vod',
      source: { providerId: 'p-source-ranges', itemId: 'movie' },
      profileId: selectedProfile.profileId,
      profileRevision: selectedProfile.revision,
      platformMode: 'universal',
      pinned: false,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    const token = session.outputUrls.primary!.split('/play/')[1]!.split('/')[0]!;
    const first = service.segment(token, 0, new AbortController().signal);
    for (let attempt = 0; attempt < 100 && streams.length < 1; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const second = service.segment(token, 1, new AbortController().signal);
    for (let attempt = 0; attempt < 100 && streams.length < 2; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(streams).toHaveLength(2);
    expect(opened[0]?.signal?.aborted).toBe(false);
    expect(opened[1]?.signal?.aborted).toBe(false);
    streams[0]!.end(Buffer.from('first range'));
    streams[1]!.end(Buffer.from('second range'));
    await Promise.all([first, second]);
    await expect(service.runtimeStats(session)).resolves.toMatchObject({
      sourceConnectionCount: 0,
      sourceRequestsLast30s: 2
    });
  });

  it('publishes a finite manifest and coalesces identical segment work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-'));
    dirs.push(dir);
    const repo = trackRepository(new SessionConflictRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'p1',
      type: 'jellyfin',
      name: 'Fixture',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 's1',
      capabilities: ['search', 'direct_source'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const secrets = new MemorySecretStore();
    await secrets.put('s1', 'token');
    const registry = new DefaultProviderRegistry();
    registry.register(provider);
    let generated = 0;
    let blockedIndex: number | undefined;
    let blockedFailure: boolean | string = false;
    let blockedStarted = Promise.withResolvers<void>();
    let blockedRelease = Promise.withResolvers<void>();
    const blockSegment = (index: number, fail: boolean | string) => {
      blockedIndex = index;
      blockedFailure = fail;
      blockedStarted = Promise.withResolvers<void>();
      blockedRelease = Promise.withResolvers<void>();
      return {
        started: blockedStarted.promise,
        release: () => blockedRelease.resolve()
      };
    };
    const transcoder: Transcoder = {
      discover: async () => ({
        ffmpegVersion: 'test',
        encoders: [],
        muxers: [],
        filters: [],
        pixelFormats: []
      }),
      generateSegment: async (request: SegmentRequest, destination: string) => {
        generated++;
        expect(request.source.url).toMatch(/^http:\/\/127\.0\.0\.1:8099\/internal\/source\//);
        expect(request.source.headers).toEqual({});
        if (request.segmentIndex === blockedIndex) {
          blockedStarted.resolve();
          await blockedRelease.promise;
          blockedIndex = undefined;
          if (blockedFailure)
            throw new Error(
              typeof blockedFailure === 'string' ? blockedFailure : 'Simulated late worker failure'
            );
        }
        await new Promise((r) => setTimeout(r, 20));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, 'segment');
      }
    };
    const profileService = new ProfileService(repo, mediaCapabilities);
    await profileService.seed({
      ffmpegVersion: 'test',
      encoders: [{ name: 'libx264', codec: 'h264', hardware: false, available: true }],
      muxers: ['mpegts'],
      filters: [],
      pixelFormats: ['yuv420p']
    });
    const metrics = new PrometheusMetricsSink();
    const service = new SessionService(
      repo,
      secrets,
      registry,
      transcoder,
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 1000,
        maxWorkers: 1
      },
      { metrics, clusterRepository: repo }
    );
    const session = await service.create({
      kind: 'vod',
      source: { providerId: 'p1', itemId: 'm1' },
      profileId: 'universal-h264-hls-vod',
      profileRevision: 1,
      platformMode: 'universal',
      pinned: false,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    const token = session.outputUrls.primary!.split('/play/')[1]!.split('/')[0]!;
    const manifest = await service.manifest(token);
    expect(manifest).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(manifest).toContain('#EXT-X-ENDLIST');
    expect(manifest.match(/#EXTINF/g)).toHaveLength(3);
    const [a, b] = await Promise.all([service.segment(token, 0), service.segment(token, 0)]);
    expect(a).toBe(b);
    expect(await readFile(a, 'utf8')).toBe('segment');
    expect(generated).toBe(1);
    await expect(service.control(session.id, { state: 'stopped' })).resolves.toMatchObject({
      state: 'stopped'
    });
    await expect(service.manifest(token)).rejects.toThrow('Session is stopped');
    await expect(service.segment(token, 1)).rejects.toThrow('Session is stopped');
    await expect(service.control(session.id, { state: 'idle' })).resolves.toMatchObject({
      state: 'idle'
    });
    await expect(service.manifest(token)).resolves.toContain('#EXT-X-ENDLIST');
    const [completedJob] = await service.listJobs();
    expect(completedJob).toMatchObject({
      state: 'complete',
      attempts: 1,
      workerHistory: [{ state: 'complete', nodeId: 'standalone' }]
    });
    const completedLogs = await service.listJobLogs(completedJob!.id);
    expect(completedLogs.map((log) => log.message)).toEqual(
      expect.arrayContaining([
        'Segment job leased for generation',
        'Local segment attempt started',
        'Local segment attempt completed',
        'Segment job completed'
      ])
    );
    const failedAt = new Date().toISOString();
    const completedRecord = (await repo.getVersionedSegmentJob(completedJob!.id))!;
    await expect(
      repo.compareAndSetSegmentJob(
        {
          ...completedJob!,
          state: 'failed',
          errorMessage: 'Simulated operator retry',
          workerHistory: completedJob!.workerHistory.map((attempt) => ({
            ...attempt,
            state: 'failed' as const,
            completedAt: failedAt,
            errorMessage: 'Simulated operator retry'
          })),
          updatedAt: failedAt
        },
        completedRecord.revision,
        ['complete']
      )
    ).resolves.toMatchObject({ applied: true });
    const retried = await service.retryJob(completedJob!.id);
    expect(retried.state).toBe('complete');
    expect(retried.workerHistory.map((attempt) => attempt.state)).toEqual(['failed', 'complete']);
    expect(generated).toBe(2);
    await expect(service.retryJob(completedJob!.id)).rejects.toThrow(
      'Only failed or cancelled segment jobs can be retried'
    );
    expect(await service.cacheUsageBytes()).toBe(Buffer.byteLength('segment'));
    service.recordEgress(10, session.id);
    service.recordEgress(20);
    service.recordIngress(40, session.id);
    expect(service.egressMbps()).toBeCloseTo(0.000000008);
    expect(service.egressMbps(Date.now() + 30_001)).toBe(0);
    const renderedMetrics = await metrics.render();
    expect(renderedMetrics).toContain('vrrelay_egress_bytes_total');
    expect(renderedMetrics).toContain('vrrelay_egress_bytes_total 30');
    expect(renderedMetrics).toContain(
      'vrrelay_segment_jobs_total{mode="local",outcome="complete"} 2'
    );
    expect(renderedMetrics).toContain(
      'vrrelay_segment_job_attempts_total{mode="local",outcome="complete"} 2'
    );
    expect(renderedMetrics).toContain(
      'vrrelay_segment_job_retries_total{mode="unknown",source="manual"} 1'
    );
    expect(renderedMetrics).toContain(
      'vrrelay_segment_generation_seconds_count{delivery="mpegts",encoder="libx264"} 2'
    );
    expect(renderedMetrics).toContain('vrrelay_cache_requests_total{layer="disk",outcome="miss"}');
    expect(renderedMetrics).toContain('vrrelay_workers_active{kind="transcode"} 0');
    expect(renderedMetrics).not.toContain('session=');

    repo.injectViewersBeforeNextSessionUpdate(7);
    await expect(service.control(session.id, { pinned: true })).resolves.toMatchObject({
      pinned: true,
      viewers: 7
    });
    repo.injectViewerSaltFailure();
    await expect(service.touchViewer(token, 'viewer-a')).rejects.toThrow(
      'simulated viewer salt outage'
    );
    repo.injectStopBeforeNextViewerUpdate();
    await service.touchViewer(token, 'viewer-a');
    const runtime = await service.runtimeStats(await service.get(session.id));
    expect(runtime).toMatchObject({
      activity: 'stopped',
      viewers: 1,
      viewerWindowSeconds: 30,
      sourceIngressMbps: expect.any(Number),
      viewerEgressMbps: expect.any(Number),
      cacheHits: expect.any(Number),
      cacheMisses: expect.any(Number)
    });
    expect(runtime.sourceIngressMbps).toBeGreaterThan(0);
    expect(runtime.viewerEgressMbps).toBeGreaterThan(0);
    expect(runtime.cacheMisses).toBeGreaterThan(0);
    await service.cleanupExpiredCache();
    expect(await metrics.render()).toContain('vrrelay_viewers_active 1');
    expect(await metrics.render()).not.toContain('session=');
    await expect(repo.getSession(session.id)).resolves.toMatchObject({
      pinned: true,
      state: 'stopped',
      viewers: 1
    });
    await expect(service.control(session.id, { state: 'idle' })).resolves.toMatchObject({
      state: 'idle'
    });

    for (const [index, fail] of [[1, false]] as const) {
      const gate = blockSegment(index, fail);
      const lateResult = service.segment(token, index);
      await gate.started;
      const job = (await service.listJobs()).find((candidate) => candidate.segmentIndex === index);
      expect(job?.state).toBe('running');
      await service.cancelJob(job!.id);
      gate.release();
      await expect(lateResult).rejects.toThrow(/cancelled/i);
      await expect(repo.getSegmentJob(job!.id)).resolves.toMatchObject({ state: 'cancelled' });
      await expect(service.listJobLogs(job!.id)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: 'Segment job cancelled by administrator' })
        ])
      );
    }
    const sensitiveFailure =
      'Simulated late worker failure token=vrr_join_reusable-secret https://private.invalid/media /internal/source/source-grant /play/playback-grant password=fixture-password';
    const failedGate = blockSegment(2, sensitiveFailure);
    const failedResult = service.segment(token, 2);
    await failedGate.started;
    await expect(service.control(session.id, { state: 'stopped' })).resolves.toMatchObject({
      state: 'stopped'
    });
    failedGate.release();
    await expect(failedResult).rejects.toThrow('Simulated late worker failure');
    const failedJob = (await service.listJobs()).find((candidate) => candidate.segmentIndex === 2);
    expect(failedJob).toMatchObject({ state: 'failed' });
    const failedLogs = await service.listJobLogs(failedJob!.id);
    expect(failedLogs).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: 'Segment job failed' })])
    );
    const serializedFailedLogs = JSON.stringify(failedLogs);
    expect(serializedFailedLogs).not.toContain('vrr_join_reusable-secret');
    expect(serializedFailedLogs).not.toContain('private.invalid');
    expect(serializedFailedLogs).not.toContain('source-grant');
    expect(serializedFailedLogs).not.toContain('playback-grant');
    expect(serializedFailedLogs).not.toContain('fixture-password');
    await expect(repo.getSession(session.id)).resolves.toMatchObject({ state: 'stopped' });
  });

  it('invalidates corrupt object-store restores and regenerates the segment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-object-restore-'));
    dirs.push(dir);
    const repo = trackRepository(new SessionConflictRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'p1',
      type: 'jellyfin',
      name: 'Fixture',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 's1',
      capabilities: ['search', 'direct_source'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const secrets = new MemorySecretStore();
    await secrets.put('s1', 'token');
    const registry = new DefaultProviderRegistry();
    registry.register(provider);
    const profiles = new ProfileService(repo);
    await profiles.seed({
      ffmpegVersion: 'test',
      encoders: [{ name: 'libx264', codec: 'h264', hardware: false, available: true }],
      muxers: ['mpegts'],
      filters: [],
      pixelFormats: ['yuv420p']
    });
    let generated = 0;
    const objectStore = new MutableMemoryObjectStore();
    const metrics = new PrometheusMetricsSink();
    const service = new SessionService(
      repo,
      secrets,
      registry,
      {
        discover: async () => ({
          ffmpegVersion: 'test',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async (_request, destination) => {
          generated += 1;
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, 'segment');
        }
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 60_000,
        maxWorkers: 1
      },
      { objectStore, clusterRepository: repo, metrics }
    );
    const session = await service.create({
      kind: 'vod',
      source: { providerId: 'p1', itemId: 'm1' },
      profileId: 'universal-h264-hls-vod',
      profileRevision: 1,
      platformMode: 'universal',
      pinned: false,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    const token = session.outputUrls.primary!.split('/play/')[1]!.split('/')[0]!;

    const firstPath = await service.segment(token, 0);
    expect(await readFile(firstPath, 'utf8')).toBe('segment');
    expect(generated).toBe(1);
    const [contentKey] = objectStore.keys();
    expect(contentKey).toBeDefined();
    await rm(firstPath, { force: true });
    objectStore.corrupt(contentKey!, 'poisons');

    const secondPath = await service.segment(token, 0);
    expect(secondPath).toBe(firstPath);
    expect(await readFile(secondPath, 'utf8')).toBe('segment');
    expect(generated).toBe(2);
    expect(objectStore.deleted).toEqual([contentKey]);
    await expect(objectStore.stat(contentKey!)).resolves.toMatchObject({
      sha256: createHash('sha256').update('segment').digest('hex')
    });
    await expect(service.evictCache({ all: true })).resolves.toBe(1);
    expect(objectStore.deleted).toEqual([contentKey, contentKey]);
    await expect(objectStore.stat(contentKey!)).resolves.toBeUndefined();
    const renderedMetrics = await metrics.render();
    expect(renderedMetrics).toContain(
      'vrrelay_cache_requests_total{layer="object_store",outcome="miss"}'
    );
    expect(renderedMetrics).toContain('vrrelay_object_restores_total{outcome="invalidated"} 1');
    expect(renderedMetrics).toContain(
      'vrrelay_object_operations_total{operation="put",outcome="success"} 2'
    );
    expect(renderedMetrics).toContain(
      'vrrelay_object_errors_total{operation="restore",kind="validation"} 1'
    );
  });

  it('enforces disk cache pressure after segment generation without evicting the requested file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-cache-pressure-'));
    dirs.push(dir);
    const repo = trackRepository(new SessionConflictRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'p1',
      type: 'jellyfin',
      name: 'Fixture',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 's1',
      capabilities: ['search', 'direct_source'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const secrets = new MemorySecretStore();
    await secrets.put('s1', 'token');
    const registry = new DefaultProviderRegistry();
    registry.register(provider);
    const profiles = new ProfileService(repo);
    await profiles.seed({
      ffmpegVersion: 'test',
      encoders: [{ name: 'libx264', codec: 'h264', hardware: false, available: true }],
      muxers: ['mpegts'],
      filters: [],
      pixelFormats: ['yuv420p']
    });
    const service = new SessionService(
      repo,
      secrets,
      registry,
      {
        discover: async () => ({
          ffmpegVersion: 'test',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async (_request, destination) => {
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, 'segment');
        }
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 60_000,
        cacheLimitBytes: Buffer.byteLength('segment'),
        maxWorkers: 1
      },
      { clusterRepository: repo }
    );
    const session = await service.create({
      kind: 'vod',
      source: { providerId: 'p1', itemId: 'm1' },
      profileId: 'universal-h264-hls-vod',
      profileRevision: 1,
      platformMode: 'universal',
      pinned: false,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    const token = session.outputUrls.primary!.split('/play/')[1]!.split('/')[0]!;

    const firstPath = await service.segment(token, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondPath = await service.segment(token, 1);

    await expect(access(firstPath)).rejects.toThrow();
    await expect(readFile(secondPath, 'utf8')).resolves.toBe('segment');
    await expect(service.cacheUsageBytes()).resolves.toBe(Buffer.byteLength('segment'));
  });

  it('issues edge-scoped playback grants that honor session revocation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-edge-grant-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'p1',
      type: 'jellyfin',
      name: 'Fixture',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 's1',
      capabilities: ['search', 'direct_source'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const secrets = new MemorySecretStore();
    await secrets.put('s1', 'token');
    const registry = new DefaultProviderRegistry();
    registry.register(provider);
    const transcoder: Transcoder = {
      discover: async () => ({
        ffmpegVersion: 'test',
        encoders: [],
        muxers: [],
        filters: [],
        pixelFormats: []
      }),
      generateSegment: async () => {}
    };
    const profileService = new ProfileService(repo);
    await profileService.seed({
      ffmpegVersion: 'test',
      encoders: [{ name: 'libx264', codec: 'h264', hardware: false, available: true }],
      muxers: ['mpegts'],
      filters: [],
      pixelFormats: ['yuv420p']
    });
    const events = new InMemoryEventBus();
    const coordination = new MemoryCoordinationStore();
    const controller = new SessionService(
      repo,
      secrets,
      registry,
      transcoder,
      events,
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'controller-cache'),
        cacheTtlMs: 1000,
        maxWorkers: 1,
        nodeId: 'controller',
        roles: ['controller']
      },
      { clusterRepository: repo, coordination }
    );
    const edgeA = new SessionService(
      repo,
      secrets,
      registry,
      transcoder,
      events,
      {
        publicUrl: 'https://edge-a.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'edge-a-cache'),
        cacheTtlMs: 1000,
        maxWorkers: 1,
        nodeId: 'edge-a',
        roles: ['edge']
      },
      { clusterRepository: repo, coordination }
    );
    const edgeB = new SessionService(
      repo,
      secrets,
      registry,
      transcoder,
      events,
      {
        publicUrl: 'https://edge-b.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'edge-b-cache'),
        cacheTtlMs: 1000,
        maxWorkers: 1,
        nodeId: 'edge-b',
        roles: ['edge']
      },
      { clusterRepository: repo }
    );
    const session = await controller.create({
      kind: 'vod',
      source: { providerId: 'p1', itemId: 'm1' },
      profileId: 'universal-h264-hls-vod',
      profileRevision: 1,
      platformMode: 'universal',
      pinned: false,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    const controllerToken = session.outputUrls.primary!.split('/play/')[1]!.split('/')[0]!;
    const edgeToken = await controller.createEdgePlaybackGrant(controllerToken, 'edge-a');

    expect(edgeToken).toMatch(/^eg1\./);
    expect(edgeToken).not.toContain(controllerToken);
    await expect(edgeA.touchViewer(controllerToken, 'viewer-raw')).rejects.toThrow(
      'edge-scoped playback link is required'
    );
    const [controllerIdentity, edgeAIdentity, edgeBIdentity] = await Promise.all([
      controller.viewerIdentity('192.0.2.40', 'viewer-agent'),
      edgeA.viewerIdentity('192.0.2.40', 'viewer-agent'),
      edgeB.viewerIdentity('192.0.2.40', 'viewer-agent')
    ]);
    expect(controllerIdentity).toBe(edgeAIdentity);
    expect(controllerIdentity).toBe(edgeBIdentity);
    await expect(edgeA.touchViewer(edgeToken, 'viewer-a')).resolves.toMatchObject({
      id: session.id
    });
    await edgeA.touchViewer(edgeToken, 'viewer-a');
    await expect(repo.getSession(session.id)).resolves.toMatchObject({ viewers: 1 });
    await edgeA.touchViewer(edgeToken, 'viewer-b');
    await expect(repo.getSession(session.id)).resolves.toMatchObject({ viewers: 2 });
    await expect(controller.runtimeStats(await controller.get(session.id))).resolves.toMatchObject({
      activity: 'streaming',
      viewers: 2,
      viewerWindowSeconds: 30
    });
    await expect(edgeB.touchViewer(edgeToken, 'viewer-b')).rejects.toThrow(
      'Edge playback link is not valid for this node'
    );

    await repo.deleteSessionAndRevokePlaybackGrants(session.id, new Date().toISOString());
    await expect(edgeA.touchViewer(edgeToken, 'viewer-a')).rejects.toThrow(
      'Playback link is invalid or expired'
    );
  });
});

describe('provider lifecycle', () => {
  it('persists explicit public HTTP approval without exposing the internal policy field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-http-policy-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const secrets = new MemorySecretStore();
    const registry = new DefaultProviderRegistry();
    let observedApproval: boolean | undefined;
    registry.register({
      ...provider,
      authenticate: async (_baseUrl, _credentials, _signal, transportPolicy) => {
        observedApproval = transportPolicy?.allowPublicHttp;
        return {
          accessToken: 'fixture-access-token',
          serverName: 'Fixture',
          serverVersion: '1.0.0'
        };
      }
    });
    const service = new ProviderService(repo, secrets, registry);

    const created = await service.create({
      type: 'jellyfin',
      name: 'Unsafe HTTP fixture',
      baseUrl: 'http://media.example.test',
      normalizedBaseUrl: 'http://media.example.test',
      authMode: 'api_key',
      apiKey: 'fixture-api-key',
      allowPublicHttp: true
    });

    expect(observedApproval).toBe(true);
    expect(created).not.toHaveProperty('allowPublicHttp');
    await expect(repo.getProvider(created.id)).resolves.toMatchObject({ allowPublicHttp: true });
  });

  it('removes the local credential and rejects deletion while a session depends on it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-delete-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'provider-delete',
      type: 'jellyfin',
      name: 'Disposable provider',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 'provider:delete',
      capabilities: ['search'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const dependentSession = {
      id: 'dependent-session',
      name: 'Dependent session',
      kind: 'vod',
      source: { providerId: 'provider-delete', itemId: 'movie' },
      durationSeconds: 10,
      profileId: 'universal-h264-hls-vod',
      profileRevision: 1,
      platformMode: 'universal',
      state: 'idle',
      pinned: false,
      reportActivity: false,
      viewers: 0,
      placementPolicy: 'local',
      placementLocked: false,
      outputUrls: { primary: 'https://relay.invalid/play/token/index.m3u8' },
      createdAt: now,
      updatedAt: now
    } as const;
    await repo.createSessionWithPlaybackGrant(dependentSession, {
      tokenHash: 'dependent-session-grant',
      sessionId: dependentSession.id,
      expiresAt: null,
      revokedAt: null,
      createdAt: now
    });
    const secrets = new MemorySecretStore();
    await secrets.put('provider:delete', 'access-token');
    const service = new ProviderService(repo, secrets, new DefaultProviderRegistry());

    await expect(service.delete('provider-delete')).rejects.toThrow(
      'Delete every session and node binding for this provider first'
    );
    expect(await secrets.get('provider:delete')).toBe('access-token');

    await repo.deleteSessionAndRevokePlaybackGrants('dependent-session', new Date().toISOString());
    await service.delete('provider-delete');
    expect(await repo.getProvider('provider-delete')).toBeUndefined();
    await expect(secrets.get('provider:delete')).rejects.toThrow('Secret not found');
    await expect(service.delete('provider-delete')).resolves.toBeUndefined();
  });

  it('resumes a deletion after transient secret-store failure', async () => {
    class FailOnceSecretStore extends TrackingSecretStore {
      #fail = true;

      override async delete(ref: string): Promise<void> {
        if (this.#fail) {
          this.#fail = false;
          throw new Error('simulated secret backend outage');
        }
        await super.delete(ref);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-secret-retry-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'provider-secret-retry',
      type: 'jellyfin',
      name: 'Retry provider',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 'provider:secret-retry',
      capabilities: ['search'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const secrets = new FailOnceSecretStore();
    await secrets.put('provider:secret-retry', 'access-token');
    const service = new ProviderService(repo, secrets, new DefaultProviderRegistry());

    await expect(service.delete('provider-secret-retry')).rejects.toThrow(
      'simulated secret backend outage'
    );
    await expect(secrets.get('provider:secret-retry')).resolves.toBe('access-token');
    await expect(service.delete('provider-secret-retry')).resolves.toBeUndefined();
    await expect(repo.getProvider('provider-secret-retry')).resolves.toBeUndefined();
    await expect(secrets.get('provider:secret-retry')).rejects.toThrow('Secret not found');
  });

  it.each(['before', 'after'] as const)(
    'reconciles a finalize acknowledgement lost %s commit',
    async (failurePoint) => {
      class AmbiguousFinalizeRepository extends SqliteRepository {
        #throwOnce = true;

        override async finalizeProviderDeletion(
          ...args: Parameters<SqliteRepository['finalizeProviderDeletion']>
        ) {
          if (this.#throwOnce && failurePoint === 'before') {
            this.#throwOnce = false;
            throw new Error('simulated finalize failure before commit');
          }
          const result = await super.finalizeProviderDeletion(...args);
          if (this.#throwOnce && failurePoint === 'after') {
            this.#throwOnce = false;
            throw new Error('simulated finalize failure after commit');
          }
          return result;
        }
      }

      const dir = await mkdtemp(join(tmpdir(), `vrrelay-provider-finalize-${failurePoint}-`));
      dirs.push(dir);
      const repo = trackRepository(new AmbiguousFinalizeRepository(join(dir, 'db.sqlite')));
      await repo.migrate();
      const now = new Date().toISOString();
      await repo.createProvider({
        id: `provider-finalize-${failurePoint}`,
        type: 'jellyfin',
        name: 'Finalize provider',
        baseUrl: 'https://media.invalid',
        authMode: 'user_token',
        secretRef: `provider:finalize-${failurePoint}`,
        capabilities: ['search'],
        healthy: true,
        createdAt: now,
        updatedAt: now
      });
      const secrets = new TrackingSecretStore();
      await secrets.put(`provider:finalize-${failurePoint}`, 'access-token');
      const service = new ProviderService(repo, secrets, new DefaultProviderRegistry());

      await expect(service.delete(`provider-finalize-${failurePoint}`)).resolves.toBeUndefined();
      await expect(repo.getProvider(`provider-finalize-${failurePoint}`)).resolves.toBeUndefined();
      expect(secrets.refs()).toEqual([]);
    }
  );

  it('retries validation CAS conflicts without overwriting concurrent metadata', async () => {
    class ValidationConflictRepository extends SqliteRepository {
      attempts = 0;

      override async compareAndSetProvider(
        value: Parameters<SqliteRepository['compareAndSetProvider']>[0],
        expectedRevision: number
      ) {
        this.attempts += 1;
        if (this.attempts === 1) {
          const current = (await this.getVersionedProvider(value.id))!;
          const concurrent = await super.compareAndSetProvider(
            {
              ...current.value,
              name: 'Concurrent provider name',
              updatedAt: new Date().toISOString()
            },
            current.revision
          );
          if (!concurrent.applied) throw new Error('Failed to inject provider CAS conflict');
          return {
            applied: false as const,
            reason: 'revision-conflict' as const,
            current: concurrent.record
          };
        }
        return super.compareAndSetProvider(value, expectedRevision);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-validation-cas-'));
    dirs.push(dir);
    const repo = trackRepository(new ValidationConflictRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'provider-validation-cas',
      type: 'jellyfin',
      name: 'Original provider name',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 'provider:validation-cas',
      capabilities: ['search'],
      healthy: false,
      createdAt: now,
      updatedAt: now
    });
    const secrets = new TrackingSecretStore();
    await secrets.put('provider:validation-cas', 'access-token');
    const registry = new DefaultProviderRegistry();
    registry.register(provider);
    const service = new ProviderService(repo, secrets, registry);

    await service.validate('provider-validation-cas');
    expect(repo.attempts).toBe(2);
    await expect(repo.getProvider('provider-validation-cas')).resolves.toMatchObject({
      name: 'Concurrent provider name',
      healthy: true
    });
  });
});

describe('Live relay service', () => {
  it('enforces installation and per-owner live-channel quotas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-live-capacity-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    for (const ownerId of ['owner-a', 'owner-b', 'owner-c'])
      await repo.createUserIdentity({
        id: ownerId,
        providerId: 'provider-live-capacity',
        providerUserId: `provider-${ownerId}`,
        displayName: ownerId,
        roles: ['user'],
        allowedProfileIds: [],
        firstSeenAt: now,
        lastSeenAt: now
      });
    const service = new LiveService(repo, {
      publicUrl: 'https://relay.example',
      rtmpUrl: 'rtmp://ingest.example/live',
      srtUrl: 'srt://ingest.example:8890',
      whipUrl: 'https://ingest.example',
      hlsUrl: 'https://edge.example',
      internalRtspUrl: 'rtsp://mediamtx:8554',
      maxChannelsTotal: 2,
      maxChannelsPerOwner: 1
    });

    await service.create({ name: 'Owner A', normalize: true }, { ownerId: 'owner-a' });
    await expect(
      service.create({ name: 'Owner A second', normalize: true }, { ownerId: 'owner-a' })
    ).rejects.toThrow('user has reached the live-channel limit');
    await service.create({ name: 'Owner B', normalize: true }, { ownerId: 'owner-b' });
    await expect(
      service.create({ name: 'Owner C', normalize: true }, { ownerId: 'owner-c' })
    ).rejects.toThrow('installation has reached its live-channel limit');
    await expect(repo.listLiveChannels()).resolves.toHaveLength(2);
  });

  it('returns publisher credentials once without persisting them in connection URLs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-live-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const service = new LiveService(repo, {
      publicUrl: 'https://relay.example',
      rtmpUrl: 'rtmp://ingest.example/live',
      srtUrl: 'srt://ingest.example:8890',
      whipUrl: 'https://ingest.example',
      hlsUrl: 'https://edge.example',
      internalRtspUrl: 'rtsp://mediamtx:8554'
    });

    const created = await service.create({ name: 'OBS test', normalize: true });
    expect(created.publisher.publishToken).toHaveLength(32);
    expect(created.publisher.rtmpUrl).toContain(created.publisher.publishToken);
    expect(created.publisher.srtUrl).toContain(created.publisher.publishToken);
    expect(created.publisher.whipUrl).toContain(created.publisher.publishToken);

    const stored = await repo.getLiveChannel(created.channel.id);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(created.publisher.publishToken);
    expect(stored?.publishTokenHash).toMatch(/^[a-f0-9]{64}$/);

    const legacy = (await repo.getVersionedLiveChannel(created.channel.id))!;
    await repo.compareAndSetLiveChannel(
      {
        ...legacy.value,
        rtmpUrl: `rtmp://127.0.0.1:1935/${legacy.value.ingestPath}`,
        srtUrl: `srt://127.0.0.1:8890?streamid=publish:${legacy.value.ingestPath}`,
        whipUrl: `http://127.0.0.1:8889/${legacy.value.ingestPath}/whip`
      },
      legacy.revision
    );

    const [listed] = await service.list();
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('publishTokenHash');
    expect(JSON.stringify(listed)).not.toContain(created.publisher.publishToken);
    expect(listed?.rtmpUrl).toBe(`rtmp://ingest.example/live/${stored?.ingestPath}`);
    expect(listed?.srtUrl).toBe(`srt://ingest.example:8890?streamid=publish:${stored?.ingestPath}`);
    expect(listed?.whipUrl).toBe(`https://ingest.example/${stored?.ingestPath}/whip`);
    await expect(
      service.authorizeMediaMtx(
        {
          action: 'publish',
          path: stored?.ingestPath ?? stored!.path,
          user: 'vrrelay-publish',
          password: created.publisher.publishToken
        },
        'read-token'
      )
    ).resolves.toBe(true);
    await expect(repo.getLiveChannel(created.channel.id)).resolves.toMatchObject({
      publisherState: 'reconnecting'
    });
    await expect(
      service.authorizeMediaMtx(
        {
          action: 'publish',
          path: stored?.ingestPath ?? stored!.path,
          user: 'vrrelay-publish',
          password: created.publisher.publishToken
        },
        'read-token'
      )
    ).resolves.toBe(false);
    const reconnectingChannel = (await repo.getVersionedLiveChannel(created.channel.id))!;
    await repo.compareAndSetLiveChannel(
      { ...reconnectingChannel.value, publisherState: 'offline' },
      reconnectingChannel.revision
    );
    await expect(
      service.authorizeMediaMtx(
        {
          action: 'publish',
          path: stored?.ingestPath ?? stored!.path,
          user: 'vrrelay-publish',
          password: created.publisher.publishToken
        },
        'read-token'
      )
    ).resolves.toBe(true);
    await expect(
      service.authorizeMediaMtx(
        {
          action: 'publish',
          path: created.channel.path,
          protocol: 'rtsp'
        },
        'read-token'
      )
    ).resolves.toBe(false);

    const internalService = new LiveService(repo, {
      publicUrl: 'https://relay.example',
      rtmpUrl: 'rtmp://ingest.example/live',
      srtUrl: 'srt://ingest.example:8890',
      whipUrl: 'https://ingest.example',
      hlsUrl: 'https://edge.example',
      internalRtspUrl: 'rtsp://mediamtx:8554',
      allowUnauthenticatedInternalRead: true
    });
    await expect(
      internalService.authorizeMediaMtx(
        { action: 'read', path: stored!.ingestPath!, protocol: 'rtsp' },
        'read-token'
      )
    ).resolves.toBe(true);
    await expect(
      internalService.authorizeMediaMtx(
        { action: 'playback', path: stored!.ingestPath!, protocol: 'rtsp' },
        'read-token'
      )
    ).resolves.toBe(true);
    await expect(
      internalService.authorizeMediaMtx(
        { action: 'read', path: stored!.ingestPath!, protocol: 'hls' },
        'read-token'
      )
    ).resolves.toBe(false);
    await expect(
      internalService.authorizeMediaMtx(
        { action: 'playback', path: stored!.ingestPath!, protocol: 'rtmp' },
        'read-token'
      )
    ).resolves.toBe(false);
    await expect(
      internalService.authorizeMediaMtx(
        { action: 'read', path: stored!.ingestPath!, protocol: 'RTSP' },
        'read-token'
      )
    ).resolves.toBe(false);
    await expect(
      internalService.authorizeMediaMtx(
        {
          action: 'read',
          path: stored!.ingestPath!,
          protocol: 'hls',
          user: 'vrrelay-read',
          password: 'read-token'
        },
        'read-token'
      )
    ).resolves.toBe(true);
    await expect(
      internalService.authorizeMediaMtx(
        { action: 'publish', path: created.channel.path, protocol: 'rtsp' },
        'read-token'
      )
    ).resolves.toBe(true);
    await expect(
      internalService.authorizeMediaMtx(
        { action: 'publish', path: created.channel.path, protocol: 'rtmp' },
        'read-token'
      )
    ).resolves.toBe(false);
    await expect(
      internalService.authorizeMediaMtx(
        { action: 'publish', path: stored!.ingestPath!, protocol: 'rtsp' },
        'read-token'
      )
    ).resolves.toBe(false);

    await new ProfileService(repo).seed({
      ffmpegVersion: 'test',
      encoders: [{ name: 'libx264', codec: 'h264', hardware: false, available: true }],
      muxers: ['mpegts'],
      filters: [],
      pixelFormats: ['yuv420p']
    });
    const sessions = new SessionService(
      repo,
      new MemorySecretStore(),
      new DefaultProviderRegistry(),
      {
        discover: async () => ({
          ffmpegVersion: 'test',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => {}
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 1000,
        maxWorkers: 1
      }
    );
    await expect(
      sessions.create({
        kind: 'live',
        name: 'Missing channel',
        liveChannelId: 'missing',
        profileId: 'h264-live-hls',
        profileRevision: 1,
        platformMode: 'universal',
        pinned: true,
        reportActivity: false,
        placementPolicy: 'local',
        placementLocked: false,
        playbackTtlSeconds: null
      })
    ).rejects.toThrow('Live channel was not found');
    const livePlayback = await sessions.create({
      kind: 'live',
      name: 'OBS test',
      liveChannelId: created.channel.id,
      profileId: 'h264-live-hls',
      profileRevision: 1,
      platformMode: 'universal',
      pinned: true,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    expect(livePlayback).toMatchObject({
      kind: 'live',
      liveChannelId: created.channel.id,
      state: 'live'
    });
    await expect(sessions.control(livePlayback.id, { state: 'stopped' })).resolves.toMatchObject({
      state: 'stopped'
    });
    await expect(sessions.control(livePlayback.id, { state: 'live' })).resolves.toMatchObject({
      state: 'live'
    });
    await expect(sessions.control(livePlayback.id, { state: 'idle' })).rejects.toThrow(
      'Only VOD sessions can resume to idle'
    );

    const offlineChannel = (await repo.getVersionedLiveChannel(created.channel.id))!;
    await repo.compareAndSetLiveChannel(
      { ...offlineChannel.value, publisherState: 'online' },
      offlineChannel.revision
    );
    await expect(service.delete(created.channel.id)).rejects.toThrow(
      'Stop the OBS publisher before deleting this live channel'
    );
    const onlineChannel = (await repo.getVersionedLiveChannel(created.channel.id))!;
    await repo.compareAndSetLiveChannel(
      { ...onlineChannel.value, publisherState: 'offline' },
      onlineChannel.revision
    );
    await expect(service.delete(created.channel.id)).rejects.toThrow(
      'Delete live playback sessions that use this channel first'
    );
    const [liveSession] = await repo.listSessions();
    await repo.deleteSessionAndRevokePlaybackGrants(liveSession!.id, new Date().toISOString());
    await service.delete(created.channel.id);
    await expect(service.delete(created.channel.id)).rejects.toThrow('Live channel was not found');
  });

  it('authorizes administrator-issued publisher replacement credentials without reopening the old token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-live-replacement-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const metrics = new PrometheusMetricsSink();
    const service = new LiveService(
      repo,
      {
        publicUrl: 'https://relay.example',
        rtmpUrl: 'rtmp://ingest.example/live',
        srtUrl: 'srt://ingest.example:8890',
        whipUrl: 'https://ingest.example',
        hlsUrl: 'https://edge.example',
        internalRtspUrl: 'rtsp://mediamtx:8554'
      },
      undefined,
      undefined,
      undefined,
      metrics
    );
    const created = await service.create({ name: 'OBS replacement', normalize: true });
    const stored = (await repo.getLiveChannel(created.channel.id))!;
    const ingestPath = stored.ingestPath ?? stored.path;

    await expect(
      service.authorizeMediaMtx(
        {
          action: 'publish',
          path: ingestPath,
          user: 'vrrelay-publish',
          password: created.publisher.publishToken
        },
        'read-token'
      )
    ).resolves.toBe(true);

    const replacement = await service.replacePublisher(created.channel.id);
    expect(replacement.publisher.publishToken).not.toBe(created.publisher.publishToken);
    expect(JSON.stringify(await service.list())).not.toContain(replacement.publisher.publishToken);
    const pendingReplacement = (await repo.getLiveChannel(created.channel.id))!;
    expect(pendingReplacement).toMatchObject({
      publisherState: 'reconnecting',
      publisherReplacementRequestedAt: expect.any(String)
    });
    expect(pendingReplacement.replacementPublishTokenHash).toMatch(/^[a-f0-9]{64}$/);

    await expect(
      service.authorizeMediaMtx(
        {
          action: 'publish',
          path: ingestPath,
          user: 'vrrelay-publish',
          password: created.publisher.publishToken
        },
        'read-token'
      )
    ).resolves.toBe(false);
    await expect(
      service.authorizeMediaMtx(
        {
          action: 'publish',
          path: ingestPath,
          user: 'vrrelay-publish',
          password: replacement.publisher.publishToken
        },
        'read-token'
      )
    ).resolves.toBe(true);

    const promoted = (await repo.getLiveChannel(created.channel.id))!;
    expect(promoted.publishTokenHash).toBe(pendingReplacement.replacementPublishTokenHash);
    expect(promoted.replacementPublishTokenHash).toBeUndefined();
    expect(promoted.publisherReplacementRequestedAt).toBeUndefined();
    await expect(
      service.authorizeMediaMtx(
        {
          action: 'publish',
          path: ingestPath,
          user: 'vrrelay-publish',
          password: replacement.publisher.publishToken
        },
        'read-token'
      )
    ).resolves.toBe(false);
    const renderedMetrics = await metrics.render();
    expect(renderedMetrics).toContain(
      'vrrelay_live_publisher_replacements_total{outcome="requested"} 1'
    );
    expect(renderedMetrics).toContain(
      'vrrelay_live_publisher_replacements_total{outcome="promoted"} 1'
    );
    expect(renderedMetrics).toMatch(
      /vrrelay_live_publisher_auth_total\{[^}]*outcome="accepted"[^}]*credential="replacement"[^}]*reason="none"[^}]*\} 1/
    );
    expect(renderedMetrics).toMatch(
      /vrrelay_live_publisher_auth_total\{[^}]*outcome="rejected"[^}]*credential="primary"[^}]*reason="replacement_pending"[^}]*\} 1/
    );
    expect(renderedMetrics).toContain(
      'vrrelay_live_publisher_reconnects_total{credential="replacement"} 1'
    );
  });

  it('records the selected ingest origin and region when creating a live channel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-live-origin-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    const origin = (id: string, region: string): ClusterNode => ({
      id,
      name: id,
      roles: ['ingest-origin'],
      region,
      publicUrl: `https://${id}.example`,
      state: 'online',
      capabilities: {
        encoders: [],
        hardwareDevices: [],
        maxWorkers: 1,
        activeWorkers: 0,
        queuedWorkers: 0,
        cacheBytes: 0,
        cacheLimitBytes: null,
        egressMbps: 0,
        providerIds: [],
        vodProducerVersion: 0
      },
      weight: 100,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now
    });
    await repo.createNode(origin('origin-us', 'us-east'));
    await repo.createNode(origin('origin-eu', 'eu-west'));
    const service = new LiveService(
      repo,
      {
        publicUrl: 'https://relay.example',
        rtmpUrl: 'rtmp://ingest.example/live',
        srtUrl: 'srt://ingest.example:8890',
        whipUrl: 'https://ingest.example',
        hlsUrl: 'https://edge.example',
        internalRtspUrl: 'rtsp://mediamtx:8554'
      },
      undefined,
      undefined,
      repo
    );

    const created = await service.create({
      name: 'Regional OBS',
      preferredRegion: 'eu-west',
      normalize: true
    });

    expect(created.channel).toMatchObject({
      originNodeId: 'origin-eu',
      region: 'eu-west'
    });
    await expect(repo.getLiveChannel(created.channel.id)).resolves.toMatchObject({
      originNodeId: 'origin-eu',
      region: 'eu-west'
    });
  });

  it('normalizes live ingest with the selected live session profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-live-profile-normalization-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const profileService = new ProfileService(repo);
    await profileService.seed({
      ffmpegVersion: 'test',
      encoders: [{ name: 'libx264', codec: 'h264', hardware: false, available: true }],
      muxers: ['mpegts'],
      filters: [],
      pixelFormats: ['yuv420p']
    });
    const liveProfile = await profileService.createRevision(
      profileInput({
        profileId: 'live-custom',
        delivery: { playlistType: 'live' },
        video: {
          width: 1280,
          height: 720,
          frameRate: 60,
          bitrateKbps: 5_000,
          maxrateKbps: 5_500,
          bufferKbps: 11_000,
          gop: 120
        },
        audio: { channels: 1, layout: 'mono', sampleRate: 44_100, bitrateKbps: 128 }
      })
    );
    const normalizer = new CapturingLiveNormalizer();
    const metrics = new PrometheusMetricsSink();
    const live = new LiveService(
      repo,
      {
        publicUrl: 'https://relay.example',
        rtmpUrl: 'rtmp://ingest.example/live',
        srtUrl: 'srt://ingest.example:8890',
        whipUrl: 'https://ingest.example',
        hlsUrl: 'https://edge.example',
        internalRtspUrl: 'rtsp://mediamtx:8554'
      },
      normalizer,
      undefined,
      undefined,
      metrics
    );
    const created = await live.create({ name: 'Profiled OBS', normalize: true });
    const sessions = new SessionService(
      repo,
      new MemorySecretStore(),
      new DefaultProviderRegistry(),
      {
        discover: async () => ({
          ffmpegVersion: 'test',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => {}
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 1000,
        maxWorkers: 1
      }
    );
    await sessions.create({
      kind: 'live',
      name: 'Profiled OBS session',
      liveChannelId: created.channel.id,
      profileId: liveProfile.profileId,
      profileRevision: liveProfile.revision,
      platformMode: 'universal',
      pinned: true,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    const stored = (await repo.getLiveChannel(created.channel.id))!;
    expect(stored).toMatchObject({
      normalizationProfileId: liveProfile.profileId,
      normalizationProfileRevision: liveProfile.revision
    });

    await live.reconcilePublisherPaths(new Set([stored.ingestPath!]));

    expect(normalizer.starts).toHaveLength(1);
    expect(normalizer.starts[0]).toMatchObject({
      channelId: created.channel.id,
      sourceUrl: `rtsp://mediamtx:8554/${stored.ingestPath}`,
      destinationUrl: `rtsp://mediamtx:8554/${stored.path}`
    });
    expect(normalizer.starts[0]!.profile).toMatchObject({
      profileId: 'live-custom',
      video: { width: 1280, height: 720, frameRate: 60, gop: 120 },
      audio: { channels: 1, sampleRate: 44_100, bitrateKbps: 128 }
    });
    const renderedMetrics = await metrics.render();
    expect(renderedMetrics).toContain('vrrelay_live_publishers{state="online"} 1');
    expect(renderedMetrics).toContain(
      'vrrelay_live_publisher_state_transitions_total{state="online"} 1'
    );
    expect(renderedMetrics).toContain(
      'vrrelay_live_normalizer_transitions_total{state="running"} 1'
    );
  });

  it('rejects conflicting normalization profiles for the same live channel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-live-profile-conflict-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const profileService = new ProfileService(repo, mediaCapabilities);
    const firstProfile = await profileService.createRevision(
      profileInput({ profileId: 'live-a', delivery: { playlistType: 'live' } })
    );
    const secondProfile = await profileService.createRevision(
      profileInput({
        profileId: 'live-b',
        delivery: { playlistType: 'live' },
        video: { width: 1280, height: 720 }
      })
    );
    const live = new LiveService(repo, {
      publicUrl: 'https://relay.example',
      rtmpUrl: 'rtmp://ingest.example/live',
      srtUrl: 'srt://ingest.example:8890',
      whipUrl: 'https://ingest.example',
      hlsUrl: 'https://edge.example',
      internalRtspUrl: 'rtsp://mediamtx:8554'
    });
    const created = await live.create({ name: 'Profile conflict OBS', normalize: true });
    const sessions = new SessionService(
      repo,
      new MemorySecretStore(),
      new DefaultProviderRegistry(),
      {
        discover: async () => ({
          ffmpegVersion: 'test',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => {}
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 1000,
        maxWorkers: 1
      }
    );
    const baseRequest = {
      kind: 'live' as const,
      liveChannelId: created.channel.id,
      platformMode: 'universal' as const,
      pinned: true,
      reportActivity: false as const,
      placementPolicy: 'local' as const,
      placementLocked: false,
      playbackTtlSeconds: null
    };
    await sessions.create({
      ...baseRequest,
      name: 'First profile',
      profileId: firstProfile.profileId,
      profileRevision: firstProfile.revision
    });

    await expect(
      sessions.create({
        ...baseRequest,
        name: 'Second profile',
        profileId: secondProfile.profileId,
        profileRevision: secondProfile.revision
      })
    ).rejects.toThrow('different normalization profile');
  });
});

describe('provider failover bindings', () => {
  it('requires a durable controller begin before idempotent worker credential cleanup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-binding-cleanup-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    await repo.createNode(sourceWorkerNode('worker-cleanup'));
    const secrets = new TrackingSecretStore();
    const service = new ProviderService(repo, secrets, providerBindingRegistry());
    const created = await service.createBinding(
      providerBindingInput('cleanup'),
      'worker-cleanup',
      'provider-cleanup',
      'binding-cleanup',
      { mode: 'new', expectedProviderRevision: null }
    );

    await expect(service.removeBinding(created.binding.id)).rejects.toThrow(
      'must be authorized by the controller first'
    );
    await expect(secrets.get(created.binding.secretRef)).resolves.toBe('token-cleanup');

    const deleting = await repo.beginProviderBindingDeletion(
      created.binding.id,
      new Date().toISOString()
    );
    expect(deleting).toMatchObject({
      applied: true,
      record: { value: { deletionPending: true, state: 'revoked', reachable: false } }
    });
    await expect(service.removeBinding(created.binding.id)).resolves.toBeUndefined();
    await expect(service.removeBinding(created.binding.id)).resolves.toBeUndefined();
    expect(secrets.deleted).toEqual([created.binding.secretRef, created.binding.secretRef]);
    await expect(
      repo.getProviderBinding(created.binding.id, { includeDeletionPending: true })
    ).resolves.toMatchObject({ deletionPending: true });
  });

  it('resolves each worker credential from its own binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-binding-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    await repo.createNode(sourceWorkerNode('worker-a'));
    await repo.createNode(sourceWorkerNode('worker-b'));
    const observedSecrets: string[] = [];
    const adapter: MediaProvider = {
      type: 'jellyfin',
      capabilities: ['search'],
      authenticate: async (_url, credentials) => ({
        accessToken: `token-${credentials.username}`,
        userId: 'fixture-user',
        username: credentials.username ?? 'fixture-user',
        serverName: 'Fixture',
        serverVersion: '1.0.0'
      }),
      validate: async (_connection, secret) => {
        observedSecrets.push(secret);
      },
      browse: async () => ({ items: [], total: 0 }),
      item: async (connection, secret, id) => {
        observedSecrets.push(secret);
        return {
          id,
          providerId: connection.id,
          name: 'Fixture',
          kind: 'Movie',
          durationSeconds: 12
        };
      },
      resolveSource: async (_connection, secret) => {
        observedSecrets.push(secret);
        return {
          url: 'https://fixture.invalid/media.mp4',
          headers: {},
          durationSeconds: 12,
          fingerprint: 'fixture-v1'
        };
      },
      openSource: async () => {
        throw new Error('not needed');
      },
      reportPlayback: async (_connection, secret) => {
        observedSecrets.push(secret);
      }
    };
    const registry = new DefaultProviderRegistry();
    registry.register(adapter);
    const workerASecrets = new TrackingSecretStore();
    const workerBSecrets = new TrackingSecretStore();
    // Both services intentionally retain their pre-enrollment bootstrap ID.
    // Secret-store locality must still resolve the controller-issued bindings.
    const workerA = new ProviderService(repo, workerASecrets, registry, { nodeId: 'standalone' });
    const workerB = new ProviderService(repo, workerBSecrets, registry, { nodeId: 'standalone' });
    const input = {
      type: 'jellyfin' as const,
      name: 'Fixture',
      baseUrl: 'https://fixture.invalid',
      normalizedBaseUrl: 'https://fixture.invalid',
      authMode: 'user_token' as const,
      password: 'fixture-password',
      allowPublicHttp: false
    };

    await workerA.createBinding(
      { ...input, username: 'worker-a' },
      'worker-a',
      'provider-1',
      'binding-a',
      { mode: 'new', expectedProviderRevision: null }
    );
    const providerAfterFirstBinding = (await repo.getVersionedProvider('provider-1'))!;
    await workerB.createBinding(
      { ...input, username: 'worker-b' },
      'worker-b',
      'provider-1',
      'binding-b',
      { mode: 'existing', expectedProviderRevision: providerAfterFirstBinding.revision }
    );
    const providerAfterSecondBinding = (await repo.getVersionedProvider('provider-1'))!;
    await expect(
      workerA.createBinding(
        { ...input, username: 'stale-worker' },
        'worker-a',
        'provider-1',
        'binding-stale',
        { mode: 'existing', expectedProviderRevision: providerAfterFirstBinding.revision }
      )
    ).rejects.toThrow('changed while the binding was being created');
    expect(
      workerASecrets.refs().some((ref) => ref.startsWith('provider-binding:binding-stale:'))
    ).toBe(false);
    await expect(
      workerB.createBinding(
        {
          ...input,
          name: 'Conflicting fixture',
          baseUrl: 'https://other-fixture.invalid',
          normalizedBaseUrl: 'https://other-fixture.invalid',
          username: 'worker-b'
        },
        'worker-b',
        'provider-1',
        'binding-conflict',
        { mode: 'existing', expectedProviderRevision: providerAfterSecondBinding.revision }
      )
    ).rejects.toThrow('same provider server');
    expect(
      workerBSecrets.refs().some((ref) => ref.startsWith('provider-binding:binding-conflict:'))
    ).toBe(false);

    const storedBindings = await repo.listProviderBindings('provider-1');
    expect(storedBindings).toHaveLength(2);
    const bindingA = storedBindings.find(({ id }) => id === 'binding-a')!;
    const bindingB = storedBindings.find(({ id }) => id === 'binding-b')!;
    expect(bindingA.secretRef).toMatch(/^provider-binding:binding-a:/);
    expect(bindingB.secretRef).toMatch(/^provider-binding:binding-b:/);
    expect((await repo.getProvider('provider-1'))?.secretRef).toBe(bindingA.secretRef);
    await workerA.item('provider-1', 'movie');
    await workerB.item('provider-1', 'movie');
    await workerA.reportActivity('provider-1', {
      sessionId: 'session',
      itemId: 'movie',
      positionTicks: 0,
      paused: false,
      event: 'start'
    });
    const profiles = new ProfileService(repo);
    await profiles.seed({
      ffmpegVersion: 'test',
      encoders: [{ name: 'libx264', codec: 'h264', hardware: false, available: true }],
      muxers: ['mpegts'],
      filters: [],
      pixelFormats: ['yuv420p']
    });
    const sessionService = new SessionService(
      repo,
      workerBSecrets,
      registry,
      {
        discover: async () => ({
          ffmpegVersion: 'test',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async (_request, destination) => {
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, 'segment');
        }
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://worker-b.invalid',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'worker-b-cache'),
        cacheTtlMs: 60_000,
        maxWorkers: 1,
        nodeId: 'standalone',
        roles: ['source-worker']
      },
      { clusterRepository: repo }
    );
    const session = await sessionService.create({
      kind: 'vod',
      source: { providerId: 'provider-1', itemId: 'movie' },
      profileId: 'universal-h264-hls-vod',
      profileRevision: 1,
      platformMode: 'universal',
      pinned: false,
      reportActivity: false,
      placementPolicy: 'local',
      placementLocked: false,
      playbackTtlSeconds: null
    });
    const token = session.outputUrls.primary!.split('/play/')[1]!.split('/')[0]!;
    await sessionService.segment(token, 0);
    expect(observedSecrets).toEqual([
      'token-worker-a',
      'token-worker-b',
      'token-worker-a',
      'token-worker-b',
      'token-worker-b'
    ]);
    await expect(workerASecrets.get(bindingB.secretRef)).rejects.toThrow();
    await expect(workerBSecrets.get(bindingA.secretRef)).rejects.toThrow();
  });

  it('routes provider activity over the bound remote worker without local credential access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-binding-activity-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    await repo.createNode(sourceWorkerNode('worker-a'));
    const registry = providerBindingRegistry();
    const workerSecrets = new TrackingSecretStore();
    const worker = new ProviderService(repo, workerSecrets, registry, { nodeId: 'worker-a' });
    await worker.createBinding(
      providerBindingInput('activity'),
      'worker-a',
      'provider-activity',
      'binding-activity',
      { mode: 'new', expectedProviderRevision: null }
    );

    const calls: Array<{
      nodeId: string;
      operation: string;
      payload: Record<string, unknown>;
    }> = [];
    const remote: RemoteProviderGateway = {
      connected: (nodeId: string) => nodeId === 'worker-a',
      async call<T>(
        nodeId: string,
        operation: Parameters<RemoteProviderGateway['call']>[1],
        payload: Record<string, unknown>
      ): Promise<T> {
        calls.push({ nodeId, operation, payload });
        return {} as T;
      }
    };
    const controller = new ProviderService(repo, new TrackingSecretStore(), registry, {
      nodeId: 'controller',
      remote
    });

    await controller.reportActivity('provider-activity', {
      sessionId: 'session-activity',
      itemId: 'movie-activity',
      positionTicks: 42,
      paused: false,
      event: 'progress'
    });

    expect(calls).toEqual([
      {
        nodeId: 'worker-a',
        operation: 'provider.activity',
        payload: {
          providerId: 'provider-activity',
          sessionId: 'session-activity',
          itemId: 'movie-activity',
          positionTicks: 42,
          paused: false,
          event: 'progress'
        }
      }
    ]);
  });

  it('reconciles concurrent and replayed creation of the same binding without deleting the winner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-binding-race-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    await repo.createNode(sourceWorkerNode('worker-a'));
    const secrets = new TrackingSecretStore();
    const service = new ProviderService(repo, secrets, providerBindingRegistry());

    const attempts = await Promise.all([
      service.createBinding(
        providerBindingInput('first'),
        'worker-a',
        'provider-race',
        'binding-race',
        { mode: 'new', expectedProviderRevision: null }
      ),
      service.createBinding(
        providerBindingInput('second'),
        'worker-a',
        'provider-race',
        'binding-race',
        { mode: 'new', expectedProviderRevision: null }
      )
    ]);
    expect(attempts).toHaveLength(2);
    const stored = (await repo.getProviderBinding('binding-race'))!;
    expect(stored.secretRef).toMatch(/^provider-binding:binding-race:/);
    expect(attempts.map(({ binding }) => binding.secretRef)).toEqual([
      stored.secretRef,
      stored.secretRef
    ]);
    expect(secrets.refs()).toEqual([stored.secretRef]);
    expect(secrets.deleted).toHaveLength(1);

    await expect(
      service.createBinding(
        providerBindingInput('replay'),
        'worker-a',
        'provider-race',
        'binding-race',
        { mode: 'new', expectedProviderRevision: null }
      )
    ).resolves.toMatchObject({ binding: { secretRef: stored.secretRef } });
    expect(secrets.refs()).toEqual([stored.secretRef]);
    expect(secrets.deleted).toHaveLength(2);
    await expect(secrets.get(stored.secretRef)).resolves.toMatch(/^token-(first|second)$/);
  });

  it('treats a throw after binding commit as idempotent success and retains its credential', async () => {
    class ThrowAfterCommitRepository extends SqliteRepository {
      #throwAfterCommit = true;

      override async createProviderBinding(
        ...args: Parameters<SqliteRepository['createProviderBinding']>
      ) {
        const result = await super.createProviderBinding(...args);
        if (result.applied && this.#throwAfterCommit) {
          this.#throwAfterCommit = false;
          throw new Error('simulated ambiguous binding commit');
        }
        return result;
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-binding-commit-'));
    dirs.push(dir);
    const repo = trackRepository(new ThrowAfterCommitRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    await repo.createNode(sourceWorkerNode('worker-a'));
    const secrets = new TrackingSecretStore();
    const service = new ProviderService(repo, secrets, providerBindingRegistry());

    const created = await service.createBinding(
      providerBindingInput('committed'),
      'worker-a',
      'provider-commit',
      'binding-commit',
      { mode: 'new', expectedProviderRevision: null }
    );
    expect(created.binding.secretRef).toMatch(/^provider-binding:binding-commit:/);
    expect(secrets.refs()).toEqual([created.binding.secretRef]);
    await expect(secrets.get(created.binding.secretRef)).resolves.toBe('token-committed');
  });

  it('retains a staged credential when an ambiguous commit cannot be reconciled', async () => {
    class UnreadableCommitRepository extends SqliteRepository {
      override async createProviderBinding(
        ...args: Parameters<SqliteRepository['createProviderBinding']>
      ) {
        const result = await super.createProviderBinding(...args);
        if (result.applied) throw new Error('simulated ambiguous binding commit');
        return result;
      }

      override async getProviderBinding(): Promise<undefined> {
        throw new Error('simulated reconciliation read failure');
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-binding-unreadable-'));
    dirs.push(dir);
    const repo = trackRepository(new UnreadableCommitRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    await repo.createNode(sourceWorkerNode('worker-a'));
    const secrets = new TrackingSecretStore();
    const service = new ProviderService(repo, secrets, providerBindingRegistry());

    await expect(
      service.createBinding(
        providerBindingInput('unreadable'),
        'worker-a',
        'provider-unreadable',
        'binding-unreadable',
        { mode: 'new', expectedProviderRevision: null }
      )
    ).rejects.toThrow('simulated ambiguous binding commit');
    expect(secrets.refs()).toHaveLength(1);
    expect(secrets.refs()[0]).toMatch(/^provider-binding:binding-unreadable:/);
    expect(secrets.deleted).toEqual([]);
    await expect(repo.listProviderBindings('provider-unreadable')).resolves.toHaveLength(1);
  });
});

describe('crash recovery', () => {
  it('retries session deletion until its durable source credential is removed', async () => {
    class FailOnceSecretStore extends TrackingSecretStore {
      #fail = true;

      override async delete(ref: string): Promise<void> {
        if (this.#fail) {
          this.#fail = false;
          throw new Error('simulated secret backend outage');
        }
        await super.delete(ref);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-secret-delete-retry-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'provider-session-secret-retry',
      type: 'jellyfin',
      name: 'Session secret retry provider',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 'provider:session-secret-retry',
      capabilities: ['search'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    await repo.createUserIdentity({
      id: 'identity-session-secret-retry',
      providerId: 'provider-session-secret-retry',
      providerUserId: 'user-session-secret-retry',
      displayName: 'Session secret retry user',
      roles: ['user'],
      allowedProfileIds: [],
      firstSeenAt: now,
      lastSeenAt: now
    });
    const session: RelaySession = {
      id: 'session-secret-delete-retry',
      name: 'Session secret delete retry',
      kind: 'vod',
      source: { providerId: 'provider-session-secret-retry', itemId: 'movie' },
      durationSeconds: 60,
      profileId: 'profile-session-secret-retry',
      profileRevision: 1,
      platformMode: 'pc',
      state: 'active',
      pinned: false,
      reportActivity: false,
      viewers: 0,
      placementPolicy: 'local',
      placementLocked: false,
      ownerId: 'identity-session-secret-retry',
      lastPlaybackActivityAt: now,
      deletionPending: false,
      outputUrls: { primary: 'https://relay.invalid/play/token/index.m3u8' },
      createdAt: now,
      updatedAt: now
    };
    await expect(
      repo.createSessionWithPlaybackGrant(session, {
        tokenHash: 'grant-session-secret-retry',
        sessionId: session.id,
        expiresAt: null,
        revokedAt: null,
        createdAt: now
      })
    ).resolves.toMatchObject({ applied: true });
    const secrets = new FailOnceSecretStore();
    const secretRef = `session-source:${session.id}`;
    await secrets.put(secretRef, 'durable source credential');
    const service = new SessionService(
      repo,
      secrets,
      providerBindingRegistry(),
      {
        discover: async () => mediaCapabilities,
        generateSegment: async () => {}
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.invalid',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 60_000,
        maxWorkers: 1
      },
      { clusterRepository: repo }
    );

    await expect(service.delete(session.id)).rejects.toThrow('simulated secret backend outage');
    await expect(repo.getSession(session.id)).resolves.toMatchObject({
      state: 'stopped',
      deletionPending: true
    });
    await expect(repo.getPlaybackGrant('grant-session-secret-retry')).resolves.toMatchObject({
      revokedAt: expect.any(String)
    });
    await expect(secrets.get(secretRef)).resolves.toBe('durable source credential');

    await expect(service.delete(session.id)).resolves.toBeUndefined();
    await expect(repo.getSession(session.id)).resolves.toBeUndefined();
    await expect(secrets.get(secretRef)).rejects.toThrow('Secret not found');
  });

  it('finishes a session deletion that was fenced before the process stopped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-delete-recovery-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createProvider({
      id: 'provider-delete-recovery',
      type: 'jellyfin',
      name: 'Deletion recovery provider',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: 'provider:delete-recovery',
      capabilities: ['search'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
    const session: RelaySession = {
      id: 'session-delete-recovery',
      name: 'Deletion recovery',
      kind: 'vod',
      source: { providerId: 'provider-delete-recovery', itemId: 'movie' },
      durationSeconds: 60,
      profileId: 'profile-delete-recovery',
      profileRevision: 1,
      platformMode: 'pc',
      state: 'active',
      pinned: false,
      reportActivity: false,
      viewers: 0,
      placementPolicy: 'local',
      placementLocked: false,
      lastPlaybackActivityAt: now,
      deletionPending: false,
      outputUrls: { primary: 'https://relay.invalid/play/token/index.m3u8' },
      createdAt: now,
      updatedAt: now
    };
    await repo.createSessionWithPlaybackGrant(session, {
      tokenHash: 'grant-delete-recovery',
      sessionId: session.id,
      expiresAt: null,
      revokedAt: null,
      createdAt: now
    });
    await expect(repo.beginSessionDeletion(session.id, { observedAt: now })).resolves.toMatchObject(
      {
        applied: true,
        record: { value: { state: 'stopped', deletionPending: true } }
      }
    );
    const cached = join(dir, 'cache', 'vod', session.id, 'profile', '0.ts');
    await mkdir(dirname(cached), { recursive: true });
    await writeFile(cached, 'cached segment');
    const registry = new DefaultProviderRegistry();
    registry.register(provider);
    const service = new SessionService(
      repo,
      new MemorySecretStore(),
      registry,
      {
        discover: async () => mediaCapabilities,
        generateSegment: async () => {}
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.invalid',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 60_000,
        maxWorkers: 1
      },
      { clusterRepository: repo }
    );

    await expect(service.recover()).resolves.toBe(1);
    await expect(repo.getSession(session.id)).resolves.toBeUndefined();
    await expect(repo.getPlaybackGrant('grant-delete-recovery')).resolves.toMatchObject({
      revokedAt: now
    });
    await expect(access(cached)).rejects.toThrow();
  });

  it('reclaims expired leases and removes partial worker output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-recovery-'));
    dirs.push(dir);
    const repo = trackRepository(new SqliteRepository(join(dir, 'db.sqlite')));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.createSegmentJob({
      id: 'expired',
      contentKey: 'vod/expired.ts',
      sessionId: 'session',
      segmentIndex: 0,
      state: 'running',
      attempts: 1,
      workerHistory: [
        {
          attempt: 1,
          nodeId: 'lost-worker',
          state: 'running',
          startedAt: now
        }
      ],
      ownerNodeId: 'lost-worker',
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      createdAt: now,
      updatedAt: now
    });
    await repo.createSegmentJob({
      id: 'active',
      contentKey: 'vod/active.ts',
      sessionId: 'session',
      segmentIndex: 1,
      state: 'running',
      attempts: 1,
      workerHistory: [],
      ownerNodeId: 'active-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: now,
      updatedAt: now
    });
    const workerPartial = join(dir, 'cache', 'worker', 'expired', '0.ts.part');
    const restorePartial = join(dir, 'cache', 'vod', 'session', '0.ts.123.part');
    await mkdir(dirname(workerPartial), { recursive: true });
    await mkdir(dirname(restorePartial), { recursive: true });
    await writeFile(workerPartial, 'partial');
    await writeFile(restorePartial, 'partial');
    const registry = new DefaultProviderRegistry();
    registry.register(provider);
    const service = new SessionService(
      repo,
      new MemorySecretStore(),
      registry,
      {
        discover: async () => ({
          ffmpegVersion: 'test',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => {}
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.invalid',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 60_000,
        maxWorkers: 1
      },
      { clusterRepository: repo }
    );

    expect(await service.recover()).toBe(1);
    const recovered = await repo.getSegmentJob('expired');
    expect(recovered?.state).toBe('queued');
    expect(recovered).not.toHaveProperty('ownerNodeId');
    expect(recovered).not.toHaveProperty('leaseExpiresAt');
    expect(recovered?.workerHistory).toEqual([
      expect.objectContaining({
        attempt: 1,
        nodeId: 'lost-worker',
        state: 'failed',
        errorMessage: 'Recovered expired segment job lease',
        completedAt: expect.any(String)
      })
    ]);
    expect(await repo.getSegmentJob('active')).toMatchObject({
      state: 'running',
      ownerNodeId: 'active-worker'
    });
    await expect(access(workerPartial)).rejects.toThrow();
    await expect(access(restorePartial)).rejects.toThrow();
  });
});
