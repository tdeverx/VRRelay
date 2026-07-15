// SPDX-License-Identifier: GPL-3.0-or-later
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { z, type ZodType } from 'zod';
import {
  ApplicationError,
  type EventBus,
  type MediaCapabilities,
  type Repository,
  type ObjectStore,
  type CoordinationStore,
  type MetricsSink,
  ClusterService,
  LiveService,
  ProfileService,
  ProviderService,
  SessionService
} from '@vrrelay/application';
import {
  CatalogQuerySchema,
  CreateCompatibilityResultRequestSchema,
  CreateLiveChannelRequestSchema,
  CreatePersonalTokenRequestSchema,
  CreateProfileRevisionRequestSchema,
  CreateProviderRequestSchema,
  CreateSessionRequestSchema,
  FirstRunRequestSchema,
  LoginRequestSchema,
  CreateNodeJoinTokenRequestSchema,
  EnrollNodeRequestSchema,
  NodeDrainRequestSchema,
  PlacementPreviewRequestSchema,
  SessionControlRequestSchema,
  CreateProviderBindingRequestSchema,
  RotateNodeCertificateRequestSchema,
  CacheEvictionRequestSchema,
  BackendValidationRequestSchema,
  BackendActivationRequestSchema
} from '@vrrelay/contracts';
import { validateProviderUrl } from '@vrrelay/adapters';
import { requiresSetupToken, type RelayConfig } from './config.js';
import { publicProviderBinding } from '@vrrelay/domain';
import { AuthService } from './auth.js';
import type { AgentController } from './agent-transport.js';
import type { BackendService } from './backend-service.js';

export interface ServerServices {
  repository: Repository;
  auth: AuthService;
  providers: ProviderService;
  profiles: ProfileService;
  sessions: SessionService;
  live: LiveService;
  events: EventBus;
  capabilities: MediaCapabilities;
  cluster: ClusterService;
  objectStore: ObjectStore;
  coordination: CoordinationStore;
  metrics: MetricsSink;
  backends: BackendService;
  agentController?: AgentController;
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function tokenFromPath(request: FastifyRequest): string {
  return (request.params as { token: string }).token;
}

function viewerIdentity(request: FastifyRequest): string {
  return `${request.ip}|${String(request.headers['user-agent'] ?? 'unknown').slice(0, 256)}`;
}

export function payloadMeter(record: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: unknown, _encoding, callback) {
      if (typeof chunk === 'string') {
        record(Buffer.byteLength(chunk));
        callback(null, chunk);
        return;
      }
      if (Buffer.isBuffer(chunk)) {
        record(chunk.length);
        callback(null, chunk);
        return;
      }
      if (ArrayBuffer.isView(chunk)) {
        record(chunk.byteLength);
        callback(null, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        return;
      }
      callback(new TypeError('Media streams must contain string or binary chunks'));
    }
  });
}

export function meteredReadable(source: Readable, record: (bytes: number) => void): Readable {
  const meter = payloadMeter(record);
  source.once('error', (error) => meter.destroy(error));
  return source.pipe(meter);
}

export function redactRequestUrl(url: string): string {
  return url
    .replace(/(\/play\/)[^/?]+/g, '$1[REDACTED]')
    .replace(/(\/internal\/source\/)[^/?]+/g, '$1[REDACTED]');
}

export function liveOriginSourceUrl(
  baseUrl: string,
  path: string,
  readToken: string,
  srtPassphrase?: string
): string {
  if (!/^live-[A-Za-z0-9_-]+$/.test(path)) throw new Error('Invalid live path');
  if (baseUrl.startsWith('srt://')) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const encryption = srtPassphrase ? `passphrase=${encodeURIComponent(srtPassphrase)}&` : '';
    return `${baseUrl}${separator}${encryption}streamid=read:${path}:vrrelay-read:${readToken}`;
  }
  const source = new URL(baseUrl);
  if (source.protocol !== 'rtsp:') throw new Error('Live origin must use RTSP or SRT');
  source.username = 'vrrelay-read';
  source.password = readToken;
  source.pathname = `${source.pathname.replace(/\/$/, '')}/${path}`;
  return source.toString();
}

const forwardedLiveHlsQueryKeys = new Set(['session', '_HLS_msn', '_HLS_part', '_HLS_skip']);

export function liveHlsUpstreamUrl(
  baseUrl: string,
  path: string,
  resource: string,
  query: Readonly<Record<string, unknown>>
): string {
  if (!/^live-[A-Za-z0-9_-]+$/.test(path)) throw new Error('Invalid live path');
  if (!resource || resource.includes('..') || resource.includes('\\'))
    throw new Error('Invalid live HLS resource');
  const target = new URL(
    `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(path)}/${resource.replace(/^\//, '')}`
  );
  for (const [name, value] of Object.entries(query)) {
    if (forwardedLiveHlsQueryKeys.has(name) && typeof value === 'string')
      target.searchParams.set(name, value);
  }
  return target.toString();
}

export function assertSetupAuthorized(
  config: Pick<RelayConfig, 'publicUrl' | 'setupToken'>,
  supplied: string | undefined
): void {
  if (!requiresSetupToken(config.publicUrl)) return;
  if (!config.setupToken) {
    throw new ApplicationError(
      'setup_token_required',
      'Remote first-run setup is disabled until VRRELAY_SETUP_TOKEN is configured',
      503
    );
  }
  const expected = Buffer.from(config.setupToken);
  const actual = Buffer.from(supplied ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ApplicationError('unauthorized', 'The first-run setup token is invalid', 401);
  }
}

export async function createServer(
  config: RelayConfig,
  services: ServerServices
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.VRRELAY_LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.setupToken',
          'req.body.apiKey',
          'res.headers.set-cookie'
        ],
        censor: '[REDACTED]'
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactRequestUrl(request.url),
            host: request.hostname,
            remoteAddress: request.ip
          };
        }
      }
    },
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID()
  });

  const configuredLivePaths = new Map<string, Promise<void>>();
  const ensureLiveEdgePath = async (path: string): Promise<void> => {
    if (!config.liveOriginUrl) return;
    const existing = configuredLivePaths.get(path);
    if (existing) return existing;
    const operation = (async () => {
      const endpoint = `${config.mediaMtxApiUrl.replace(/\/$/, '')}/v3/config/paths`;
      const body = JSON.stringify({
        source: liveOriginSourceUrl(
          config.liveOriginUrl!,
          path,
          config.mediaMtxReadToken,
          config.liveOriginSrtPassphrase
        ),
        sourceOnDemand: true,
        sourceOnDemandCloseAfter: '30s'
      });
      const add = await fetch(`${endpoint}/add/${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      });
      if (add.ok) return;
      if (add.status !== 400) throw new Error(`MediaMTX path add failed (${add.status})`);
      const replace = await fetch(`${endpoint}/replace/${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      });
      if (!replace.ok) throw new Error(`MediaMTX path replace failed (${replace.status})`);
    })();
    configuredLivePaths.set(path, operation);
    try {
      await operation;
    } catch (error) {
      configuredLivePaths.delete(path);
      throw error;
    }
  };

  await app.register(cookie, { hook: 'onRequest' });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        // SvelteKit's static SPA fallback emits a small inline bootstrap script.
        // Moving to a per-build hash or nonce is tracked as post-v1 hardening.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    }
  });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  await app.register(websocket);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: 'invalid_request',
          message: 'Request validation failed',
          requestId: request.id,
          details: { issues: error.issues }
        }
      });
    }
    if (error instanceof ApplicationError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          details: error.details
        }
      });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'The relay could not complete the request',
        requestId: request.id
      }
    });
  });

  const authenticate = async (
    request: FastifyRequest,
    scopes: Parameters<AuthService['authenticate']>[1] = []
  ) => services.auth.authenticate(request, scopes);
  const mutate = async (
    request: FastifyRequest,
    scopes: Parameters<AuthService['authenticate']>[1] = []
  ) => {
    const principal = await authenticate(request, scopes);
    services.auth.requireCsrf(request, principal);
    return principal;
  };
  const metricsAuthorized = (request: FastifyRequest): boolean => {
    if (!config.metricsToken) return false;
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const expected = Buffer.from(config.metricsToken);
    const actual = Buffer.from(supplied);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    version: config.applicationVersion,
    now: new Date().toISOString(),
    workers: services.sessions.capacity()
  }));
  app.get('/api/v1/setup', async () => {
    const status = await services.auth.setupStatus();
    return {
      ...status,
      requiresToken: !status.configured && requiresSetupToken(config.publicUrl)
    };
  });
  app.post(
    '/api/v1/setup',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parse(FirstRunRequestSchema, request.body);
      assertSetupAuthorized(config, body.setupToken);
      await services.auth.initialize(body.password);
      return reply.status(201).send({ configured: true, requiresToken: false });
    }
  );
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parse(LoginRequestSchema, request.body);
      const session = await services.auth.login(body.password);
      reply.setCookie('vrrelay_session', session.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.publicUrl.startsWith('https://'),
        path: '/',
        expires: new Date(session.expiresAt)
      });
      return { csrfToken: session.csrfToken, expiresAt: session.expiresAt };
    }
  );
  app.post('/api/v1/auth/logout', async (request, reply) => {
    await mutate(request);
    services.auth.logout(request.cookies.vrrelay_session);
    reply.clearCookie('vrrelay_session', { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/v1/providers', async (request) => {
    await authenticate(request, ['catalog:read']);
    return { items: await services.providers.list() };
  });
  app.post('/api/v1/providers', async (request, reply) => {
    await mutate(request, ['admin']);
    const body = parse(CreateProviderRequestSchema, request.body);
    const policy = await validateProviderUrl(body.baseUrl, body.allowPublicHttp);
    const provider = await services.providers.create({
      ...body,
      normalizedBaseUrl: policy.normalizedUrl,
      ...(policy.securityNotice ? { securityNotice: policy.securityNotice } : {})
    });
    return reply.status(201).send(provider);
  });
  app.post('/api/v1/providers/:providerId/validate', async (request, reply) => {
    await mutate(request, ['admin']);
    await services.providers.validate((request.params as { providerId: string }).providerId);
    return reply.status(204).send();
  });
  app.delete('/api/v1/providers/:providerId', async (request, reply) => {
    await mutate(request, ['admin']);
    await services.providers.delete((request.params as { providerId: string }).providerId);
    return reply.status(204).send();
  });
  app.get('/api/v1/providers/:providerId/catalog', async (request) => {
    await authenticate(request, ['catalog:read']);
    const query = parse(CatalogQuerySchema, request.query);
    return services.providers.browse((request.params as { providerId: string }).providerId, query);
  });
  app.get('/api/v1/providers/:providerId/items/:itemId', async (request) => {
    await authenticate(request, ['catalog:read']);
    const params = request.params as { providerId: string; itemId: string };
    return services.providers.item(params.providerId, params.itemId);
  });

  app.get('/api/v1/profiles', async (request) => {
    await authenticate(request, ['sessions:read']);
    return { items: await services.profiles.list() };
  });
  app.post('/api/v1/profiles', async (request, reply) => {
    await mutate(request, ['admin']);
    return reply
      .status(201)
      .send(
        await services.profiles.createRevision(
          parse(CreateProfileRevisionRequestSchema, request.body)
        )
      );
  });
  app.get('/api/v1/capabilities', async (request) => {
    await authenticate(request, ['sessions:read']);
    return services.capabilities;
  });

  app.get('/api/v1/nodes', async (request) => {
    await authenticate(request, ['sessions:read']);
    return {
      items: (await services.cluster.list()).map((node) => ({
        ...node,
        agent: services.agentController?.status(node.id) ?? { connected: false }
      }))
    };
  });
  app.post('/api/v1/nodes/join-tokens', async (request, reply) => {
    await mutate(request, ['admin']);
    return reply
      .status(201)
      .send(
        await services.cluster.createJoinToken(
          parse(CreateNodeJoinTokenRequestSchema, request.body)
        )
      );
  });
  app.post(
    '/api/v1/nodes/enroll',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parse(EnrollNodeRequestSchema, request.body);
      return reply.status(201).send(
        await services.cluster.enroll({
          token: body.token,
          name: body.name,
          publicUrl: body.publicUrl,
          capabilities: body.capabilities,
          ...(body.internalUrl ? { internalUrl: body.internalUrl } : {})
        })
      );
    }
  );
  app.post('/api/v1/nodes/:nodeId/drain', async (request) => {
    await mutate(request, ['admin']);
    return services.cluster.drain(
      (request.params as { nodeId: string }).nodeId,
      parse(NodeDrainRequestSchema, request.body).draining
    );
  });
  app.post('/api/v1/nodes/:nodeId/certificate/rotate', async (request) => {
    await mutate(request, ['admin']);
    parse(RotateNodeCertificateRequestSchema, request.body ?? {});
    const nodeId = (request.params as { nodeId: string }).nodeId;
    if (!services.agentController?.connected(nodeId))
      throw new ApplicationError(
        'node_unavailable',
        'The node must be connected to receive and persist its replacement certificate',
        409
      );
    await services.agentController.request(nodeId, 'certificate.rotate', {}, 60_000);
    const node = (await services.cluster.list()).find((candidate) => candidate.id === nodeId);
    if (!node?.certificateExpiresAt)
      throw new ApplicationError('not_found', 'Rotated node certificate was not found', 404);
    return {
      certificateExpiresAt: node.certificateExpiresAt
    };
  });
  app.post('/api/v1/nodes/:nodeId/revoke', async (request) => {
    await mutate(request, ['admin']);
    const nodeId = (request.params as { nodeId: string }).nodeId;
    const node = await services.cluster.revoke(nodeId);
    services.agentController?.disconnect(nodeId, 'Node revoked by administrator');
    return node;
  });
  app.get('/api/v1/nodes/:nodeId/logs', async (request) => {
    await authenticate(request, ['admin']);
    return {
      items: await services.cluster.logs((request.params as { nodeId: string }).nodeId, 200)
    };
  });
  app.delete('/api/v1/nodes/:nodeId', async (request, reply) => {
    await mutate(request, ['admin']);
    await services.cluster.remove((request.params as { nodeId: string }).nodeId);
    return reply.status(204).send();
  });
  app.post('/api/v1/placement/preview', async (request) => {
    await authenticate(request, ['sessions:create']);
    const body = parse(PlacementPreviewRequestSchema, request.body);
    const profile = await services.repository.getProfile(body.profileId, body.profileRevision);
    if (!profile) throw new ApplicationError('not_found', 'Profile revision was not found', 404);
    return services.cluster.previewPlacement({
      policy: body.placementPolicy,
      profile,
      ...(body.providerId ? { providerId: body.providerId } : {}),
      ...(body.preferredNodeId ? { preferredNodeId: body.preferredNodeId } : {}),
      ...(body.preferredRegion ? { preferredRegion: body.preferredRegion } : {})
    });
  });

  app.get('/api/v1/provider-bindings', async (request) => {
    await authenticate(request, ['admin']);
    const providerId = (request.query as { providerId?: string }).providerId;
    return { items: (await services.cluster.bindings(providerId)).map(publicProviderBinding) };
  });
  app.post('/api/v1/provider-bindings', async (request, reply) => {
    await mutate(request, ['admin']);
    if (!services.agentController)
      throw new ApplicationError(
        'cluster_unavailable',
        'The node agent controller is not enabled',
        409
      );
    const body = parse(CreateProviderBindingRequestSchema, request.body);
    if (!services.agentController.connected(body.nodeId))
      throw new ApplicationError(
        'node_unavailable',
        'The selected source worker is not connected',
        409
      );
    const policy = await validateProviderUrl(body.baseUrl, body.allowPublicHttp);
    const providerId = body.providerId ?? randomUUID();
    const bindingId = randomUUID();
    const result = await services.agentController.call<{
      provider: unknown;
      binding: import('@vrrelay/domain').ProviderBinding;
    }>(body.nodeId, 'provider.bind', {
      nodeId: body.nodeId,
      providerId,
      bindingId,
      input: { ...body, baseUrl: policy.normalizedUrl }
    });
    return reply
      .status(201)
      .send({ provider: result.provider, binding: publicProviderBinding(result.binding) });
  });
  app.delete('/api/v1/provider-bindings/:bindingId', async (request, reply) => {
    await mutate(request, ['admin']);
    const bindingId = (request.params as { bindingId: string }).bindingId;
    const binding = (await services.cluster.bindings()).find(
      (candidate) => candidate.id === bindingId
    );
    if (!binding) throw new ApplicationError('not_found', 'Provider binding was not found', 404);
    if (!services.agentController?.connected(binding.nodeId))
      throw new ApplicationError(
        'node_unavailable',
        'The bound source worker must be connected before its credential can be removed',
        409
      );
    await services.agentController.call(binding.nodeId, 'provider.unbind', { bindingId });
    await services.cluster.removeBinding(bindingId);
    return reply.status(204).send();
  });

  app.get('/api/v1/sessions', async (request) => {
    await authenticate(request, ['sessions:read']);
    return { items: await services.sessions.list() };
  });
  app.get('/api/v1/sessions/:sessionId', async (request) => {
    await authenticate(request, ['sessions:read']);
    return services.sessions.get((request.params as { sessionId: string }).sessionId);
  });
  app.post('/api/v1/sessions', async (request, reply) => {
    await mutate(request, ['sessions:create']);
    const body = parse(CreateSessionRequestSchema, request.body);
    body.placementLocked = Boolean(body.preferredNodeId);
    if (body.kind === 'vod' && body.placementPolicy !== 'local') {
      const profile = await services.repository.getProfile(body.profileId, body.profileRevision);
      if (!profile) throw new ApplicationError('not_found', 'Profile revision was not found', 404);
      const placement = await services.cluster.previewPlacement({
        policy: body.placementPolicy,
        providerId: body.source.providerId,
        profile,
        ...(body.preferredNodeId ? { preferredNodeId: body.preferredNodeId } : {}),
        ...(body.preferredRegion ? { preferredRegion: body.preferredRegion } : {})
      });
      if (!placement.node)
        throw new ApplicationError('placement_unavailable', placement.reason, 409);
      body.preferredNodeId = placement.node.id;
    }
    return reply.status(201).send(await services.sessions.create(body));
  });
  app.delete('/api/v1/sessions/:sessionId', async (request, reply) => {
    await mutate(request, ['sessions:control']);
    await services.sessions.delete((request.params as { sessionId: string }).sessionId);
    return reply.status(204).send();
  });
  app.patch('/api/v1/sessions/:sessionId', async (request) => {
    await mutate(request, ['sessions:control']);
    const body = parse(SessionControlRequestSchema, request.body);
    return services.sessions.control((request.params as { sessionId: string }).sessionId, {
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      ...(body.state !== undefined ? { state: body.state } : {})
    });
  });

  app.get('/api/v1/live-channels', async (request) => {
    await authenticate(request, ['sessions:read']);
    return { items: await services.live.list() };
  });
  app.post('/api/v1/live-channels', async (request, reply) => {
    await mutate(request, ['sessions:create']);
    return reply
      .status(201)
      .send(await services.live.create(parse(CreateLiveChannelRequestSchema, request.body)));
  });
  app.delete('/api/v1/live-channels/:channelId', async (request, reply) => {
    await mutate(request, ['sessions:control']);
    await services.live.delete((request.params as { channelId: string }).channelId);
    return reply.status(204).send();
  });

  app.get('/api/v1/compatibility', async (request) => {
    await authenticate(request, ['sessions:read']);
    return { items: await services.repository.listCompatibilityResults() };
  });
  app.post('/api/v1/compatibility', async (request, reply) => {
    await mutate(request, ['admin']);
    const body = parse(CreateCompatibilityResultRequestSchema, request.body);
    const result = { ...body, id: randomUUID(), testedAt: new Date().toISOString() };
    await services.repository.putCompatibilityResult(result);
    return reply.status(201).send(result);
  });
  app.post('/api/v1/tokens', async (request, reply) => {
    await mutate(request, ['admin']);
    const body = parse(CreatePersonalTokenRequestSchema, request.body);
    return reply
      .status(201)
      .send(await services.auth.createPersonalToken(body.name, body.scopes, body.expiresAt));
  });
  app.get('/api/v1/tokens', async (request) => {
    await authenticate(request, ['admin']);
    return { items: await services.auth.listPersonalTokens() };
  });
  app.delete('/api/v1/tokens/:tokenId', async (request, reply) => {
    await mutate(request, ['admin']);
    await services.auth.revokePersonalToken((request.params as { tokenId: string }).tokenId);
    return reply.status(204).send();
  });
  app.get('/api/v1/events/recent', async (request) => {
    await authenticate(request, ['sessions:read']);
    return { items: services.events.recent(100) };
  });
  app.get('/api/v1/jobs', async (request) => {
    await authenticate(request, ['sessions:read']);
    return { items: await services.sessions.listJobs() };
  });
  app.delete('/api/v1/jobs/:jobId', async (request, reply) => {
    await mutate(request, ['sessions:control']);
    await services.sessions.cancelJob((request.params as { jobId: string }).jobId);
    return reply.status(204).send();
  });
  app.post('/api/v1/jobs/:jobId/retry', async (request) => {
    await mutate(request, ['sessions:control']);
    return services.sessions.retryJob((request.params as { jobId: string }).jobId);
  });
  app.get('/api/v1/backends', async (request) => {
    await authenticate(request, ['admin']);
    return services.backends.list();
  });
  app.post('/api/v1/backends/validate', async (request) => {
    await mutate(request, ['admin']);
    const body = parse(BackendValidationRequestSchema, request.body);
    return services.backends.validate(body);
  });
  app.post('/api/v1/backends/activate', async (request) => {
    await mutate(request, ['admin']);
    return services.backends.activate(parse(BackendActivationRequestSchema, request.body));
  });
  app.get('/api/v1/cache', async (request) => {
    await authenticate(request, ['sessions:read']);
    const items = await services.sessions.cacheInventory();
    return { items, totalBytes: items.reduce((sum, item) => sum + item.size, 0) };
  });
  app.delete('/api/v1/cache', async (request) => {
    await mutate(request, ['sessions:control']);
    const body = parse(CacheEvictionRequestSchema, request.body);
    return {
      removed: await services.sessions.evictCache({
        ...(body.all !== undefined ? { all: body.all } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(body.profileId ? { profileId: body.profileId } : {})
      })
    };
  });
  app.get('/metrics', async (request, reply) => {
    if (!metricsAuthorized(request)) return reply.status(401).send();
    return reply.type(services.metrics.contentType).send(await services.metrics.render());
  });
  app.get('/api/v1/events', { websocket: true }, (socket, request) => {
    void services.auth
      .authenticate(request, ['sessions:read'])
      .then(() => {
        for (const recent of services.events.recent(20).reverse())
          socket.send(JSON.stringify(recent));
        const unsubscribe = services.events.subscribe((next) => socket.send(JSON.stringify(next)));
        socket.on('close', unsubscribe);
      })
      .catch(() => socket.close(1008, 'Authentication required'));
  });

  app.post('/internal/mediamtx/auth', async (request, reply) => {
    const body = parse(
      z.object({
        action: z.string(),
        path: z.string(),
        protocol: z.string().optional(),
        user: z.string().optional(),
        password: z.string().optional(),
        token: z.string().optional()
      }),
      request.body
    );
    return (await services.live.authorizeMediaMtx(body, config.mediaMtxReadToken))
      ? reply.status(204).send()
      : reply.status(401).send();
  });

  app.get('/internal/source/:token', async (request, reply) => {
    const peer = request.raw.socket.remoteAddress;
    if (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') {
      return reply.status(403).send({
        error: { code: 'forbidden', message: 'Internal source grants are loopback-only' }
      });
    }
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    const source = await services.sessions.openSourceProxy(
      (request.params as { token: string }).token,
      request.headers.range,
      controller.signal
    );
    reply.status(source.status);
    for (const [name, value] of Object.entries(source.headers)) reply.header(name, value);
    return reply
      .type(source.headers['content-type'] ?? 'application/octet-stream')
      .send(source.stream);
  });

  app.get('/play/:token/index.m3u8', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = tokenFromPath(request);
    const session = await services.sessions.touchViewer(token, viewerIdentity(request));
    const route = await services.cluster.selectEdge(session.id, session.preferredRegion);
    const base = route ? `${route.publicUrl.replace(/\/$/, '')}/play/${token}/segment` : undefined;
    const manifest = await services.sessions.manifest(token, base);
    services.sessions.recordEgress(Buffer.byteLength(manifest), session.id);
    return reply.type('application/vnd.apple.mpegurl').send(manifest);
  });
  app.get('/play/:token/segment/:index.ts', async (request, reply) => {
    const params = request.params as { token: string; index: string };
    const session = await services.sessions.touchViewer(params.token, viewerIdentity(request));
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    const path = await services.sessions.segment(
      params.token,
      Number(params.index),
      controller.signal
    );
    const info = await stat(path);
    reply.header('Content-Length', info.size);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply
      .type('video/mp2t')
      .send(
        meteredReadable(createReadStream(path), (bytes) =>
          services.sessions.recordEgress(bytes, session.id)
        )
      );
  });
  app.get('/play/:token/segment/:index.m4s', async (request, reply) => {
    const params = request.params as { token: string; index: string };
    const session = await services.sessions.touchViewer(params.token, viewerIdentity(request));
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    const path = await services.sessions.segment(
      params.token,
      Number(params.index),
      controller.signal
    );
    const info = await stat(path);
    reply.header('Content-Length', info.size);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply
      .type('video/iso.segment')
      .send(
        meteredReadable(createReadStream(path), (bytes) =>
          services.sessions.recordEgress(bytes, session.id)
        )
      );
  });
  app.get('/play/:token/segment/init.mp4', async (request, reply) => {
    const token = tokenFromPath(request);
    const session = await services.sessions.touchViewer(token, viewerIdentity(request));
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    const path = await services.sessions.initSegment(token, controller.signal);
    const info = await stat(path);
    reply.header('Content-Length', info.size);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply
      .type('video/mp4')
      .send(
        meteredReadable(createReadStream(path), (bytes) =>
          services.sessions.recordEgress(bytes, session.id)
        )
      );
  });
  app.get('/play/:token/stream.mp4', async (request, reply) => {
    const token = tokenFromPath(request);
    const session = await services.sessions.touchViewer(token, viewerIdentity(request));
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    reply.raw.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    const output = payloadMeter((bytes) => services.sessions.recordEgress(bytes, session.id));
    output.pipe(reply.raw);
    await services.sessions.streamFragmentedMp4(token, output, controller.signal).catch((error) => {
      output.destroy();
      throw error;
    });
  });
  app.get('/play/:token/live.m3u8', async (request, reply) => {
    const token = tokenFromPath(request);
    const session = await services.sessions.touchViewer(token, viewerIdentity(request));
    const query = request.query as { edge?: string };
    if (query.edge !== '1') {
      const route = await services.cluster.selectEdge(session.id, session.preferredRegion);
      if (route && route.nodeId !== config.nodeId) {
        const target = `${route.publicUrl.replace(/\/$/, '')}/play/${token}/live.m3u8?edge=1`;
        const redirect = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\n${target}\n`;
        services.sessions.recordEgress(Buffer.byteLength(redirect), session.id);
        return reply.type('application/vnd.apple.mpegurl').send(redirect);
      }
    }
    const channel = await services.sessions.resolveLive(token);
    await ensureLiveEdgePath(channel.path);
    const response = await fetch(`${config.mediaMtxHlsUrl}/${channel.path}/index.m3u8`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`vrrelay-read:${config.mediaMtxReadToken}`).toString('base64')}`
      }
    });
    if (!response.ok) return reply.status(response.status).send();
    const playlist = (await response.text())
      .split('\n')
      .map((line) =>
        !line || line.startsWith('#') || /^https?:/.test(line)
          ? line
          : `/play/${token}/live/${line}`
      )
      .join('\n');
    services.sessions.recordEgress(Buffer.byteLength(playlist), session.id);
    return reply.type('application/vnd.apple.mpegurl').send(playlist);
  });
  app.get('/play/:token/live/*', async (request, reply) => {
    const params = request.params as { token: string; '*': string };
    if (!params['*'] || params['*'].includes('..') || params['*'].includes('\\'))
      return reply.status(400).send();
    const session = await services.sessions.touchViewer(params.token, viewerIdentity(request));
    const channel = await services.sessions.resolveLive(params.token);
    await ensureLiveEdgePath(channel.path);
    const response = await fetch(
      liveHlsUpstreamUrl(
        config.mediaMtxHlsUrl,
        channel.path,
        params['*'],
        request.query as Record<string, unknown>
      ),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`vrrelay-read:${config.mediaMtxReadToken}`).toString('base64')}`
        }
      }
    );
    if (!response.ok || !response.body) return reply.status(response.status).send();
    reply.header('Cache-Control', response.headers.get('cache-control') ?? 'no-store');
    return reply
      .type(response.headers.get('content-type') ?? 'application/octet-stream')
      .send(
        meteredReadable(
          Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
          (bytes) => services.sessions.recordEgress(bytes, session.id)
        )
      );
  });

  const publicRoot = resolve(process.cwd(), 'apps/relay/public');
  if (existsSync(publicRoot)) {
    await app.register(staticPlugin, { root: publicRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.url.startsWith('/api/') ||
        request.url.startsWith('/play/') ||
        request.url.startsWith('/internal/')
      ) {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Route not found', requestId: request.id }
        });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
