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
  authenticate: async () => ({
    accessToken: 'fixture-provider-token',
    userId: 'fixture-user',
    username: 'fixture-user',
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

async function securityFixture(): Promise<SecurityFixture> {
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
  const auth = new AuthService(repository);
  const cluster = new ClusterService(
    repository,
    coordination,
    new BuiltinTrafficDirector(),
    events,
    undefined,
    { metrics }
  );
  const liveCreates: unknown[] = [];
  const live = {
    list: async () => [],
    create: async (input: unknown) => {
      liveCreates.push(input);
      return {
        channel: { id: `live-${liveCreates.length}`, name: 'Fixture live channel' },
        publisher: {}
      };
    },
    replacePublisher: async () => {
      throw new Error('Not used by this fixture');
    },
    delete: async () => {},
    authorizeMediaMtx: async () => false
  };
  const services = {
    repository,
    auth,
    providers: new ProviderService(repository, secrets, registry),
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
    VRRELAY_SETUP_TOKEN: setupToken
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
    payload: { password: adminPassword }
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
  it('enforces remote setup authorization and returns a hardened login cookie', async () => {
    const { app } = await securityFixture();
    const passwordSentinel = 'setup-password-must-not-leak';
    const wrongSetupToken = 'w'.repeat(40);

    const initial = await app.inject({ method: 'GET', url: '/api/v1/setup' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ configured: false, requiresToken: true });

    const missingToken = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { password: passwordSentinel }
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
      payload: { password: passwordSentinel }
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.body).not.toContain(passwordSentinel);

    const authenticated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: adminPassword }
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({
      csrfToken: expect.any(String),
      expiresAt: expect.any(String)
    });
    const setCookie = String(authenticated.headers['set-cookie']);
    expect(setCookie).toMatch(/vrrelay_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Path=\//i);
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
