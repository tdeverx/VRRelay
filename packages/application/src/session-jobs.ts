// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  JobLogEntry,
  NodeCapability,
  NodeRole,
  Profile,
  RelaySession,
  SegmentJob
} from '@vrrelay/domain';
import type {
  ClusterRepository,
  CoordinationStore,
  EventBus,
  MetricsSink,
  RemoteSegmentCommand,
  RemoteSegmentDispatcher,
  Repository
} from './index.js';
import { CapacityError, ConflictError, NotFoundError, UnauthorizedError } from './errors.js';
import { createServiceEvent as event } from './service-helpers.js';
import { SessionCache } from './session-cache.js';

const MAX_ATOMIC_WRITE_ATTEMPTS = 5;
const DEFAULT_JOB_LOG_RETENTION_ROWS = 1000;
const DEFAULT_JOB_LOG_QUERY_LIMIT = 200;

function supportsVideoCodec(capabilities: NodeCapability, codec: Profile['video']['codec']) {
  if (codec === 'copy') return true;
  if (capabilities.videoCodecs) return capabilities.videoCodecs.includes(codec);
  const names = capabilities.encoders.map((encoder) => encoder.toLowerCase());
  if (codec === 'h264') return names.some((name) => name.includes('264'));
  if (codec === 'h265') return names.some((name) => name.includes('265') || name.includes('hevc'));
  return names.some((name) => name.includes('av1'));
}

class SegmentJobCancelledError extends Error {
  constructor() {
    super('Segment job was cancelled');
    this.name = 'SegmentJobCancelledError';
  }
}

type SegmentJobMode = 'local' | 'remote' | 'unknown';
type SegmentJobOutcome = 'complete' | 'failed' | 'cancelled';

function secondsSince(startedAt: number): number {
  return (Date.now() - startedAt) / 1_000;
}

function failureKind(
  error: unknown
): 'capacity' | 'conflict' | 'not_found' | 'unauthorized' | 'error' {
  if (error instanceof CapacityError) return 'capacity';
  if (error instanceof ConflictError) return 'conflict';
  if (error instanceof NotFoundError) return 'not_found';
  if (error instanceof UnauthorizedError) return 'unauthorized';
  return 'error';
}

function redactJobLogMessage(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bvrr_(?:join_)?[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\/internal\/source\/[A-Za-z0-9._~-]+/gi, '/internal/source/[REDACTED]')
    .replace(/\/play\/[A-Za-z0-9._~-]+/gi, '/play/[REDACTED]')
    .replace(/\b(?:https?|wss?|rtsp|rtmp|srt):\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(
      /(authorization|password|token|secret|api[-_ ]?key)["']?\s*[:=]\s*["']?[^\s,"'}]+/gi,
      '$1=[REDACTED]'
    )
    .slice(0, 2_000);
}

function redactJobLogValue(value: unknown, depth = 0): unknown {
  if (depth >= 6) return '[REDACTED:DEPTH]';
  if (typeof value === 'string') return redactJobLogMessage(value);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactJobLogValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /authorization|password|token|secret|private.?key|api.?key/i.test(key)
          ? '[REDACTED]'
          : redactJobLogValue(item, depth + 1)
      ])
    );
  }
  return value;
}

function redactJobLogContext(context: Record<string, unknown>): Record<string, unknown> {
  return redactJobLogValue(context) as Record<string, unknown>;
}

export interface SessionJobOptions {
  cacheDir: string;
  nodeId?: string;
  roles?: NodeRole[];
  jobLogRetentionRows?: number;
  jobLogQueryLimit?: number;
}

export interface SessionJobInfrastructure {
  coordination?: CoordinationStore;
  clusterRepository?: ClusterRepository;
  metrics?: MetricsSink;
  dispatcher?: RemoteSegmentDispatcher;
}

export interface SessionJobCallbacks {
  getSession(id: string): Promise<RelaySession>;
  generateSegment(
    session: RelaySession,
    profile: Profile,
    index: number,
    destination: string,
    signal?: AbortSignal
  ): Promise<string>;
  remoteCommand?(
    jobId: string,
    session: RelaySession,
    contentKey: string,
    segmentIndex: number
  ): Promise<RemoteSegmentCommand>;
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

export class SessionJobCoordinator {
  readonly #jobControllers = new Map<string, AbortController>();

  constructor(
    private readonly repository: Repository,
    private readonly events: EventBus,
    private readonly options: SessionJobOptions,
    private readonly cache: SessionCache,
    private readonly infrastructure: SessionJobInfrastructure,
    private readonly callbacks: SessionJobCallbacks
  ) {}

  async listJobs(limit = 100): Promise<SegmentJob[]> {
    const jobs = (await this.infrastructure.clusterRepository?.listSegmentJobs(limit)) ?? [];
    return jobs.map((job) => ({ ...job, workerHistory: job.workerHistory ?? [] }));
  }

  async listLogs(jobId: string, limit = this.#jobLogQueryLimit()): Promise<JobLogEntry[]> {
    return (
      (await this.infrastructure.clusterRepository?.listJobLogs(
        jobId,
        Math.min(this.#jobLogQueryLimit(), Math.max(1, Math.floor(limit)))
      )) ?? []
    );
  }

  async recoverExpiredJobs(now = Date.now()): Promise<number> {
    const repository = this.infrastructure.clusterRepository;
    if (!repository) return 0;
    let recovered = 0;
    for (const listed of await repository.listSegmentJobs(1_000)) {
      if (
        !['leased', 'running'].includes(listed.state) ||
        (listed.leaseExpiresAt && Date.parse(listed.leaseExpiresAt) > now)
      )
        continue;
      let settled = false;
      for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
        const current = await repository.getVersionedSegmentJob(listed.id);
        if (
          !current ||
          !['leased', 'running'].includes(current.value.state) ||
          (current.value.leaseExpiresAt && Date.parse(current.value.leaseExpiresAt) > now)
        ) {
          settled = true;
          break;
        }
        const queued: SegmentJob = {
          ...finishLatestAttempt(current.value, 'failed', 'Recovered expired segment job lease'),
          state: 'queued',
          ownerNodeId: undefined,
          leaseExpiresAt: undefined,
          errorMessage: undefined,
          updatedAt: new Date().toISOString()
        };
        const result = await repository.compareAndSetSegmentJob(queued, current.revision, [
          'leased',
          'running'
        ]);
        if (result.applied) {
          recovered += 1;
          this.infrastructure.metrics?.increment('segment_jobs_recovered_total', {
            reason: 'expired_lease'
          });
          await this.#recordJobLog(queued, 'warn', 'Segment job lease expired; requeued', {
            reason: 'expired_lease'
          });
          settled = true;
          break;
        }
        if (result.reason === 'not-found' || result.reason === 'invalid-state') {
          settled = true;
          break;
        }
      }
      if (!settled)
        throw new ConflictError('Segment job recovery conflicted with repeated concurrent updates');
    }
    return recovered;
  }

  async cancelJob(id: string): Promise<void> {
    const repository = this.infrastructure.clusterRepository;
    if (!repository) return;
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await repository.getVersionedSegmentJob(id);
      if (!current || ['complete', 'failed', 'cancelled'].includes(current.value.state)) return;
      const cancelled: SegmentJob = {
        ...finishLatestAttempt(current.value, 'cancelled', 'Cancelled by an administrator'),
        state: 'cancelled',
        leaseExpiresAt: undefined,
        updatedAt: new Date().toISOString()
      };
      const result = await repository.cancelSegmentJob(cancelled, current.revision);
      if (result.applied) {
        this.infrastructure.metrics?.increment('segment_job_cancellations_total', {
          source: 'admin'
        });
        await this.#recordJobLog(cancelled, 'warn', 'Segment job cancelled by administrator', {
          source: 'admin'
        });
        this.#jobControllers.get(id)?.abort(new Error('Job cancelled'));
        if (current.value.ownerNodeId && current.value.ownerNodeId !== this.options.nodeId)
          await this.infrastructure.dispatcher?.cancel(current.value.ownerNodeId, id);
        return;
      }
      if (result.reason === 'not-found') return;
      if (result.reason === 'invalid-state') return;
    }
    throw new ConflictError('Job cancellation conflicted with repeated concurrent updates');
  }

  async retryJob(id: string): Promise<SegmentJob> {
    const repository = this.infrastructure.clusterRepository;
    if (!repository) throw new NotFoundError('Segment job was not found');
    const current = await repository.getVersionedSegmentJob(id);
    if (!current) throw new NotFoundError('Segment job was not found');
    if (!['failed', 'cancelled'].includes(current.value.state))
      throw new ConflictError('Only failed or cancelled segment jobs can be retried');
    const job = current.value;
    const session = await this.callbacks.getSession(job.sessionId);
    if (session.kind !== 'vod' || !session.source || !session.durationSeconds)
      throw new ConflictError('The segment job no longer references a retryable VOD session');
    const profile = await this.repository.getProfile(session.profileId);
    if (!profile) throw new NotFoundError('Profile was not found');
    const expectedKey = this.cache.contentKey(session, profile, job.segmentIndex);
    if (expectedKey !== job.contentKey)
      throw new ConflictError('The segment job does not match the current profile');
    const extension = profile.delivery.segmentType === 'fmp4' ? 'm4s' : 'ts';
    const destination = join(
      this.options.cacheDir,
      'vod',
      session.id,
      profile.profileId,
      `${job.segmentIndex}.${extension}`
    );
    await rm(destination, { force: true });
    const queued = await this.#retryJobTransition(id);
    await this.#recordJobLog(queued, 'info', 'Segment job queued for manual retry', {
      source: 'manual'
    });
    await this.generateDistributedSegment(
      session,
      profile,
      job.segmentIndex,
      destination,
      job.contentKey
    );
    return (await repository.getSegmentJob(id))!;
  }

  async executeRemoteSegment(command: RemoteSegmentCommand, signal?: AbortSignal): Promise<void> {
    const session = await this.callbacks.getSession(command.sessionId);
    if (session.kind !== 'vod' || !session.source || !session.durationSeconds)
      throw new NotFoundError('VOD session was not found');
    const profile = await this.repository.getProfile(session.profileId);
    if (!profile) throw new NotFoundError('Profile was not found');
    const expectedKey = this.cache.contentKey(session, profile, command.segmentIndex);
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
      await this.callbacks.generateSegment(
        session,
        profile,
        command.segmentIndex,
        destination,
        controller.signal
      );
      await this.cache.publishObject(
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

  async generateDistributedSegment(
    session: RelaySession,
    profile: Profile,
    index: number,
    destination: string,
    contentKey: string,
    signal?: AbortSignal
  ): Promise<string> {
    const jobStartedAt = Date.now();
    let jobMode: SegmentJobMode = 'local';
    const coordination = this.infrastructure.coordination;
    const owner = `${this.options.nodeId ?? 'standalone'}:${randomUUID()}`;
    const leaseKey = `segment:${contentKey}`;
    if (coordination && !(await coordination.acquire(leaseKey, owner, 120_000))) {
      this.infrastructure.metrics?.increment('segment_lease_contention_total');
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw signal.reason ?? new Error('Segment request was aborted');
        if (await this.cache.restoreObject(contentKey, destination)) return destination;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new CapacityError('Timed out waiting for another node to publish the segment');
    }
    const now = new Date().toISOString();
    const jobId = createHash('sha256').update(contentKey).digest('hex');
    const previousJob = await this.infrastructure.clusterRepository?.getSegmentJob(jobId);
    let job = await this.#startJob({
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
    });
    await this.#recordJobLog(job, 'info', 'Segment job leased for generation', {
      segmentIndex: index,
      ownerNodeId: job.ownerNodeId,
      attempts: job.attempts
    });
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
              job = await this.#transitionActiveJob(job, (current) => ({
                ...current,
                leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
                updatedAt: new Date().toISOString()
              }));
            })
            .catch((error) => leaseController.abort(error));
        }, 30_000)
      : undefined;
    renew?.unref();
    try {
      const candidates = await this.#remoteCandidates(session, profile);
      if (candidates.length) {
        jobMode = 'remote';
        let failure: unknown;
        const candidatePool = session.placementLocked ? candidates.slice(0, 1) : candidates;
        const remainingAttempts = Math.max(0, 3 - job.attempts);
        if (!remainingAttempts)
          throw new CapacityError('Segment job exhausted its automatic retry limit');
        for (let attemptIndex = 0; attemptIndex < remainingAttempts; attemptIndex += 1) {
          const remoteNode = candidatePool[attemptIndex % candidatePool.length]!;
          const attempt = job.attempts + 1;
          job = await this.#transitionActiveJob(job, (current) => ({
            ...current,
            ownerNodeId: remoteNode,
            attempts: attempt,
            workerHistory: [
              ...current.workerHistory,
              { attempt, nodeId: remoteNode, state: 'running', startedAt: new Date().toISOString() }
            ],
            updatedAt: new Date().toISOString()
          }));
          this.#recordJobAttempt('remote', 'started');
          await this.#recordJobLog(job, 'info', 'Remote segment attempt started', {
            mode: 'remote',
            attempt,
            nodeId: remoteNode,
            segmentIndex: index
          });
          if (attempt > 1)
            this.infrastructure.metrics?.increment('segment_job_retries_total', {
              mode: 'remote',
              source: 'automatic'
            });
          try {
            const command = this.callbacks.remoteCommand
              ? await this.callbacks.remoteCommand(job.id, session, contentKey, index)
              : { jobId: job.id, sessionId: session.id, contentKey, segmentIndex: index };
            const dispatcher = this.infrastructure.dispatcher!;
            if (profile.delivery.method === 'hls' && dispatcher.dispatchProducer)
              await dispatcher.dispatchProducer(remoteNode, command, leaseController.signal);
            else await dispatcher.dispatch(remoteNode, command, leaseController.signal);
            if (!(await this.cache.restoreObject(contentKey, destination)))
              throw new Error('Worker completed without publishing the segment object');
            job = await this.#transitionActiveJob(job, (current) => ({
              ...finishLatestAttempt(current, 'complete'),
              updatedAt: new Date().toISOString()
            }));
            this.#recordJobAttempt('remote', 'complete');
            await this.#recordJobLog(job, 'info', 'Remote segment attempt completed', {
              mode: 'remote',
              attempt,
              nodeId: remoteNode,
              segmentIndex: index
            });
            failure = undefined;
            break;
          } catch (error) {
            failure = error;
            this.#recordJobAttempt('remote', 'failed');
            job = await this.#transitionActiveJob(job, (current) => ({
              ...finishLatestAttempt(
                current,
                'failed',
                error instanceof Error ? error.message : String(error)
              ),
              updatedAt: new Date().toISOString()
            }));
            await this.#recordJobLog(job, 'warn', 'Remote segment attempt failed', {
              mode: 'remote',
              attempt,
              nodeId: remoteNode,
              segmentIndex: index,
              error: error instanceof Error ? error.message : String(error)
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
        job = await this.#transitionActiveJob(job, (current) => ({
          ...current,
          attempts: attempt,
          ownerNodeId: this.options.nodeId,
          workerHistory: [
            ...current.workerHistory,
            {
              attempt,
              nodeId: this.options.nodeId ?? 'standalone',
              state: 'running',
              startedAt: new Date().toISOString()
            }
          ],
          updatedAt: new Date().toISOString()
        }));
        this.#recordJobAttempt('local', 'started');
        await this.#recordJobLog(job, 'info', 'Local segment attempt started', {
          mode: 'local',
          attempt,
          nodeId: this.options.nodeId ?? 'standalone',
          segmentIndex: index
        });
        if (attempt > 1)
          this.infrastructure.metrics?.increment('segment_job_retries_total', {
            mode: 'local',
            source: 'automatic'
          });
        await this.callbacks.generateSegment(
          session,
          profile,
          index,
          destination,
          leaseController.signal
        );
        await this.cache.publishObject(session, profile, index, destination, contentKey);
        this.#recordJobAttempt('local', 'complete');
        job = finishLatestAttempt(job, 'complete');
        await this.#recordJobLog(job, 'info', 'Local segment attempt completed', {
          mode: 'local',
          attempt,
          nodeId: this.options.nodeId ?? 'standalone',
          segmentIndex: index
        });
      }
      const completedAt = new Date().toISOString();
      job = await this.#completeJob(job, completedAt);
      this.#recordJobFinished(jobStartedAt, jobMode, 'complete');
      await this.#recordJobLog(job, 'info', 'Segment job completed', {
        mode: jobMode,
        segmentIndex: index,
        durationSeconds: secondsSince(jobStartedAt)
      });
      this.events.publish(event('job.completed', { jobId: job.id }, session.id));
      await coordination?.publish('segments', JSON.stringify({ contentKey, state: 'complete' }));
      return destination;
    } catch (error) {
      if (error instanceof SegmentJobCancelledError) {
        this.#recordJobFinished(jobStartedAt, jobMode, 'cancelled');
        throw error;
      }
      this.infrastructure.metrics?.increment('segment_job_failures_total', {
        mode: jobMode,
        kind: failureKind(error)
      });
      const failed = await this.#failJob(
        job,
        error instanceof Error ? error.message : String(error)
      );
      if (failed.state === 'cancelled') {
        this.#recordJobFinished(jobStartedAt, jobMode, 'cancelled');
        throw new SegmentJobCancelledError();
      }
      this.#recordJobFinished(jobStartedAt, jobMode, 'failed');
      await this.#recordJobLog(failed, 'error', 'Segment job failed', {
        mode: jobMode,
        segmentIndex: index,
        error: error instanceof Error ? error.message : String(error)
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
      // Expiry safely releases the lease if coordination is temporarily down.
      // Do not mask the segment outcome or crash a background request while
      // Valkey is restarting.
      await coordination?.release(leaseKey, owner).catch(() => undefined);
    }
  }

  async #retryJobTransition(id: string): Promise<SegmentJob> {
    const repository = this.infrastructure.clusterRepository;
    if (!repository) throw new NotFoundError('Segment job was not found');
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await repository.getVersionedSegmentJob(id);
      if (!current) throw new NotFoundError('Segment job was not found');
      if (!['failed', 'cancelled'].includes(current.value.state))
        throw new ConflictError('Only failed or cancelled segment jobs can be retried');
      const queued: SegmentJob = {
        ...current.value,
        state: 'queued',
        attempts: 0,
        ownerNodeId: undefined,
        leaseExpiresAt: undefined,
        completedAt: undefined,
        errorMessage: undefined,
        updatedAt: new Date().toISOString()
      };
      const result = await repository.compareAndSetSegmentJob(queued, current.revision, [
        'failed',
        'cancelled'
      ]);
      if (result.applied) {
        this.infrastructure.metrics?.increment('segment_job_retries_total', {
          mode: 'unknown',
          source: 'manual'
        });
        return result.record.value;
      }
      if (result.reason === 'not-found') throw new NotFoundError('Segment job was not found');
      if (result.reason === 'invalid-state')
        throw new ConflictError('Only failed or cancelled segment jobs can be retried');
    }
    throw new ConflictError('Job retry conflicted with repeated concurrent updates');
  }

  async #startJob(initial: SegmentJob): Promise<SegmentJob> {
    const repository = this.infrastructure.clusterRepository;
    if (!repository) return initial;
    const creation = await repository.createSegmentJob(initial);
    if (creation.created) return creation.record.value;
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current =
        attempt === 0 ? creation.record : await repository.getVersionedSegmentJob(initial.id);
      if (!current) throw new NotFoundError('Segment job was not found');
      if (current.value.state === 'cancelled') throw new SegmentJobCancelledError();
      const running: SegmentJob = {
        ...initial,
        attempts: current.value.attempts,
        workerHistory: current.value.workerHistory,
        createdAt: current.value.createdAt
      };
      const result = await repository.compareAndSetSegmentJob(running, current.revision, [
        'queued',
        'leased',
        'running',
        'failed',
        'complete'
      ]);
      if (result.applied) return result.record.value;
      if (result.reason === 'not-found') continue;
      if (result.reason === 'invalid-state') {
        if (result.current?.value.state === 'cancelled') throw new SegmentJobCancelledError();
        throw new ConflictError('Segment job can no longer be started');
      }
    }
    throw new ConflictError('Segment job start conflicted with repeated concurrent updates');
  }

  async #transitionActiveJob(
    fallback: SegmentJob,
    update: (job: SegmentJob) => SegmentJob
  ): Promise<SegmentJob> {
    const repository = this.infrastructure.clusterRepository;
    if (!repository) return update(fallback);
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await repository.getVersionedSegmentJob(fallback.id);
      if (!current) throw new NotFoundError('Segment job was not found');
      if (current.value.state === 'cancelled') throw new SegmentJobCancelledError();
      if (!['leased', 'running'].includes(current.value.state))
        throw new ConflictError('Segment job is no longer active');
      const result = await repository.compareAndSetSegmentJob(
        update(current.value),
        current.revision,
        ['leased', 'running']
      );
      if (result.applied) return result.record.value;
      if (result.reason === 'not-found') throw new NotFoundError('Segment job was not found');
      if (result.reason === 'invalid-state') {
        if (result.current?.value.state === 'cancelled') throw new SegmentJobCancelledError();
        throw new ConflictError('Segment job is no longer active');
      }
    }
    throw new ConflictError('Segment job update conflicted with repeated concurrent updates');
  }

  async #completeJob(fallback: SegmentJob, completedAt: string): Promise<SegmentJob> {
    const repository = this.infrastructure.clusterRepository;
    if (!repository)
      return {
        ...finishLatestAttempt(fallback, 'complete'),
        state: 'complete',
        leaseExpiresAt: undefined,
        completedAt,
        updatedAt: completedAt
      };
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await repository.getVersionedSegmentJob(fallback.id);
      if (!current) throw new NotFoundError('Segment job was not found');
      if (current.value.state === 'cancelled') throw new SegmentJobCancelledError();
      if (current.value.state === 'complete') return current.value;
      const complete: SegmentJob = {
        ...finishLatestAttempt(current.value, 'complete'),
        state: 'complete',
        leaseExpiresAt: undefined,
        completedAt,
        updatedAt: completedAt
      };
      const result = await repository.completeSegmentJob(complete, current.revision);
      if (result.applied) return result.record.value;
      if (result.reason === 'not-found') throw new NotFoundError('Segment job was not found');
      if (result.reason === 'invalid-state') {
        if (result.current?.value.state === 'cancelled') throw new SegmentJobCancelledError();
        if (result.current?.value.state === 'complete') return result.current.value;
        throw new ConflictError('Segment job can no longer complete');
      }
    }
    throw new ConflictError('Job completion conflicted with repeated concurrent updates');
  }

  async #failJob(fallback: SegmentJob, errorMessage: string): Promise<SegmentJob> {
    const repository = this.infrastructure.clusterRepository;
    if (!repository)
      return {
        ...finishLatestAttempt(fallback, 'failed', errorMessage),
        state: 'failed',
        errorMessage,
        updatedAt: new Date().toISOString()
      };
    for (let attempt = 0; attempt < MAX_ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
      const current = await repository.getVersionedSegmentJob(fallback.id);
      if (!current) throw new NotFoundError('Segment job was not found');
      if (['cancelled', 'complete', 'failed'].includes(current.value.state)) return current.value;
      const failed: SegmentJob = {
        ...finishLatestAttempt(current.value, 'failed', errorMessage),
        state: 'failed',
        errorMessage,
        updatedAt: new Date().toISOString()
      };
      const result = await repository.compareAndSetSegmentJob(failed, current.revision, [
        'queued',
        'leased',
        'running'
      ]);
      if (result.applied) return result.record.value;
      if (result.reason === 'not-found') throw new NotFoundError('Segment job was not found');
      if (result.reason === 'invalid-state') return result.current?.value ?? current.value;
    }
    throw new ConflictError('Job failure update conflicted with repeated concurrent updates');
  }

  async #remoteCandidates(session: RelaySession, profile: Profile): Promise<string[]> {
    const dispatcher = this.infrastructure.dispatcher;
    const repository = this.infrastructure.clusterRepository;
    if (!dispatcher || !repository || !session.source) return [];
    const bindings = await repository.listProviderBindings(session.source.providerId);
    const nodes = await repository.listNodes();
    const compatible = nodes.filter(
      (node) =>
        node.roles.includes('source-worker') &&
        node.state === 'online' &&
        supportsVideoCodec(node.capabilities, profile.video.codec) &&
        (profile.delivery.method !== 'hls' || (node.capabilities.vodProducerVersion ?? 0) >= 1) &&
        bindings.some(
          (binding) =>
            binding.nodeId === node.id && binding.state === 'healthy' && !binding.deletionPending
        ) &&
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

  #jobLogRetentionRows(): number {
    const configured = Math.floor(
      this.options.jobLogRetentionRows ?? DEFAULT_JOB_LOG_RETENTION_ROWS
    );
    const rows = Number.isFinite(configured) ? configured : DEFAULT_JOB_LOG_RETENTION_ROWS;
    return Math.min(50_000, Math.max(100, rows));
  }

  #jobLogQueryLimit(): number {
    const configured = Math.floor(this.options.jobLogQueryLimit ?? DEFAULT_JOB_LOG_QUERY_LIMIT);
    const limit = Number.isFinite(configured) ? configured : DEFAULT_JOB_LOG_QUERY_LIMIT;
    return Math.min(1000, Math.max(1, limit));
  }

  async #recordJobLog(
    job: SegmentJob,
    level: JobLogEntry['level'],
    message: string,
    context: Record<string, unknown> = {}
  ): Promise<void> {
    const nodeId =
      typeof context.nodeId === 'string'
        ? context.nodeId
        : job.ownerNodeId
          ? job.ownerNodeId
          : this.options.nodeId;
    const entry: JobLogEntry = {
      id: randomUUID(),
      jobId: job.id,
      sessionId: job.sessionId,
      ...(nodeId ? { nodeId } : {}),
      level,
      message: redactJobLogMessage(message),
      context: redactJobLogContext(context),
      timestamp: new Date().toISOString()
    };
    try {
      await this.infrastructure.clusterRepository?.putJobLog(entry, this.#jobLogRetentionRows());
    } catch {
      this.infrastructure.metrics?.increment('segment_job_log_write_failures_total');
    }
    this.events.publish({
      version: 1,
      id: entry.id,
      type: 'job.log',
      timestamp: entry.timestamp,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      payload: {
        jobId: entry.jobId,
        ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
        level: entry.level,
        message: entry.message,
        context: entry.context
      }
    });
  }

  #recordJobAttempt(
    mode: Exclude<SegmentJobMode, 'unknown'>,
    outcome: 'started' | 'complete' | 'failed'
  ): void {
    this.infrastructure.metrics?.increment('segment_job_attempts_total', { mode, outcome });
  }

  #recordJobFinished(startedAt: number, mode: SegmentJobMode, outcome: SegmentJobOutcome): void {
    const duration = Number.isFinite(startedAt) ? secondsSince(startedAt) : 0;
    this.infrastructure.metrics?.increment('segment_jobs_total', { mode, outcome });
    this.infrastructure.metrics?.observe('segment_job_duration_seconds', duration, {
      mode,
      outcome
    });
  }
}
