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
import { CapacityError, ConflictError } from './errors.js';
import { SessionCache } from './session-cache.js';

const LEASE_MS = 120_000;
const LEASE_RENEW_MS = 30_000;
const DEMAND_WINDOW_MS = 30_000;
const WAIT_FOR_SEGMENT_MS = 125_000;
const ALL_STATES: readonly VodProducer['state'][] = [
  'idle',
  'starting',
  'running',
  'switching',
  'complete',
  'failed',
  'cancelled'
];

interface ActiveProducer {
  generation: number;
  controller: AbortController;
  completion: Promise<void>;
  owner: string;
  startSegmentIndex: number;
  lastPublishedSegmentIndex?: number;
  lastDemandAtMs: number;
  placementLocked: boolean;
  stopState?: 'idle' | 'switching' | 'cancelled';
}

export interface VodProducerCoordinatorOptions {
  cacheDir: string;
  nodeId: string;
  idleTimeoutMs: number;
  leaseMs?: number;
  leaseRenewMs?: number;
  waitForSegmentMs?: number;
}

export interface VodProducerCallbacks {
  acquire?(signal: AbortSignal): Promise<void>;
  prepare(
    session: RelaySession,
    profile: ProfileRevision,
    startSegmentIndex: number,
    signal: AbortSignal
  ): Promise<VodProducerRequest>;
  released?(sessionId: string): void;
}

export class VodProducerCoordinator {
  readonly #active = new Map<string, ActiveProducer>();
  readonly #starting = new Map<string, Promise<ActiveProducer | undefined>>();

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
      let active = this.#active.get(session.id);
      const dominant = await this.#dominantDemand(session.id, profile, segmentIndex, active);
      if (
        active &&
        this.#shouldSwitch(active, dominant.index, dominant.currentViewers, dominant.viewers)
      ) {
        await this.#stopActive(session.id, 'switching');
        active = undefined;
      }
      active ??= await this.#start(session, profile, dominant.index, signal);
      if (!active) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const demandedAt = Date.now();
      active.lastDemandAtMs = demandedAt;
      await this.#transition(session.id, active.generation, (current) => ({
        ...current,
        demandedSegmentIndex: dominant.index,
        lastDemandAt: new Date(demandedAt).toISOString(),
        idleDeadlineAt: new Date(demandedAt + this.options.idleTimeoutMs).toISOString(),
        updatedAt: new Date().toISOString()
      }));
      if (await this.#waitForObject(contentKey, session.id, active, deadline, signal)) return;
    }
    throw new CapacityError('Timed out waiting for the persistent producer');
  }

  async stop(sessionId: string): Promise<void> {
    await this.#stopActive(sessionId, 'cancelled');
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
      if (!['starting', 'running', 'switching'].includes(listed.state)) continue;
      if (listed.leaseExpiresAt && Date.parse(listed.leaseExpiresAt) > now) continue;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await this.repository.getVersionedVodProducer(listed.sessionId);
        if (!current || !['starting', 'running', 'switching'].includes(current.value.state)) break;
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
        const result = await this.repository.compareAndSetVodProducer(updated, current.revision, [
          'starting',
          'running',
          'switching'
        ]);
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
    await Promise.all(
      [...this.#active.keys()].map((sessionId) => this.#stopActive(sessionId, 'idle'))
    );
  }

  async drain(): Promise<void> {
    await Promise.all(
      [...this.#active.entries()].map(([sessionId, active]) =>
        this.#stopActive(sessionId, active.placementLocked ? 'cancelled' : 'switching')
      )
    );
  }

  async #start(
    session: RelaySession,
    profile: ProfileRevision,
    startSegmentIndex: number,
    signal?: AbortSignal
  ): Promise<ActiveProducer | undefined> {
    const existing = this.#starting.get(session.id);
    if (existing) return existing;
    const start = this.#startExclusive(session, profile, startSegmentIndex, signal).finally(() => {
      this.#starting.delete(session.id);
    });
    this.#starting.set(session.id, start);
    return start;
  }

  async #startExclusive(
    session: RelaySession,
    profile: ProfileRevision,
    startSegmentIndex: number,
    signal?: AbortSignal
  ): Promise<ActiveProducer | undefined> {
    if (
      session.placementLocked &&
      session.assignedNodeId &&
      session.assignedNodeId !== this.options.nodeId
    )
      throw new CapacityError('The session is locked to another source worker');
    const owner = `${this.options.nodeId}:${randomUUID()}`;
    const leaseKey = `vod-producer:${session.id}`;
    const leaseMs = this.options.leaseMs ?? LEASE_MS;
    if (!(await this.coordination.acquire(leaseKey, owner, leaseMs))) return undefined;
    const controller = new AbortController();
    const forwardAbort = () =>
      controller.abort(signal?.reason ?? new Error('Producer start aborted'));
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const current = await this.repository.getVersionedVodProducer(session.id);
      const generation = (current?.value.generation ?? 0) + 1;
      const now = new Date().toISOString();
      const producer: VodProducer = {
        id: session.id,
        sessionId: session.id,
        ownerNodeId: this.options.nodeId,
        generation,
        state: 'starting',
        demandedSegmentIndex: startSegmentIndex,
        startSegmentIndex,
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
        ? await this.repository.compareAndSetVodProducer(producer, current.revision, ALL_STATES)
        : await this.repository.createVodProducer(producer);
      if ('applied' in stored && !stored.applied)
        throw new ConflictError('Producer ownership changed during start');
      const active: ActiveProducer = {
        generation,
        controller,
        completion: Promise.resolve(),
        owner,
        startSegmentIndex,
        lastDemandAtMs: Date.now(),
        placementLocked: session.placementLocked
      };
      this.#active.set(session.id, active);
      active.completion = this.#run(session, profile, producer, active, leaseKey);
      return active;
    } catch (error) {
      await this.coordination.release(leaseKey, owner).catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
    }
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
        active.controller.signal
      );
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
      idleCheck = setInterval(() => {
        void this.#refreshDemand(session, profile, active).catch((error) =>
          active.controller.abort(error)
        );
      }, 2_000);
      idleCheck.unref();
      this.metrics?.increment('vod_producers_started_total');
      if (!this.transcoder.produceVod)
        throw new CapacityError('The source worker does not support persistent VOD producers');
      await this.transcoder.produceVod(
        request,
        directory,
        async (segment) => {
          if (active.controller.signal.aborted) throw active.controller.signal.reason;
          const contentKey = this.cache.contentKey(session, profile, segment.index);
          await this.cache.publishObject(session, profile, segment.index, segment.path, contentKey);
          active.lastPublishedSegmentIndex = segment.index;
          await this.#transition(session.id, active.generation, (current) => ({
            ...current,
            state: 'running',
            lastPublishedSegmentIndex: segment.index,
            leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
            updatedAt: new Date().toISOString()
          }));
          await this.coordination.publish(
            'segments',
            JSON.stringify({ contentKey, sessionId: session.id, segmentIndex: segment.index })
          );
        },
        active.controller.signal
      );
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
      active.lastPublishedSegmentIndex ?? active.startSegmentIndex,
      active
    );
    if (this.#shouldSwitch(active, dominant.index, dominant.currentViewers, dominant.viewers)) {
      active.stopState = 'switching';
      active.controller.abort(new Error('Producer playback window changed'));
      return;
    }
    await this.#transition(session.id, active.generation, (current) => ({
      ...current,
      demandedSegmentIndex: dominant.index,
      lastDemandAt: new Date(latest).toISOString(),
      idleDeadlineAt: new Date(latest + this.options.idleTimeoutMs).toISOString(),
      updatedAt: new Date().toISOString()
    }));
  }

  async #stopActive(sessionId: string, state: 'idle' | 'switching' | 'cancelled'): Promise<void> {
    const active = this.#active.get(sessionId);
    if (!active) return;
    active.stopState = state;
    active.controller.abort(new Error(`Producer stopped: ${state}`));
    await active.completion;
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
      if (this.#active.get(sessionId) !== active) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async #dominantDemand(
    sessionId: string,
    profile: ProfileRevision,
    requestedIndex: number,
    active?: ActiveProducer
  ): Promise<{ index: number; viewers: number; currentViewers: number }> {
    const now = Date.now();
    const demands = await this.coordination.listSegmentDemands({
      sessionId,
      observedAtMs: now,
      windowMs: DEMAND_WINDOW_MS
    });
    if (!demands.length) return { index: requestedIndex, viewers: 1, currentViewers: 0 };
    const radius = Math.min(5, Math.max(2, Math.ceil(10 / profile.delivery.segmentDuration)));
    const currentIndex = active?.lastPublishedSegmentIndex ?? active?.startSegmentIndex;
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
    return { ...winner, currentViewers };
  }

  #shouldSwitch(
    active: ActiveProducer,
    demandedIndex: number,
    currentViewers: number,
    demandedViewers: number
  ): boolean {
    const highWater = (active.lastPublishedSegmentIndex ?? active.startSegmentIndex) + 5;
    const covered = demandedIndex >= active.startSegmentIndex && demandedIndex <= highWater;
    return !covered && (currentViewers === 0 || demandedViewers > currentViewers);
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
        ALL_STATES
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
    return { ...producer, workerHistory };
  }
}
