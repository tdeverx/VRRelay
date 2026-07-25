// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveEdgePathManager } from './live-edge-path-manager.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LiveEdgePathManager', () => {
  it('removes stale paths from MediaMTX and reconfigures them on later demand', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00.000Z'));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v3/config/paths/add/live-fixture')) {
        return new Response(null, { status: 200 });
      }
      if (url.includes('/v3/config/paths/delete/live-fixture')) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new LiveEdgePathManager({
      originUrl: 'rtsp://origin.example:8554',
      apiUrl: 'http://mediamtx:9997',
      readToken: 'edge-read-token-fixture',
      staleAfterMs: 1_000,
      cleanupIntervalMs: 60_000
    });

    await manager.ensure('live-fixture');
    vi.setSystemTime(new Date('2026-07-25T00:00:01.001Z'));
    await manager.pruneStale();
    await manager.ensure('live-fixture');

    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/v3/config/paths/add/live-fixture')
      )
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/v3/config/paths/delete/live-fixture')
      )
    ).toHaveLength(1);
    manager.close();
  });

  it('serializes stale deletion with concurrent viewer demand', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00.000Z'));
    const deletion = Promise.withResolvers<Response>();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v3/config/paths/add/live-fixture'))
        return new Response(null, { status: 200 });
      if (url.includes('/v3/config/paths/delete/live-fixture')) return deletion.promise;
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new LiveEdgePathManager({
      originUrl: 'rtsp://origin.example:8554',
      apiUrl: 'http://mediamtx:9997',
      readToken: 'edge-read-token-fixture',
      staleAfterMs: 1_000,
      cleanupIntervalMs: 60_000
    });

    await manager.ensure('live-fixture');
    vi.setSystemTime(new Date('2026-07-25T00:00:01.001Z'));
    const pruning = manager.pruneStale();
    await Promise.resolve();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/v3/config/paths/delete/live-fixture')
      )
    ).toBe(true);
    const firstViewer = manager.ensure('live-fixture');
    const secondViewer = manager.ensure('live-fixture');
    deletion.resolve(new Response(null, { status: 200 }));
    await Promise.all([pruning, firstViewer, secondViewer]);

    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/v3/config/paths/add/live-fixture')
      )
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/v3/config/paths/delete/live-fixture')
      )
    ).toHaveLength(1);
    manager.close();
  });
});
