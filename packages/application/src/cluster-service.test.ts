import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../adapters/src/sqlite-repository.js';
import { MemoryCoordinationStore } from '../../adapters/src/local-infrastructure.js';
import { BuiltinTrafficDirector, ClusterService } from './cluster-service.js';
import { InMemoryEventBus } from './index.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
);

const capabilities = {
  encoders: ['libx264'],
  hardwareDevices: [],
  maxWorkers: 4,
  activeWorkers: 0,
  queuedWorkers: 0,
  cacheBytes: 0,
  cacheLimitBytes: null,
  egressMbps: 0,
  providerIds: ['provider-1']
};

describe('cluster service', () => {
  it('routes new sessions away from saturated edges', async () => {
    const now = new Date().toISOString();
    const director = new BuiltinTrafficDirector();
    const selected = await director.selectEdge('capacity-sensitive-session', [
      {
        id: 'saturated',
        name: 'Saturated edge',
        roles: ['edge'],
        region: 'local',
        publicUrl: 'https://saturated.example',
        state: 'online',
        capabilities: {
          ...capabilities,
          activeWorkers: 4,
          cacheBytes: 100,
          cacheLimitBytes: 100,
          egressMbps: 1_000_000
        },
        weight: 100,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'available',
        name: 'Available edge',
        roles: ['edge'],
        region: 'local',
        publicUrl: 'https://available.example',
        state: 'online',
        capabilities,
        weight: 100,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now
      }
    ]);

    expect(selected?.id).toBe('available');
  });

  it('consumes join tokens once and honors draining edges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-cluster-'));
    dirs.push(dir);
    const repository = new SqliteRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    const claim = await cluster.createJoinToken({
      name: 'London edge',
      roles: ['edge'],
      region: 'eu-west',
      expiresInSeconds: 60
    });
    const enrolled = await cluster.enroll({
      token: claim.token,
      name: 'London edge',
      publicUrl: 'https://edge.example',
      capabilities
    });
    await expect(
      cluster.enroll({
        token: claim.token,
        name: 'Duplicate',
        publicUrl: 'https://duplicate.example',
        capabilities
      })
    ).rejects.toThrow(/already used/);
    expect((await cluster.selectEdge('session-a', 'eu-west'))?.nodeId).toBe(enrolled.node.id);
    await cluster.drain(enrolled.node.id, true);
    expect(await cluster.selectEdge('session-a', 'eu-west')).toBeUndefined();
  });

  it('allows only one concurrent consumer of a join token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-cluster-race-'));
    dirs.push(dir);
    const repository = new SqliteRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    const claim = await cluster.createJoinToken({
      name: 'Worker',
      roles: ['source-worker'],
      region: 'local',
      expiresInSeconds: 60
    });
    const attempt = (name: string) =>
      cluster.enroll({
        token: claim.token,
        name,
        publicUrl: `https://${name.toLowerCase()}.example`,
        capabilities
      });

    const results = await Promise.allSettled([attempt('WorkerA'), attempt('WorkerB')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await repository.listNodes()).toHaveLength(1);
  });

  it('fails explicit placement when the requested encoder is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-placement-'));
    dirs.push(dir);
    const repository = new SqliteRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    await cluster.registerLocal({
      id: 'worker',
      name: 'Worker',
      roles: ['source-worker'],
      region: 'local',
      publicUrl: 'https://worker.example',
      state: 'online',
      capabilities,
      weight: 100
    });
    const result = await cluster.previewPlacement({
      policy: 'hosted',
      preferredNodeId: 'worker',
      providerId: 'provider-1',
      profile: {
        profileId: 'hevc',
        revision: 1,
        name: 'HEVC',
        platform: 'pc',
        state: 'experimental',
        video: {
          codec: 'h265',
          encoder: 'hevc_nvenc',
          hardwareMode: 'nvenc',
          decodeMode: 'auto',
          pixelFormat: 'yuv420p',
          width: 1920,
          height: 1080,
          frameRate: 30,
          bitrateKbps: 6000,
          maxrateKbps: 7000,
          bufferKbps: 12000,
          gop: 60,
          bFrames: 0
        },
        audio: { codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, bitrateKbps: 192 },
        delivery: {
          method: 'hls',
          container: 'mpegts',
          segmentType: 'mpegts',
          segmentDuration: 4,
          playlistType: 'vod',
          latencyMode: 'standard'
        },
        processing: { toneMap: false, burnSubtitles: false, passthrough: 'never', maxWorkers: 1 },
        createdAt: new Date().toISOString()
      }
    });
    expect(result).toEqual({ reason: 'preferred-node-unavailable' });
  });

  it('degrades nodes after 45 seconds and marks them offline after 90 seconds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-heartbeat-'));
    dirs.push(dir);
    const repository = new SqliteRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    const node = await cluster.registerLocal({
      id: 'edge',
      name: 'Edge',
      roles: ['edge'],
      region: 'local',
      publicUrl: 'https://edge.example',
      state: 'online',
      capabilities,
      weight: 100
    });
    await repository.putNode({
      ...node,
      lastHeartbeatAt: new Date(Date.now() - 46_000).toISOString()
    });
    expect((await cluster.list())[0]?.state).toBe('degraded');
    expect(await cluster.selectEdge('session')).toBeUndefined();
    await repository.putNode({
      ...(await repository.getNode('edge'))!,
      lastHeartbeatAt: new Date(Date.now() - 91_000).toISOString()
    });
    expect((await cluster.list())[0]?.state).toBe('offline');
  });
});
