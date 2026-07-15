import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateProfileRevisionRequest } from '@vrrelay/contracts';
import {
  DefaultProviderRegistry,
  InMemoryEventBus,
  type MediaProvider,
  type LiveNormalizer,
  type ObjectStore,
  type RemoteProviderGateway,
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
import type { BackendStatus, CachedObject, ClusterNode, ProfileRevision } from '@vrrelay/domain';
import { LiveService, ProfileService, ProviderService, SessionService } from './services.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
);
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
      providerIds: []
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

describe('profile lifecycle', () => {
  it('accepts implemented HLS and fragmented MP4 profile shapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-profile-implemented-'));
    dirs.push(dir);
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
    await repo.migrate();
    const service = new ProfileService(repo);

    await expect(service.createRevision(profileInput())).resolves.toMatchObject({
      profileId: expect.any(String),
      revision: 1,
      delivery: { method: 'hls', container: 'mpegts', segmentType: 'mpegts' }
    });
    await expect(
      service.createRevision(
        profileInput({
          profileId: 'fragmented-profile',
          delivery: {
            method: 'fragmented_mp4',
            container: 'mp4',
            segmentType: 'none',
            playlistType: 'vod'
          }
        })
      )
    ).resolves.toMatchObject({
      profileId: 'fragmented-profile',
      revision: 1,
      delivery: { method: 'fragmented_mp4', container: 'mp4', segmentType: 'none' }
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
      'mismatched fragmented MP4 shape',
      { delivery: { method: 'fragmented_mp4', container: 'fmp4', segmentType: 'fmp4' } },
      /Fragmented MP4 profiles/
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
      const repo = new SqliteRepository(join(dir, 'db.sqlite'));
      await repo.migrate();
      const service = new ProfileService(repo);

      await expect(service.createRevision(profileInput(overrides))).rejects.toThrow(expected);
      await expect(repo.listProfiles()).resolves.toEqual([]);
    }
  );
});

describe('VOD relay service', () => {
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
      const repo = new ProviderFailureRepository(join(dir, 'db.sqlite'));
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
          generateSegment: async () => {},
          streamFragmentedMp4: async () => {}
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

  it('publishes a finite manifest and coalesces identical segment work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-'));
    dirs.push(dir);
    const repo = new SessionConflictRepository(join(dir, 'db.sqlite'));
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
    let blockedFailure = false;
    let blockedStarted = Promise.withResolvers<void>();
    let blockedRelease = Promise.withResolvers<void>();
    const blockSegment = (index: number, fail: boolean) => {
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
          if (blockedFailure) throw new Error('Simulated late worker failure');
        }
        await new Promise((r) => setTimeout(r, 20));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, 'segment');
      },
      streamFragmentedMp4: async () => {}
    };
    const profileService = new ProfileService(repo);
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
    const [completedJob] = await service.listJobs();
    expect(completedJob).toMatchObject({
      state: 'complete',
      attempts: 1,
      workerHistory: [{ state: 'complete', nodeId: 'standalone' }]
    });
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
    expect(service.egressMbps()).toBeCloseTo(0.000000008);
    expect(service.egressMbps(Date.now() + 30_001)).toBe(0);
    const renderedMetrics = await metrics.render();
    expect(renderedMetrics).toContain('vrrelay_egress_bytes_total');
    expect(renderedMetrics).toContain('vrrelay_egress_bytes_total{session="unattributed"} 20');

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
    await expect(repo.getSession(session.id)).resolves.toMatchObject({
      pinned: true,
      state: 'stopped',
      viewers: 1
    });

    for (const [index, fail] of [
      [1, false],
      [2, true]
    ] as const) {
      const gate = blockSegment(index, fail);
      const lateResult = service.segment(token, index);
      await gate.started;
      const job = (await service.listJobs()).find((candidate) => candidate.segmentIndex === index);
      expect(job?.state).toBe('running');
      await service.cancelJob(job!.id);
      gate.release();
      await expect(lateResult).rejects.toThrow(/cancelled/i);
      await expect(repo.getSegmentJob(job!.id)).resolves.toMatchObject({ state: 'cancelled' });
    }
    await expect(repo.getSession(session.id)).resolves.toMatchObject({ state: 'stopped' });
  });

  it('invalidates corrupt object-store restores and regenerates the segment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-object-restore-'));
    dirs.push(dir);
    const repo = new SessionConflictRepository(join(dir, 'db.sqlite'));
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
        },
        streamFragmentedMp4: async () => {}
      },
      new InMemoryEventBus(),
      {
        publicUrl: 'https://relay.example',
        internalUrl: 'http://127.0.0.1:8099',
        cacheDir: join(dir, 'cache'),
        cacheTtlMs: 60_000,
        maxWorkers: 1
      },
      { objectStore, clusterRepository: repo }
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
  });

  it('enforces disk cache pressure after segment generation without evicting the requested file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-cache-pressure-'));
    dirs.push(dir);
    const repo = new SessionConflictRepository(join(dir, 'db.sqlite'));
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
        },
        streamFragmentedMp4: async () => {}
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
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
      generateSegment: async () => {},
      streamFragmentedMp4: async () => {}
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
    await expect(edgeA.touchViewer(edgeToken, 'viewer-a')).resolves.toMatchObject({
      id: session.id
    });
    await edgeA.touchViewer(edgeToken, 'viewer-a');
    await expect(repo.getSession(session.id)).resolves.toMatchObject({ viewers: 1 });
    await edgeA.touchViewer(edgeToken, 'viewer-b');
    await expect(repo.getSession(session.id)).resolves.toMatchObject({ viewers: 2 });
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
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
      const repo = new AmbiguousFinalizeRepository(join(dir, 'db.sqlite'));
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
    const repo = new ValidationConflictRepository(join(dir, 'db.sqlite'));
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
  it('returns publisher credentials once without persisting them in connection URLs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-live-'));
    dirs.push(dir);
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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

    const [listed] = await service.list();
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('publishTokenHash');
    expect(JSON.stringify(listed)).not.toContain(created.publisher.publishToken);
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
        generateSegment: async () => {},
        streamFragmentedMp4: async () => {}
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
    await expect(
      sessions.create({
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
      })
    ).resolves.toMatchObject({ kind: 'live', liveChannelId: created.channel.id });

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
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
    await repo.migrate();
    const service = new LiveService(repo, {
      publicUrl: 'https://relay.example',
      rtmpUrl: 'rtmp://ingest.example/live',
      srtUrl: 'srt://ingest.example:8890',
      whipUrl: 'https://ingest.example',
      hlsUrl: 'https://edge.example',
      internalRtspUrl: 'rtsp://mediamtx:8554'
    });
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
  });

  it('records the selected ingest origin and region when creating a live channel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-live-origin-'));
    dirs.push(dir);
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
        providerIds: []
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
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
      normalizer
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
        generateSegment: async () => {},
        streamFragmentedMp4: async () => {}
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
  });

  it('rejects conflicting normalization profiles for the same live channel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-live-profile-conflict-'));
    dirs.push(dir);
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
    await repo.migrate();
    const profileService = new ProfileService(repo);
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
        generateSegment: async () => {},
        streamFragmentedMp4: async () => {}
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
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
        },
        streamFragmentedMp4: async () => {}
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
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
    const repo = new ThrowAfterCommitRepository(join(dir, 'db.sqlite'));
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
    const repo = new UnreadableCommitRepository(join(dir, 'db.sqlite'));
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
  it('reclaims expired leases and removes partial worker output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-recovery-'));
    dirs.push(dir);
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
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
        generateSegment: async () => {},
        streamFragmentedMp4: async () => {}
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
