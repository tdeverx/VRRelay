// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalObjectStore, MemoryCoordinationStore, SqliteRepository } from '@vrrelay/adapters';
import type { ProfileRevision, RelaySession, VodProducer } from '@vrrelay/domain';
import type { Transcoder } from './index.js';
import { InMemoryEventBus } from './index.js';
import { SessionCache } from './session-cache.js';
import { VodProducerCoordinator } from './vod-producer-coordinator.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const profile: ProfileRevision = {
  profileId: 'producer-test',
  revision: 1,
  name: 'Producer test',
  description: 'Persistent producer fixture',
  platform: 'pc',
  state: 'experimental',
  video: {
    codec: 'h264',
    encoder: 'libx264',
    hardwareMode: 'software',
    decodeMode: 'auto',
    profile: 'high',
    level: '4.1',
    pixelFormat: 'yuv420p',
    width: 320,
    height: 180,
    frameRate: 30,
    bitrateKbps: 600,
    maxrateKbps: 700,
    bufferKbps: 1_400,
    preset: 'fast',
    gop: 60,
    bFrames: 0
  },
  audio: { codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48_000, bitrateKbps: 96 },
  delivery: {
    method: 'hls',
    container: 'mpegts',
    segmentType: 'mpegts',
    segmentDuration: 2,
    playlistType: 'vod',
    latencyMode: 'standard'
  },
  processing: { toneMap: false, burnSubtitles: false, passthrough: 'never', maxWorkers: 1 },
  createdAt: new Date().toISOString()
};

function session(id = 'session-producer'): RelaySession {
  const now = new Date().toISOString();
  return {
    id,
    name: 'Producer fixture',
    kind: 'vod',
    source: { providerId: 'provider-1', itemId: 'movie-1', versionId: 'v1' },
    profileId: profile.profileId,
    profileRevision: profile.revision,
    platformMode: 'universal',
    state: 'idle',
    durationSeconds: 120,
    pinned: false,
    reportActivity: false,
    viewers: 0,
    placementPolicy: 'auto',
    assignedNodeId: 'worker-a',
    placementLocked: false,
    outputUrls: { primary: 'https://relay.example/play/grant/index.m3u8' },
    createdAt: now,
    updatedAt: now
  };
}

function continuousTranscoder(starts: number[]): Transcoder {
  return {
    discover: async () => ({
      ffmpegVersion: 'fixture',
      encoders: [],
      muxers: [],
      filters: [],
      pixelFormats: []
    }),
    generateSegment: async () => undefined,
    produceVod: async (request, directory, onSegment, signal) => {
      starts.push(request.startSegmentIndex);
      await mkdir(directory, { recursive: true });
      for (const index of [request.startSegmentIndex, request.startSegmentIndex + 1]) {
        const path = join(directory, `segment-${index}.ts`);
        await writeFile(path, `segment-${index}`);
        await onSegment({ index, path });
      }
      await new Promise<never>((_resolve, reject) => {
        const stop = () => reject(signal?.reason ?? new Error('producer stopped'));
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
      });
    },
    streamFragmentedMp4: async (_source, _profile, output: Writable) => {
      output.end();
    }
  };
}

class LeaseLosingCoordination extends MemoryCoordinationStore {
  loseLease = false;

  override async renew(key: string, owner: string, ttlMs: number): Promise<boolean> {
    return this.loseLease ? false : super.renew(key, owner, ttlMs);
  }
}

class ReleaseFailingCoordination extends MemoryCoordinationStore {
  override async release(): Promise<void> {
    throw new Error('coordination unavailable');
  }
}

async function fixture(
  idleTimeoutMs = 60_000,
  coordination: MemoryCoordinationStore = new MemoryCoordinationStore(),
  timing: { leaseMs?: number; leaseRenewMs?: number } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'vrrelay-producer-'));
  directories.push(directory);
  const repository = new SqliteRepository(join(directory, 'state.sqlite'));
  await repository.migrate();
  const objectStore = new LocalObjectStore(join(directory, 'objects'));
  const cache = new SessionCache(
    { cacheDir: join(directory, 'cache'), cacheTtlMs: 60_000 },
    objectStore,
    undefined,
    new InMemoryEventBus()
  );
  const starts: number[] = [];
  const coordinator = new VodProducerCoordinator(
    repository,
    coordination,
    objectStore,
    continuousTranscoder(starts),
    cache,
    {
      prepare: async (_session, selectedProfile, startSegmentIndex) => ({
        source: {
          url: 'http://127.0.0.1/internal/source/opaque',
          headers: {},
          durationSeconds: 120,
          fingerprint: 'fixture'
        },
        profile: selectedProfile,
        startSegmentIndex,
        startSeconds: startSegmentIndex * selectedProfile.delivery.segmentDuration,
        duration: 120 - startSegmentIndex * selectedProfile.delivery.segmentDuration
      })
    },
    { cacheDir: join(directory, 'cache'), nodeId: 'worker-a', idleTimeoutMs, ...timing }
  );
  return { coordinator, coordination, repository, starts };
}

describe('durable VOD producer coordination', () => {
  it('joins concurrent and sequential demand, then replaces only for a distant majority seek', async () => {
    const { coordinator, coordination, repository, starts } = await fixture();
    const selectedSession = session();
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-a',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await Promise.all([
      coordinator.ensure(selectedSession, profile, 0),
      coordinator.ensure(selectedSession, profile, 0)
    ]);
    await coordinator.ensure(selectedSession, profile, 1);
    expect(starts).toEqual([0]);

    for (const viewerHash of ['viewer-b', 'viewer-c'])
      await coordination.recordSegmentDemand({
        sessionId: selectedSession.id,
        viewerHash,
        segmentIndex: 10,
        observedAtMs: Date.now(),
        windowMs: 30_000
      });
    await coordinator.ensure(selectedSession, profile, 10);
    expect(starts).toEqual([0, 10]);
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      ownerNodeId: 'worker-a',
      generation: 2,
      state: 'running',
      demandedSegmentIndex: 10,
      startSegmentIndex: 10,
      lastPublishedSegmentIndex: 11
    });
    await coordinator.close();
    repository.close();
  });

  it('stops an otherwise continuous producer after the demand timeout', async () => {
    const { coordinator, coordination, repository } = await fixture(50);
    const selectedSession = session('session-idle');
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-a',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(selectedSession, profile, 0);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const producer = await coordinator.get(selectedSession.id);
    expect(producer).toMatchObject({ state: 'idle' });
    expect(producer?.ownerNodeId).toBeUndefined();
    await coordinator.close();
    repository.close();
  }, 5_000);

  it('re-evaluates a majority that arrives after the first distant request', async () => {
    const { coordinator, coordination, repository, starts } = await fixture();
    const selectedSession = session('session-late-majority');
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-current',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(selectedSession, profile, 0);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-seek-a',
      segmentIndex: 10,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    const seeking = coordinator.ensure(selectedSession, profile, 10);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const viewerHash of ['viewer-seek-b', 'viewer-seek-c'])
      await coordination.recordSegmentDemand({
        sessionId: selectedSession.id,
        viewerHash,
        segmentIndex: 10,
        observedAtMs: Date.now(),
        windowMs: 30_000
      });
    await seeking;
    expect(starts).toEqual([0, 10]);
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      generation: 2,
      demandedSegmentIndex: 10,
      startSegmentIndex: 10
    });
    await coordinator.close();
    repository.close();
  }, 5_000);

  it('fails and releases ownership when its distributed lease is lost', async () => {
    const coordination = new LeaseLosingCoordination();
    const { coordinator, repository } = await fixture(60_000, coordination, {
      leaseMs: 100,
      leaseRenewMs: 20
    });
    const selectedSession = session('session-lease-loss');
    await coordinator.ensure(selectedSession, profile, 0);
    coordination.loseLease = true;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      generation: 1,
      state: 'failed'
    });
    expect((await coordinator.get(selectedSession.id))?.ownerNodeId).toBeUndefined();
    await coordinator.close();
    repository.close();
  });

  it('does not reject producer shutdown when best-effort lease release is unavailable', async () => {
    const { coordinator, repository } = await fixture(
      60_000,
      new ReleaseFailingCoordination()
    );
    await coordinator.ensure(session('session-release-outage'), profile, 0);
    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(await coordinator.get('session-release-outage')).toMatchObject({ state: 'idle' });
    repository.close();
  });

  it('uses fenced handoff state on drain and ignores stale-generation completion', async () => {
    const { coordinator, repository } = await fixture();
    const selectedSession = session('session-fenced-drain');
    await coordinator.ensure(selectedSession, profile, 0);
    const current = await repository.getVersionedVodProducer(selectedSession.id);
    if (!current) throw new Error('Producer fixture was not persisted');
    const handedOff: VodProducer = {
      ...current.value,
      ownerNodeId: 'worker-b',
      generation: 2,
      state: 'running',
      workerHistory: [
        ...current.value.workerHistory,
        {
          generation: 2,
          nodeId: 'worker-b',
          state: 'running',
          startSegmentIndex: 0,
          startedAt: new Date().toISOString()
        }
      ],
      updatedAt: new Date().toISOString()
    };
    expect(
      (
        await repository.compareAndSetVodProducer(handedOff, current.revision, [
          'starting',
          'running'
        ])
      ).applied
    ).toBe(true);
    await coordinator.drain();
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      ownerNodeId: 'worker-b',
      generation: 2,
      state: 'running'
    });
    repository.close();
  });

  it('reconciles an abandoned durable generation to idle on startup', async () => {
    const { coordinator, repository } = await fixture();
    const now = new Date().toISOString();
    const abandoned: VodProducer = {
      id: 'session-recovery',
      sessionId: 'session-recovery',
      ownerNodeId: 'worker-old',
      generation: 4,
      state: 'running',
      demandedSegmentIndex: 6,
      startSegmentIndex: 6,
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      lastDemandAt: now,
      idleDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      workerHistory: [
        {
          generation: 4,
          nodeId: 'worker-old',
          state: 'running',
          startSegmentIndex: 6,
          startedAt: now
        }
      ],
      createdAt: now,
      updatedAt: now
    };
    await repository.createVodProducer(abandoned);
    expect(await coordinator.recoverExpired()).toBe(1);
    const recovered = await coordinator.get(abandoned.sessionId);
    expect(recovered).toMatchObject({ generation: 4, state: 'idle' });
    expect(recovered?.ownerNodeId).toBeUndefined();
    expect(recovered?.workerHistory.at(-1)?.state).toBe('failed');
    repository.close();
  });
});
