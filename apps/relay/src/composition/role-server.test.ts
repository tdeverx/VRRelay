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
      if (url.endsWith('/live-fixture/index.m3u8')) {
        hlsAttempts += 1;
        return new Response(hlsAttempts === 1 ? '' : '#EXTM3U\nsegment.ts\n', {
          status: hlsAttempts === 1 ? 502 : 200
        });
      }
      return new Response('', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const sessions = {
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
    expect(response.payload).toContain('/play/live-token/live/segment.ts');
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/v3/config/paths/add/live-fixture')
      )
    ).toHaveLength(2);
    expect(hlsAttempts).toBe(2);
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
    const live = new LiveService({} as Repository, {
      publicUrl: 'https://relay.example',
      rtmpUrl: 'rtmp://ingest.example/live',
      srtUrl: 'srt://ingest.example:8890',
      whipUrl: 'https://ingest.example',
      hlsUrl: 'https://edge.example',
      internalRtspUrl: 'rtsp://mediamtx:8554',
      allowUnauthenticatedInternalRead: true
    });
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
