// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProfileRevision, RelaySession, VodProducer } from '@vrrelay/domain';
import type {
  ClusterRepository,
  CoordinationStore,
  MetricsSink,
  ObjectStore,
  Transcoder,
  VodProducerRequest
} from './index.js';
import { CapacityError, ConflictError, NotFoundError } from './errors.js';
import { SessionCache } from './session-cache.js';
import { VodProducerSourcePacer, type VodProducerSourcePacing } from './vod-source-pacing.js';

const LEASE_MS = 120_000;
const LEASE_RENEW_MS = 30_000;
const DEMAND_WINDOW_MS = 30_000;
const WAIT_FOR_SEGMENT_MS = 125_000;
const FAILURE_RETRY_MIN_MS = 1_000;
const FAILURE_RETRY_MAX_MS = 30_000;
const ACTIVE_STATES: readonly VodProducer['state'][] = ['starting', 'running', 'switching'];

interface ActiveProducer {
  generation: number;
  controller: AbortController;
  completion: Promise<void>;
  owner: string;
  providerId: string;
  startSegmentIndex: number;
  playbackAnchorSegmentIndex: number;
  playbackAnchorAtMs: number;
  lastAppliedPlaybackAnchorAtMs: number;
  demandedSegmentIndex: number;
  lastPublishedSegmentIndex?: number;
  lastDemandAtMs: number;
  placementLocked: boolean;
  pacing: VodProducerSourcePacer;
  publishedAny: boolean;
  failure?: Error;
  stopState?: 'idle' | 'switching' | 'cancelled';
}

interface StartingProducer {
  controller: AbortController;
  completion: Promise<ActiveProducer | undefined>;
  placementLocked: boolean;
  stopState?: 'idle' | 'switching' | 'cancelled';
}

interface ProducerRetry {
  failures: number;
  notBeforeMs: number;
}

export function vodProducerForwardJoinSegments(
  bufferLowWatermarkMs: number,
  segmentDurationSeconds: number
): number {
  return Math.max(
    2,
    Math.ceil(Math.min(bufferLowWatermarkMs, 10_000) / (segmentDurationSeconds * 1_000))
  );
}

export function isVodProducerDemandCovered(input: {
  startSegmentIndex: number;
  lastPublishedSegmentIndex: number | undefined;
  demandedSegmentIndex: number;
  bufferLowWatermarkMs: number;
  segmentDurationSeconds: number;
}): boolean {
  const forwardJoinSegments = vodProducerForwardJoinSegments(
    input.bufferLowWatermarkMs,
    input.segmentDurationSeconds
  );
  const highWater =
    (input.lastPublishedSegmentIndex ?? input.startSegmentIndex) + forwardJoinSegments;
  return (
    input.demandedSegmentIndex >= input.startSegmentIndex && input.demandedSegmentIndex <= highWater
  );
}

export function estimateVodProducerBufferMs(input: {
  playbackAnchorSegmentIndex: number;
  lastPublishedSegmentIndex: number | undefined;
  segmentDurationSeconds: number;
  playbackAnchorAtMs: number;
  observedAtMs: number;
}): number {
  if (
    input.lastPublishedSegmentIndex === undefined ||
    !Number.isFinite(input.playbackAnchorAtMs) ||
    !Number.isFinite(input.observedAtMs)
  )
    return 0;
  const publishedHeadMs =
    Math.max(0, input.lastPublishedSegmentIndex + 1) * input.segmentDurationSeconds * 1_000;
  const estimatedPlaybackPositionMs =
    input.playbackAnchorSegmentIndex * input.segmentDurationSeconds * 1_000 +
    Math.max(0, input.observedAtMs - input.playbackAnchorAtMs);
  return Math.max(0, publishedHeadMs - estimatedPlaybackPositionMs);
}

export interface VodProducerCoordinatorOptions {
  cacheDir: string;
  nodeId: string;
  idleTimeoutMs: number;
  bufferLowWatermarkMs: number;
  bufferHighWatermarkMs: number;
  maxConcurrentProducers?: number;
  maxConcurrentProducersPerProvider?: number;
  leaseMs?: number;
  leaseRenewMs?: number;
  waitForSegmentMs?: number;
  failureRetryMinMs?: number;
  failureRetryMaxMs?: number;
}

export interface VodProducerCallbacks {
  getSession(sessionId: string): Promise<RelaySession | undefined>;
  acquire?(signal: AbortSignal): Promise<void>;
  prepare(
    session: RelaySession,
    profile: ProfileRevision,
    startSegmentIndex: number,
    signal: AbortSignal,
    pacing: VodProducerSourcePacing,
    generation: number
  ): Promise<VodProducerRequest>;
  released?(sessionId: string): void;
  published?(
    sessionId: string,
    segmentIndex: number,
    mediaDurationSeconds: number,
    observedAtMs: number
  ): void;
}

export class VodProducerCoordinator {
  readonly #active = new Map<string, ActiveProducer>();
  readonly #starting = new Map<string, StartingProducer>();
  readonly #startReservations = new Map<string, number>();
  readonly #retries = new Map<string, ProducerRetry>();

  constructor(
    private readonly repository: ClusterRepository,
    private readonly coordination: CoordinationStore,
    private readonly objectStore: ObjectStore | undefined,
    private readonly transcoder: Transcoder,
    private readonly cache: SessionCache,
    private readonly callbacks: VodProducerCallbacks,
    private readonly options: VodProducerCoordinatorOptions,
    private readonly metrics?: MetricsSink
  ) {}

  async ensure(
    session: RelaySession,
    profile: ProfileRevision,
    segmentIndex: number,
    signal?: AbortSignal
  ): Promise<void> {
    const contentKey = this.cache.contentKey(session, profile, segmentIndex);
    const deadline = Date.now() + (this.options.waitForSegmentMs ?? WAIT_FOR_SEGMENT_MS);
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error('Segment request was aborted');
      if (await this.objectStore?.stat(contentKey)) return;
      const currentSession = await this.callbacks.getSession(session.id);
      if (!currentSession) {
        this.#retries.delete(session.id);
        await this.#stopProducer(session.id, 'cancelled');
        throw new NotFoundError('Session was not found');
      }
      if (currentSession.state === 'stopped') {
        this.#retries.delete(session.id);
        await this.#stopProducer(session.id, 'cancelled');
        throw new ConflictError('Session is stopped');
      }
      let active = this.#active.get(session.id);
      if (!active) {
        const retryDelayMs = this.#retryDelayMs(session.id);
        if (retryDelayMs > 0) {
          await this.#delay(Math.min(retryDelayMs, deadline - Date.now()), signal);
          continue;
        }
      }
      const dominant = await this.#dominantDemand(session.id, profile, segmentIndex, active);
      if (
        active &&
        this.#shouldSwitch(
          active,
          dominant.index,
          dominant.currentViewers,
          dominant.viewers,
          profile.delivery.segmentDuration
        )
      ) {
        await this.#stopProducer(session.id, 'switching');
        active = undefined;
      }
      // An HTTP client may leave while the producer warms.  Its signal must
      // only detach that waiter, never cancel the shared producer.
      active ??= await this.#start(currentSession, profile, dominant.index);
      if (!active) {
        const retryDelayMs = this.#retryDelayMs(session.id);
        await this.#delay(
          Math.min(retryDelayMs > 0 ? retryDelayMs : 250, deadline - Date.now()),
          signal
        );
        continue;
      }
      const demandedAt = Math.max(active.lastDemandAtMs, dominant.observedAtMs ?? 0);
      active.lastDemandAtMs = demandedAt;
      this.#applyPlaybackAnchor(active, dominant);
      active.demandedSegmentIndex = dominant.index;
      this.#reconcilePacing(profile, active);
      await this.#transition(session.id, active.generation, (current) => ({
        ...current,
        demandedSegmentIndex: dominant.index,
        playbackAnchorSegmentIndex: active.playbackAnchorSegmentIndex,
        playbackAnchorAt: new Date(active.playbackAnchorAtMs).toISOString(),
        bufferState: active.pacing.state,
        lastDemandAt: new Date(demandedAt).toISOString(),
        idleDeadlineAt: new Date(demandedAt + this.options.idleTimeoutMs).toISOString(),
        updatedAt: new Date().toISOString()
      }));
      if (await this.#waitForObject(contentKey, session.id, active, deadline, signal)) return;
    }
    throw new CapacityError('Timed out waiting for the persistent producer');
  }

  async stop(sessionId: string): Promise<void> {
    this.#retries.delete(sessionId);
    await this.#stopProducer(sessionId, 'cancelled');
  }

  async list(limit = 100): Promise<VodProducer[]> {
    return this.repository.listVodProducers(limit);
  }

  async get(sessionId: string): Promise<VodProducer | undefined> {
    return this.repository.getVodProducer(sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.#active.has(sessionId) || this.#starting.has(sessionId);
  }

  async recoverExpired(now = Date.now()): Promise<number> {
    let recovered = 0;
    for (const listed of await this.repository.listVodProducers(1_000)) {
      if (!ACTIVE_STATES.includes(listed.state)) continue;
      if (listed.leaseExpiresAt && Date.parse(listed.leaseExpiresAt) > now) continue;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await this.repository.getVersionedVodProducer(listed.sessionId);
        if (!current || !ACTIVE_STATES.includes(current.value.state)) break;
        if (current.value.leaseExpiresAt && Date.parse(current.value.leaseExpiresAt) > now) break;
        const updated: VodProducer = {
          ...this.#finishAttempt(current.value, 'failed', 'Recovered expired producer lease'),
          state: 'idle',
          ownerNodeId: undefined,
          leaseExpiresAt: undefined,
          idleDeadlineAt: undefined,
          errorMessage: undefined,
          updatedAt: new Date().toISOString()
        };
        const result = await this.repository.compareAndSetVodProducer(
          updated,
          current.revision,
          ACTIVE_STATES
        );
        if (result.applied) {
          recovered += 1;
          break;
        }
        if (result.reason === 'not-found' || result.reason === 'invalid-state') break;
      }
    }
    return recovered;
  }

  async close(): Promise<void> {
    const sessionIds = new Set([...this.#active.keys(), ...this.#starting.keys()]);
    await Promise.all([...sessionIds].map((sessionId) => this.#stopProducer(sessionId, 'idle')));
    this.#retries.clear();
  }

  async drain(): Promise<void> {
    const sessionIds = new Set([...this.#active.keys(), ...this.#starting.keys()]);
    await Promise.all(
      [...sessionIds].map((sessionId) =>
        this.#stopProducer(
          sessionId,
          (this.#active.get(sessionId)?.placementLocked ??
            this.#starting.get(sessionId)?.placementLocked)
            ? 'cancelled'
            : 'switching'
        )
      )
    );
  }

  async #start(
    session: RelaySession,
    profile: ProfileRevision,
    startSegmentIndex: number,
    _signal?: AbortSignal
  ): Promise<ActiveProducer | undefined> {
    const existing = this.#starting.get(session.id);
    if (existing) return existing.completion;
    if (this.#retryDelayMs(session.id) > 0) return undefined;
    const starting: StartingProducer = {
      controller: new AbortController(),
      completion: Promise.resolve(undefined),
      placementLocked: session.placementLocked
    };
    starting.completion = this.#startExclusive(
      session,
      profile,
      startSegmentIndex,
      starting
    ).finally(() => {
      if (this.#starting.get(session.id) === starting) this.#starting.delete(session.id);
    });
    this.#starting.set(session.id, starting);
    return starting.completion;
  }

  async #startExclusive(
    session: RelaySession,
    profile: ProfileRevision,
    startSegmentIndex: number,
    starting: StartingProducer
  ): Promise<ActiveProducer | undefined> {
    const providerId = session.source?.providerId;
    if (!providerId) throw new CapacityError('The VOD session has no provider source');
    if (
      session.placementLocked &&
      session.assignedNodeId &&
      session.assignedNodeId !== this.options.nodeId
    )
      throw new CapacityError('The session is locked to another source worker');
    if (!this.#reserveProducer(providerId)) {
      this.metrics?.increment('vod_producer_admission_rejected_total', { reason: 'capacity' });
      throw new CapacityError('The source worker has reached its VOD producer capacity');
    }
    let reserved = true;
    let leaseOwned = false;
    let handedOff = false;
    let persistedGeneration: number | undefined;
    const owner = `${this.options.nodeId}:${randomUUID()}`;
    const leaseKey = `vod-producer:${session.id}`;
    const leaseMs = this.options.leaseMs ?? LEASE_MS;
    const controller = starting.controller;
    try {
      leaseOwned = await this.coordination.acquire(leaseKey, owner, leaseMs);
      if (!leaseOwned || controller.signal.aborted) return undefined;
      const currentSession = await this.callbacks.getSession(session.id);
      if (controller.signal.aborted) return undefined;
      if (!currentSession) throw new NotFoundError('Session was not found');
      if (currentSession.state === 'stopped') throw new ConflictError('Session is stopped');
      const currentProviderId = currentSession.source?.providerId;
      if (!currentProviderId)
        throw new CapacityError('The durable VOD session has no provider source');
      if (currentProviderId !== providerId)
        throw new ConflictError('The VOD session source changed during producer start');
      if (
        currentSession.placementLocked &&
        currentSession.assignedNodeId &&
        currentSession.assignedNodeId !== this.options.nodeId
      )
        throw new CapacityError('The session is locked to another source worker');
      starting.placementLocked = currentSession.placementLocked;
      const current = await this.repository.getVersionedVodProducer(session.id);
      if (controller.signal.aborted) return undefined;
      const generation = (current?.value.generation ?? 0) + 1;
      const playbackAnchorAtMs = Date.now();
      const now = new Date(playbackAnchorAtMs).toISOString();
      const producer: VodProducer = {
        id: session.id,
        sessionId: session.id,
        ownerNodeId: this.options.nodeId,
        generation,
        state: 'starting',
        demandedSegmentIndex: startSegmentIndex,
        startSegmentIndex,
        playbackAnchorSegmentIndex: startSegmentIndex,
        playbackAnchorAt: now,
        bufferState: 'catching_up',
        leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
        lastDemandAt: now,
        idleDeadlineAt: new Date(Date.now() + this.options.idleTimeoutMs).toISOString(),
        workerHistory: [
          ...(current?.value.workerHistory ?? []),
          {
            generation,
            nodeId: this.options.nodeId,
            state: 'running',
            startSegmentIndex,
            startedAt: now
          }
        ],
        createdAt: current?.value.createdAt ?? now,
        updatedAt: now
      };
      const stored = current
        ? await this.repository.compareAndSetVodProducer(producer, current.revision, [
            'idle',
            'switching',
            'complete',
            'failed',
            'cancelled'
          ])
        : await this.repository.createVodProducer(producer);
      if ('applied' in stored && !stored.applied)
        throw new ConflictError('Producer ownership changed during start');
      persistedGeneration = generation;
      if (controller.signal.aborted) return undefined;
      const active: ActiveProducer = {
        generation,
        controller,
        completion: Promise.resolve(),
        owner,
        providerId,
        startSegmentIndex,
        playbackAnchorSegmentIndex: startSegmentIndex,
        playbackAnchorAtMs,
        lastAppliedPlaybackAnchorAtMs: playbackAnchorAtMs,
        demandedSegmentIndex: startSegmentIndex,
        lastDemandAtMs: Date.now(),
        placementLocked: currentSession.placementLocked,
        pacing: new VodProducerSourcePacer(),
        publishedAny: false,
        ...(starting.stopState ? { stopState: starting.stopState } : {})
      };
      this.#active.set(session.id, active);
      handedOff = true;
      this.#releaseReservation(providerId);
      reserved = false;
      active.completion = this.#run(currentSession, profile, producer, active, leaseKey);
      return active;
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      throw error;
    } finally {
      if (!handedOff && persistedGeneration !== undefined) {
        const state = starting.stopState ?? 'cancelled';
        await this.#transition(session.id, persistedGeneration, (current) => ({
          ...this.#finishAttempt(current, 'cancelled'),
          state,
          ownerNodeId: undefined,
          leaseExpiresAt: undefined,
          idleDeadlineAt: undefined,
          errorMessage: undefined,
          updatedAt: new Date().toISOString()
        })).catch(() => undefined);
      }
      if (leaseOwned && !handedOff)
        await this.coordination.release(leaseKey, owner).catch(() => undefined);
      if (reserved) this.#releaseReservation(providerId);
    }
  }

  #reserveProducer(providerId: string): boolean {
    const activeForProvider = [...this.#active.values()].filter(
      (active) => active.providerId === providerId
    ).length;
    const reservedForProvider = this.#startReservations.get(providerId) ?? 0;
    const activeCount = this.#active.size;
    const reservedCount = [...this.#startReservations.values()].reduce(
      (total, count) => total + count,
      0
    );
    const maxConcurrent = this.options.maxConcurrentProducers ?? Number.MAX_SAFE_INTEGER;
    const maxPerProvider =
      this.options.maxConcurrentProducersPerProvider ?? Number.MAX_SAFE_INTEGER;
    if (
      activeCount + reservedCount >= maxConcurrent ||
      activeForProvider + reservedForProvider >= maxPerProvider
    )
      return false;
    this.#startReservations.set(providerId, reservedForProvider + 1);
    return true;
  }

  #releaseReservation(providerId: string): void {
    const current = this.#startReservations.get(providerId) ?? 0;
    if (current <= 1) this.#startReservations.delete(providerId);
    else this.#startReservations.set(providerId, current - 1);
  }

  async #run(
    session: RelaySession,
    profile: ProfileRevision,
    initial: VodProducer,
    active: ActiveProducer,
    leaseKey: string
  ): Promise<void> {
    const directory = join(
      this.options.cacheDir,
      'producer',
      session.id,
      String(active.generation)
    );
    let renewal: NodeJS.Timeout | undefined;
    let idleCheck: NodeJS.Timeout | undefined;
    let acquired = false;
    const leaseMs = this.options.leaseMs ?? LEASE_MS;
    try {
      await this.callbacks.acquire?.(active.controller.signal);
      acquired = true;
      const request = await this.callbacks.prepare(
        session,
        profile,
        active.startSegmentIndex,
        active.controller.signal,
        active.pacing,
        active.generation
      );
      const ffmpegDurationSeconds = Number(request.duration.toFixed(3));
      const remainingSegmentCount = Math.ceil(
        ffmpegDurationSeconds / profile.delivery.segmentDuration
      );
      if (
        !Number.isFinite(request.duration) ||
        !Number.isFinite(ffmpegDurationSeconds) ||
        ffmpegDurationSeconds <= 0 ||
        remainingSegmentCount < 1
      )
        throw new CapacityError('The persistent VOD producer received an invalid duration');
      const terminalSegmentIndex = request.startSegmentIndex + remainingSegmentCount - 1;
      let terminalSegmentPublished = false;
      await this.#transition(initial.sessionId, active.generation, (current) => ({
        ...current,
        state: 'running',
        updatedAt: new Date().toISOString()
      }));
      renewal = setInterval(() => {
        void this.coordination
          .renew(leaseKey, active.owner, leaseMs)
          .then(async (renewed) => {
            if (!renewed) return active.controller.abort(new Error('Producer lease was lost'));
            await this.#transition(session.id, active.generation, (current) => ({
              ...current,
              leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
              updatedAt: new Date().toISOString()
            }));
          })
          .catch((error) => active.controller.abort(error));
      }, this.options.leaseRenewMs ?? LEASE_RENEW_MS);
      renewal.unref();
      let refreshing = false;
      idleCheck = setInterval(() => {
        if (refreshing) return;
        refreshing = true;
        void this.#refreshDemand(session, profile, active)
          .catch((error) => active.controller.abort(error))
          .finally(() => {
            refreshing = false;
          });
      }, 2_000);
      idleCheck.unref();
      this.metrics?.increment('vod_producers_started_total');
      if (!this.transcoder.produceVod)
        throw new CapacityError('The source worker does not support persistent VOD producers');
      await this.transcoder.produceVod(
        request,
        directory,
        async (segment) => {
          try {
            if (active.controller.signal.aborted) throw active.controller.signal.reason;
            const contentKey = this.cache.contentKey(session, profile, segment.index);
            await this.cache.publishObject(
              session,
              profile,
              segment.index,
              segment.path,
              contentKey
            );
            active.publishedAny = true;
            terminalSegmentPublished ||= segment.index >= terminalSegmentIndex;
            this.#retries.delete(session.id);
            active.lastPublishedSegmentIndex = segment.index;
            this.#reconcilePacing(profile, active);
            await this.#transition(session.id, active.generation, (current) => ({
              ...current,
              state: 'running',
              lastPublishedSegmentIndex: segment.index,
              bufferState: active.pacing.state,
              leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
              updatedAt: new Date().toISOString()
            }));
            await this.coordination.publish(
              'segments',
              JSON.stringify({ contentKey, sessionId: session.id, segmentIndex: segment.index })
            );
            this.callbacks.published?.(
              session.id,
              segment.index,
              Math.min(
                profile.delivery.segmentDuration,
                Math.max(
                  0,
                  (session.durationSeconds ?? 0) - segment.index * profile.delivery.segmentDuration
                )
              ),
              Date.now()
            );
          } finally {
            await this.cache.removeScratchObject(segment.path);
          }
        },
        active.controller.signal
      );
      if (active.controller.signal.aborted)
        throw active.controller.signal.reason ?? new Error('Producer was aborted');
      if (!terminalSegmentPublished)
        throw new Error(
          `Persistent VOD producer completed before publishing terminal segment ${terminalSegmentIndex}`
        );
      this.#retries.delete(session.id);
      await this.#transition(session.id, active.generation, (current) => ({
        ...this.#finishAttempt(current, 'complete'),
        state: 'complete',
        ownerNodeId: undefined,
        leaseExpiresAt: undefined,
        idleDeadlineAt: undefined,
        updatedAt: new Date().toISOString()
      }));
      this.metrics?.increment('vod_producers_completed_total');
    } catch (error) {
      const stopped = active.controller.signal.aborted ? active.stopState : undefined;
      const state = stopped ?? 'failed';
      if (state === 'failed') {
        active.failure =
          error instanceof Error ? error : new Error('Persistent VOD producer failed');
        this.#recordFailure(session.id, active.publishedAny);
      } else {
        this.#retries.delete(session.id);
      }
      await this.#transition(session.id, active.generation, (current) => ({
        ...this.#finishAttempt(
          current,
          state === 'failed' ? 'failed' : 'cancelled',
          state === 'failed' && error instanceof Error ? error.message : undefined
        ),
        state,
        ownerNodeId: undefined,
        leaseExpiresAt: undefined,
        idleDeadlineAt: undefined,
        ...(state === 'failed'
          ? {
              errorMessage:
                error instanceof Error ? error.message.slice(0, 2_000) : 'Producer failed'
            }
          : { errorMessage: undefined }),
        updatedAt: new Date().toISOString()
      })).catch(() => undefined);
      if (state === 'failed') this.metrics?.increment('vod_producer_failures_total');
    } finally {
      if (renewal) clearInterval(renewal);
      if (idleCheck) clearInterval(idleCheck);
      if (this.#active.get(session.id) === active) this.#active.delete(session.id);
      // Lease expiry is the recovery boundary when coordination is unavailable.
      // A best-effort release must never turn a handled producer shutdown into
      // an unhandled rejection that terminates the source-worker process.
      await this.coordination.release(leaseKey, active.owner).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      if (acquired) this.callbacks.released?.(session.id);
    }
  }

  async #refreshDemand(
    session: RelaySession,
    profile: ProfileRevision,
    active: ActiveProducer
  ): Promise<void> {
    const currentSession = await this.callbacks.getSession(session.id);
    if (!currentSession || currentSession.state === 'stopped') {
      this.#retries.delete(session.id);
      active.stopState = 'cancelled';
      active.controller.abort(
        new Error(currentSession ? 'Session was stopped' : 'Session was deleted')
      );
      return;
    }
    const now = Date.now();
    const demands = await this.coordination.listSegmentDemands({
      sessionId: session.id,
      observedAtMs: now,
      windowMs: DEMAND_WINDOW_MS
    });
    const latest = Math.max(active.lastDemandAtMs, ...demands.map((demand) => demand.observedAtMs));
    active.lastDemandAtMs = latest;
    if (now - latest >= this.options.idleTimeoutMs) {
      active.stopState = 'idle';
      active.controller.abort(new Error('Producer became idle'));
      return;
    }
    const dominant = await this.#dominantDemand(
      session.id,
      profile,
      active.demandedSegmentIndex,
      active
    );
    if (
      this.#shouldSwitch(
        active,
        dominant.index,
        dominant.currentViewers,
        dominant.viewers,
        profile.delivery.segmentDuration
      )
    ) {
      active.stopState = 'switching';
      active.controller.abort(new Error('Producer playback window changed'));
      return;
    }
    this.#applyPlaybackAnchor(active, dominant);
    active.demandedSegmentIndex = dominant.index;
    this.#reconcilePacing(profile, active);
    await this.#transition(session.id, active.generation, (current) => ({
      ...current,
      demandedSegmentIndex: dominant.index,
      playbackAnchorSegmentIndex: active.playbackAnchorSegmentIndex,
      playbackAnchorAt: new Date(active.playbackAnchorAtMs).toISOString(),
      bufferState: active.pacing.state,
      lastDemandAt: new Date(latest).toISOString(),
      idleDeadlineAt: new Date(latest + this.options.idleTimeoutMs).toISOString(),
      updatedAt: new Date().toISOString()
    }));
  }

  async #stopProducer(sessionId: string, state: 'idle' | 'switching' | 'cancelled'): Promise<void> {
    const activeBeforeStartSettled = this.#active.get(sessionId);
    if (activeBeforeStartSettled) {
      activeBeforeStartSettled.stopState = state;
      activeBeforeStartSettled.controller.abort(new Error(`Producer stopped: ${state}`));
    }
    const starting = this.#starting.get(sessionId);
    if (starting) {
      starting.stopState = state;
      starting.controller.abort(new Error(`Producer stopped while starting: ${state}`));
      await starting.completion.catch(() => undefined);
    }
    const active = this.#active.get(sessionId);
    if (active && active !== activeBeforeStartSettled) {
      active.stopState = state;
      active.controller.abort(new Error(`Producer stopped: ${state}`));
    }
    await Promise.all(
      [activeBeforeStartSettled, active]
        .filter((candidate): candidate is ActiveProducer => Boolean(candidate))
        .map((candidate) => candidate.completion)
    );
  }

  async #waitForObject(
    contentKey: string,
    sessionId: string,
    active: ActiveProducer,
    deadline: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (!this.objectStore)
      throw new CapacityError('Persistent VOD producers require an object store');
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error('Segment request was aborted');
      if (await this.objectStore.stat(contentKey)) return true;
      if (this.#active.get(sessionId) !== active) {
        if (active.failure) {
          const currentSession = await this.callbacks.getSession(sessionId);
          if (!currentSession) {
            this.#retries.delete(sessionId);
            throw new NotFoundError('Session was not found');
          }
          if (currentSession.state === 'stopped') {
            this.#retries.delete(sessionId);
            throw new ConflictError('Session is stopped');
          }
          throw new CapacityError(
            'Persistent VOD producer failed before publishing the requested segment'
          );
        }
        return false;
      }
      await this.#delay(Math.min(100, deadline - Date.now()), signal);
    }
    return false;
  }

  #retryDelayMs(sessionId: string): number {
    return Math.max(0, (this.#retries.get(sessionId)?.notBeforeMs ?? 0) - Date.now());
  }

  #recordFailure(sessionId: string, publishedAny: boolean): void {
    const previous = this.#retries.get(sessionId);
    const failures = publishedAny ? 1 : (previous?.failures ?? 0) + 1;
    const minimum = Math.max(1, this.options.failureRetryMinMs ?? FAILURE_RETRY_MIN_MS);
    const maximum = Math.max(minimum, this.options.failureRetryMaxMs ?? FAILURE_RETRY_MAX_MS);
    this.#retries.set(sessionId, {
      failures,
      notBeforeMs: Date.now() + Math.min(maximum, minimum * 2 ** Math.min(failures - 1, 10))
    });
  }

  async #delay(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error('Segment request was aborted');
    if (delayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const complete = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason ?? new Error('Segment request was aborted'));
      };
      const timer = setTimeout(complete, delayMs);
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }
    });
  }

  async #dominantDemand(
    sessionId: string,
    profile: ProfileRevision,
    requestedIndex: number,
    active?: ActiveProducer
  ): Promise<{
    index: number;
    viewers: number;
    currentViewers: number;
    observedAtMs: number;
    playbackAnchorSegmentIndex?: number;
    playbackAnchorObservedAtMs?: number;
  }> {
    const now = Date.now();
    const demands = await this.coordination.listSegmentDemands({
      sessionId,
      observedAtMs: now,
      windowMs: DEMAND_WINDOW_MS
    });
    if (!demands.length)
      return { index: requestedIndex, viewers: 1, currentViewers: 0, observedAtMs: now };
    const radius = Math.min(5, Math.max(2, Math.ceil(10 / profile.delivery.segmentDuration)));
    // The encoded head is deliberately ahead while buffering.  Use the
    // accepted demand window as the audience position so a healthy buffer is
    // not mistaken for an abandoned audience.
    const currentIndex = active?.demandedSegmentIndex ?? active?.startSegmentIndex;
    const scored = demands.map((candidate) => ({
      index: candidate.segmentIndex,
      viewers: demands.filter(
        (demand) => Math.abs(demand.segmentIndex - candidate.segmentIndex) <= radius
      ).length
    }));
    scored.sort(
      (left, right) =>
        right.viewers - left.viewers ||
        (currentIndex === undefined
          ? Math.abs(left.index - requestedIndex) - Math.abs(right.index - requestedIndex)
          : Math.abs(left.index - currentIndex) - Math.abs(right.index - currentIndex))
    );
    const winner = scored[0]!;
    const currentViewers =
      currentIndex === undefined
        ? 0
        : demands.filter((demand) => Math.abs(demand.segmentIndex - currentIndex) <= radius).length;
    const playbackAnchor = demands
      .filter(
        (demand) =>
          Math.abs(demand.segmentIndex - winner.index) <= radius &&
          demand.playbackAnchorSegmentIndex !== undefined &&
          demand.playbackAnchorObservedAtMs !== undefined &&
          Math.abs(demand.playbackAnchorSegmentIndex - winner.index) <= radius
      )
      .sort(
        (left, right) =>
          (right.playbackAnchorObservedAtMs ?? 0) - (left.playbackAnchorObservedAtMs ?? 0)
      )[0];
    return {
      ...winner,
      currentViewers,
      observedAtMs: Math.max(...demands.map((demand) => demand.observedAtMs)),
      ...(playbackAnchor?.playbackAnchorSegmentIndex === undefined ||
      playbackAnchor.playbackAnchorObservedAtMs === undefined
        ? {}
        : {
            playbackAnchorSegmentIndex: playbackAnchor.playbackAnchorSegmentIndex,
            playbackAnchorObservedAtMs: playbackAnchor.playbackAnchorObservedAtMs
          })
    };
  }

  #applyPlaybackAnchor(
    active: ActiveProducer,
    demand: {
      playbackAnchorSegmentIndex?: number;
      playbackAnchorObservedAtMs?: number;
    }
  ): void {
    if (
      demand.playbackAnchorSegmentIndex === undefined ||
      demand.playbackAnchorObservedAtMs === undefined ||
      demand.playbackAnchorObservedAtMs <= active.lastAppliedPlaybackAnchorAtMs
    )
      return;
    active.playbackAnchorSegmentIndex = demand.playbackAnchorSegmentIndex;
    active.playbackAnchorAtMs = demand.playbackAnchorObservedAtMs;
    active.lastAppliedPlaybackAnchorAtMs = demand.playbackAnchorObservedAtMs;
  }

  #shouldSwitch(
    active: ActiveProducer,
    demandedIndex: number,
    currentViewers: number,
    demandedViewers: number,
    segmentDurationSeconds: number
  ): boolean {
    // A player can request ahead of the current file while the producer fills
    // its low watermark.  Those requests join the same generation.
    const covered = isVodProducerDemandCovered({
      startSegmentIndex: active.startSegmentIndex,
      lastPublishedSegmentIndex: active.lastPublishedSegmentIndex,
      demandedSegmentIndex: demandedIndex,
      bufferLowWatermarkMs: this.options.bufferLowWatermarkMs,
      segmentDurationSeconds
    });
    return !covered && (currentViewers === 0 || demandedViewers > currentViewers);
  }

  #reconcilePacing(profile: ProfileRevision, active: ActiveProducer): void {
    const bufferMs = estimateVodProducerBufferMs({
      playbackAnchorSegmentIndex: active.playbackAnchorSegmentIndex,
      lastPublishedSegmentIndex: active.lastPublishedSegmentIndex,
      segmentDurationSeconds: profile.delivery.segmentDuration,
      playbackAnchorAtMs: active.playbackAnchorAtMs,
      observedAtMs: Date.now()
    });
    if (active.pacing.state === 'catching_up' && bufferMs >= this.options.bufferHighWatermarkMs)
      active.pacing.pause();
    else if (active.pacing.state === 'buffered' && bufferMs <= this.options.bufferLowWatermarkMs)
      active.pacing.resume();
  }

  async #transition(
    sessionId: string,
    generation: number,
    update: (current: VodProducer) => VodProducer
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.repository.getVersionedVodProducer(sessionId);
      if (!current || current.value.generation !== generation) return;
      const result = await this.repository.compareAndSetVodProducer(
        update(current.value),
        current.revision,
        ACTIVE_STATES
      );
      if (result.applied || result.reason === 'not-found' || result.reason === 'invalid-state')
        return;
    }
    throw new ConflictError('Producer state conflicted with repeated concurrent updates');
  }

  #finishAttempt(
    producer: VodProducer,
    state: 'complete' | 'failed' | 'cancelled',
    errorMessage?: string
  ): VodProducer {
    const workerHistory = [...producer.workerHistory];
    const latest = workerHistory.at(-1);
    if (latest?.generation === producer.generation && latest.state === 'running')
      workerHistory[workerHistory.length - 1] = {
        ...latest,
        state,
        completedAt: new Date().toISOString(),
        ...(errorMessage ? { errorMessage } : {})
      };
    return { ...producer, workerHistory: workerHistory.slice(-100) };
  }
}
