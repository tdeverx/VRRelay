// SPDX-License-Identifier: GPL-3.0-or-later
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  ApplicationError,
  type LiveService,
  type MediaCapabilities,
  type MetricsSink,
  type SessionService
} from '@vrrelay/application';
import type { BackendStatus } from '@vrrelay/domain';
import type { RelayConfig } from '../config.js';
import {
  liveHlsUpstreamUrl,
  isInternalPeer,
  isLiveMediaResponse,
  isLoopbackPeer,
  mediaDeliveryRecorder,
  meteredReadable,
  redactRequestUrl
} from '../server.js';
import { PlaybackRequestTracker, logPlaybackRequest, safeRangeHeader } from '../request-logging.js';
import {
  frameworkClientError,
  shouldRateLimitRequest,
  SIGNED_GRANT_MAX_PARAMETER_LENGTH
} from '../request-policy.js';
import { LiveEdgePathManager } from '../live-edge-path-manager.js';

export type RoleReadinessDependency = Pick<
  BackendStatus,
  'category' | 'kind' | 'healthy' | 'checkedAt' | 'restartRequired'
>;

type RoleReadiness = {
  readiness?: () => Promise<RoleReadinessDependency[]>;
};

export type RoleServerServices = (
  | {
      kind: 'source-worker';
      sessions: SessionService;
      capabilities: MediaCapabilities;
      metrics: MetricsSink;
    }
  | {
      kind: 'ingest-origin';
      live: LiveService;
      capabilities: MediaCapabilities;
      metrics: MetricsSink;
    }
  | {
      kind: 'edge';
      sessions: SessionService;
      capabilities: MediaCapabilities;
      metrics: MetricsSink;
    }
) &
  RoleReadiness;

const mediaMtxAuthRequestSchema = z.object({
  action: z.string(),
  path: z.string(),
  protocol: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  token: z.string().optional()
});

function authorizeEdgeMediaMtxRead(
  input: z.infer<typeof mediaMtxAuthRequestSchema>,
  readToken: string
): boolean {
  if ((input.action !== 'read' && input.action !== 'playback') || input.user !== 'vrrelay-read')
    return false;
  const supplied = input.password ?? input.token ?? '';
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(readToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function metricsAuthorized(config: RelayConfig, request: FastifyRequest): boolean {
  if (!config.metricsToken) return false;
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expected = Buffer.from(config.metricsToken);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function registerRoleInternalRoutes(
  app: FastifyInstance,
  config: RelayConfig,
  services: RoleServerServices
): void {
  if (services.kind === 'source-worker') {
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
      request.log.info(
        {
          sourceRequest: {
            event: 'source.range.opened',
            nodeId: config.nodeId,
            ...(source.sessionId ? { sessionId: source.sessionId } : {}),
            ...(source.sourceRequestId ? { sourceRequestId: source.sourceRequestId } : {}),
            ...(source.producerGeneration !== undefined
              ? { producerGeneration: source.producerGeneration }
              : {}),
            range: safeRangeHeader(request.headers.range),
            status: source.status
          }
        },
        'source range opened'
      );
      reply.status(source.status);
      for (const [name, value] of Object.entries(source.headers)) reply.header(name, value);
      let transferredBytes = 0;
      const stream = source.sessionId
        ? meteredReadable(source.stream, (bytes) => {
            transferredBytes += bytes;
            services.sessions.recordIngress(bytes, source.sessionId);
          })
        : source.stream;
      stream.once('end', () =>
        request.log.debug(
          {
            sourceRequest: {
              event: 'source.range.completed',
              nodeId: config.nodeId,
              ...(source.sessionId ? { sessionId: source.sessionId } : {}),
              ...(source.sourceRequestId ? { sourceRequestId: source.sourceRequestId } : {}),
              ...(source.producerGeneration !== undefined
                ? { producerGeneration: source.producerGeneration }
                : {}),
              range: safeRangeHeader(request.headers.range),
              transferredBytes
            }
          },
          'source range completed'
        )
      );
      return reply.type(source.headers['content-type'] ?? 'application/octet-stream').send(stream);
    });
  }

  if (services.kind === 'ingest-origin') {
    app.post('/internal/mediamtx/auth', async (request, reply) => {
      if (!isInternalPeer(request.raw.socket.remoteAddress))
        return reply.status(403).send({
          error: {
            code: 'forbidden',
            message: 'Internal MediaMTX auth is private-network or loopback-only'
          }
        });
      const body = mediaMtxAuthRequestSchema.parse(request.body);
      return (await services.live.authorizeMediaMtx(body, config.mediaMtxReadToken))
        ? reply.status(204).send()
        : reply.status(401).send();
    });
  }

  if (services.kind === 'edge') {
    app.post('/internal/mediamtx/auth', async (request, reply) => {
      if (!isInternalPeer(request.raw.socket.remoteAddress))
        return reply.status(403).send({
          error: {
            code: 'forbidden',
            message: 'Internal MediaMTX auth is private-network or loopback-only'
          }
        });
      const body = mediaMtxAuthRequestSchema.parse(request.body);
      return authorizeEdgeMediaMtxRead(body, config.mediaMtxReadToken)
        ? reply.status(204).send()
        : reply.status(401).send();
    });
  }
}

export async function createRoleServer(
  config: RelayConfig,
  services: RoleServerServices
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.token'
        ],
        censor: '[REDACTED]'
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactRequestUrl(request.url),
            host: request.hostname
          };
        }
      }
    },
    trustProxy: config.trustedProxyCidrs,
    bodyLimit: 1_048_576,
    // Signed controller-to-edge grants are larger than Fastify's default route
    // parameter limit but remain capped to prevent unbounded routing work.
    routerOptions: { maxParamLength: SIGNED_GRANT_MAX_PARAMETER_LENGTH },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID()
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: '1 minute',
    allowList: (request) => !shouldRateLimitRequest(request.url)
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.status(400).send({
        error: {
          code: 'invalid_request',
          message: 'Request validation failed',
          requestId: request.id,
          details: { issues: error.issues }
        }
      });
    if (error instanceof ApplicationError)
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          details: error.details
        }
      });
    const clientError = frameworkClientError(error);
    if (clientError)
      return reply.status(clientError.statusCode).send({
        error: {
          code: clientError.code,
          message: clientError.message,
          requestId: request.id
        }
      });
    request.log.error({ err: error }, 'request failed');
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'The relay could not complete the request',
        requestId: request.id
      }
    });
  });

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    version: config.applicationVersion,
    role: services.kind,
    now: new Date().toISOString(),
    workers:
      'sessions' in services ? services.sessions.capacity() : { active: 0, limit: 0, queued: 0 }
  }));
  app.get('/api/v1/ready', async (_request, reply) => {
    const dependencies = (await services.readiness?.()) ?? [];
    const ready = dependencies.every((dependency) => dependency.healthy);
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      version: config.applicationVersion,
      now: new Date().toISOString(),
      workers:
        'sessions' in services ? services.sessions.capacity() : { active: 0, limit: 0, queued: 0 },
      dependencies,
      restartRequired: dependencies.some((dependency) => dependency.restartRequired)
    });
  });
  app.get('/metrics', async (request, reply) => {
    if (!metricsAuthorized(config, request)) return reply.status(401).send();
    return reply.type(services.metrics.contentType).send(await services.metrics.render());
  });

  registerRoleInternalRoutes(app, config, services);

  if (services.kind === 'edge') {
    const viewerAffinity = (request: FastifyRequest) =>
      services.sessions.viewerIdentity(request.ip, request.headers['user-agent']);
    const playbackRequests = new PlaybackRequestTracker();
    const liveEdgePaths = new LiveEdgePathManager({
      ...(config.liveOriginUrl ? { originUrl: config.liveOriginUrl } : {}),
      apiUrl: config.mediaMtxApiUrl,
      readToken: config.mediaMtxReadToken,
      ...(config.liveOriginSrtPassphrase ? { srtPassphrase: config.liveOriginSrtPassphrase } : {})
    });
    app.addHook('onClose', () => liveEdgePaths.close());
    const fetchLiveHlsWithPathRecovery = async (path: string, url: string): Promise<Response> => {
      return liveEdgePaths.fetchHls(path, url);
    };

    app.get('/play/:token/index.m3u8', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const token = (request.params as { token: string }).token;
      const affinity = await viewerAffinity(request);
      const session = await services.sessions.touchViewer(token, affinity);
      const base = `${config.playbackUrl.replace(/\/$/, '')}/play/${token}/segment`;
      const manifest = await services.sessions.manifest(token, base);
      logPlaybackRequest(request.log, playbackRequests, {
        sessionId: session.id,
        clientAffinity: affinity,
        resource: 'manifest',
        nodeId: config.nodeId
      });
      services.sessions.recordEgress(Buffer.byteLength(manifest), session.id);
      return reply.type('application/vnd.apple.mpegurl').send(manifest);
    });
    app.get('/play/:token/segment/:index.ts', async (request, reply) => {
      const params = request.params as { token: string; index: string };
      const segmentIndex = Number(params.index);
      const affinity = await viewerAffinity(request);
      const observation = playbackRequests.observe(params.token, affinity, segmentIndex);
      const session = await services.sessions.touchViewer(
        params.token,
        affinity,
        segmentIndex,
        observation.change === 'seeked-forward' || observation.change === 'seeked-backward'
      );
      logPlaybackRequest(
        request.log,
        playbackRequests,
        {
          sessionId: session.id,
          clientAffinity: affinity,
          resource: 'segment',
          nodeId: config.nodeId,
          segmentIndex
        },
        observation
      );
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      const path = await services.sessions.segment(params.token, segmentIndex, controller.signal);
      const info = await stat(path);
      reply.header('Content-Length', info.size);
      reply.header('Cache-Control', 'private, no-store');
      return reply.type('video/mp2t').send(
        meteredReadable(
          createReadStream(path),
          mediaDeliveryRecorder(services.sessions, session.id, (error) =>
            request.log.debug({ err: error }, 'playback activity update failed')
          )
        )
      );
    });
    app.get('/play/:token/segment/:index.m4s', async (request, reply) => {
      const params = request.params as { token: string; index: string };
      const segmentIndex = Number(params.index);
      const affinity = await viewerAffinity(request);
      const observation = playbackRequests.observe(params.token, affinity, segmentIndex);
      const session = await services.sessions.touchViewer(
        params.token,
        affinity,
        segmentIndex,
        observation.change === 'seeked-forward' || observation.change === 'seeked-backward'
      );
      logPlaybackRequest(
        request.log,
        playbackRequests,
        {
          sessionId: session.id,
          clientAffinity: affinity,
          resource: 'segment',
          nodeId: config.nodeId,
          segmentIndex
        },
        observation
      );
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      const path = await services.sessions.segment(params.token, segmentIndex, controller.signal);
      const info = await stat(path);
      reply.header('Content-Length', info.size);
      reply.header('Cache-Control', 'private, no-store');
      return reply.type('video/iso.segment').send(
        meteredReadable(
          createReadStream(path),
          mediaDeliveryRecorder(services.sessions, session.id, (error) =>
            request.log.debug({ err: error }, 'playback activity update failed')
          )
        )
      );
    });
    app.get('/play/:token/segment/init.mp4', async (request, reply) => {
      const token = (request.params as { token: string }).token;
      const affinity = await viewerAffinity(request);
      const session = await services.sessions.touchViewer(token, affinity);
      logPlaybackRequest(request.log, playbackRequests, {
        sessionId: session.id,
        clientAffinity: affinity,
        resource: 'init',
        nodeId: config.nodeId
      });
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      const path = await services.sessions.initSegment(token, controller.signal);
      const info = await stat(path);
      reply.header('Content-Length', info.size);
      reply.header('Cache-Control', 'private, no-store');
      return reply
        .type('video/mp4')
        .send(
          meteredReadable(createReadStream(path), (bytes) =>
            services.sessions.recordEgress(bytes, session.id)
          )
        );
    });
    app.get('/play/:token/live.m3u8', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const token = (request.params as { token: string }).token;
      const affinity = await viewerAffinity(request);
      const session = await services.sessions.touchViewer(token, affinity);
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
      logPlaybackRequest(request.log, playbackRequests, {
        sessionId: session.id,
        clientAffinity: affinity,
        resource: 'live-manifest',
        nodeId: config.nodeId
      });
      services.sessions.recordEgress(Buffer.byteLength(playlist), session.id);
      return reply.type('application/vnd.apple.mpegurl').send(playlist);
    });
    app.get('/play/:token/live/*', async (request, reply) => {
      const params = request.params as { token: string; '*': string };
      if (!params['*'] || params['*'].includes('..') || params['*'].includes('\\'))
        return reply.status(400).send();
      const session = await services.sessions.touchViewer(
        params.token,
        await viewerAffinity(request)
      );
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
        return reply.status(response.status).send();
      }
      reply.header('Cache-Control', 'private, no-store');
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const record = isLiveMediaResponse(params['*'], contentType)
        ? mediaDeliveryRecorder(services.sessions, session.id, (error) =>
            request.log.debug({ err: error }, 'playback activity update failed')
          )
        : (bytes: number) => services.sessions.recordEgress(bytes, session.id);
      return reply
        .type(contentType)
        .send(
          meteredReadable(
            Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
            record
          )
        );
    });
  }

  return app;
}
