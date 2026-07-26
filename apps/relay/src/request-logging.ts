// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';

const CLIENT_RETENTION_MS = 2 * 60_000;
const CLIENT_RESUME_MS = 30_000;
const MAX_TRACKED_CLIENTS = 10_000;
const SEEK_CONFIRM_SEGMENTS = 5;

export type PlaybackClientChange =
  | 'manifest'
  | 'started'
  | 'advanced'
  | 'retry'
  | 'reordered'
  | 'resumed'
  | 'seeked-forward'
  | 'seeked-backward';

export interface PlaybackClientObservation {
  clientId: string;
  change: PlaybackClientChange;
  previousSegmentIndex?: number;
  segmentDelta?: number;
  idleMs?: number;
}

interface TrackedClient {
  segmentIndex?: number;
  observedAtMs: number;
  seekCandidate?: {
    direction: 'forward' | 'backward';
    segmentIndex: number;
  };
}

export class PlaybackRequestTracker {
  readonly #clients = new Map<string, TrackedClient>();
  #lastPrunedAtMs = 0;

  observe(
    sessionId: string,
    clientAffinity: string,
    segmentIndex?: number,
    observedAtMs = Date.now()
  ): PlaybackClientObservation {
    this.#prune(observedAtMs);
    const clientId = createHash('sha256').update(clientAffinity).digest('hex').slice(0, 16);
    const key = `${sessionId}\0${clientId}`;
    const previous = this.#clients.get(key);
    const idleMs = previous ? Math.max(0, observedAtMs - previous.observedAtMs) : undefined;
    let change: PlaybackClientChange = 'manifest';
    let segmentDelta: number | undefined;
    let direction: 'forward' | 'backward' | undefined;
    let candidateConfirmed = false;

    if (segmentIndex !== undefined) {
      if (previous?.segmentIndex === undefined) change = 'started';
      else {
        segmentDelta = segmentIndex - previous.segmentIndex;
        if (idleMs !== undefined && idleMs > CLIENT_RESUME_MS) {
          change = 'resumed';
        } else if (segmentDelta === 0) change = 'retry';
        else if (segmentDelta > 0 && segmentDelta <= 2) change = 'advanced';
        else if (segmentDelta < 0 && segmentDelta >= -2) change = 'reordered';
        else change = 'reordered';

        direction = segmentDelta > 0 ? 'forward' : 'backward';
        const candidate = previous?.seekCandidate;
        const candidateDelta = candidate ? segmentIndex - candidate.segmentIndex : undefined;
        candidateConfirmed =
          candidate?.direction === direction &&
          candidateDelta !== undefined &&
          ((direction === 'forward' &&
            candidateDelta > 0 &&
            candidateDelta <= SEEK_CONFIRM_SEGMENTS) ||
            (direction === 'backward' &&
              candidateDelta < 0 &&
              candidateDelta >= -SEEK_CONFIRM_SEGMENTS));
        if (candidateConfirmed) change = `seeked-${direction}`;
      }
    }

    const candidate = previous?.seekCandidate;
    const candidateContinues =
      candidate !== undefined &&
      candidate.direction === direction &&
      segmentIndex !== undefined &&
      ((direction === 'forward' &&
        segmentIndex > candidate.segmentIndex &&
        segmentIndex - candidate.segmentIndex <= SEEK_CONFIRM_SEGMENTS) ||
        (direction === 'backward' &&
          segmentIndex < candidate.segmentIndex &&
          candidate.segmentIndex - segmentIndex <= SEEK_CONFIRM_SEGMENTS));
    const seekCandidate: TrackedClient['seekCandidate'] = candidateContinues
      ? undefined
      : segmentIndex === undefined ||
          direction === undefined ||
          (idleMs !== undefined && idleMs > CLIENT_RESUME_MS) ||
          candidateConfirmed
        ? undefined
        : { direction, segmentIndex };

    this.#clients.delete(key);
    this.#clients.set(key, {
      ...(segmentIndex !== undefined
        ? { segmentIndex }
        : previous?.segmentIndex !== undefined
          ? { segmentIndex: previous.segmentIndex }
          : {}),
      ...(seekCandidate ? { seekCandidate } : {}),
      observedAtMs
    });
    return {
      clientId,
      change,
      ...(previous?.segmentIndex === undefined
        ? {}
        : { previousSegmentIndex: previous.segmentIndex }),
      ...(segmentDelta === undefined ? {} : { segmentDelta }),
      ...(idleMs === undefined ? {} : { idleMs })
    };
  }

  #prune(now: number): void {
    if (
      this.#clients.size < MAX_TRACKED_CLIENTS &&
      now - this.#lastPrunedAtMs < CLIENT_RETENTION_MS
    )
      return;
    this.#lastPrunedAtMs = now;
    const cutoff = now - CLIENT_RETENTION_MS;
    for (const [key, client] of this.#clients) {
      if (client.observedAtMs <= cutoff || this.#clients.size >= MAX_TRACKED_CLIENTS)
        this.#clients.delete(key);
      else break;
    }
  }
}

export interface DiagnosticLogger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
}

export interface PlaybackRequestLogInput {
  sessionId: string;
  clientAffinity: string;
  resource: 'manifest' | 'segment' | 'init' | 'stream' | 'live-manifest' | 'live-resource';
  nodeId: string;
  segmentIndex?: number;
  viewerRegion?: string;
  selectedEdgeNodeId?: string;
  selectedEdgeRegion?: string;
}

export function logPlaybackRequest(
  logger: DiagnosticLogger,
  tracker: PlaybackRequestTracker,
  input: PlaybackRequestLogInput,
  observed?: PlaybackClientObservation
): PlaybackClientObservation {
  const observation =
    observed ?? tracker.observe(input.sessionId, input.clientAffinity, input.segmentIndex);
  const context = {
    clientRequest: {
      event: 'playback.request',
      sessionId: input.sessionId,
      clientId: observation.clientId,
      resource: input.resource,
      change: observation.change,
      nodeId: input.nodeId,
      ...(input.segmentIndex === undefined ? {} : { segmentIndex: input.segmentIndex }),
      ...(observation.previousSegmentIndex === undefined
        ? {}
        : { previousSegmentIndex: observation.previousSegmentIndex }),
      ...(observation.segmentDelta === undefined ? {} : { segmentDelta: observation.segmentDelta }),
      ...(observation.idleMs === undefined ? {} : { idleMs: observation.idleMs }),
      ...(input.viewerRegion ? { viewerRegion: input.viewerRegion } : {}),
      ...(input.selectedEdgeNodeId ? { selectedEdgeNodeId: input.selectedEdgeNodeId } : {}),
      ...(input.selectedEdgeRegion ? { selectedEdgeRegion: input.selectedEdgeRegion } : {})
    }
  };
  if (
    ['manifest', 'started', 'resumed', 'seeked-forward', 'seeked-backward'].includes(
      observation.change
    )
  )
    logger.info(context, 'playback client state changed');
  else logger.debug(context, 'playback client request');
  return observation;
}

export function safeRangeHeader(value: string | undefined): string {
  if (value === undefined) return 'none';
  const normalized = value.trim();
  return /^bytes=\d*-\d*$/.test(normalized) && normalized.length <= 80
    ? normalized
    : '[INVALID_RANGE]';
}
