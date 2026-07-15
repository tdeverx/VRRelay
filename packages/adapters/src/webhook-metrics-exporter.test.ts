import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetricsSink } from '@vrrelay/application';
import { WebhookMetricsExporter } from './webhook-metrics-exporter.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function metricsSink(): MetricsSink {
  return {
    contentType: 'text/plain; version=0.0.4',
    increment: vi.fn(),
    gauge: vi.fn(),
    observe: vi.fn(),
    render: vi.fn(async () => 'vrrelay_sessions 2\n')
  };
}

describe('webhook metrics exporter', () => {
  it('checks health and immediately sends an authenticated metrics payload', async () => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ body, headers: new Headers(init?.headers) });
        return body.type === 'health'
          ? Response.json({ healthy: true, message: 'ready' })
          : new Response(null, { status: 204 });
      })
    );
    const exporter = new WebhookMetricsExporter(metricsSink(), {
      endpoint: 'https://metrics.example.test/ingest',
      token: 'metrics-secret',
      intervalMs: 60_000
    });

    await expect(exporter.health()).resolves.toMatchObject({
      category: 'metrics',
      kind: 'webhook',
      healthy: true,
      message: 'ready'
    });
    exporter.start();
    await exporter.stop();

    expect(requests.map(({ body }) => body.type)).toEqual(['health', 'metrics']);
    expect(requests[1]?.body).toMatchObject({
      type: 'metrics',
      contentType: 'text/plain; version=0.0.4',
      payload: 'vrrelay_sessions 2\n'
    });
    expect(requests[1]?.body.timestamp).toEqual(expect.any(String));
    expect(
      requests.every(({ headers }) => headers.get('authorization') === 'Bearer metrics-secret')
    ).toBe(true);
  });

  it('reports the latest push failure until a later delivery succeeds', async () => {
    let failPush = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { type?: string };
        if (body.type === 'health') return Response.json({ healthy: true, message: 'ready' });
        return failPush ? new Response(null, { status: 503 }) : new Response(null, { status: 204 });
      })
    );
    const exporter = new WebhookMetricsExporter(metricsSink(), {
      endpoint: 'https://metrics.example.test/ingest',
      intervalMs: 60_000
    });

    exporter.start();
    await exporter.stop();
    await expect(exporter.health()).resolves.toMatchObject({
      healthy: false,
      message: 'Most recent metrics push failed: Metrics webhook returned HTTP 503'
    });

    failPush = false;
    exporter.start();
    await exporter.stop();
    await expect(exporter.health()).resolves.toMatchObject({ healthy: true, message: 'ready' });
  });
});
