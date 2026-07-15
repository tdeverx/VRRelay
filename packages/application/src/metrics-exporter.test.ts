import { describe, expect, it } from 'vitest';
import type { BackendStatus } from '@vrrelay/domain';
import type { MetricsExporter } from './index.js';
import { SwitchableMetricsExporter } from './metrics-exporter.js';

function exporter(
  kind: string,
  calls: string[],
  options: { startError?: Error } = {}
): MetricsExporter {
  return {
    kind,
    start: () => {
      calls.push(`${kind}:start`);
      if (options.startError) throw options.startError;
    },
    stop: async () => {
      calls.push(`${kind}:stop`);
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
  it('starts replacements, stops previous exporters, and returns to Prometheus', async () => {
    const calls: string[] = [];
    const switchable = new SwitchableMetricsExporter();
    const first = exporter('first', calls);
    const second = exporter('second', calls);

    await switchable.activate(first);
    expect(switchable.kind).toBe('first');
    await switchable.activate(second);
    expect(switchable.kind).toBe('second');
    await switchable.activate();
    expect(switchable.kind).toBe('prometheus');
    await switchable.stop();

    expect(calls).toEqual(['first:start', 'second:start', 'first:stop', 'second:stop']);
  });

  it('keeps the current exporter active when a replacement cannot start', async () => {
    const calls: string[] = [];
    const switchable = new SwitchableMetricsExporter();
    const current = exporter('current', calls);
    const failed = exporter('failed', calls, { startError: new Error('start failed') });

    await switchable.activate(current);
    await expect(switchable.activate(failed)).rejects.toThrow('start failed');

    expect(switchable.kind).toBe('current');
    expect(calls).toEqual(['current:start', 'failed:start']);
    await switchable.stop();
    expect(calls).toEqual(['current:start', 'failed:start', 'current:stop']);
  });
});
