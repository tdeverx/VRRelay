// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveService,
  type MediaCapabilities,
  type MetricsSink,
  type Repository,
  type SessionService
} from '@vrrelay/application';
import { loadConfig } from '../config.js';
import { createRoleServer } from './role-server.js';

const capabilities: MediaCapabilities = {
  ffmpegVersion: 'test',
  encoders: [],
  muxers: [],
  filters: [],
  pixelFormats: []
};
const metrics: MetricsSink = {
  contentType: 'text/plain',
  increment: () => undefined,
  gauge: () => undefined,
  observe: () => undefined,
  render: async () => ''
};

afterEach(() => vi.unstubAllGlobals());

describe('data-plane role servers', () => {
  it('preserves framework rate-limit responses on dedicated roles', async () => {
    const app = await createRoleServer(loadConfig({ VRRELAY_LOG_LEVEL: 'fatal' }), {
      kind: 'source-worker',
      sessions: {
        capacity: () => ({ active: 0, limit: 1, queued: 0 })
      } as SessionService,
      capabilities,
      metrics
    });
    let response;
    for (let index = 0; index <= 240; index += 1) {
      response = await app.inject({ method: 'GET', url: `/api/v1/health?request=${index}` });
    }

    expect(response?.statusCode).toBe(429);
    expect(response?.json()).toMatchObject({
      error: { code: 'rate_limited', message: 'Too many requests' }
    });
    await app.close();
  });

  it('routes bounded signed edge grants beyond Fastify’s default parameter length', async () => {
    const app = await createRoleServer(loadConfig({ VRRELAY_LOG_LEVEL: 'fatal' }), {
      kind: 'edge',
      sessions: {
        viewerIdentity: async () => 'viewer-fixture',
        touchViewer: async () => ({ id: 'session-fixture' }),
        manifest: async () => '#EXTM3U\n',
        recordEgress: () => undefined
      } as unknown as SessionService,
      capabilities,
      metrics
    });
    const response = await app.inject({
      method: 'GET',
      url: `/play/${'g'.repeat(512)}/index.m3u8`
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe('#EXTM3U\n');
    await app.close();
  });

  it('registers only the source-worker HTTP surface', async () => {
    const app = await createRoleServer(loadConfig({}), {
      kind: 'source-worker',
      sessions: {} as SessionService,
      capabilities,
      metrics
    });
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: '/internal/source/:token' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/internal/mediamtx/auth' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/play/:token/index.m3u8' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/providers' })).toBe(false);
    await app.close();
  });

  it('reports role dependency readiness independently from liveness', async () => {
    const app = await createRoleServer(loadConfig({}), {
      kind: 'source-worker',
      sessions: { capacity: () => ({ active: 1, limit: 2, queued: 0 }) } as SessionService,
      capabilities,
      metrics,
      readiness: async () => [
        {
          category: 'coordination',
          kind: 'controller-agent',
          healthy: false,
          checkedAt: '2026-07-25T00:00:00.000Z'
        }
      ]
    });

    await expect(app.inject({ method: 'GET', url: '/api/v1/health' })).resolves.toMatchObject({
      statusCode: 200
    });
    const readiness = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      status: 'degraded',
      workers: { active: 1, limit: 2, queued: 0 },
      dependencies: [{ kind: 'controller-agent', healthy: false }]
    });
    await app.close();
  });

  it('registers only the ingest-origin HTTP surface', async () => {
    const app = await createRoleServer(loadConfig({}), {
      kind: 'ingest-origin',
      live: {} as LiveService,
      capabilities,
      metrics
    });
    await app.ready();
    expect(app.hasRoute({ method: 'POST', url: '/internal/mediamtx/auth' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/internal/source/:token' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/play/:token/index.m3u8' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/providers' })).toBe(false);
    await app.close();
  });

  it('registers only the edge playback HTTP surface', async () => {
    const app = await createRoleServer(loadConfig({}), {
      kind: 'edge',
      sessions: {} as SessionService,
      capabilities,
      metrics
    });
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: '/play/:token/index.m3u8' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/internal/source/:token' })).toBe(false);
    expect(app.hasRoute({ method: 'POST', url: '/internal/mediamtx/auth' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/providers' })).toBe(false);
    await app.close();
  });

  it('allows only authenticated read/playback callbacks on an edge', async () => {
    const readToken = 'edge-read-token-fixture';
    const app = await createRoleServer(loadConfig({ VRRELAY_MEDIAMTX_READ_TOKEN: readToken }), {
      kind: 'edge',
      sessions: {} as SessionService,
      capabilities,
      metrics
    });
    const request = (payload: Record<string, string>, remoteAddress = '10.20.30.40') =>
      app.inject({
        method: 'POST',
        url: '/internal/mediamtx/auth',
        remoteAddress,
        payload: { path: 'live-fixture', ...payload }
      });

    await expect(
      request({ action: 'read', user: 'vrrelay-read', password: readToken })
    ).resolves.toMatchObject({ statusCode: 204 });
    await expect(
      request({ action: 'playback', user: 'vrrelay-read', token: readToken }, '127.0.0.2')
    ).resolves.toMatchObject({ statusCode: 204 });
    await expect(
      request({ action: 'publish', user: 'vrrelay-read', password: readToken })
    ).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      request({ action: 'read', user: 'vrrelay-read', password: 'wrong-token-value' })
    ).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      request({ action: 'read', user: 'vrrelay-read', password: readToken }, '203.0.113.40')
    ).resolves.toMatchObject({ statusCode: 403 });
    await app.close();
  });

  it('retries a live edge request after reconfiguring a failed origin path', async () => {
    let hlsAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v3/config/paths/add/live-fixture'))
        return new Response(null, { status: 200 });
      if (url.includes('/v3/config/paths/delete/live-fixture'))
        return new Response(null, { status: 200 });
      if (url.endsWith('/live-fixture/index.m3u8')) {
        hlsAttempts += 1;
        return new Response(hlsAttempts === 1 ? '' : '#EXTM3U\nsegment.ts\n', {
          status: hlsAttempts === 1 ? 502 : 200
        });
      }
      if (url.endsWith('/live-fixture/segment.ts'))
        return new Response('live-segment', {
          status: 200,
          headers: {
            'content-type': 'video/mp2t',
            'cache-control': 'public, max-age=31536000, immutable'
          }
        });
      return new Response('', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const sessions = {
      viewerIdentity: async () => 'viewer-fixture',
      touchViewer: async () => ({ id: 'live-session' }),
      resolveLive: async () => ({ path: 'live-fixture' }),
      recordEgress: () => undefined
    } as unknown as SessionService;
    const app = await createRoleServer(
      loadConfig({ VRRELAY_LIVE_ORIGIN_URL: 'rtsp://origin.example:8554' }),
      {
        kind: 'edge',
        sessions,
        capabilities,
        metrics
      }
    );

    const response = await app.inject({ method: 'GET', url: '/play/live-token/live.m3u8' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.payload).toContain('/play/live-token/live/segment.ts');
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
    expect(hlsAttempts).toBe(2);
    const segment = await app.inject({
      method: 'GET',
      url: '/play/live-token/live/segment.ts'
    });
    expect(segment.statusCode).toBe(200);
    expect(segment.headers['cache-control']).toBe('private, no-store');
    await app.close();
  });

  it('coalesces concurrent live edge path setup across viewers', async () => {
    let releaseAdd!: () => void;
    const addGate = new Promise<Response>((resolve) => {
      releaseAdd = () => resolve(new Response(null, { status: 200 }));
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v3/config/paths/add/live-fixture')) return addGate;
      if (url.endsWith('/live-fixture/index.m3u8'))
        return new Response('#EXTM3U\nsegment.ts\n', { status: 200 });
      return new Response('', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const sessions = {
      viewerIdentity: async () => 'viewer-fixture',
      touchViewer: async () => ({ id: 'live-session' }),
      resolveLive: async () => ({ path: 'live-fixture' }),
      recordEgress: () => undefined
    } as unknown as SessionService;
    const app = await createRoleServer(
      loadConfig({ VRRELAY_LIVE_ORIGIN_URL: 'rtsp://origin.example:8554' }),
      {
        kind: 'edge',
        sessions,
        capabilities,
        metrics
      }
    );

    const first = app.inject({ method: 'GET', url: '/play/live-token-a/live.m3u8' });
    const second = app.inject({ method: 'GET', url: '/play/live-token-b/live.m3u8' });
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes('/v3/config/paths/add/live-fixture')
        )
      ).toHaveLength(1)
    );
    releaseAdd();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ statusCode: 200 }),
      expect.objectContaining({ statusCode: 200 })
    ]);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/v3/config/paths/add/live-fixture')
      )
    ).toHaveLength(1);
    await app.close();
  });

  it('limits credential-free ingest reads to RTSP callbacks', async () => {
    const readToken = 'ingest-read-token-fixture';
    const live = new LiveService(
      {
        listLiveChannels: async () => [
          {
            id: 'live-channel-fixture',
            name: 'Live fixture',
            path: 'live-normalized',
            ingestPath: 'live-fixture',
            normalize: true,
            publisherState: 'online',
            publishTokenHash: 'not-a-real-token',
            rtmpUrl: 'rtmp://relay.example/live-fixture',
            srtUrl: 'srt://relay.example:8890?streamid=publish:live-fixture',
            whipUrl: 'https://relay.example/live-fixture/whip',
            createdAt: '2026-07-25T00:00:00.000Z'
          }
        ]
      } as unknown as Repository,
      {
        publicUrl: 'https://relay.example',
        rtmpUrl: 'rtmp://ingest.example/live',
        srtUrl: 'srt://ingest.example:8890',
        whipUrl: 'https://ingest.example',
        hlsUrl: 'https://edge.example',
        internalRtspUrl: 'rtsp://mediamtx:8554',
        allowUnauthenticatedInternalRead: true
      }
    );
    const app = await createRoleServer(loadConfig({ VRRELAY_MEDIAMTX_READ_TOKEN: readToken }), {
      kind: 'ingest-origin',
      live,
      capabilities,
      metrics
    });
    const request = (payload: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/internal/mediamtx/auth',
        remoteAddress: '10.20.30.40',
        payload: { path: 'live-fixture', ...payload }
      });

    await expect(request({ action: 'read', protocol: 'rtsp' })).resolves.toMatchObject({
      statusCode: 204
    });
    await expect(request({ action: 'playback', protocol: 'rtsp' })).resolves.toMatchObject({
      statusCode: 204
    });
    await expect(request({ action: 'read', protocol: 'hls' })).resolves.toMatchObject({
      statusCode: 401
    });
    await expect(request({ action: 'read', protocol: 'rtmp' })).resolves.toMatchObject({
      statusCode: 401
    });
    await expect(request({ action: 'read' })).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      app.inject({
        method: 'POST',
        url: '/internal/mediamtx/auth',
        remoteAddress: '10.20.30.40',
        payload: { action: 'read', protocol: 'rtsp', path: 'another-private-path' }
      })
    ).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      request({
        action: 'read',
        protocol: 'hls',
        user: 'vrrelay-read',
        password: readToken
      })
    ).resolves.toMatchObject({ statusCode: 204 });
    await app.close();
  });

  it('restricts MediaMTX auth to loopback and internal-network peers', async () => {
    let authorizationCalls = 0;
    const live = {
      authorizeMediaMtx: async () => {
        authorizationCalls += 1;
        return true;
      }
    } as unknown as LiveService;
    const app = await createRoleServer(loadConfig({}), {
      kind: 'ingest-origin',
      live,
      capabilities,
      metrics
    });
    const remote = await app.inject({
      method: 'POST',
      url: '/internal/mediamtx/auth',
      remoteAddress: '203.0.113.40',
      payload: { action: 'publish', path: 'live-fixture' }
    });
    expect(remote.statusCode).toBe(403);
    expect(authorizationCalls).toBe(0);

    const internal = await app.inject({
      method: 'POST',
      url: '/internal/mediamtx/auth',
      remoteAddress: '10.20.30.40',
      payload: { action: 'publish', path: 'live-fixture' }
    });
    expect(internal.statusCode).toBe(204);
    expect(authorizationCalls).toBe(1);

    const loopback = await app.inject({
      method: 'POST',
      url: '/internal/mediamtx/auth',
      remoteAddress: '127.0.0.2',
      payload: { action: 'publish', path: 'live-fixture' }
    });
    expect(loopback.statusCode).toBe(204);
    expect(authorizationCalls).toBe(2);
    await app.close();
  });
});
