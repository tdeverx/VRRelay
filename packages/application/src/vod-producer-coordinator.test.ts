// SPDX-License-Identifier: GPL-3.0-or-later
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalObjectStore, MemoryCoordinationStore, SqliteRepository } from '@vrrelay/adapters';
import type { ProfileRevision, RelaySession, VodProducer } from '@vrrelay/domain';
import type { Transcoder } from './index.js';
import { InMemoryEventBus } from './index.js';
import { SessionCache } from './session-cache.js';
import {
  estimateVodProducerBufferMs,
  isVodProducerDemandCovered,
  VodProducerCoordinator,
  vodProducerCatchupRate,
  vodProducerForwardJoinSegments
} from './vod-producer-coordinator.js';
import type { VodProducerCallbacks } from './vod-producer-coordinator.js';
import type { VodProducerSourcePacing } from './vod-source-pacing.js';

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

async function persistSession(
  repository: SqliteRepository,
  selectedSession: RelaySession
): Promise<void> {
  const providerId = selectedSession.source?.providerId;
  if (!providerId) throw new Error('Producer test session requires a provider');
  if (!(await repository.getProvider(providerId))) {
    const now = new Date().toISOString();
    await repository.createProvider({
      id: providerId,
      type: 'jellyfin',
      name: 'Producer fixture',
      baseUrl: 'https://media.invalid',
      authMode: 'user_token',
      secretRef: `fixture-secret-${providerId}`,
      capabilities: ['direct_source'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    });
  }
  const created = await repository.createSessionWithPlaybackGrant(selectedSession, {
    tokenHash: `fixture-grant-${selectedSession.id}`,
    sessionId: selectedSession.id,
    expiresAt: null,
    revokedAt: null,
    createdAt: selectedSession.createdAt
  });
  if (!created.applied) throw new Error('Producer test session was not persisted');
}

function continuousTranscoder(starts: number[], publishedPaths: string[]): Transcoder {
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
        publishedPaths.push(path);
      }
      await new Promise<never>((_resolve, reject) => {
        const stop = () => reject(signal?.reason ?? new Error('producer stopped'));
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
      });
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

class LeaseRejectingCoordination extends MemoryCoordinationStore {
  override async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    if (key.includes('lease-rejected')) return false;
    return super.acquire(key, owner, ttlMs);
  }
}

class GatedAcquireCoordination extends MemoryCoordinationStore {
  readonly entered: Promise<void>;
  #markEntered!: () => void;
  #release!: () => void;
  readonly #gate: Promise<void>;

  constructor() {
    super();
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  releaseAcquire(): void {
    this.#release();
  }

  override async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    this.#markEntered();
    await this.#gate;
    return super.acquire(key, owner, ttlMs);
  }
}

class GatedDemandCoordination extends MemoryCoordinationStore {
  readonly entered: Promise<void>;
  #markEntered!: () => void;
  #release!: () => void;
  readonly #gate: Promise<void>;

  constructor() {
    super();
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  releaseDemand(): void {
    this.#release();
  }

  override async listSegmentDemands(input: {
    sessionId: string;
    observedAtMs: number;
    windowMs: number;
  }) {
    this.#markEntered();
    await this.#gate;
    return super.listSegmentDemands(input);
  }
}

async function fixture(
  idleTimeoutMs = 60_000,
  coordination: MemoryCoordinationStore = new MemoryCoordinationStore(),
  timing: {
    leaseMs?: number;
    leaseRenewMs?: number;
    bufferLowWatermarkMs?: number;
    bufferHighWatermarkMs?: number;
    maxConcurrentProducers?: number;
    maxConcurrentProducersPerProvider?: number;
    waitForSegmentMs?: number;
    failureRetryMinMs?: number;
    failureRetryMaxMs?: number;
    demandRefreshIntervalMs?: number;
    progressStallTimeoutMs?: number;
  } = {},
  prepare?: VodProducerCallbacks['prepare'],
  transcoderFactory?: (starts: number[], publishedPaths: string[]) => Transcoder
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
  const publishedPaths: string[] = [];
  let sourcePacing: VodProducerSourcePacing | undefined;
  const coordinator = new VodProducerCoordinator(
    repository,
    coordination,
    objectStore,
    transcoderFactory?.(starts, publishedPaths) ?? continuousTranscoder(starts, publishedPaths),
    cache,
    {
      getSession: (id) => repository.getSession(id),
      prepare:
        prepare ??
        (async (selectedSession, selectedProfile, startSegmentIndex, _signal, pacing) => {
          sourcePacing = pacing;
          const durationSeconds = selectedSession.durationSeconds ?? 120;
          return {
            source: {
              url: 'http://127.0.0.1/internal/source/opaque',
              headers: {},
              durationSeconds,
              fingerprint: 'fixture'
            },
            profile: selectedProfile,
            startSegmentIndex,
            startSeconds: startSegmentIndex * selectedProfile.delivery.segmentDuration,
            duration:
              durationSeconds - startSegmentIndex * selectedProfile.delivery.segmentDuration,
            initialReadBurstSeconds: 60,
            readRate: 2
          };
        })
    },
    {
      cacheDir: join(directory, 'cache'),
      nodeId: 'worker-a',
      idleTimeoutMs,
      bufferLowWatermarkMs: 30_000,
      bufferHighWatermarkMs: 60_000,
      ...timing
    }
  );
  return {
    coordinator,
    coordination,
    repository,
    starts,
    publishedPaths,
    sourcePacing: () => sourcePacing
  };
}

describe('durable VOD producer coordination', () => {
  it('measures producer headroom against a one-speed playback clock', () => {
    expect(
      estimateVodProducerBufferMs({
        playbackAnchorSegmentIndex: 10,
        lastPublishedSegmentIndex: 19,
        segmentDurationSeconds: 4,
        playbackAnchorAtMs: 1_000,
        observedAtMs: 11_000
      })
    ).toBe(30_000);
    expect(
      estimateVodProducerBufferMs({
        playbackAnchorSegmentIndex: 10,
        lastPublishedSegmentIndex: 19,
        segmentDurationSeconds: 4,
        playbackAnchorAtMs: 1_000,
        observedAtMs: 51_000
      })
    ).toBe(0);
  });

  it('scales the forward join window with one-second and long segments', () => {
    expect(vodProducerForwardJoinSegments(30_000, 1)).toBe(10);
    expect(vodProducerForwardJoinSegments(30_000, 30)).toBe(2);
    const covered = (demandedSegmentIndex: number, segmentDurationSeconds: number) =>
      isVodProducerDemandCovered({
        startSegmentIndex: 0,
        lastPublishedSegmentIndex: 0,
        demandedSegmentIndex,
        bufferLowWatermarkMs: 30_000,
        segmentDurationSeconds
      });
    expect(covered(10, 1)).toBe(true);
    expect(covered(11, 1)).toBe(false);
    expect(covered(2, 30)).toBe(true);
    expect(covered(3, 30)).toBe(false);
  });

  it('fails a code-zero producer that ends before the expected terminal segment', async () => {
    let finishProducer!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishProducer = resolve;
    });
    const { coordinator, coordination, repository, starts } = await fixture(
      60_000,
      new MemoryCoordinationStore(),
      {},
      undefined,
      (observedStarts) => ({
        discover: async () => ({
          ffmpegVersion: 'fixture',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => undefined,
        produceVod: async (request, directory, onSegment) => {
          observedStarts.push(request.startSegmentIndex);
          await mkdir(directory, { recursive: true });
          const path = join(directory, `segment-${request.startSegmentIndex}.ts`);
          await writeFile(path, 'truncated-segment');
          await onSegment({ index: request.startSegmentIndex, path });
          await finish;
        }
      })
    );
    const selectedSession = { ...session('session-truncated-success'), durationSeconds: 5 };
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-truncated',
      segmentIndex: 1,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });

    await coordinator.ensure(selectedSession, profile, 1);
    const terminalSegment = coordinator.ensure(selectedSession, profile, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishProducer();
    await expect(terminalSegment).rejects.toThrow(
      'Persistent VOD producer failed before publishing the requested segment'
    );

    expect(starts).toEqual([1]);
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      generation: 1,
      state: 'failed',
      startSegmentIndex: 1,
      lastPublishedSegmentIndex: 1,
      errorMessage: expect.stringContaining('terminal segment 2')
    });
    await coordinator.close();
    repository.close();
  });

  it('uses FFmpeg millisecond duration precision for terminal segment validation', async () => {
    const { coordinator, coordination, repository, starts } = await fixture(
      60_000,
      new MemoryCoordinationStore(),
      {},
      undefined,
      (observedStarts) => ({
        discover: async () => ({
          ffmpegVersion: 'fixture',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => undefined,
        produceVod: async (request, directory, onSegment) => {
          observedStarts.push(request.startSegmentIndex);
          await mkdir(directory, { recursive: true });
          for (const index of [request.startSegmentIndex, request.startSegmentIndex + 1]) {
            const path = join(directory, `segment-${index}.ts`);
            await writeFile(path, `segment-${index}`);
            await onSegment({ index, path });
          }
        }
      })
    );
    const selectedSession = {
      ...session('session-terminal-duration-rounding'),
      durationSeconds: 4.0001
    };
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-terminal-rounding',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });

    await coordinator.ensure(selectedSession, profile, 0);
    await vi.waitFor(() => expect(coordinator.isActive(selectedSession.id)).toBe(false), {
      timeout: 2_000,
      interval: 10
    });

    expect(starts).toEqual([0]);
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      generation: 1,
      state: 'complete',
      lastPublishedSegmentIndex: 1
    });
    await coordinator.close();
    repository.close();
  });

  it('bounds immediate failures across the current request and rapid retries', async () => {
    let prepareAttempts = 0;
    const retryDelayMs = 200;
    const { coordinator, coordination, repository, starts } = await fixture(
      60_000,
      new MemoryCoordinationStore(),
      {
        failureRetryMinMs: retryDelayMs,
        failureRetryMaxMs: retryDelayMs
      },
      async (selectedSession, selectedProfile, startSegmentIndex) => {
        prepareAttempts += 1;
        if (prepareAttempts === 1) throw new Error('transient prepare failure');
        const durationSeconds = selectedSession.durationSeconds ?? 120;
        return {
          source: {
            url: 'http://127.0.0.1/internal/source/opaque',
            headers: {},
            durationSeconds,
            fingerprint: 'fixture'
          },
          profile: selectedProfile,
          startSegmentIndex,
          startSeconds: startSegmentIndex * selectedProfile.delivery.segmentDuration,
          duration: durationSeconds - startSegmentIndex * selectedProfile.delivery.segmentDuration,
          initialReadBurstSeconds: 60,
          readRate: 2
        };
      }
    );
    const selectedSession = session('session-failure-backoff');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-retry',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });

    await expect(coordinator.ensure(selectedSession, profile, 0)).rejects.toThrow(
      'Persistent VOD producer failed before publishing the requested segment'
    );
    expect(prepareAttempts).toBe(1);
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      generation: 1,
      state: 'failed'
    });

    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const rapidRetries = controllers.map((controller) =>
      coordinator.ensure(selectedSession, profile, 0, controller.signal)
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prepareAttempts).toBe(1);
    for (const controller of controllers) controller.abort(new Error('retry waiter left'));
    const retryResults = await Promise.allSettled(rapidRetries);
    expect(retryResults).toHaveLength(3);
    expect(
      retryResults.every(
        (result) => result.status === 'rejected' && result.reason.message === 'retry waiter left'
      )
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs + 20));
    await coordinator.ensure(selectedSession, profile, 0);
    expect(prepareAttempts).toBe(2);
    expect(starts).toEqual([0]);
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      generation: 2,
      state: 'running'
    });
    await coordinator.close();
    repository.close();
  });

  it('joins concurrent and sequential demand, then replaces only for a distant majority seek', async () => {
    const { coordinator, coordination, repository, starts } = await fixture();
    const selectedSession = session();
    await persistSession(repository, selectedSession);
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
    await vi.waitFor(
      async () => {
        const active = await coordinator.get(selectedSession.id);
        expect(active).toMatchObject({
          ownerNodeId: 'worker-a',
          generation: 2,
          state: 'running',
          demandedSegmentIndex: 10,
          startSegmentIndex: 10
        });
        expect(active?.lastPublishedSegmentIndex).toBeGreaterThanOrEqual(10);
      },
      { timeout: 2_000, interval: 10 }
    );
    await coordinator.close();
    repository.close();
  }, 60_000);

  it('stops an otherwise continuous producer after the demand timeout', async () => {
    const { coordinator, coordination, repository } = await fixture(
      50,
      new MemoryCoordinationStore(),
      { demandRefreshIntervalMs: 10 }
    );
    const selectedSession = session('session-idle');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-a',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(selectedSession, profile, 0);
    await vi.waitFor(
      async () => {
        const producer = await coordinator.get(selectedSession.id);
        expect(producer).toMatchObject({ state: 'idle' });
        expect(producer?.ownerNodeId).toBeUndefined();
      },
      { timeout: 2_000, interval: 10 }
    );
    await coordinator.close();
    repository.close();
  }, 5_000);

  it.each(['abort', 'publish'] as const)(
    'keeps a producer alive for pending waiters, then idles after the last waiter exits by %s',
    async (completion) => {
      const idleTimeoutMs = 60;
      let markStarted!: () => void;
      let publishSegment!: () => Promise<void>;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const { coordinator, coordination, repository, starts } = await fixture(
        idleTimeoutMs,
        new MemoryCoordinationStore(),
        {
          demandRefreshIntervalMs: 10,
          waitForSegmentMs: 2_000
        },
        undefined,
        (observedStarts) => ({
          discover: async () => ({
            ffmpegVersion: 'fixture',
            encoders: [],
            muxers: [],
            filters: [],
            pixelFormats: []
          }),
          generateSegment: async () => undefined,
          produceVod: async (request, directory, onSegment, signal) => {
            observedStarts.push(request.startSegmentIndex);
            await mkdir(directory, { recursive: true });
            publishSegment = async () => {
              const path = join(directory, `segment-${request.startSegmentIndex}.ts`);
              await writeFile(path, 'delayed-segment');
              await onSegment({ index: request.startSegmentIndex, path });
            };
            markStarted();
            await new Promise<never>((_resolve, reject) => {
              const stop = () => reject(signal?.reason ?? new Error('producer stopped'));
              if (signal?.aborted) stop();
              else signal?.addEventListener('abort', stop, { once: true });
            });
          }
        })
      );
      const selectedSession = session(`session-pending-waiter-${completion}`);
      await persistSession(repository, selectedSession);
      await coordination.recordSegmentDemand({
        sessionId: selectedSession.id,
        viewerHash: 'viewer-pending',
        segmentIndex: 0,
        observedAtMs: Date.now(),
        windowMs: 30_000
      });
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = coordinator.ensure(selectedSession, profile, 0, firstController.signal);
      const second = coordinator.ensure(selectedSession, profile, 0, secondController.signal);

      await started;
      await new Promise((resolve) => setTimeout(resolve, idleTimeoutMs * 2));
      expect(starts).toEqual([0]);
      expect(await coordinator.get(selectedSession.id)).toMatchObject({
        generation: 1,
        state: 'running'
      });

      const firstRejected = expect(first).rejects.toThrow('first waiter left');
      firstController.abort(new Error('first waiter left'));
      await firstRejected;
      await new Promise((resolve) => setTimeout(resolve, idleTimeoutMs * 2));
      expect(starts).toEqual([0]);
      expect(await coordinator.get(selectedSession.id)).toMatchObject({
        generation: 1,
        state: 'running'
      });

      if (completion === 'abort') {
        const secondRejected = expect(second).rejects.toThrow('last waiter left');
        secondController.abort(new Error('last waiter left'));
        await secondRejected;
      } else {
        await publishSegment();
        await second;
      }

      await vi.waitFor(
        async () => {
          expect(await coordinator.get(selectedSession.id)).toMatchObject({
            generation: 1,
            state: 'idle'
          });
        },
        { timeout: 1_000, interval: 10 }
      );
      expect(starts).toEqual([0]);
      await coordinator.close();
      repository.close();
    }
  );

  it('restarts a catching-up generation that stops publishing while a segment is pending', async () => {
    const { coordinator, coordination, repository, starts } = await fixture(
      60_000,
      new MemoryCoordinationStore(),
      {
        demandRefreshIntervalMs: 10,
        failureRetryMinMs: 10,
        failureRetryMaxMs: 10,
        progressStallTimeoutMs: 250,
        waitForSegmentMs: 2_000
      },
      undefined,
      (observedStarts) => ({
        discover: async () => ({
          ffmpegVersion: 'fixture',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => undefined,
        produceVod: async (request, directory, onSegment, signal) => {
          observedStarts.push(request.startSegmentIndex);
          await mkdir(directory, { recursive: true });
          const path = join(directory, `segment-${request.startSegmentIndex}.ts`);
          await writeFile(path, `segment-${request.startSegmentIndex}`);
          await onSegment({ index: request.startSegmentIndex, path });
          await new Promise<never>((_resolve, reject) => {
            const stop = () => reject(signal?.reason ?? new Error('producer stopped'));
            if (signal?.aborted) stop();
            else signal?.addEventListener('abort', stop, { once: true });
          });
        }
      })
    );
    const selectedSession = session('session-progress-stall-retry');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-stall',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(selectedSession, profile, 0);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-stall',
      segmentIndex: 1,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });

    await coordinator.ensure(selectedSession, profile, 1);

    expect(starts).toEqual([0, 1]);
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      generation: 2,
      state: 'running',
      startSegmentIndex: 1,
      workerHistory: [
        {
          generation: 1,
          state: 'failed',
          errorMessage: expect.stringContaining('stopped publishing')
        },
        { generation: 2, state: 'running' }
      ]
    });
    await coordinator.close();
    repository.close();
  });

  it('does not restart a stalled catching-up producer without a pending segment waiter', async () => {
    const { coordinator, coordination, repository, starts } = await fixture(
      60_000,
      new MemoryCoordinationStore(),
      {
        demandRefreshIntervalMs: 10,
        progressStallTimeoutMs: 1_000
      },
      undefined,
      (observedStarts) => ({
        discover: async () => ({
          ffmpegVersion: 'fixture',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => undefined,
        produceVod: async (request, directory, onSegment, signal) => {
          observedStarts.push(request.startSegmentIndex);
          await mkdir(directory, { recursive: true });
          const path = join(directory, `segment-${request.startSegmentIndex}.ts`);
          await writeFile(path, 'single-segment');
          await onSegment({ index: request.startSegmentIndex, path });
          await new Promise<never>((_resolve, reject) => {
            const stop = () => reject(signal?.reason ?? new Error('producer stopped'));
            if (signal?.aborted) stop();
            else signal?.addEventListener('abort', stop, { once: true });
          });
        }
      })
    );
    const selectedSession = session('session-progress-stall-no-waiter');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-no-waiter',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });

    await coordinator.ensure(selectedSession, profile, 0);
    const currentTimeMs = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(currentTimeMs + 2_000);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(starts).toEqual([0]);
      expect(await coordinator.get(selectedSession.id)).toMatchObject({
        generation: 1,
        state: 'running'
      });
    } finally {
      now.mockRestore();
      await coordinator.close();
      repository.close();
    }
  });

  it('does not restart a buffered producer while a later segment is pending', async () => {
    const { coordinator, coordination, repository, sourcePacing, starts } = await fixture(
      60_000,
      new MemoryCoordinationStore(),
      {
        bufferLowWatermarkMs: 500,
        bufferHighWatermarkMs: 1_000,
        demandRefreshIntervalMs: 10,
        progressStallTimeoutMs: 100,
        waitForSegmentMs: 2_000
      },
      undefined,
      (observedStarts) => ({
        discover: async () => ({
          ffmpegVersion: 'fixture',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => undefined,
        produceVod: async (request, directory, onSegment, signal) => {
          observedStarts.push(request.startSegmentIndex);
          await mkdir(directory, { recursive: true });
          const path = join(directory, `segment-${request.startSegmentIndex}.ts`);
          await writeFile(path, 'buffered-segment');
          await onSegment({ index: request.startSegmentIndex, path });
          await new Promise<never>((_resolve, reject) => {
            const stop = () => reject(signal?.reason ?? new Error('producer stopped'));
            if (signal?.aborted) stop();
            else signal?.addEventListener('abort', stop, { once: true });
          });
        }
      })
    );
    const selectedSession = session('session-progress-stall-buffered');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-buffered',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(selectedSession, profile, 0);
    await vi.waitFor(() => expect(sourcePacing()?.state).toBe('buffered'), {
      timeout: 2_000,
      interval: 25
    });
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-buffered',
      segmentIndex: 1,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    const waiter = new AbortController();
    const pending = coordinator.ensure(selectedSession, profile, 1, waiter.signal);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sourcePacing()?.state).toBe('buffered');
    expect(starts).toEqual([0]);
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      generation: 1,
      state: 'running',
      bufferState: 'buffered'
    });

    const rejected = expect(pending).rejects.toThrow('buffered waiter left');
    waiter.abort(new Error('buffered waiter left'));
    await rejected;
    await coordinator.close();
    repository.close();
  });

  it('resets the catching-up watchdog after every successful publication', async () => {
    let markFourthPublished!: () => void;
    const fourthPublished = new Promise<void>((resolve) => {
      markFourthPublished = resolve;
    });
    const { coordinator, coordination, repository, starts } = await fixture(
      60_000,
      new MemoryCoordinationStore(),
      {
        demandRefreshIntervalMs: 10,
        progressStallTimeoutMs: 2_000,
        waitForSegmentMs: 10_000
      },
      undefined,
      (observedStarts) => ({
        discover: async () => ({
          ffmpegVersion: 'fixture',
          encoders: [],
          muxers: [],
          filters: [],
          pixelFormats: []
        }),
        generateSegment: async () => undefined,
        produceVod: async (request, directory, onSegment, signal) => {
          observedStarts.push(request.startSegmentIndex);
          await mkdir(directory, { recursive: true });
          for (let offset = 0; offset <= 4; offset += 1) {
            if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 600));
            const index = request.startSegmentIndex + offset;
            const path = join(directory, `segment-${index}.ts`);
            await writeFile(path, `segment-${index}`);
            await onSegment({ index, path });
          }
          markFourthPublished();
          await new Promise<never>((_resolve, reject) => {
            const stop = () => reject(signal?.reason ?? new Error('producer stopped'));
            if (signal?.aborted) stop();
            else signal?.addEventListener('abort', stop, { once: true });
          });
        }
      })
    );
    const selectedSession = session('session-progress-stall-reset');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-progress',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(selectedSession, profile, 0);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-progress',
      segmentIndex: 5,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    const waiter = new AbortController();
    const pending = coordinator.ensure(selectedSession, profile, 5, waiter.signal);

    await fourthPublished;
    expect(starts).toEqual([0]);
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      generation: 1,
      state: 'running',
      lastPublishedSegmentIndex: 4
    });

    const rejected = expect(pending).rejects.toThrow('progress waiter left');
    waiter.abort(new Error('progress waiter left'));
    await rejected;
    await coordinator.close();
    repository.close();
  });

  it('rejects new producers when the source worker or provider reaches capacity', async () => {
    const { coordinator, coordination, repository } = await fixture(60_000, undefined, {
      maxConcurrentProducers: 1,
      maxConcurrentProducersPerProvider: 1
    });
    const first = session('session-capacity-first');
    await persistSession(repository, first);
    await coordination.recordSegmentDemand({
      sessionId: first.id,
      viewerHash: 'viewer-a',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(first, profile, 0);

    const sameProvider = {
      ...session('session-capacity-provider'),
      source: { ...first.source!, itemId: 'movie-2' }
    };
    await persistSession(repository, sameProvider);
    await coordination.recordSegmentDemand({
      sessionId: sameProvider.id,
      viewerHash: 'viewer-b',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await expect(coordinator.ensure(sameProvider, profile, 0)).rejects.toThrow(
      'source worker has reached its VOD producer capacity'
    );

    const otherProvider = {
      ...session('session-capacity-worker'),
      source: { ...first.source!, providerId: 'provider-2' }
    };
    await persistSession(repository, otherProvider);
    await coordination.recordSegmentDemand({
      sessionId: otherProvider.id,
      viewerHash: 'viewer-c',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await expect(coordinator.ensure(otherProvider, profile, 0)).rejects.toThrow(
      'source worker has reached its VOD producer capacity'
    );

    await coordinator.close();
    repository.close();
  });

  it('releases reserved capacity when a distributed lease cannot be acquired', async () => {
    const coordination = new LeaseRejectingCoordination();
    const { coordinator, repository, starts } = await fixture(60_000, coordination, {
      maxConcurrentProducers: 1,
      maxConcurrentProducersPerProvider: 1,
      waitForSegmentMs: 1_000
    });
    const rejected = session('session-lease-rejected');
    await persistSession(repository, rejected);
    await expect(coordinator.ensure(rejected, profile, 0)).rejects.toThrow(
      'Timed out waiting for the persistent producer'
    );

    const admitted = session('session-after-rejected-lease');
    await persistSession(repository, admitted);
    await coordination.recordSegmentDemand({
      sessionId: admitted.id,
      viewerHash: 'viewer-after-rejection',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(admitted, profile, 0);
    expect(starts).toEqual([0]);
    await coordinator.close();
    repository.close();
  });

  it('cancels and awaits a producer start that is still acquiring its lease', async () => {
    const coordination = new GatedAcquireCoordination();
    const { coordinator, repository } = await fixture(60_000, coordination);
    const selectedSession = session('session-stop-during-acquire');
    await persistSession(repository, selectedSession);
    const waiter = new AbortController();
    const ensuring = coordinator.ensure(selectedSession, profile, 0, waiter.signal);
    await coordination.entered;

    let stopped = false;
    const stopping = coordinator.stop(selectedSession.id).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(coordinator.ensure(selectedSession, profile, 0)).rejects.toThrow(
      'producer coordination is stopping'
    );

    waiter.abort(new Error('segment waiter left'));
    coordination.releaseAcquire();
    await stopping;
    await expect(ensuring).rejects.toThrow('segment waiter left');
    expect(coordinator.isActive(selectedSession.id)).toBe(false);
    expect(await coordinator.get(selectedSession.id)).toBeUndefined();
    await coordinator.close();
    repository.close();
  });

  it('fences pending waiters during drain without preventing a later fresh request', async () => {
    const { coordinator, coordination, repository, starts } = await fixture();
    const selectedSession = session('session-waiter-during-drain');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-drain',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(selectedSession, profile, 0);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-drain',
      segmentIndex: 2,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    const pending = coordinator.ensure(selectedSession, profile, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await coordinator.drain();
    await expect(pending).rejects.toThrow('producer coordination was stopped');
    expect(starts).toEqual([0]);
    expect(await coordinator.get(selectedSession.id)).toMatchObject({
      generation: 1,
      state: 'switching'
    });

    await coordinator.ensure(selectedSession, profile, 2);
    expect(starts).toEqual([0, 2]);
    await coordinator.close();
    repository.close();
  });

  it('permanently fences pending and future requests when the coordinator closes', async () => {
    const { coordinator, coordination, repository, starts } = await fixture();
    const selectedSession = session('session-waiter-during-close');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-close',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(selectedSession, profile, 0);
    const pending = coordinator.ensure(selectedSession, profile, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await coordinator.close();
    await expect(pending).rejects.toThrow('producer coordination was stopped');
    await expect(coordinator.ensure(selectedSession, profile, 2)).rejects.toThrow(
      'producer coordination is closed'
    );
    expect(starts).toEqual([0]);
    repository.close();
  });

  it('does not start after the durable session stops during demand lookup', async () => {
    const coordination = new GatedDemandCoordination();
    const { coordinator, repository, starts } = await fixture(60_000, coordination);
    const selectedSession = session('session-stopped-during-demand');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-stopped-during-demand',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });

    const ensuring = coordinator.ensure(selectedSession, profile, 0);
    await coordination.entered;
    const current = await repository.getVersionedSession(selectedSession.id);
    if (!current) throw new Error('Producer test session was not persisted');
    expect(
      (
        await repository.compareAndSetSession(
          {
            ...current.value,
            state: 'stopped',
            updatedAt: new Date().toISOString()
          },
          current.revision
        )
      ).applied
    ).toBe(true);
    await coordinator.stop(selectedSession.id);
    coordination.releaseDemand();

    await expect(ensuring).rejects.toThrow('Session is stopped');
    expect(starts).toEqual([]);
    expect(coordinator.isActive(selectedSession.id)).toBe(false);
    expect(await coordinator.get(selectedSession.id)).toBeUndefined();
    await coordinator.close();
    repository.close();
  });

  it('does not start after an explicit producer stop during demand lookup', async () => {
    const coordination = new GatedDemandCoordination();
    const { coordinator, repository, starts } = await fixture(60_000, coordination);
    const selectedSession = session('session-producer-stop-during-demand');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-producer-stop-during-demand',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });

    const ensuring = coordinator.ensure(selectedSession, profile, 0);
    await coordination.entered;
    await coordinator.stop(selectedSession.id);
    coordination.releaseDemand();

    await expect(ensuring).rejects.toThrow('producer coordination was stopped');
    expect(starts).toEqual([]);
    expect(coordinator.isActive(selectedSession.id)).toBe(false);
    expect(await coordinator.get(selectedSession.id)).toBeUndefined();
    await coordinator.close();
    repository.close();
  });

  it.each(['stop', 'drain', 'close'] as const)(
    'does not resurrect a switched producer when %s fences the switch shutdown',
    async (action) => {
      const abortEntered = Promise.withResolvers<void>();
      const continueAbort = Promise.withResolvers<void>();
      const { coordinator, coordination, repository, starts } = await fixture(
        60_000,
        new MemoryCoordinationStore(),
        {},
        undefined,
        (observedStarts) => ({
          discover: async () => ({
            ffmpegVersion: 'fixture',
            encoders: [],
            muxers: [],
            filters: [],
            pixelFormats: []
          }),
          generateSegment: async () => undefined,
          produceVod: async (request, directory, onSegment, signal) => {
            observedStarts.push(request.startSegmentIndex);
            await mkdir(directory, { recursive: true });
            const path = join(directory, `segment-${request.startSegmentIndex}.ts`);
            await writeFile(path, 'switch-fence-segment');
            await onSegment({ index: request.startSegmentIndex, path });
            await new Promise<never>((_resolve, reject) => {
              const stop = () => {
                abortEntered.resolve();
                void continueAbort.promise.then(() =>
                  reject(signal?.reason ?? new Error('producer stopped'))
                );
              };
              if (signal?.aborted) stop();
              else signal?.addEventListener('abort', stop, { once: true });
            });
          }
        })
      );
      const selectedSession = session(`session-${action}-during-switch`);
      await persistSession(repository, selectedSession);
      await coordination.recordSegmentDemand({
        sessionId: selectedSession.id,
        viewerHash: 'viewer-current',
        segmentIndex: 0,
        observedAtMs: Date.now(),
        windowMs: 30_000
      });
      await coordinator.ensure(selectedSession, profile, 0);
      for (const viewerHash of ['viewer-seek-a', 'viewer-seek-b'])
        await coordination.recordSegmentDemand({
          sessionId: selectedSession.id,
          viewerHash,
          segmentIndex: 20,
          observedAtMs: Date.now(),
          windowMs: 30_000
        });

      const switching = coordinator.ensure(selectedSession, profile, 20);
      await abortEntered.promise;
      const fencing =
        action === 'stop'
          ? coordinator.stop(selectedSession.id)
          : action === 'drain'
            ? coordinator.drain()
            : coordinator.close();
      continueAbort.resolve();

      await fencing;
      await expect(switching).rejects.toThrow('producer coordination was stopped');
      expect(starts).toEqual([0]);
      expect(coordinator.isActive(selectedSession.id)).toBe(false);
      if (action !== 'close') await coordinator.close();
      repository.close();
    },
    60_000
  );

  it('removes each published producer scratch segment while the producer remains active', async () => {
    const { coordinator, coordination, repository, publishedPaths } = await fixture();
    const selectedSession = session('session-scratch-cleanup');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-scratch',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(selectedSession, profile, 0);
    await vi.waitFor(() => expect(publishedPaths.length).toBeGreaterThan(0), {
      timeout: 2_000,
      interval: 10
    });
    for (const path of publishedPaths) {
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(`${path}.vrrelay-object.json`)).rejects.toMatchObject({
        code: 'ENOENT'
      });
    }
    expect(coordinator.isActive(selectedSession.id)).toBe(true);
    await coordinator.close();
    repository.close();
  });

  it('scales each producer smoothly between normal speed and its configured maximum', () => {
    const settings = { lowWatermarkMs: 2_500, highWatermarkMs: 3_000, maximumRate: 2 };
    expect(vodProducerCatchupRate({ ...settings, bufferMs: 0 })).toBe(2);
    expect(vodProducerCatchupRate({ ...settings, bufferMs: 2_500 })).toBe(2);
    expect(vodProducerCatchupRate({ ...settings, bufferMs: 2_750 })).toBe(1.5);
    expect(vodProducerCatchupRate({ ...settings, bufferMs: 3_000 })).toBe(1);
    expect(vodProducerCatchupRate({ ...settings, bufferMs: 3_500 })).toBe(1);
    expect(vodProducerCatchupRate({ ...settings, bufferMs: 0, maximumRate: 1 })).toBe(1);
  });

  it('re-evaluates a majority that arrives after the first distant request', async () => {
    const { coordinator, coordination, repository, starts } = await fixture();
    const selectedSession = session('session-late-majority');
    await persistSession(repository, selectedSession);
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
  }, 10_000);

  it('does not restart a failed producer after its durable session is deleted', async () => {
    let markPrepared!: () => void;
    let failPrepare!: () => void;
    const prepared = new Promise<void>((resolve) => {
      markPrepared = resolve;
    });
    const prepareFailure = new Promise<void>((resolve) => {
      failPrepare = resolve;
    });
    const { coordinator, repository } = await fixture(
      60_000,
      new MemoryCoordinationStore(),
      {},
      async () => {
        markPrepared();
        await prepareFailure;
        throw new Error('Session source credential is unavailable');
      }
    );
    const selectedSession = session('session-deleted-during-prepare');
    await persistSession(repository, selectedSession);

    const ensuring = coordinator.ensure(selectedSession, profile, 0);
    const rejected = expect(ensuring).rejects.toThrow('Session was not found');
    await prepared;
    await repository.deleteSessionAndRevokePlaybackGrants(selectedSession.id);
    failPrepare();
    await rejected;

    const producer = await coordinator.get(selectedSession.id);
    expect(producer).toMatchObject({ generation: 1, state: 'failed' });
    expect(producer?.workerHistory).toHaveLength(1);
    await coordinator.close();
    repository.close();
  }, 30_000);

  it('fences a running producer when its durable session disappears', async () => {
    const { coordinator, coordination, repository } = await fixture(
      60_000,
      new MemoryCoordinationStore(),
      { demandRefreshIntervalMs: 10 }
    );
    const selectedSession = session('session-deleted-while-running');
    await persistSession(repository, selectedSession);
    await coordination.recordSegmentDemand({
      sessionId: selectedSession.id,
      viewerHash: 'viewer-deleted-session',
      segmentIndex: 0,
      observedAtMs: Date.now(),
      windowMs: 30_000
    });
    await coordinator.ensure(selectedSession, profile, 0);

    await repository.deleteSessionAndRevokePlaybackGrants(selectedSession.id);
    await vi.waitFor(
      async () => {
        expect(coordinator.isActive(selectedSession.id)).toBe(false);
        expect(await coordinator.get(selectedSession.id)).toMatchObject({
          generation: 1,
          state: 'cancelled'
        });
      },
      { timeout: 2_000, interval: 10 }
    );
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
    await persistSession(repository, selectedSession);
    await coordinator.ensure(selectedSession, profile, 0);
    coordination.loseLease = true;
    await vi.waitFor(
      async () => {
        const producer = await coordinator.get(selectedSession.id);
        expect(producer).toMatchObject({
          generation: 1,
          state: 'failed'
        });
        expect(producer?.ownerNodeId).toBeUndefined();
      },
      { timeout: 2_000, interval: 10 }
    );
    await coordinator.close();
    repository.close();
  });

  it('does not reject producer shutdown when best-effort lease release is unavailable', async () => {
    const { coordinator, repository } = await fixture(60_000, new ReleaseFailingCoordination());
    const selectedSession = session('session-release-outage');
    await persistSession(repository, selectedSession);
    await coordinator.ensure(selectedSession, profile, 0);
    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(await coordinator.get('session-release-outage')).toMatchObject({ state: 'idle' });
    repository.close();
  });

  it('uses fenced handoff state on drain and ignores stale-generation completion', async () => {
    const { coordinator, repository } = await fixture();
    const selectedSession = session('session-fenced-drain');
    await persistSession(repository, selectedSession);
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
