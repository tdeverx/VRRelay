// SPDX-License-Identifier: GPL-3.0-or-later
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { compile as compileProxyTrust } from '@fastify/proxy-addr';
import { z, type ZodType } from 'zod';
import {
  ApplicationError,
  UnauthorizedError,
  type EventBus,
  type MediaCapabilities,
  type Repository,
  type ObjectStore,
  type CoordinationStore,
  type MetricsSink,
  type AuditService,
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
  SignInConfigurationRequestSchema,
  UpdateUserRequestSchema,
  CreateNodeJoinTokenRequestSchema,
  EnrollNodeRequestSchema,
  NodeDrainRequestSchema,
  PlacementPreviewRequestSchema,
  SessionControlRequestSchema,
  CreateProviderBindingRequestSchema,
  DeleteProviderBindingQuerySchema,
  RotateNodeCertificateRequestSchema,
  NodeLogsQuerySchema,
  JobLogsQuerySchema,
  CacheInventoryQuerySchema,
  CacheEvictionRequestSchema,
  BackendValidationRequestSchema,
  BackendActivationRequestSchema,
  RuntimeConfigurationUpdateRequestSchema
} from '@vrrelay/contracts';
import { isPrivateAddress, validateProviderUrl } from '@vrrelay/adapters';
import { requiresSetupToken, validateRuntimeConfiguration, type RelayConfig } from './config.js';
import { publicProviderBinding, type ClusterNode } from '@vrrelay/domain';
import { AuthService, type Principal } from './auth.js';
import type { AgentController } from './agent-transport.js';
import type { BackendService } from './backend-service.js';
import {
  persistRuntimeConfiguration,
  publicRuntimeConfiguration
} from './runtime-configuration.js';
import {
  auditActor,
  auditedOperation,
  type AuditedOperationOptions,
  type AuditWriteFailure
} from './audited-operation.js';

export { auditActor, auditedOperation } from './audited-operation.js';

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
  audit: AuditService;
  backends: BackendService;
  agentController?: AgentController;
}

export interface ProviderBindingDeletionOutcome {
  cleanupMode: 'already-finalized' | 'worker-confirmed' | 'administrator-acknowledged-orphan';
  nodeId?: string;
  orphanAcknowledged: boolean;
}

export type ControlPlaneHttpSurface = 'controller' | 'standalone';
export const RUNTIME_RESTART_EXIT_CODE = 75;

export function placementNodeConnectivity(
  surface: ControlPlaneHttpSurface,
  localNodeId: string,
  agentConnected?: (nodeId: string) => boolean
): ((nodeId: string) => boolean) | undefined {
  if (surface === 'standalone')
    return (nodeId) => nodeId === localNodeId || Boolean(agentConnected?.(nodeId));
  return agentConnected;
}

export function registerStandaloneInternalRoutes(
  app: FastifyInstance,
  config: RelayConfig,
  services: Pick<ServerServices, 'live' | 'sessions'>
): void {
  app.post('/internal/mediamtx/auth', async (request, reply) => {
    if (!isInternalPeer(request.raw.socket.remoteAddress))
      return reply.status(403).send({
        error: {
          code: 'forbidden',
          message: 'Internal MediaMTX auth is private-network or loopback-only'
        }
      });
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
    if (!isLoopbackPeer(request.raw.socket.remoteAddress))
      return reply.status(403).send({
        error: { code: 'forbidden', message: 'Internal source grants are loopback-only' }
      });
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
      .send(
        source.sessionId
          ? meteredReadable(source.stream, (bytes) =>
              services.sessions.recordIngress(bytes, source.sessionId)
            )
          : source.stream
      );
  });
}

export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  if (normalized === '::1') return true;
  const dottedMapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dottedMapped && isIP(dottedMapped) === 4) return dottedMapped.startsWith('127.');
  const hexadecimalMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
  return Boolean(
    hexadecimalMapped && (Number.parseInt(hexadecimalMapped[1]!, 16) & 0xff00) === 0x7f00
  );
}

export function shouldRateLimitRequest(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return ['/api', '/internal', '/play'].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

export function isInternalPeer(address: string | undefined): boolean {
  return Boolean(address && (isLoopbackPeer(address) || isPrivateAddress(address)));
}

interface ProviderBindingCleanupServices {
  cluster: Pick<ClusterService, 'beginBindingDeletion' | 'finalizeBindingDeletion' | 'list'>;
  agentController?: {
    connected(nodeId: string): boolean;
    call(
      nodeId: string,
      operation: 'provider.unbind',
      payload: Record<string, unknown>
    ): Promise<unknown>;
  };
}

interface NodeDrainServices {
  cluster: Pick<ClusterService, 'drain' | 'get'>;
  agentController?: {
    setDrain(
      nodeId: string,
      draining: boolean
    ): Promise<{ persisted: true; acknowledged: boolean }>;
  };
}

export interface NodeDrainDeliveryOutcome {
  node: ClusterNode;
  commandAcknowledged: boolean | null;
}

export async function setNodeDrainWithDelivery(
  services: NodeDrainServices,
  nodeId: string,
  draining: boolean,
  localNodeId?: string
): Promise<NodeDrainDeliveryOutcome> {
  if (!services.agentController || nodeId === localNodeId)
    return {
      node: await services.cluster.drain(nodeId, draining),
      commandAcknowledged: null
    };
  const delivery = await services.agentController.setDrain(nodeId, draining);
  const node = await services.cluster.get(nodeId);
  if (!node) throw new ApplicationError('not_found', 'Cluster node was not found', 404);
  return { node, commandAcknowledged: delivery.acknowledged };
}

interface NodeCertificateRotationServices {
  cluster: Pick<ClusterService, 'get'>;
  agentController?: Pick<AgentController, 'connected' | 'rotateCertificate'>;
}

export async function rotateNodeCertificateWithDelivery(
  services: NodeCertificateRotationServices,
  nodeId: string,
  timeoutMs = 60_000
): Promise<{ certificateExpiresAt: string }> {
  if (!services.agentController?.connected(nodeId))
    throw new ApplicationError(
      'node_unavailable',
      'The node must be connected to receive and persist its replacement certificate',
      409
    );
  await services.agentController.rotateCertificate(nodeId, timeoutMs);
  const node = await services.cluster.get(nodeId);
  if (!node?.certificateExpiresAt)
    throw new ApplicationError('not_found', 'Rotated node certificate was not found', 404);
  return { certificateExpiresAt: node.certificateExpiresAt };
}

interface NodeCacheServices {
  sessions: Pick<SessionService, 'cacheInventory' | 'evictCache'>;
  agentController?: Pick<AgentController, 'connected' | 'cacheInventory' | 'evictCache'>;
}

export async function cacheInventoryWithNodeTarget(
  services: NodeCacheServices,
  nodeId?: string
): Promise<{ items: Awaited<ReturnType<SessionService['cacheInventory']>>; totalBytes: number }> {
  if (nodeId) {
    if (!services.agentController?.connected(nodeId))
      throw new ApplicationError(
        'node_unavailable',
        'The node must be connected before its cache inventory can be read',
        409
      );
    return services.agentController.cacheInventory(nodeId);
  }
  const items = await services.sessions.cacheInventory();
  return { items, totalBytes: items.reduce((sum, item) => sum + item.size, 0) };
}

export async function evictCacheWithNodeTarget(
  services: NodeCacheServices,
  filter: {
    nodeId?: string | undefined;
    sessionId?: string | undefined;
    profileId?: string | undefined;
    all?: boolean | undefined;
  }
): Promise<{ removed: number }> {
  const eviction = {
    ...(filter.all !== undefined ? { all: filter.all } : {}),
    ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
    ...(filter.profileId ? { profileId: filter.profileId } : {})
  };
  if (filter.nodeId) {
    if (!services.agentController?.connected(filter.nodeId))
      throw new ApplicationError(
        'node_unavailable',
        'The node must be connected before its cache can be evicted',
        409
      );
    return services.agentController.evictCache(filter.nodeId, eviction);
  }
  return { removed: await services.sessions.evictCache(eviction) };
}

export function providerBindingDeletionAuditContext(result: ProviderBindingDeletionOutcome) {
  return {
    cleanupMode: result.cleanupMode,
    orphanAcknowledged: result.orphanAcknowledged,
    ...(result.nodeId ? { nodeId: result.nodeId } : {})
  };
}

export async function deleteProviderBindingWithCredentialCleanup(
  services: ProviderBindingCleanupServices,
  bindingId: string,
  acknowledgeOrphanedCredential: boolean
): Promise<ProviderBindingDeletionOutcome> {
  const deleting = await services.cluster.beginBindingDeletion(bindingId);
  if (!deleting) return { cleanupMode: 'already-finalized', orphanAcknowledged: false };

  const binding = deleting.value;
  const connected = Boolean(services.agentController?.connected(binding.nodeId));
  if (connected) {
    await services.agentController!.call(binding.nodeId, 'provider.unbind', { bindingId });
    await services.cluster.finalizeBindingDeletion(bindingId, deleting.revision);
    return {
      cleanupMode: 'worker-confirmed',
      nodeId: binding.nodeId,
      orphanAcknowledged: false
    };
  }

  const node = (await services.cluster.list()).find((candidate) => candidate.id === binding.nodeId);
  if (node && node.state !== 'revoked')
    throw new ApplicationError(
      'node_unavailable',
      'Reconnect the source worker to remove its provider credential, or revoke the node first for emergency cleanup',
      409
    );
  if (!acknowledgeOrphanedCredential)
    throw new ApplicationError(
      'orphaned_credential_acknowledgement_required',
      'The revoked or missing node cannot erase its stored provider credential. Revoke or rotate the provider token, then retry with acknowledgeOrphanedCredential=true',
      409
    );

  await services.cluster.finalizeBindingDeletion(bindingId, deleting.revision);
  return {
    cleanupMode: 'administrator-acknowledged-orphan',
    nodeId: binding.nodeId,
    orphanAcknowledged: true
  };
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function reportAuditWriteFailure(request: FastifyRequest, failure: AuditWriteFailure): void {
  request.log.error({ audit: failure }, 'durable audit outcome could not be written');
}

function tokenFromPath(request: FastifyRequest): string {
  return (request.params as { token: string }).token;
}

function viewerIdentity(request: FastifyRequest, key: Buffer): string {
  return createHmac('sha256', key)
    .update(request.ip)
    .update('\0')
    .update(String(request.headers['user-agent'] ?? 'unknown').slice(0, 256))
    .digest('hex');
}

export function trustedViewerRegion(
  request: Pick<FastifyRequest, 'headers' | 'raw'>,
  headerName: string,
  isTrustedPeer: (address: string, hop: number) => boolean,
  configuredRegions?: readonly string[]
): string | undefined {
  const remoteAddress = request.raw.socket.remoteAddress;
  if (!remoteAddress || !isTrustedPeer(remoteAddress, 0)) return undefined;
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === headerName.toLowerCase()
  ).length;
  if (occurrences !== 1) return undefined;
  const value = request.headers[headerName];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalized)) return undefined;
  if (configuredRegions && !configuredRegions.includes(normalized)) return undefined;
  return normalized;
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
  config: Pick<RelayConfig, 'adminUrl' | 'setupToken'>,
  supplied: string | undefined
): void {
  if (!requiresSetupToken(config.adminUrl)) return;
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

export function assertProductionNodePublicUrl(
  config: Pick<RelayConfig, 'environment'>,
  publicUrl: string
): void {
  if (config.environment === 'production' && new URL(publicUrl).protocol !== 'https:')
    throw new ApplicationError(
      'insecure_node_public_url',
      'Production node public URLs must use HTTPS',
      400
    );
}

export async function createServer(
  config: RelayConfig,
  services: ServerServices,
  surface: ControlPlaneHttpSurface = 'standalone'
): Promise<FastifyInstance> {
  const app = Fastify({
    logController: new LogController({
      disableRequestLogging: (request) => request.url.split('?', 1)[0] === '/api/v1/health'
    }),
    logger: {
      level: process.env.VRRELAY_LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.setupToken',
          'req.body.apiKey',
          'req.body.token',
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
    trustProxy: config.trustedProxyCidrs,
    bodyLimit: 1_048_576,
    // Signed edge playback grants include bounded session and node metadata and
    // therefore exceed Fastify's 100-character default parameter limit.
    routerOptions: { maxParamLength: 1_024 },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID()
  });
  const isPlacementNodeConnected = placementNodeConnectivity(
    surface,
    config.nodeId,
    services.agentController
      ? (nodeId) => Boolean(services.agentController?.connected(nodeId))
      : undefined
  );
  const isTrustedRegionPeer = compileProxyTrust(config.trustedProxyCidrs);
  const viewerIdentityKey = randomBytes(32);
  const viewerAffinity = (request: FastifyRequest) => viewerIdentity(request, viewerIdentityKey);
  const viewerRegion = async (request: FastifyRequest) => {
    if (request.headers[config.viewerRegionHeader] === undefined) return undefined;
    const regions = [...new Set((await services.cluster.list()).map((node) => node.region))];
    const region = trustedViewerRegion(
      request,
      config.viewerRegionHeader,
      isTrustedRegionPeer,
      regions
    );
    if (request.headers[config.viewerRegionHeader] !== undefined && !region)
      services.metrics.increment('viewer_region_fallback_total', { reason: 'rejected' });
    return region;
  };
  let runtimeRestartRequired = false;

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
  const forgetLiveEdgePath = (path: string): void => {
    configuredLivePaths.delete(path);
  };
  const liveReadHeaders = () => ({
    Authorization: `Basic ${Buffer.from(`vrrelay-read:${config.mediaMtxReadToken}`).toString('base64')}`
  });
  const fetchLiveHlsWithPathRecovery = async (path: string, url: string): Promise<Response> => {
    await ensureLiveEdgePath(path);
    let response = await fetch(url, { headers: liveReadHeaders() });
    if (response.ok) return response;
    forgetLiveEdgePath(path);
    await ensureLiveEdgePath(path);
    response = await fetch(url, { headers: liveReadHeaders() });
    if (!response.ok) forgetLiveEdgePath(path);
    return response;
  };

  await app.register(cookie, { hook: 'onRequest' });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        // Every dashboard asset is same-origin and root-relative, so an HTTPS request already
        // loads it over HTTPS. Emitting this directive based on the advertised admin URL breaks
        // direct loopback recovery: Safari upgrades the local HTTP asset requests to HTTPS.
        upgradeInsecureRequests: null,
        // SvelteKit's static SPA fallback emits a small inline bootstrap script.
        // Moving to a per-build hash or nonce is tracked as post-v1 hardening.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    }
  });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: '1 minute',
    allowList: (request) => !shouldRateLimitRequest(request.url)
  });
  await app.register(websocket);

  app.setErrorHandler((error, request, reply) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
    ) {
      return reply.status(400).send({
        error: {
          code: 'invalid_request',
          message: 'Request validation failed',
          requestId: request.id
        }
      });
    }
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
  const auditAs = <T>(
    request: FastifyRequest,
    principal: Principal,
    options: Omit<AuditedOperationOptions<T>, 'actor' | 'onAuditWriteFailure'>,
    operation: () => Promise<T>
  ) =>
    auditedOperation(
      services.audit,
      {
        ...options,
        actor: auditActor(principal),
        onAuditWriteFailure: (failure) => reportAuditWriteFailure(request, failure)
      },
      operation
    );
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
  app.get('/api/v1/ready', async (request, reply) => {
    const backends = await services.backends.list();
    const dependencies = backends.items.map(
      ({ category, kind, healthy, checkedAt, restartRequired }) => ({
        category,
        kind,
        healthy,
        checkedAt,
        ...(restartRequired ? { restartRequired } : {})
      })
    );
    const ready =
      dependencies.every((dependency) => dependency.healthy) && !backends.restartRequired;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      version: config.applicationVersion,
      now: new Date().toISOString(),
      workers: services.sessions.capacity(),
      dependencies,
      restartRequired: backends.restartRequired
    });
  });
  app.get('/api/v1/setup', async () => {
    const status = await services.auth.setupStatus();
    return {
      ...status,
      requiresToken: !status.configured && requiresSetupToken(config.adminUrl)
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
      const session = await services.auth.login(body);
      reply.setCookie('vrrelay_session', session.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: request.protocol === 'https',
        path: '/',
        expires: new Date(session.expiresAt)
      });
      reply.setCookie('vrrelay_csrf', session.csrfToken, {
        httpOnly: false,
        sameSite: 'strict',
        secure: request.protocol === 'https',
        path: '/',
        expires: new Date(session.expiresAt)
      });
      return { csrfToken: session.csrfToken, expiresAt: session.expiresAt, user: session.user };
    }
  );
  app.get('/api/v1/auth/me', async (request) =>
    services.auth.publicPrincipal(await authenticate(request))
  );
  app.post('/api/v1/auth/logout', async (request, reply) => {
    await mutate(request);
    await services.auth.logout(request.cookies.vrrelay_session);
    reply.clearCookie('vrrelay_session', { path: '/' });
    reply.clearCookie('vrrelay_csrf', { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/v1/auth/configuration/status', async () => {
    const configuration = await services.auth.configuration();
    if (!configuration) return { configured: false };
    const provider = (await services.providers.list()).find(
      (candidate) => candidate.id === configuration.providerId
    );
    if (!provider) return { configured: false };
    return { configured: true, providerName: provider.serverName ?? provider.name };
  });

  app.get('/api/v1/auth/configuration', async (request) => {
    await authenticate(request, ['admin']);
    return { configuration: (await services.auth.configuration()) ?? null };
  });

  app.put('/api/v1/auth/configuration', async (request) => {
    await mutate(request, ['admin']);
    const configuration = parse(SignInConfigurationRequestSchema, request.body);
    const provider = (await services.providers.list()).find(
      (candidate) => candidate.id === configuration.providerId
    );
    if (!provider)
      throw new ApplicationError('not_found', 'Provider connection was not found', 404);
    if (provider.authMode !== 'delegated')
      throw new ApplicationError(
        'invalid_provider_authentication',
        'Interactive sign-in requires a delegated provider connection',
        409
      );
    const profiles = await services.profiles.list();
    const profileIds = new Set(profiles.map((profile) => profile.profileId));
    if (configuration.allowedProfileIds.some((id) => !profileIds.has(id)))
      throw new ApplicationError('not_found', 'An allowed profile was not found', 404);
    await services.auth.configure(configuration);
    return configuration;
  });

  app.get('/api/v1/catalog', async (request) => {
    const principal = await authenticate(request, ['catalog:read']);
    if (!principal.providerId || !principal.providerUserId)
      throw new ApplicationError(
        'catalog_unavailable',
        'Sign in with Jellyfin to browse media',
        403
      );
    const result = await services.providers.browseAs(
      principal.providerId,
      await services.auth.credential(principal),
      principal.providerUserId,
      parse(CatalogQuerySchema, request.query)
    );
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        imageUrl: `/api/v1/catalog/items/${encodeURIComponent(item.id)}/image`
      }))
    };
  });

  app.get('/api/v1/catalog/items/:itemId', async (request) => {
    const principal = await authenticate(request, ['catalog:read']);
    if (!principal.providerId || !principal.providerUserId)
      throw new ApplicationError(
        'catalog_unavailable',
        'Sign in with Jellyfin to browse media',
        403
      );
    const item = await services.providers.itemAs(
      principal.providerId,
      await services.auth.credential(principal),
      principal.providerUserId,
      (request.params as { itemId: string }).itemId
    );
    return {
      ...item,
      imageUrl: `/api/v1/catalog/items/${encodeURIComponent(item.id)}/image`
    };
  });

  app.get('/api/v1/catalog/items/:itemId/image', async (request, reply) => {
    const principal = await authenticate(request, ['catalog:read']);
    if (!principal.providerId || !principal.providerUserId)
      throw new ApplicationError(
        'catalog_unavailable',
        'Sign in with Jellyfin to browse media',
        403
      );
    const artwork = await services.providers.artworkAs(
      principal.providerId,
      await services.auth.credential(principal),
      principal.providerUserId,
      (request.params as { itemId: string }).itemId
    );
    return reply
      .type(artwork.contentType)
      .header('Cache-Control', 'private, max-age=3600')
      .send(Buffer.from(artwork.data));
  });

  app.get('/api/v1/catalog/profiles', async (request) => {
    const principal = await authenticate(request, ['sessions:read']);
    if (!principal.id) throw new UnauthorizedError();
    const identity = await services.repository.getUserIdentity(principal.id);
    if (!identity)
      throw new ApplicationError(
        'catalog_unavailable',
        'Sign in with Jellyfin to view profiles',
        403
      );
    return {
      defaultProfileId: identity.value.defaultProfileId,
      items: (await services.profiles.list()).filter((profile) =>
        identity.value.allowedProfileIds.includes(profile.profileId)
      )
    };
  });

  app.get('/api/v1/users', async (request) => {
    const principal = await authenticate(request, ['admin']);
    if (!principal.roles.includes('owner') && principal.kind !== 'recovery_session')
      throw new UnauthorizedError('Owner access is required');
    return { items: await services.auth.listUsers() };
  });

  app.patch('/api/v1/users/:userId', async (request) => {
    const principal = await mutate(request, ['admin']);
    if (!principal.roles.includes('owner') && principal.kind !== 'recovery_session')
      throw new UnauthorizedError('Owner access is required');
    const body = parse(UpdateUserRequestSchema, request.body);
    const userId = (request.params as { userId: string }).userId;
    return auditAs(
      request,
      principal,
      {
        category: 'authorization',
        action: 'user.access.update',
        target: { type: 'user', id: userId },
        context: {
          roleCount: body.roles.length,
          profileEntitlementCount: body.allowedProfileIds.length
        }
      },
      () =>
        services.auth.updateUser(userId, body.expectedRevision, {
          roles: body.roles,
          allowedProfileIds: body.allowedProfileIds,
          ...(body.defaultProfileId ? { defaultProfileId: body.defaultProfileId } : {})
        })
    );
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

  app.get('/api/v1/configuration/runtime', async (request) => {
    await authenticate(request, ['admin']);
    return publicRuntimeConfiguration(config, runtimeRestartRequired);
  });
  app.post('/api/v1/configuration/runtime/validate', async (request) => {
    await mutate(request, ['admin']);
    const configuration = validateRuntimeConfiguration(
      config,
      parse(RuntimeConfigurationUpdateRequestSchema, request.body)
    );
    return { valid: true, configuration };
  });
  app.put('/api/v1/configuration/runtime', async (request) => {
    const principal = await mutate(request, ['admin']);
    if (!config.runtimeConfigPath)
      throw new ApplicationError(
        'configuration_read_only',
        'Runtime configuration is managed by the deployment environment',
        409
      );
    const result = await auditAs(
      request,
      principal,
      {
        category: 'backend',
        action: 'runtime.configuration.stage',
        target: { type: 'runtime-configuration' },
        success: () => ({ context: { restartRequired: true } })
      },
      async () => {
        const configuration = await persistRuntimeConfiguration(
          config,
          parse(RuntimeConfigurationUpdateRequestSchema, request.body)
        );
        runtimeRestartRequired = true;
        return {
          ...publicRuntimeConfiguration({ ...config, ...configuration }, true),
          configuration
        };
      }
    );
    return result;
  });
  app.post('/api/v1/configuration/runtime/restart', async (request, reply) => {
    const principal = await mutate(request, ['admin']);
    if (config.restartMode !== 'exit')
      throw new ApplicationError(
        'restart_not_supported',
        'This deployment must be restarted by its service manager',
        409
      );
    const result = await auditAs(
      request,
      principal,
      {
        category: 'backend',
        action: 'runtime.restart',
        target: { type: 'runtime' }
      },
      async () => ({ restarting: true as const })
    );
    void reply.send(result);
    const timer = setTimeout(() => process.exit(RUNTIME_RESTART_EXIT_CODE), 250);
    timer.unref();
    return reply;
  });

  app.get('/api/v1/nodes', async (request) => {
    await authenticate(request, ['sessions:read']);
    return {
      items: (await services.cluster.list()).map((node) => ({
        ...node,
        agent:
          surface === 'standalone' && node.id === config.nodeId
            ? { connected: true }
            : (services.agentController?.status(node.id) ?? { connected: false })
      }))
    };
  });
  app.post('/api/v1/nodes/join-tokens', async (request, reply) => {
    const principal = await mutate(request, ['admin']);
    const result = await auditAs(
      request,
      principal,
      {
        category: 'cluster',
        action: 'node.join-token.create',
        target: { type: 'node-join-token' },
        success: (created) => ({ context: { expiresAt: created.expiresAt } })
      },
      () => services.cluster.createJoinToken(parse(CreateNodeJoinTokenRequestSchema, request.body))
    );
    return reply.status(201).send(result);
  });
  app.post(
    '/api/v1/nodes/enroll',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const result = await auditedOperation(
        services.audit,
        {
          category: 'cluster',
          action: 'node.enroll',
          actor: { type: 'node' },
          onAuditWriteFailure: (failure) => reportAuditWriteFailure(request, failure),
          success: (enrollment) => ({
            target: { type: 'node', id: enrollment.node.id },
            context: {
              region: enrollment.node.region,
              roles: enrollment.node.roles.join(','),
              certificateIssued: Boolean(enrollment.certificate)
            }
          })
        },
        async () => {
          const body = parse(EnrollNodeRequestSchema, request.body);
          assertProductionNodePublicUrl(config, body.publicUrl);
          return services.cluster.enroll({
            token: body.token,
            name: body.name,
            publicUrl: body.publicUrl,
            capabilities: body.capabilities,
            csrPem: body.csrPem,
            ...(body.internalUrl ? { internalUrl: body.internalUrl } : {})
          });
        }
      );
      return reply.status(201).send(result);
    }
  );
  app.post('/api/v1/nodes/:nodeId/drain', async (request) => {
    const principal = await mutate(request, ['admin']);
    const nodeId = (request.params as { nodeId: string }).nodeId;
    const { draining } = parse(NodeDrainRequestSchema, request.body);
    const result = await auditAs(
      request,
      principal,
      {
        category: 'cluster',
        action: 'node.drain',
        target: { type: 'node', id: nodeId },
        success: (outcome) => ({
          context: {
            state: outcome.node.state,
            commandAcknowledged: outcome.commandAcknowledged
          }
        })
      },
      () =>
        setNodeDrainWithDelivery(
          services,
          nodeId,
          draining,
          surface === 'standalone' ? config.nodeId : undefined
        )
    );
    return result.node;
  });
  app.post('/api/v1/nodes/:nodeId/certificate/rotate', async (request) => {
    const principal = await mutate(request, ['admin']);
    parse(RotateNodeCertificateRequestSchema, request.body ?? {});
    const nodeId = (request.params as { nodeId: string }).nodeId;
    return auditAs(
      request,
      principal,
      {
        category: 'cluster',
        action: 'node.certificate.rotate',
        target: { type: 'node', id: nodeId },
        success: (result) => ({ context: { expiresAt: result.certificateExpiresAt } })
      },
      () => rotateNodeCertificateWithDelivery(services, nodeId)
    );
  });
  app.post('/api/v1/nodes/:nodeId/revoke', async (request) => {
    const principal = await mutate(request, ['admin']);
    const nodeId = (request.params as { nodeId: string }).nodeId;
    return auditAs(
      request,
      principal,
      {
        category: 'cluster',
        action: 'node.revoke',
        target: { type: 'node', id: nodeId }
      },
      async () => {
        const node = await services.cluster.revoke(nodeId);
        services.agentController?.disconnect(nodeId, 'Node revoked by administrator');
        return node;
      }
    );
  });
  app.get('/api/v1/nodes/:nodeId/logs', async (request) => {
    await authenticate(request, ['admin']);
    const query = parse(NodeLogsQuerySchema, request.query);
    return {
      items: await services.cluster.logs((request.params as { nodeId: string }).nodeId, query.limit)
    };
  });
  app.delete('/api/v1/nodes/:nodeId', async (request, reply) => {
    const principal = await mutate(request, ['admin']);
    const nodeId = (request.params as { nodeId: string }).nodeId;
    await auditAs(
      request,
      principal,
      {
        category: 'cluster',
        action: 'node.remove',
        target: { type: 'node', id: nodeId }
      },
      () => services.cluster.remove(nodeId)
    );
    services.agentController?.disconnect(nodeId, 'Node removed by administrator');
    return reply.status(204).send();
  });
  app.post('/api/v1/placement/preview', async (request) => {
    const principal = await authenticate(request, ['sessions:create']);
    return auditAs(
      request,
      principal,
      {
        category: 'cluster',
        action: 'placement.preview',
        success: (placement) => ({
          outcome: placement.node ? 'success' : 'failure',
          ...(placement.node ? { target: { type: 'node', id: placement.node.id } } : {}),
          context: {
            available: Boolean(placement.node),
            reason: placement.reason
          }
        })
      },
      async () => {
        const body = parse(PlacementPreviewRequestSchema, request.body);
        const profile = await services.repository.getProfile(body.profileId, body.profileRevision);
        if (!profile)
          throw new ApplicationError('not_found', 'Profile revision was not found', 404);
        return services.cluster.previewPlacement({
          policy: body.placementPolicy,
          profile,
          ...(isPlacementNodeConnected ? { isNodeConnected: isPlacementNodeConnected } : {}),
          ...(body.providerId ? { providerId: body.providerId } : {}),
          ...(body.placementPolicy === 'local'
            ? { preferredNodeId: config.nodeId }
            : body.preferredNodeId
              ? { preferredNodeId: body.preferredNodeId }
              : {}),
          ...(body.preferredRegion ? { preferredRegion: body.preferredRegion } : {})
        });
      }
    );
  });

  app.get('/api/v1/provider-bindings', async (request) => {
    await authenticate(request, ['admin']);
    const providerId = (request.query as { providerId?: string }).providerId;
    return { items: (await services.cluster.bindings(providerId)).map(publicProviderBinding) };
  });
  app.post('/api/v1/provider-bindings', async (request, reply) => {
    const principal = await mutate(request, ['admin']);
    const result = await auditAs(
      request,
      principal,
      {
        category: 'provider',
        action: 'provider-binding.create',
        success: (created) => ({
          target: { type: 'provider-binding', id: created.binding.id },
          context: {
            providerId: created.binding.providerId,
            nodeId: created.binding.nodeId
          }
        })
      },
      async () => {
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
        let creation:
          | { creationMode: 'new'; expectedProviderRevision: null }
          | { creationMode: 'existing'; expectedProviderRevision: number };
        if (body.providerId) {
          const provider = await services.repository.getVersionedProvider(body.providerId);
          if (!provider)
            throw new ApplicationError('not_found', 'Provider connection was not found', 404);
          creation = {
            creationMode: 'existing',
            expectedProviderRevision: provider.revision
          };
        } else {
          creation = { creationMode: 'new', expectedProviderRevision: null };
        }
        return services.agentController.call<{
          provider: unknown;
          binding: import('@vrrelay/domain').ProviderBinding;
        }>(body.nodeId, 'provider.bind', {
          nodeId: body.nodeId,
          providerId,
          bindingId,
          ...creation,
          input: { ...body, baseUrl: policy.normalizedUrl }
        });
      }
    );
    return reply
      .status(201)
      .send({ provider: result.provider, binding: publicProviderBinding(result.binding) });
  });
  app.delete('/api/v1/provider-bindings/:bindingId', async (request, reply) => {
    const principal = await mutate(request, ['admin']);
    const bindingId = (request.params as { bindingId: string }).bindingId;
    const { acknowledgeOrphanedCredential } = parse(
      DeleteProviderBindingQuerySchema,
      request.query
    );
    await auditAs(
      request,
      principal,
      {
        category: 'provider',
        action: 'provider-binding.delete',
        target: { type: 'provider-binding', id: bindingId },
        context: { orphanAcknowledgementRequested: acknowledgeOrphanedCredential },
        success: (result) => ({
          context: providerBindingDeletionAuditContext(result)
        })
      },
      () =>
        deleteProviderBindingWithCredentialCleanup(
          services,
          bindingId,
          acknowledgeOrphanedCredential
        )
    );
    return reply.status(204).send();
  });

  app.get('/api/v1/sessions', async (request) => {
    const principal = await authenticate(request, ['sessions:read']);
    const items = await services.sessions.list();
    const systemWide =
      principal.kind === 'personal_token' ||
      principal.roles.some((role) => role === 'operator' || role === 'admin' || role === 'owner');
    const visible = systemWide
      ? items
      : items.filter((session) => session.ownerId === principal.id);
    return { items: visible, runtime: await services.sessions.listRuntimeStats(visible) };
  });
  app.get('/api/v1/sessions/:sessionId', async (request) => {
    const principal = await authenticate(request, ['sessions:read']);
    const session = await services.sessions.get(
      (request.params as { sessionId: string }).sessionId
    );
    const systemWide =
      principal.kind === 'personal_token' ||
      principal.roles.some((role) => role === 'operator' || role === 'admin' || role === 'owner');
    if (!systemWide && session.ownerId !== principal.id)
      throw new ApplicationError('not_found', 'Session was not found', 404);
    return session;
  });
  app.get('/api/v1/vod-producers', async (request) => {
    await authenticate(request, ['admin']);
    return { items: await services.sessions.listProducers() };
  });
  app.get('/api/v1/vod-producers/:sessionId', async (request) => {
    const principal = await authenticate(request, ['sessions:read']);
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const session = await services.sessions.get(sessionId);
    const systemWide =
      principal.kind === 'personal_token' ||
      principal.roles.some((role) => role === 'operator' || role === 'admin' || role === 'owner');
    if (!systemWide && session.ownerId !== principal.id)
      throw new ApplicationError('not_found', 'Producer was not found', 404);
    const producer = await services.sessions.producer(sessionId);
    if (!producer) throw new ApplicationError('not_found', 'Producer was not found', 404);
    return producer;
  });
  app.post('/api/v1/sessions', async (request, reply) => {
    const principal = await mutate(request, ['sessions:create']);
    const session = await auditAs(
      request,
      principal,
      {
        category: 'session',
        action: 'session.create',
        success: (created) => ({
          target: { type: 'session', id: created.id },
          context: {
            kind: created.kind,
            profileId: created.profileId,
            profileRevision: created.profileRevision,
            assignedNodeId: created.assignedNodeId ?? null
          }
        })
      },
      async () => {
        const body = parse(CreateSessionRequestSchema, request.body);
        body.placementLocked = Boolean(body.preferredNodeId);
        if (principal.kind === 'jellyfin_session') {
          if (body.kind === 'vod' && body.source.providerId !== principal.providerId)
            throw new ApplicationError(
              'invalid_provider',
              'Source does not belong to the signed-in provider',
              409
            );
          const identity = principal.id
            ? await services.repository.getUserIdentity(principal.id)
            : undefined;
          if (!identity?.value.allowedProfileIds.includes(body.profileId))
            throw new ApplicationError(
              'profile_not_allowed',
              'Profile is not available to this user',
              403
            );
          if (body.kind === 'live') {
            const channel = await services.repository.getLiveChannel(body.liveChannelId);
            if (!channel || channel.ownerId !== principal.id)
              throw new ApplicationError('not_found', 'Live channel was not found', 404);
            return services.sessions.create(
              { ...body, placementPolicy: 'local', placementLocked: true },
              { ownerId: principal.id! }
            );
          }
          if (surface === 'standalone')
            return services.sessions.create(
              {
                ...body,
                placementPolicy: 'local',
                preferredNodeId: config.nodeId,
                placementLocked: true
              },
              {
                ownerId: principal.id!,
                providerAccessToken: await services.auth.credential(principal),
                providerUserId: principal.providerUserId!
              }
            );
          const profile = await services.repository.getProfile(
            body.profileId,
            body.profileRevision
          );
          if (!profile)
            throw new ApplicationError('not_found', 'Profile revision was not found', 404);
          const placement = await services.cluster.previewPlacement({
            policy: 'auto',
            providerId: body.source.providerId,
            profile,
            ...(isPlacementNodeConnected ? { isNodeConnected: isPlacementNodeConnected } : {}),
            ...(body.preferredRegion ? { preferredRegion: body.preferredRegion } : {})
          });
          if (!placement.node)
            throw new ApplicationError('placement_unavailable', placement.reason, 409);
          return services.sessions.create(
            {
              ...body,
              placementPolicy: 'auto',
              preferredNodeId: placement.node.id,
              placementLocked: false
            },
            {
              ownerId: principal.id!,
              providerAccessToken: await services.auth.credential(principal),
              providerUserId: principal.providerUserId!
            }
          );
        }
        if (body.kind === 'vod') {
          const profile = await services.repository.getProfile(
            body.profileId,
            body.profileRevision
          );
          if (!profile)
            throw new ApplicationError('not_found', 'Profile revision was not found', 404);
          const placement = await services.cluster.previewPlacement({
            policy: body.placementPolicy,
            providerId: body.source.providerId,
            profile,
            ...(isPlacementNodeConnected ? { isNodeConnected: isPlacementNodeConnected } : {}),
            ...(body.placementPolicy === 'local'
              ? { preferredNodeId: config.nodeId }
              : body.preferredNodeId
                ? { preferredNodeId: body.preferredNodeId }
                : {}),
            ...(body.preferredRegion ? { preferredRegion: body.preferredRegion } : {})
          });
          if (!placement.node)
            throw new ApplicationError('placement_unavailable', placement.reason, 409);
          if (body.placementPolicy !== 'local') body.preferredNodeId = placement.node.id;
        }
        return services.sessions.create(body);
      }
    );
    return reply.status(201).send(session);
  });
  app.delete('/api/v1/sessions/:sessionId', async (request, reply) => {
    const principal = await mutate(request, ['sessions:control']);
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const current = await services.sessions.get(sessionId);
    const systemWide =
      principal.kind === 'personal_token' ||
      principal.roles.some((role) => role === 'operator' || role === 'admin' || role === 'owner');
    if (!systemWide && current.ownerId !== principal.id)
      throw new ApplicationError('not_found', 'Session was not found', 404);
    await auditAs(
      request,
      principal,
      {
        category: 'session',
        action: 'session.delete',
        target: { type: 'session', id: sessionId }
      },
      () => services.sessions.delete(sessionId)
    );
    return reply.status(204).send();
  });
  app.patch('/api/v1/sessions/:sessionId', async (request) => {
    const principal = await mutate(request, ['sessions:control']);
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const current = await services.sessions.get(sessionId);
    const systemWide =
      principal.kind === 'personal_token' ||
      principal.roles.some((role) => role === 'operator' || role === 'admin' || role === 'owner');
    if (!systemWide && current.ownerId !== principal.id)
      throw new ApplicationError('not_found', 'Session was not found', 404);
    return auditAs(
      request,
      principal,
      {
        category: 'session',
        action: 'session.control',
        target: { type: 'session', id: sessionId },
        success: (session) => ({
          context: { state: session.state, pinned: session.pinned }
        })
      },
      () => {
        const body = parse(SessionControlRequestSchema, request.body);
        return services.sessions.control(sessionId, {
          ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
          ...(body.state !== undefined ? { state: body.state } : {})
        });
      }
    );
  });

  app.get('/api/v1/live-channels', async (request) => {
    const principal = await authenticate(request, ['sessions:read']);
    const systemWide =
      principal.kind === 'personal_token' ||
      principal.roles.some((role) => role === 'operator' || role === 'admin' || role === 'owner');
    return {
      items: await services.live.list(
        systemWide ? undefined : { ownerId: principal.id ?? '__no_identity__' }
      )
    };
  });
  app.post('/api/v1/live-channels', async (request, reply) => {
    const principal = await mutate(request, ['sessions:create']);
    return reply.status(201).send(
      await services.live.create(parse(CreateLiveChannelRequestSchema, request.body), {
        ...(principal.kind === 'jellyfin_session' && principal.id ? { ownerId: principal.id } : {})
      })
    );
  });
  app.post('/api/v1/live-channels/:channelId/publisher/replacement', async (request, reply) => {
    const principal = await mutate(request, ['sessions:control']);
    const channelId = (request.params as { channelId: string }).channelId;
    const channel = await services.repository.getLiveChannel(channelId);
    const systemWide =
      principal.kind === 'personal_token' ||
      principal.roles.some((role) => role === 'operator' || role === 'admin' || role === 'owner');
    if (!channel || (!systemWide && channel.ownerId !== principal.id))
      throw new ApplicationError('not_found', 'Live channel was not found', 404);
    return reply.status(201).send(await services.live.replacePublisher(channelId));
  });
  app.delete('/api/v1/live-channels/:channelId', async (request, reply) => {
    const principal = await mutate(request, ['sessions:control']);
    const channelId = (request.params as { channelId: string }).channelId;
    const channel = await services.repository.getLiveChannel(channelId);
    const systemWide =
      principal.kind === 'personal_token' ||
      principal.roles.some((role) => role === 'operator' || role === 'admin' || role === 'owner');
    if (!channel || (!systemWide && channel.ownerId !== principal.id))
      throw new ApplicationError('not_found', 'Live channel was not found', 404);
    await services.live.delete(channelId);
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
    const principal = await mutate(request, ['admin']);
    const token = await auditAs(
      request,
      principal,
      {
        category: 'token',
        action: 'personal-token.create',
        success: (created) => ({
          target: { type: 'personal-token', id: created.id },
          context: {
            scopeCount: created.scopes.length,
            expires: Boolean(created.expiresAt)
          }
        })
      },
      async () => {
        const body = parse(CreatePersonalTokenRequestSchema, request.body);
        return services.auth.createPersonalToken(body.name, body.scopes, body.expiresAt);
      }
    );
    return reply.status(201).send(token);
  });
  app.get('/api/v1/tokens', async (request) => {
    await authenticate(request, ['admin']);
    return { items: await services.auth.listPersonalTokens() };
  });
  app.delete('/api/v1/tokens/:tokenId', async (request, reply) => {
    const principal = await mutate(request, ['admin']);
    const tokenId = (request.params as { tokenId: string }).tokenId;
    await auditAs(
      request,
      principal,
      {
        category: 'token',
        action: 'personal-token.revoke',
        target: { type: 'personal-token', id: tokenId }
      },
      () => services.auth.revokePersonalToken(tokenId)
    );
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
  app.get('/api/v1/jobs/:jobId/logs', async (request) => {
    await authenticate(request, ['sessions:read']);
    const query = parse(JobLogsQuerySchema, request.query);
    return {
      items: await services.sessions.listJobLogs(
        (request.params as { jobId: string }).jobId,
        query.limit
      )
    };
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
    const principal = await mutate(request, ['admin']);
    return auditAs(
      request,
      principal,
      {
        category: 'backend',
        action: 'backend.activate',
        success: (status) => ({
          target: { type: 'backend', id: `${status.category}:${status.kind}` },
          context: {
            category: status.category,
            kind: status.kind,
            healthy: status.healthy,
            restartRequired: Boolean(status.restartRequired)
          }
        })
      },
      () => services.backends.activate(parse(BackendActivationRequestSchema, request.body))
    );
  });
  app.get('/api/v1/cache', async (request) => {
    await authenticate(request, ['sessions:read']);
    const query = parse(CacheInventoryQuerySchema, request.query);
    return cacheInventoryWithNodeTarget(services, query.nodeId);
  });
  app.delete('/api/v1/cache', async (request) => {
    await mutate(request, ['sessions:control']);
    const body = parse(CacheEvictionRequestSchema, request.body);
    return evictCacheWithNodeTarget(services, body);
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

  if (surface === 'standalone') registerStandaloneInternalRoutes(app, config, services);

  app.get('/play/:token/index.m3u8', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = tokenFromPath(request);
    const session = await services.sessions.touchViewer(token, viewerAffinity(request));
    const route = await services.cluster.selectEdge(
      session.id,
      session.preferredRegion,
      await viewerRegion(request)
    );
    if (surface === 'controller' && (!route || route.nodeId === config.nodeId))
      throw new ApplicationError(
        'edge_unavailable',
        'No edge is available to serve this playback session',
        503
      );
    const routedToEdge = route && route.nodeId !== config.nodeId;
    const edgeToken = routedToEdge
      ? await services.sessions.createEdgePlaybackGrant(token, route.nodeId)
      : token;
    const base = route
      ? `${route.publicUrl.replace(/\/$/, '')}/play/${edgeToken}/segment`
      : undefined;
    const manifest = await services.sessions.manifest(token, base);
    services.sessions.recordEgress(Buffer.byteLength(manifest), session.id);
    return reply.type('application/vnd.apple.mpegurl').send(manifest);
  });
  if (surface === 'standalone') {
    app.get('/play/:token/segment/:index.ts', async (request, reply) => {
      const params = request.params as { token: string; index: string };
      const segmentIndex = Number(params.index);
      const session = await services.sessions.touchViewer(
        params.token,
        viewerAffinity(request),
        segmentIndex
      );
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      const path = await services.sessions.segment(params.token, segmentIndex, controller.signal);
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
      const segmentIndex = Number(params.index);
      const session = await services.sessions.touchViewer(
        params.token,
        viewerAffinity(request),
        segmentIndex
      );
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      const path = await services.sessions.segment(params.token, segmentIndex, controller.signal);
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
      const session = await services.sessions.touchViewer(token, viewerAffinity(request));
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
      const session = await services.sessions.touchViewer(token, viewerAffinity(request));
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      reply.raw.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
      const output = payloadMeter((bytes) => services.sessions.recordEgress(bytes, session.id));
      output.pipe(reply.raw);
      await services.sessions
        .streamFragmentedMp4(token, output, controller.signal)
        .catch((error) => {
          output.destroy();
          throw error;
        });
    });
  }
  app.get('/play/:token/live.m3u8', async (request, reply) => {
    const token = tokenFromPath(request);
    const session = await services.sessions.touchViewer(token, viewerAffinity(request));
    const query = request.query as { edge?: string };
    if (surface === 'controller' || query.edge !== '1') {
      const route = await services.cluster.selectEdge(
        session.id,
        session.preferredRegion,
        await viewerRegion(request)
      );
      if (route && route.nodeId !== config.nodeId) {
        const edgeToken = await services.sessions.createEdgePlaybackGrant(token, route.nodeId);
        const target = `${route.publicUrl.replace(/\/$/, '')}/play/${edgeToken}/live.m3u8?edge=1`;
        const redirect = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\n${target}\n`;
        services.sessions.recordEgress(Buffer.byteLength(redirect), session.id);
        return reply.type('application/vnd.apple.mpegurl').send(redirect);
      }
    }
    if (surface === 'controller')
      throw new ApplicationError(
        'edge_unavailable',
        'No edge is available to serve this live playback session',
        503
      );
    const channel = await services.sessions.resolveLive(token);
    const response = await fetchLiveHlsWithPathRecovery(
      channel.path,
      `${config.mediaMtxHlsUrl}/${channel.path}/index.m3u8`
    );
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
  if (surface === 'standalone') {
    app.get('/play/:token/live/*', async (request, reply) => {
      const params = request.params as { token: string; '*': string };
      if (!params['*'] || params['*'].includes('..') || params['*'].includes('\\'))
        return reply.status(400).send();
      const session = await services.sessions.touchViewer(params.token, viewerAffinity(request));
      const channel = await services.sessions.resolveLive(params.token);
      const response = await fetchLiveHlsWithPathRecovery(
        channel.path,
        liveHlsUpstreamUrl(
          config.mediaMtxHlsUrl,
          channel.path,
          params['*'],
          request.query as Record<string, unknown>
        )
      );
      if (!response.ok || !response.body) {
        forgetLiveEdgePath(channel.path);
        return reply.status(response.status).send();
      }
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
  }

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
