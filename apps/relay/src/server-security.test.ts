// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AuditService,
  BuiltinTrafficDirector,
  ClusterService,
  DefaultProviderRegistry,
  InMemoryEventBus,
  LiveService,
  ProfileService,
  ProviderService,
  SessionService,
  type MediaProvider,
  type Transcoder
} from '@vrrelay/application';
import {
  LocalObjectStore,
  MemoryCoordinationStore,
  MemorySecretStore,
  PrometheusMetricsSink,
  SqliteRepository
} from '@vrrelay/adapters';
import { AuthService } from './auth.js';
import { loadConfig } from './config.js';
import { createServer, type ServerServices } from './server.js';

const setupToken = 's'.repeat(40);
const adminPassword = 'correct horse battery staple';
const capabilities = {
  ffmpegVersion: 'fixture',
  encoders: [{ name: 'libx264', codec: 'h264', hardware: false, available: true }],
  muxers: ['mpegts'],
  filters: [],
  pixelFormats: ['yuv420p']
};

const provider: MediaProvider = {
  type: 'jellyfin',
  capabilities: ['search', 'direct_source'],
  authenticate: async (_baseUrl, credentials) => ({
    accessToken: 'fixture-provider-token',
    userId: credentials.username ?? 'fixture-user',
    username: credentials.username ?? 'fixture-user',
    serverName: 'Fixture',
    serverVersion: '1.0.0'
  }),
  validate: async () => {},
  browse: async () => ({ items: [], total: 0 }),
  item: async (connection, _secret, id) => ({
    id,
    providerId: connection.id,
    name: 'Finite fixture',
    kind: 'Movie',
    durationSeconds: 10
  }),
  resolveSource: async () => ({
    url: 'https://source.example.test/fixture',
    headers: {},
    durationSeconds: 10,
    fingerprint: 'fixture-v1'
  }),
  openSource: async () => {
    throw new Error('Source streaming is outside this HTTP security fixture');
  },
  reportPlayback: async () => {}
};

const transcoder: Transcoder = {
  discover: async () => capabilities,
  generateSegment: async () => {},
  streamFragmentedMp4: async () => {}
};

interface SecurityFixture {
  app: FastifyInstance;
  auth: AuthService;
  repository: SqliteRepository;
  sessions: SessionService;
  liveCreates: unknown[];
  close(): Promise<void>;
}

const fixtures: SecurityFixture[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function securityFixture(environment: NodeJS.ProcessEnv = {}): Promise<SecurityFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'vrrelay-http-security-'));
  const repository = new SqliteRepository(join(directory, 'state.sqlite'));
  await repository.migrate();

  const secrets = new MemorySecretStore();
  const registry = new DefaultProviderRegistry();
  registry.register(provider);
  const now = new Date().toISOString();
  await repository.createProvider({
    id: 'provider-http-security',
    type: 'jellyfin',
    name: 'HTTP security fixture',
    baseUrl: 'https://media.example.test',
    authMode: 'user_token',
    secretRef: 'provider:http-security',
    capabilities: [...provider.capabilities],
    healthy: true,
    createdAt: now,
    updatedAt: now
  });
  await secrets.put('provider:http-security', 'fixture-provider-token');

  const profiles = new ProfileService(repository);
  await profiles.seed(capabilities);
  const events = new InMemoryEventBus();
  const coordination = new MemoryCoordinationStore();
  const metrics = new PrometheusMetricsSink({ node: 'http-security' });
  const objectStore = new LocalObjectStore(join(directory, 'objects'));
  const sessions = new SessionService(
    repository,
    secrets,
    registry,
    transcoder,
    events,
    {
      publicUrl: 'https://play.example.test',
      internalUrl: 'http://127.0.0.1:8099',
      cacheDir: join(directory, 'cache'),
      cacheTtlMs: 60_000,
      maxWorkers: 1,
      nodeId: 'standalone',
      roles: ['controller', 'source-worker', 'ingest-origin', 'edge']
    },
    { objectStore, coordination, clusterRepository: repository, metrics }
  );
  const providerService = new ProviderService(repository, secrets, registry);
  const auth = new AuthService(repository, secrets, providerService);
  const cluster = new ClusterService(
    repository,
    coordination,
    new BuiltinTrafficDirector(),
    events,
    undefined,
    { metrics }
  );
  const liveCreates: unknown[] = [];
  const live = new LiveService(
    repository,
    {
      publicUrl: 'https://play.example.test',
      rtmpUrl: 'rtmp://live.example.test/live',
      srtUrl: 'srt://live.example.test:8890',
      whipUrl: 'https://live.example.test',
      hlsUrl: 'https://live.example.test',
      internalRtspUrl: 'rtsp://127.0.0.1:8554'
    },
    undefined,
    events,
    repository,
    metrics
  );
  const createLive = live.create.bind(live);
  vi.spyOn(live, 'create').mockImplementation(async (input, context) => {
    liveCreates.push({ input, context });
    return createLive(input, context);
  });
  const services = {
    repository,
    auth,
    providers: providerService,
    profiles,
    sessions,
    live,
    events,
    capabilities,
    cluster,
    objectStore,
    coordination,
    metrics,
    audit: new AuditService(repository),
    backends: {
      list: async () => ({ restartRequired: false, items: [] })
    }
  } as unknown as ServerServices;
  const config = loadConfig({
    VRRELAY_PUBLIC_URL: 'https://relay.example.test',
    VRRELAY_ADMIN_URL: 'https://admin.example.test',
    VRRELAY_PLAYBACK_URL: 'https://play.example.test',
    VRRELAY_SETUP_TOKEN: setupToken,
    ...environment
  });
  const app = await createServer(config, services, 'standalone');
  const fixture: SecurityFixture = {
    app,
    auth,
    repository,
    sessions,
    liveCreates,
    close: async () => {
      await app.close();
      repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  fixtures.push(fixture);
  return fixture;
}

function cookieFrom(response: {
  headers: Record<string, string | string[] | number | undefined>;
}): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') throw new Error('Login response did not set a session cookie');
  return value.split(';', 1)[0]!;
}

async function login(app: FastifyInstance): Promise<{ cookie: string; csrfToken: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { method: 'recovery', password: adminPassword }
  });
  expect(response.statusCode).toBe(200);
  return { cookie: cookieFrom(response), csrfToken: response.json().csrfToken as string };
}

async function jellyfinLogin(
  app: FastifyInstance,
  username: string
): Promise<{ cookie: string; csrfToken: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { method: 'jellyfin', username, password: 'provider-password' }
  });
  expect(response.statusCode).toBe(200);
  return { cookie: cookieFrom(response), csrfToken: response.json().csrfToken as string };
}

async function createVodSession(sessions: SessionService, playbackTtlSeconds: number | null) {
  const session = await sessions.create({
    kind: 'vod',
    name: 'HTTP playback fixture',
    source: { providerId: 'provider-http-security', itemId: 'fixture-movie' },
    profileId: 'universal-h264-hls-vod',
    profileRevision: 1,
    platformMode: 'universal',
    pinned: false,
    reportActivity: false,
    placementPolicy: 'local',
    placementLocked: false,
    playbackTtlSeconds
  });
  const primaryUrl = session.outputUrls.primary;
  if (!primaryUrl) throw new Error('VOD session did not return a primary playback URL');
  const token = new URL(primaryUrl).pathname.split('/play/')[1]!.split('/')[0]!;
  return { session, token };
}

describe('HTTP authentication boundary', () => {
  it('keeps runtime configuration redacted, admin-only, CSRF-protected, and deployment-aware', async () => {
    const { app, auth } = await securityFixture();
    await auth.initialize(adminPassword);
    const admin = await login(app);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/configuration/runtime' })).statusCode
    ).toBe(401);

    const visible = await app.inject({
      method: 'GET',
      url: '/api/v1/configuration/runtime',
      headers: { cookie: admin.cookie }
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toMatchObject({ writable: false, restartSupported: false });
    expect(visible.body).not.toContain(setupToken);

    const payload = visible.json().configuration;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/configuration/runtime',
          headers: { cookie: admin.cookie },
          payload
        })
      ).statusCode
    ).toBe(401);
    const readOnly = await app.inject({
      method: 'PUT',
      url: '/api/v1/configuration/runtime',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload
    });
    expect(readOnly.statusCode).toBe(409);
    expect(readOnly.json()).toMatchObject({ error: { code: 'configuration_read_only' } });
  });

  it('enforces remote setup authorization and returns a hardened login cookie', async () => {
    const { app } = await securityFixture({
      VRRELAY_TRUSTED_PROXY_CIDRS: '127.0.0.0/8'
    });
    const passwordSentinel = 'setup-password-must-not-leak';
    const wrongSetupToken = 'w'.repeat(40);

    const initial = await app.inject({ method: 'GET', url: '/api/v1/setup' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ configured: false, requiresToken: true });

    const missingToken = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { method: 'recovery', password: passwordSentinel }
    });
    expect(missingToken.statusCode).toBe(401);
    expect(missingToken.body).not.toContain(passwordSentinel);

    const wrongToken = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { password: passwordSentinel, setupToken: wrongSetupToken }
    });
    expect(wrongToken.statusCode).toBe(401);
    expect(wrongToken.body).not.toContain(wrongSetupToken);
    expect(wrongToken.body).not.toContain(passwordSentinel);

    const configured = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { password: adminPassword, setupToken }
    });
    expect(configured.statusCode).toBe(201);
    expect(configured.json()).toEqual({ configured: true, requiresToken: false });
    expect((await app.inject({ method: 'GET', url: '/api/v1/setup' })).json()).toEqual({
      configured: true,
      requiresToken: false
    });

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { method: 'recovery', password: passwordSentinel }
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.body).not.toContain(passwordSentinel);

    const authenticated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { method: 'recovery', password: adminPassword }
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({
      csrfToken: expect.any(String),
      expiresAt: expect.any(String)
    });
    const setCookie = String(authenticated.headers['set-cookie']);
    expect(setCookie).toMatch(/vrrelay_session=/);
    expect(setCookie).toMatch(/vrrelay_csrf=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).not.toMatch(/Secure/i);
    expect(setCookie).toMatch(/Path=\//i);
    const setCookies = Array.isArray(authenticated.headers['set-cookie'])
      ? authenticated.headers['set-cookie']
      : [authenticated.headers['set-cookie']];
    const csrfCookie = setCookies.find((cookie) => String(cookie).startsWith('vrrelay_csrf='));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toMatch(/HttpOnly/i);
    expect(csrfCookie).toMatch(/SameSite=Strict/i);
    expect(csrfCookie).not.toMatch(/Secure/i);

    const proxiedHttps = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { method: 'recovery', password: adminPassword }
    });
    expect(proxiedHttps.statusCode).toBe(200);
    expect(String(proxiedHttps.headers['set-cookie'])).toMatch(/Secure/i);
  });

  it('enforces browser CSRF and PAT scopes, expiry, and revocation at route level', async () => {
    const { app, auth, liveCreates } = await securityFixture();
    await auth.initialize(adminPassword);
    const admin = await login(app);

    for (const csrfToken of [undefined, 'incorrect-csrf-token']) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/v1/live-channels',
        headers: {
          cookie: admin.cookie,
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {})
        },
        payload: { name: 'Rejected browser mutation' }
      });
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json()).toMatchObject({ error: { code: 'unauthorized' } });
    }

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/live-channels',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { name: 'Accepted browser mutation' }
    });
    expect(accepted.statusCode).toBe(201);

    const readToken = await auth.createPersonalToken('Read only', ['sessions:read'], null);
    const readHeaders = { authorization: `Bearer ${readToken.token}` };
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/profiles', headers: readHeaders }))
        .statusCode
    ).toBe(200);
    const wrongScope = await app.inject({
      method: 'POST',
      url: '/api/v1/live-channels',
      headers: readHeaders,
      payload: { name: 'Wrong PAT scope' }
    });
    expect(wrongScope.statusCode).toBe(401);
    expect(wrongScope.json()).toMatchObject({ error: { code: 'unauthorized' } });

    const createToken = await auth.createPersonalToken('Create live', ['sessions:create'], null);
    const patMutation = await app.inject({
      method: 'POST',
      url: '/api/v1/live-channels',
      headers: { authorization: `Bearer ${createToken.token}` },
      payload: { name: 'PAT mutation without CSRF' }
    });
    expect(patMutation.statusCode).toBe(201);

    const expiredToken = await auth.createPersonalToken(
      'Expired',
      ['sessions:read'],
      new Date(Date.now() - 1_000).toISOString()
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/profiles',
          headers: { authorization: `Bearer ${expiredToken.token}` }
        })
      ).statusCode
    ).toBe(401);

    await auth.revokePersonalToken(readToken.id);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/profiles', headers: readHeaders }))
        .statusCode
    ).toBe(401);
    expect(liveCreates).toHaveLength(2);
  });

  it('rejects malformed JSON and schema-invalid secret-bearing requests without reflection', async () => {
    const { app, auth } = await securityFixture();
    const adminToken = await auth.createPersonalToken('HTTP test admin', ['admin'], null);
    const authorization = `Bearer ${adminToken.token}`;
    const secretSentinel = 'api-key-sentinel-must-not-leak';

    const invalidSchema = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization },
      payload: {
        type: 'jellyfin',
        name: 'Invalid provider',
        baseUrl: 'not-a-url',
        authMode: 'api_key',
        apiKey: secretSentinel
      }
    });
    expect(invalidSchema.statusCode).toBe(400);
    expect(invalidSchema.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(invalidSchema.body).not.toContain(secretSentinel);

    const malformedJson = await app.inject({
      method: 'POST',
      url: '/api/v1/live-channels',
      headers: { authorization, 'content-type': 'application/json' },
      payload: `{"name":"${secretSentinel}"`
    });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(malformedJson.body).not.toContain(secretSentinel);
  });
});

describe('unified Jellyfin user experience', () => {
  it('isolates user sessions, enforces CSRF, and keeps created playback links valid after logout', async () => {
    const { app, auth } = await securityFixture();
    await auth.initialize(adminPassword);
    const admin = await login(app);
    const adminHeaders = { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken };

    const createdProvider = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: adminHeaders,
      payload: {
        type: 'jellyfin',
        name: 'User Jellyfin',
        baseUrl: 'http://127.0.0.1:8096',
        authMode: 'delegated',
        allowPublicHttp: false
      }
    });
    expect(createdProvider.statusCode).toBe(201);
    const providerId = createdProvider.json().id as string;

    const configuration = {
      providerId,
      defaultProfileId: 'universal-h264-hls-vod',
      allowedProfileIds: ['universal-h264-hls-vod', 'h264-live-hls'],
      reportPlaybackActivity: false
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/auth/configuration',
          headers: adminHeaders,
          payload: configuration
        })
      ).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/configuration/status' })).json()
    ).toMatchObject({
      configured: true,
      providerName: 'User Jellyfin'
    });

    const alice = await jellyfinLogin(app, 'alice');
    const createPayload = {
      kind: 'vod',
      source: { providerId, itemId: 'movie-alice' },
      profileId: 'universal-h264-hls-vod',
      profileRevision: 1,
      platformMode: 'universal',
      pinned: false,
      reportActivity: true,
      placementPolicy: 'local',
      placementLocked: true,
      playbackTtlSeconds: null
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/sessions',
          headers: { cookie: alice.cookie },
          payload: createPayload
        })
      ).statusCode
    ).toBe(401);
    const createdSession = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrfToken },
      payload: createPayload
    });
    expect(createdSession.statusCode).toBe(201);
    const session = createdSession.json();
    expect(session.reportActivity).toBe(false);

    const bob = await jellyfinLogin(app, 'bob');
    const bobSessions = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { cookie: bob.cookie }
    });
    expect(bobSessions.json()).toEqual({ items: [], runtime: [] });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/sessions/${session.id}`,
          headers: { cookie: bob.cookie, 'x-csrf-token': bob.csrfToken }
        })
      ).statusCode
    ).toBe(404);

    const aliceChannel = await app.inject({
      method: 'POST',
      url: '/api/v1/live-channels',
      headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrfToken },
      payload: { name: 'Alice OBS' }
    });
    expect(aliceChannel.statusCode).toBe(201);
    expect(aliceChannel.json().channel).not.toHaveProperty('ownerId');
    const channelId = aliceChannel.json().channel.id as string;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/live-channels',
          headers: { cookie: bob.cookie }
        })
      ).json()
    ).toEqual({ items: [] });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/live-channels/${channelId}/publisher/replacement`,
          headers: { cookie: bob.cookie, 'x-csrf-token': bob.csrfToken }
        })
      ).statusCode
    ).toBe(404);
    const livePlayback = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrfToken },
      payload: {
        kind: 'live',
        name: 'Alice live playback',
        liveChannelId: channelId,
        profileId: 'h264-live-hls',
        profileRevision: 1,
        platformMode: 'universal',
        pinned: true,
        reportActivity: false,
        placementPolicy: 'local',
        placementLocked: true,
        playbackTtlSeconds: null
      }
    });
    expect(livePlayback.statusCode).toBe(201);
    expect(livePlayback.json()).toMatchObject({
      ownerId: expect.any(String),
      liveChannelId: channelId
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/live-channels',
          headers: { cookie: admin.cookie }
        })
      ).json().items
    ).toHaveLength(1);

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/logout',
          headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrfToken }
        })
      ).statusCode
    ).toBe(204);
    const playbackPath = new URL(session.outputUrls.primary).pathname;
    const manifest = await app.inject({ method: 'GET', url: playbackPath });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.body).toContain('#EXT-X-ENDLIST');
  });
});

describe('HTTP playback-grant boundary', () => {
  it('accepts valid grants and rejects tampered, revoked, and expired grants without reflection', async () => {
    const { app, sessions } = await securityFixture();
    const valid = await createVodSession(sessions, null);
    const expiring = await createVodSession(sessions, 60);

    const manifest = await app.inject({
      method: 'GET',
      url: `/play/${valid.token}/index.m3u8`,
      headers: { 'user-agent': 'HTTP security fixture' }
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['cache-control']).toBe('no-store');
    expect(manifest.body).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(manifest.body).toContain('#EXT-X-ENDLIST');

    const edgeGrant = await sessions.createEdgePlaybackGrant(valid.token, 'edge-a');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/play/${edgeGrant}/index.m3u8`,
          headers: { 'user-agent': 'HTTP security fixture' }
        })
      ).statusCode
    ).toBe(200);

    const tamperedGrant = `${edgeGrant.slice(0, -1)}${edgeGrant.endsWith('a') ? 'b' : 'a'}`;
    const tampered = await app.inject({
      method: 'GET',
      url: `/play/${tamperedGrant}/index.m3u8`
    });
    expect(tampered.statusCode).toBe(401);
    expect(tampered.body).not.toContain(tamperedGrant);

    await sessions.delete(valid.session.id);
    const revoked = await app.inject({
      method: 'GET',
      url: `/play/${edgeGrant}/index.m3u8`
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.body).not.toContain(edgeGrant);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    const expired = await app.inject({
      method: 'GET',
      url: `/play/${expiring.token}/index.m3u8`
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.body).not.toContain(expiring.token);
  });
});
