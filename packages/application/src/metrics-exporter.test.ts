// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { BackendStatus } from '@vrrelay/domain';
import type { MetricsExporter } from './index.js';
import { SwitchableMetricsExporter } from './metrics-exporter.js';

interface ExporterOptions {
  start?: () => void;
  stop?: () => void | Promise<void>;
}

function exporter(kind: string, calls: string[], options: ExporterOptions = {}): MetricsExporter {
  return {
    kind,
    start: () => {
      calls.push(`${kind}:start`);
      options.start?.();
    },
    stop: async () => {
      calls.push(`${kind}:stop`);
      await options.stop?.();
    },
    health: async (): Promise<BackendStatus> => ({
      category: 'metrics',
      kind: 'webhook',
      healthy: true,
      checkedAt: new Date().toISOString()
    })
  };
}

describe('switchable metrics exporter', () => {
  it('keeps the current exporter active when a candidate cannot start', async () => {
    const calls: string[] = [];
    const switchable = new SwitchableMetricsExporter();
    const current = exporter('current', calls);
    const failed = exporter('failed', calls, {
      start: () => {
        throw new Error('start failed');
      }
    });

    await switchable.activate(current);
    await expect(switchable.activate(failed)).rejects.toThrow('start failed');

    expect(switchable.kind).toBe('current');
    expect(calls).toEqual(['current:start', 'failed:start']);
  });

  it('rolls back when the previous exporter cannot stop', async () => {
    const calls: string[] = [];
    let stopAttempts = 0;
    const switchable = new SwitchableMetricsExporter();
    const current = exporter('current', calls, {
      stop: () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error('stop failed');
      }
    });
    const candidate = exporter('candidate', calls);

    await switchable.activate(current);
    await expect(switchable.activate(candidate)).rejects.toThrow('stop failed');

    expect(switchable.kind).toBe('current');
    expect(calls).toEqual([
      'current:start',
      'candidate:start',
      'current:stop',
      'candidate:stop',
      'current:start'
    ]);

    await switchable.stop();
    expect(calls.at(-1)).toBe('current:stop');
  });

  it('publishes a replacement only after it starts and the previous exporter stops', async () => {
    const calls: string[] = [];
    const stopEntered = Promise.withResolvers<void>();
    const stopRelease = Promise.withResolvers<void>();
    const switchable = new SwitchableMetricsExporter();
    const current = exporter('current', calls, {
      stop: async () => {
        stopEntered.resolve();
        await stopRelease.promise;
      }
    });
    const candidate = exporter('candidate', calls);

    await switchable.activate(current);
    const activation = switchable.activate(candidate);
    await stopEntered.promise;

    expect(switchable.kind).toBe('current');
    expect(calls).toEqual(['current:start', 'candidate:start', 'current:stop']);

    stopRelease.resolve();
    await activation;
    expect(switchable.kind).toBe('candidate');

    await switchable.activate();
    expect(switchable.kind).toBe('prometheus');
    expect(calls.at(-1)).toBe('candidate:stop');
  });

  it('shuts down the active exporter once and returns to Prometheus', async () => {
    const calls: string[] = [];
    const switchable = new SwitchableMetricsExporter();
    const current = exporter('current', calls);

    await switchable.activate(current);
    await switchable.stop();
    await switchable.stop();

    expect(switchable.kind).toBe('prometheus');
    expect(calls).toEqual(['current:start', 'current:stop']);
  });

  it('retains the active exporter when shutdown fails so shutdown can be retried', async () => {
    const calls: string[] = [];
    let stopAttempts = 0;
    const switchable = new SwitchableMetricsExporter();
    const current = exporter('current', calls, {
      stop: () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error('shutdown failed');
      }
    });

    await switchable.activate(current);
    await expect(switchable.stop()).rejects.toThrow('shutdown failed');
    expect(switchable.kind).toBe('current');

    await switchable.stop();
    expect(switchable.kind).toBe('prometheus');
    expect(calls).toEqual(['current:start', 'current:stop', 'current:stop']);
  });
});
