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
import type { RelayConfig } from '../config.js';
import {
  liveHlsUpstreamUrl,
  liveOriginSourceUrl,
  isInternalPeer,
  isLoopbackPeer,
  meteredReadable,
  redactRequestUrl
} from '../server.js';

type RoleServerServices =
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
    };

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

function viewerIdentity(request: FastifyRequest): string {
  return `${request.ip}|${String(request.headers['user-agent'] ?? 'unknown').slice(0, 256)}`;
}

function metricsAuthorized(config: RelayConfig, request: FastifyRequest): boolean {
  if (!config.metricsToken) return false;
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expected = Buffer.from(config.metricsToken);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createRoleServer(
  config: RelayConfig,
  services: RoleServerServices
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.VRRELAY_LOG_LEVEL ?? 'info',
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
            host: request.hostname,
            remoteAddress: request.ip
          };
        }
      }
    },
    trustProxy: config.trustedProxyCidrs,
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID()
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });

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
    workers: 'sessions' in services ? services.sessions.capacity() : undefined
  }));
  app.get('/metrics', async (request, reply) => {
    if (!metricsAuthorized(config, request)) return reply.status(401).send();
    return reply.type(services.metrics.contentType).send(await services.metrics.render());
  });

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
      reply.status(source.status);
      for (const [name, value] of Object.entries(source.headers)) reply.header(name, value);
      return reply
        .type(source.headers['content-type'] ?? 'application/octet-stream')
        .send(source.stream);
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

    app.get('/play/:token/index.m3u8', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const token = (request.params as { token: string }).token;
      const session = await services.sessions.touchViewer(token, viewerIdentity(request));
      const base = `${config.playbackUrl.replace(/\/$/, '')}/play/${token}/segment`;
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
      const token = (request.params as { token: string }).token;
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
    app.get('/play/:token/live.m3u8', async (request, reply) => {
      const token = (request.params as { token: string }).token;
      const session = await services.sessions.touchViewer(token, viewerIdentity(request));
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
  }

  return app;
}
