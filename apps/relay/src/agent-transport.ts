// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  AgentEnvelopeSchema,
  NodeCapabilitySchema,
  type AgentEnvelope,
  type NodeCapability
} from '@vrrelay/domain';
import type {
  CertificateAuthority,
  RemoteProviderGateway,
  RemoteSegmentCommand,
  RemoteSegmentDispatcher,
  SecretStore
} from '@vrrelay/application';
import { ClusterService } from '@vrrelay/application';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_MESSAGES_PER_MINUTE = 240;
const REQUEST_TIMEOUT_MS = 125_000;
const ROTATE_BEFORE_MS = 48 * 60 * 60_000;
const ROTATION_COOLDOWN_MS = 5 * 60_000;

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
}

function payloadText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

interface AgentConnection {
  socket: WebSocket;
  nodeId: string;
  lastSequence: number;
  nextSequence: number;
  connectedAt: string;
  messageWindowStartedAt: number;
  messageCount: number;
}

interface PendingRequest {
  kind: AgentEnvelope['kind'];
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AgentController implements RemoteSegmentDispatcher, RemoteProviderGateway {
  readonly #connections = new Map<string, AgentConnection>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #lastCertificateRotation = new Map<string, number>();
  #server: HttpsServer | undefined;
  #unsubscribe?: () => Promise<void>;
  #ensureHandler?: (token: string, segmentIndex: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly cluster: ClusterService,
    private readonly certificates: CertificateAuthority,
    private readonly coordination: {
      subscribe(channel: string, listener: (payload: string) => void): Promise<() => Promise<void>>;
    }
  ) {}

  connected(nodeId: string): boolean {
    return this.#connections.get(nodeId)?.socket.readyState === WebSocket.OPEN;
  }
  setEnsureHandler(
    handler: (token: string, segmentIndex: number, signal?: AbortSignal) => Promise<void>
  ): void {
    this.#ensureHandler = handler;
  }

  status(nodeId: string): { connected: boolean; connectedAt?: string } {
    const connection = this.#connections.get(nodeId);
    return connection
      ? { connected: true, connectedAt: connection.connectedAt }
      : { connected: false };
  }
  address(): AddressInfo | undefined {
    const address = this.#server?.address();
    return address && typeof address !== 'string' ? address : undefined;
  }

  async start(host: string, port: number, tlsNames: readonly string[]): Promise<void> {
    if (this.#server) return;
    const serverIdentity = await this.certificates.issue(
      'controller:agent',
      30 * 24 * 60 * 60_000,
      tlsNames
    );
    const ca = await this.certificates.caCertificate();
    const server = createServer({
      key: serverIdentity.privateKeyPem,
      cert: serverIdentity.certificatePem,
      ca,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    });
    // Agent processes can disappear mid-handshake or while a frame is being
    // read. HTTPS otherwise leaves some TLS socket errors unobserved, which can
    // terminate the controller process on a routine node restart.
    server.on('tlsClientError', (_error, socket) => socket.destroy());
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('secureConnection', (socket) => socket.on('error', () => undefined));
    const sockets = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false
    });
    server.on('upgrade', (request, socket, head) => {
      const rejectUpgrade = (status: number, reason: string) => {
        socket.end(
          `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
        );
      };
      if (request.url !== '/api/v1/nodes/connect') return rejectUpgrade(404, 'Not Found');
      void this.#authenticate(request)
        .then((nodeId) => {
          if (!nodeId) return rejectUpgrade(401, 'Unauthorized');
          sockets.handleUpgrade(request, socket, head, (ws) => this.#accept(nodeId, ws));
        })
        .catch(() => rejectUpgrade(401, 'Unauthorized'));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    this.#unsubscribe = await this.coordination.subscribe('cluster:revocations', (payload) => {
      try {
        const { nodeId } = JSON.parse(payload) as { nodeId: string };
        this.disconnect(nodeId, 'Certificate revoked');
      } catch {
        /* ignore malformed external event */
      }
    });
  }

  async stop(): Promise<void> {
    for (const nodeId of this.#connections.keys())
      this.disconnect(nodeId, 'Controller shutting down');
    await this.#unsubscribe?.();
    if (this.#server)
      await new Promise<void>((resolve, reject) =>
        this.#server!.close((error) => (error ? reject(error) : resolve()))
      );
    this.#server = undefined;
  }

  disconnect(nodeId: string, reason: string): void {
    const connection = this.#connections.get(nodeId);
    if (!connection) return;
    this.#connections.delete(nodeId);
    connection.socket.close(1008, reason.slice(0, 120));
  }

  async dispatch(
    nodeId: string,
    command: RemoteSegmentCommand,
    signal?: AbortSignal
  ): Promise<void> {
    await this.request(
      nodeId,
      'job.offer',
      command as unknown as Record<string, unknown>,
      REQUEST_TIMEOUT_MS,
      signal
    );
  }

  async cancel(nodeId: string, jobId: string): Promise<void> {
    await this.request(nodeId, 'job.cancel', { jobId }, 10_000).catch(() => undefined);
  }

  async call<T>(
    nodeId: string,
    operation:
      | 'provider.bind'
      | 'provider.unbind'
      | 'provider.browse'
      | 'provider.item'
      | 'provider.validate'
      | 'provider.activity',
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    return (await this.request(nodeId, operation, payload, 60_000, signal)) as T;
  }

  async request(
    nodeId: string,
    kind: AgentEnvelope['kind'],
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
    signal?: AbortSignal
  ) {
    const connection = this.#connections.get(nodeId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN)
      throw new Error(`Node ${nodeId} is not connected`);
    const id = randomUUID();
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Node request timed out: ${kind}`));
      }, timeoutMs);
      this.#pending.set(id, { kind, resolve, reject, timer });
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(signal.reason ?? new Error('Request aborted'));
        },
        { once: true }
      );
    });
    this.#send(connection, kind, payload, { id, deadlineAt });
    return promise;
  }

  async #authenticate(request: IncomingMessage): Promise<string | undefined> {
    const socket = request.socket as TLSSocket;
    if (!socket.authorized) return undefined;
    const peer = socket.getPeerCertificate();
    const commonName = Array.isArray(peer.subject?.CN) ? peer.subject.CN[0] : peer.subject?.CN;
    const uriIdentity = peer.subjectaltname
      ?.split(', ')
      .find((value) => value.startsWith('URI:urn:vrrelay:node:'))
      ?.slice('URI:urn:vrrelay:node:'.length);
    const nodeId = commonName?.startsWith('node:') ? commonName.slice(5) : uriIdentity;
    if (!nodeId || !peer.serialNumber || !peer.raw) return undefined;
    const serial = peer.serialNumber.replaceAll(':', '').toLowerCase();
    const fingerprint = createHash('sha256').update(peer.raw).digest('hex');
    return (await this.cluster.certificateIsActive(nodeId, serial, fingerprint))
      ? nodeId
      : undefined;
  }

  #accept(nodeId: string, socket: WebSocket): void {
    this.disconnect(nodeId, 'Replaced by a newer connection');
    const connection: AgentConnection = {
      socket,
      nodeId,
      lastSequence: 0,
      nextSequence: 1,
      connectedAt: new Date().toISOString(),
      messageWindowStartedAt: Date.now(),
      messageCount: 0
    };
    this.#connections.set(nodeId, connection);
    socket.on('message', (data, binary) => {
      const raw = rawText(data);
      if (binary || Buffer.byteLength(raw) > MAX_MESSAGE_BYTES)
        return socket.close(1009, 'Message too large');
      void this.#message(connection, raw).catch(() => socket.close(1008, 'Invalid agent message'));
    });
    socket.on('close', () => {
      if (this.#connections.get(nodeId) === connection) this.#connections.delete(nodeId);
    });
    socket.on('error', () => {
      if (this.#connections.get(nodeId) === connection) this.#connections.delete(nodeId);
    });
  }

  async #message(connection: AgentConnection, raw: string): Promise<void> {
    const now = Date.now();
    if (now - connection.messageWindowStartedAt >= 60_000) {
      connection.messageWindowStartedAt = now;
      connection.messageCount = 0;
    }
    connection.messageCount += 1;
    if (connection.messageCount > MAX_MESSAGES_PER_MINUTE)
      throw new Error('Agent message rate limit exceeded');
    const message = AgentEnvelopeSchema.parse(JSON.parse(raw));
    if (message.sequence <= connection.lastSequence) throw new Error('Replayed agent message');
    if (Math.abs(Date.now() - Date.parse(message.sentAt)) > 60_000)
      throw new Error('Agent message timestamp is outside the allowed clock skew');
    if (message.deadlineAt && Date.parse(message.deadlineAt) < Date.now())
      throw new Error('Expired agent message');
    connection.lastSequence = message.sequence;
    if (message.replyTo) {
      const pending = this.#pending.get(message.replyTo);
      if (!pending) return;
      if (
        pending.kind === 'job.offer' &&
        (message.kind === 'job.accept' || message.kind === 'job.progress')
      )
        return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.replyTo);
      if (
        message.kind === 'error' ||
        message.kind === 'job.reject' ||
        message.kind === 'job.fail' ||
        message.payload.ok === false
      )
        pending.reject(new Error(payloadText(message.payload.message, 'Node request failed')));
      else pending.resolve(message.payload);
      return;
    }
    if (
      message.kind === 'heartbeat' ||
      message.kind === 'capabilities' ||
      message.kind === 'hello'
    ) {
      const capabilities = message.payload.capabilities
        ? NodeCapabilitySchema.parse(message.payload.capabilities)
        : undefined;
      if (capabilities)
        await this.cluster.heartbeat(
          connection.nodeId,
          capabilities,
          message.payload.draining ? 'draining' : 'online'
        );
      this.#reply(connection, message, { ok: true });
      return;
    }
    if (message.kind === 'certificate.rotate') {
      const previous = this.#lastCertificateRotation.get(connection.nodeId) ?? 0;
      if (now - previous < ROTATION_COOLDOWN_MS)
        throw new Error('Certificate rotation rate limit exceeded');
      const certificate = await this.cluster.rotateCertificate(connection.nodeId);
      this.#lastCertificateRotation.set(connection.nodeId, now);
      this.#reply(connection, message, { ok: true, certificate });
      return;
    }
    if (message.kind === 'job.progress' && message.payload.action === 'ensure') {
      if (!this.#ensureHandler) throw new Error('Segment ensure handler is unavailable');
      await this.#ensureHandler(
        String(message.payload.token),
        Number(message.payload.segmentIndex)
      );
      this.#reply(connection, message, { ok: true });
      return;
    }
    if (message.kind === 'log') {
      await this.cluster.recordLog({
        id: message.id,
        nodeId: connection.nodeId,
        level: ['debug', 'info', 'warn', 'error'].includes(String(message.payload.level))
          ? (message.payload.level as 'debug' | 'info' | 'warn' | 'error')
          : 'info',
        message: redact(payloadText(message.payload.message)),
        context: redactAgentContext(message.payload.context),
        timestamp: message.sentAt
      });
      this.#reply(connection, message, { ok: true });
    }
  }

  #reply(
    connection: AgentConnection,
    request: AgentEnvelope,
    payload: Record<string, unknown>
  ): void {
    this.#send(connection, 'response', payload, { replyTo: request.id });
  }

  #send(
    connection: AgentConnection,
    kind: AgentEnvelope['kind'],
    payload: Record<string, unknown>,
    extra: { id?: string; replyTo?: string; deadlineAt?: string } = {}
  ): void {
    const message: AgentEnvelope = {
      version: 1,
      id: extra.id ?? randomUUID(),
      sequence: connection.nextSequence++,
      kind,
      sentAt: new Date().toISOString(),
      ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
      ...(extra.deadlineAt ? { deadlineAt: extra.deadlineAt } : {}),
      payload
    };
    connection.socket.send(JSON.stringify(message));
  }
}

interface StoredNodeIdentity {
  nodeId: string;
  certificatePem: string;
  privateKeyPem: string;
  caCertificatePem: string;
  expiresAt: string;
}

export interface NodeAgentOptions {
  controllerUrl: string;
  enrollmentUrl: string;
  joinToken?: string;
  nodeName: string;
  publicUrl: string;
  internalUrl?: string;
  secretStore: SecretStore;
  capabilities: () => Promise<NodeCapability>;
  onSegment: (command: RemoteSegmentCommand, signal: AbortSignal) => Promise<void>;
  onCancel: (jobId: string) => Promise<void>;
  onProvider: (
    operation:
      | 'provider.bind'
      | 'provider.unbind'
      | 'provider.browse'
      | 'provider.item'
      | 'provider.validate'
      | 'provider.activity',
    payload: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
}

export class NodeAgent {
  #socket?: WebSocket;
  #stopping = false;
  #sequence = 1;
  #lastReceivedSequence = 0;
  #heartbeat?: NodeJS.Timeout;
  #reconnect: NodeJS.Timeout | undefined;
  #attempt = 0;
  readonly #jobs = new Map<string, AbortController>();
  readonly #pending = new Map<string, PendingRequest>();

  constructor(private readonly options: NodeAgentOptions) {}

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#connect();
  }
  async ensure(token: string, segmentIndex: number, signal?: AbortSignal): Promise<void> {
    await this.#request('job.progress', { action: 'ensure', token, segmentIndex }, 125_000, signal);
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#reconnect) clearTimeout(this.#reconnect);
    for (const job of this.#jobs.values()) job.abort(new Error('Node agent stopped'));
    this.#jobs.clear();
    this.#socket?.close(1000, 'Node stopping');
  }

  async #identity(): Promise<StoredNodeIdentity> {
    try {
      return JSON.parse(
        await this.options.secretStore.get('cluster:node-identity')
      ) as StoredNodeIdentity;
    } catch (error) {
      if (!this.options.joinToken) throw error;
      const response = await fetch(
        `${this.options.enrollmentUrl.replace(/\/$/, '')}/api/v1/nodes/enroll`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: this.options.joinToken,
            name: this.options.nodeName,
            publicUrl: this.options.publicUrl,
            ...(this.options.internalUrl ? { internalUrl: this.options.internalUrl } : {}),
            capabilities: await this.options.capabilities()
          })
        }
      );
      if (!response.ok) throw new Error(`Node enrollment failed (${response.status})`);
      const body = (await response.json()) as {
        node: { id: string };
        certificate: Omit<StoredNodeIdentity, 'nodeId'>;
      };
      const identity = { nodeId: body.node.id, ...body.certificate };
      await this.options.secretStore.put('cluster:node-identity', JSON.stringify(identity));
      return identity;
    }
  }

  async #connect(): Promise<void> {
    if (this.#stopping) return;
    const identity = await this.#identity();
    const socket = new WebSocket(this.options.controllerUrl, {
      cert: identity.certificatePem,
      key: identity.privateKeyPem,
      ca: identity.caCertificatePem,
      rejectUnauthorized: true,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 15_000
    });
    this.#socket = socket;
    socket.once('open', () => void this.#opened(identity));
    socket.on('message', (data, binary) => {
      const raw = rawText(data);
      if (binary || Buffer.byteLength(raw) > MAX_MESSAGE_BYTES)
        return socket.close(1009, 'Message too large');
      void this.#message(raw).catch((error) =>
        this.#log('error', error instanceof Error ? error.message : String(error))
      );
    });
    socket.once('close', () => this.#scheduleReconnect());
    socket.once('error', () => this.#scheduleReconnect());
  }

  async #opened(identity: StoredNodeIdentity): Promise<void> {
    this.#attempt = 0;
    this.#sequence = 1;
    this.#lastReceivedSequence = 0;
    this.#send('hello', {
      nodeId: identity.nodeId,
      capabilities: await this.options.capabilities()
    });
    this.#heartbeat = setInterval(
      () =>
        void this.options
          .capabilities()
          .then((capabilities) => this.#send('heartbeat', { capabilities })),
      15_000
    );
    this.#heartbeat.unref();
    if (Date.parse(identity.expiresAt) - Date.now() <= ROTATE_BEFORE_MS)
      void this.#request('certificate.rotate', {}, 30_000).catch((error) =>
        this.#log('warn', error instanceof Error ? error.message : String(error))
      );
  }

  #scheduleReconnect(): void {
    if (this.#stopping || this.#reconnect) return;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    const delay =
      Math.min(30_000, 1_000 * 2 ** Math.min(this.#attempt++, 5)) + Math.floor(Math.random() * 500);
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      void this.#connect().catch(() => this.#scheduleReconnect());
    }, delay);
    this.#reconnect.unref();
  }

  async #message(raw: string): Promise<void> {
    const message = AgentEnvelopeSchema.parse(JSON.parse(raw));
    if (message.sequence <= this.#lastReceivedSequence)
      throw new Error('Replayed controller message');
    if (Math.abs(Date.now() - Date.parse(message.sentAt)) > 60_000)
      throw new Error('Controller message timestamp is outside the allowed clock skew');
    this.#lastReceivedSequence = message.sequence;
    if (message.deadlineAt && Date.parse(message.deadlineAt) < Date.now())
      return this.#reply(message, false, 'Command deadline expired');
    if (message.replyTo) {
      const pending = this.#pending.get(message.replyTo);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.replyTo);
      if (message.payload.certificate) {
        const current = await this.#identity();
        const certificate = message.payload.certificate as Omit<StoredNodeIdentity, 'nodeId'>;
        await this.options.secretStore.put(
          'cluster:node-identity',
          JSON.stringify({ nodeId: current.nodeId, ...certificate })
        );
      }
      if (message.kind === 'error' || message.payload.ok === false)
        pending.reject(
          new Error(payloadText(message.payload.message, 'Controller request failed'))
        );
      else pending.resolve(message.payload);
      return;
    }
    if (message.kind === 'job.offer') {
      const jobId = payloadText(message.payload.jobId);
      const sessionId = payloadText(message.payload.sessionId);
      const contentKey = payloadText(message.payload.contentKey);
      const segmentIndex = Number(message.payload.segmentIndex);
      if (
        !jobId ||
        !sessionId ||
        !contentKey ||
        !Number.isInteger(segmentIndex) ||
        segmentIndex < 0
      ) {
        this.#send('job.reject', { ok: false, message: 'Malformed segment job offer' }, message.id);
        return;
      }
      if (this.#jobs.has(jobId)) {
        this.#send(
          'job.reject',
          { ok: false, jobId, message: 'Segment job is already running' },
          message.id
        );
        return;
      }
      const command: RemoteSegmentCommand = { jobId, sessionId, contentKey, segmentIndex };
      const controller = new AbortController();
      this.#jobs.set(command.jobId, controller);
      this.#send('job.accept', { ok: true, jobId }, message.id);
      this.#send('job.progress', { ok: true, jobId, state: 'running' }, message.id);
      try {
        await this.options.onSegment(command, controller.signal);
        this.#send('job.complete', { ok: true, jobId }, message.id);
      } catch (error) {
        this.#send(
          'job.fail',
          {
            ok: false,
            jobId,
            message: redact(error instanceof Error ? error.message : String(error))
          },
          message.id
        );
      } finally {
        this.#jobs.delete(command.jobId);
      }
      return;
    }
    if (message.kind === 'job.cancel') {
      const jobId = payloadText(message.payload.jobId);
      this.#jobs.get(jobId)?.abort(new Error('Job cancelled by controller'));
      await this.options.onCancel(jobId);
      this.#reply(message, true);
      return;
    }
    if (
      [
        'provider.bind',
        'provider.unbind',
        'provider.browse',
        'provider.item',
        'provider.validate',
        'provider.activity'
      ].includes(message.kind)
    ) {
      try {
        const payload = await this.options.onProvider(
          message.kind as
            | 'provider.bind'
            | 'provider.unbind'
            | 'provider.browse'
            | 'provider.item'
            | 'provider.validate'
            | 'provider.activity',
          message.payload
        );
        this.#send('response', { ok: true, ...payload }, message.id);
      } catch (error) {
        this.#reply(message, false, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (message.kind === 'certificate.rotate') {
      // Administrative rotation is a controller command. Ask the controller
      // to issue the certificate through the normal node-initiated path so the
      // replacement is stored before acknowledging the outer command.
      await this.#request('certificate.rotate', {}, 30_000);
      this.#reply(message, true);
    }
  }

  #reply(request: AgentEnvelope, ok: boolean, message?: string): void {
    this.#send(
      ok ? 'response' : 'error',
      { ok, ...(message ? { message: redact(message) } : {}) },
      request.id
    );
  }
  #log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (this.#socket?.readyState === WebSocket.OPEN)
      this.#send('log', { level, message: redact(message), context: {} });
  }
  #send(kind: AgentEnvelope['kind'], payload: Record<string, unknown>, replyTo?: string): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    const envelope: AgentEnvelope = {
      version: 1,
      id: randomUUID(),
      sequence: this.#sequence++,
      kind,
      sentAt: new Date().toISOString(),
      ...(replyTo ? { replyTo } : {}),
      payload
    };
    this.#socket.send(JSON.stringify(envelope));
  }
  async #request(
    kind: AgentEnvelope['kind'],
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (this.#socket?.readyState !== WebSocket.OPEN)
      throw new Error('Controller agent connection is unavailable');
    const id = randomUUID();
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Controller request timed out: ${kind}`));
      }, timeoutMs);
      this.#pending.set(id, { kind, resolve, reject, timer });
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(signal.reason ?? new Error('Request aborted'));
        },
        { once: true }
      );
    });
    const envelope: AgentEnvelope = {
      version: 1,
      id,
      sequence: this.#sequence++,
      kind,
      sentAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
      payload
    };
    this.#socket.send(JSON.stringify(envelope));
    return promise;
  }
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bvrr_(?:join_)?[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(
      /(authorization|password|token|secret|api[-_ ]?key)["']?\s*[:=]\s*["']?[^\s,"'}]+/gi,
      '$1=[REDACTED]'
    )
    .slice(0, 2_000);
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth >= 6) return '[REDACTED:DEPTH]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        /authorization|password|token|secret|private.?key|api.?key/i.test(key)
          ? '[REDACTED]'
          : redactValue(item, depth + 1)
      ])
  );
}

export function redactAgentContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return redactValue(value) as Record<string, unknown>;
}
