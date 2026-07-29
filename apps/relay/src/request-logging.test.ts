// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { PlaybackRequestTracker, logPlaybackRequest, safeRangeHeader } from './request-logging.js';

describe('playback request diagnostics', () => {
  it('confirms a consecutive playback window before identifying a seek', () => {
    const tracker = new PlaybackRequestTracker();
    expect(tracker.observe('session-a', 'private-affinity', 4, 1_000)).toMatchObject({
      change: 'started'
    });
    expect(tracker.observe('session-a', 'private-affinity', 5, 2_000)).toMatchObject({
      change: 'advanced',
      previousSegmentIndex: 4,
      segmentDelta: 1
    });
    expect(tracker.observe('session-a', 'private-affinity', 5, 3_000)).toMatchObject({
      change: 'retry'
    });
    expect(tracker.observe('session-a', 'private-affinity', 20, 4_000)).toMatchObject({
      change: 'reordered',
      segmentDelta: 15
    });
    expect(tracker.observe('session-a', 'private-affinity', 21, 4_100)).toMatchObject({
      change: 'seeked-forward',
      segmentDelta: 1
    });
    expect(tracker.observe('session-a', 'private-affinity', 3, 5_000)).toMatchObject({
      change: 'reordered',
      segmentDelta: -18
    });
    expect(tracker.observe('session-a', 'private-affinity', 2, 5_100)).toMatchObject({
      change: 'seeked-backward',
      segmentDelta: -1
    });
    expect(tracker.observe('session-a', 'private-affinity', 4, 40_001)).toMatchObject({
      change: 'resumed'
    });
    expect(
      JSON.stringify(tracker.observe('session-a', 'private-affinity', 5, 41_000))
    ).not.toContain('private-affinity');
  });

  it('does not mistake interleaved HLS prefetches for seeks', () => {
    const tracker = new PlaybackRequestTracker();
    const changes = [
      tracker.observe('session-a', 'private-affinity', 0, 1_000).change,
      tracker.observe('session-a', 'private-affinity', 24, 1_100).change,
      tracker.observe('session-a', 'private-affinity', 0, 1_200).change,
      tracker.observe('session-a', 'private-affinity', 25, 1_300).change,
      tracker.observe('session-a', 'private-affinity', 1, 1_400).change,
      tracker.observe('session-a', 'private-affinity', 26, 1_500).change
    ];

    expect(changes).not.toContain('seeked-forward');
    expect(changes).not.toContain('seeked-backward');
  });

  it('keeps sustained sequential HLS playback classified as ordinary advancement', () => {
    const tracker = new PlaybackRequestTracker();
    const changes = Array.from({ length: 100 }, (_, segmentIndex) =>
      tracker.observe('session-a', 'private-affinity', segmentIndex, 1_000 + segmentIndex * 4_000)
    );

    expect(changes[0]).toMatchObject({ change: 'started' });
    expect(changes.slice(1).every((observation) => observation.change === 'advanced')).toBe(true);
    expect(
      changes.some(
        (observation) =>
          observation.change === 'seeked-forward' || observation.change === 'seeked-backward'
      )
    ).toBe(false);
  });

  it('logs state changes at info and ordinary segment traffic at debug', () => {
    const logger = { info: vi.fn(), debug: vi.fn() };
    const tracker = new PlaybackRequestTracker();
    logPlaybackRequest(logger, tracker, {
      sessionId: 'session-a',
      clientAffinity: 'private-affinity',
      resource: 'segment',
      nodeId: 'edge-london',
      segmentIndex: 2
    });
    logPlaybackRequest(logger, tracker, {
      sessionId: 'session-a',
      clientAffinity: 'private-affinity',
      resource: 'segment',
      nodeId: 'edge-london',
      segmentIndex: 3
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('private-affinity');
  });

  it('only retains bounded valid byte ranges', () => {
    expect(safeRangeHeader('bytes=0-')).toBe('bytes=0-');
    expect(safeRangeHeader('bytes=100-200')).toBe('bytes=100-200');
    expect(safeRangeHeader(undefined)).toBe('none');
    expect(safeRangeHeader('bytes=0-1,4-5')).toBe('[INVALID_RANGE]');
    expect(safeRangeHeader('Bearer secret')).toBe('[INVALID_RANGE]');
  });
});
