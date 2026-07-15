import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DefaultProviderRegistry,
  InMemoryEventBus,
  type MediaProvider,
  type SegmentRequest,
  type Transcoder
} from './index.js';
import { MemorySecretStore, PrometheusMetricsSink, SqliteRepository } from '@vrrelay/adapters';
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

describe('VOD relay service', () => {
  it('publishes a finite manifest and coalesces identical segment work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-session-'));
    dirs.push(dir);
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.putProvider({
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
    await repo.putSegmentJob({
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
    });
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
  });
});

describe('provider lifecycle', () => {
  it('removes the local credential and rejects deletion while a session depends on it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-delete-'));
    dirs.push(dir);
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.putProvider({
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
    await repo.putSession({
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
    });
    const secrets = new MemorySecretStore();
    await secrets.put('provider:delete', 'access-token');
    const service = new ProviderService(repo, secrets, new DefaultProviderRegistry());

    await expect(service.delete('provider-delete')).rejects.toThrow(
      'Delete relay sessions that use this provider first'
    );
    expect(await secrets.get('provider:delete')).toBe('access-token');

    await repo.deleteSession('dependent-session');
    await service.delete('provider-delete');
    expect(await repo.getProvider('provider-delete')).toBeUndefined();
    await expect(secrets.get('provider:delete')).rejects.toThrow('Secret not found');
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

    await repo.putLiveChannel({ ...stored!, publisherState: 'online' });
    await expect(service.delete(created.channel.id)).rejects.toThrow(
      'Stop the OBS publisher before deleting this live channel'
    );
    await repo.putLiveChannel({ ...stored!, publisherState: 'offline' });
    await expect(service.delete(created.channel.id)).rejects.toThrow(
      'Delete live playback sessions that use this channel first'
    );
    const [liveSession] = await repo.listSessions();
    await repo.deleteSession(liveSession!.id);
    await service.delete(created.channel.id);
    await expect(service.delete(created.channel.id)).rejects.toThrow('Live channel was not found');
  });
});

describe('provider failover bindings', () => {
  it('resolves each worker credential from its own binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-provider-binding-'));
    dirs.push(dir);
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
    await repo.migrate();
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
    const workerASecrets = new MemorySecretStore();
    const workerBSecrets = new MemorySecretStore();
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
      'binding-a'
    );
    await workerB.createBinding(
      { ...input, username: 'worker-b' },
      'worker-b',
      'provider-1',
      'binding-b'
    );

    expect(await repo.listProviderBindings('provider-1')).toHaveLength(2);
    expect((await repo.getProvider('provider-1'))?.secretRef).toBe('provider-binding:binding-a');
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
    await expect(workerASecrets.get('provider-binding:binding-b')).rejects.toThrow();
    await expect(workerBSecrets.get('provider-binding:binding-a')).rejects.toThrow();
  });
});

describe('crash recovery', () => {
  it('reclaims expired leases and removes partial worker output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-recovery-'));
    dirs.push(dir);
    const repo = new SqliteRepository(join(dir, 'db.sqlite'));
    await repo.migrate();
    const now = new Date().toISOString();
    await repo.putSegmentJob({
      id: 'expired',
      contentKey: 'vod/expired.ts',
      sessionId: 'session',
      segmentIndex: 0,
      state: 'running',
      attempts: 1,
      workerHistory: [],
      ownerNodeId: 'lost-worker',
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      createdAt: now,
      updatedAt: now
    });
    await repo.putSegmentJob({
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
    expect(await repo.getSegmentJob('active')).toMatchObject({
      state: 'running',
      ownerNodeId: 'active-worker'
    });
    await expect(access(workerPartial)).rejects.toThrow();
    await expect(access(restorePartial)).rejects.toThrow();
  });
});
