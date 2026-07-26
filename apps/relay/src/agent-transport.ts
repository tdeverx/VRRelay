// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { createCertificateSigningRequest } from '@vrrelay/adapters';
import {
  AgentCacheEvictionResultSchema,
  AgentCacheInventoryResultSchema,
  AgentEnvelopeSchema,
  AgentSignedCertificateSchema,
  type AgentEnvelope,
  type AgentJsonObject,
  type AgentMessageKind
} from '@vrrelay/contracts';
import type { CachedObject, NodeCapability } from '@vrrelay/domain';
import type {
  CertificateAuthority,
  RemoteProviderGateway,
  RemoteSegmentCommand,
  RemoteSegmentDispatcher,
  SecretStore,
  SignedCertificate
} from '@vrrelay/application';
import { ClusterService } from '@vrrelay/application';
import { fetchWithTimeout } from './fetch-timeout.js';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_MESSAGES_PER_MINUTE = 240;
const REQUEST_TIMEOUT_MS = 125_000;
const ROTATE_BEFORE_MS = 48 * 60 * 60_000;
const ROTATION_COOLDOWN_MS = 5 * 60_000;
const STAGED_IDENTITY_TTL_MS = 5 * 60_000;
const HELLO_TIMEOUT_MS = 15_000;
const MAX_TIMER_MS = 2_147_000_000;
const MAX_PENDING_REQUESTS = 512;
const MAX_DECLARED_WORKERS = 32;
const CORRELATED_RESPONSES_PER_WORKER_MINUTE = 60;
const ROTATION_RETRY_MS = 5_000;
const SEGMENT_ENSURE_RETRY_DELAYS_MS = [250, 750] as const;
const NODE_IDENTITY_REFERENCE = 'cluster:node-identity';
const NODE_ENROLLMENT_REFERENCE = 'cluster:node-enrollment';
const NODE_ROTATION_REFERENCE = 'cluster:node-rotation';

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface PendingRequest {
  kind: AgentMessageKind;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  jobId?: string;
}

interface RateWindow {
  messageWindowStartedAt: number;
  messageCount: number;
}

interface AgentConnection extends RateWindow {
  socket: WebSocket;
  nodeId: string;
  serialNumber: string;
  fingerprintSha256: string;
  certificateExpiresAt: number;
  lastSequence: number;
  nextSequence: number;
  connectedAt: string;
  pending: Map<string, PendingRequest>;
  correlatedResponses: RateWindow;
  declaredMaxWorkers: number;
  stagedIdentity: StagedNodeIdentity | undefined;
  activatedStagedIdentity: StagedNodeIdentity | undefined;
  helloReceived: boolean;
  helloDeadline: NodeJS.Timeout | undefined;
  certificateExpiry: NodeJS.Timeout | undefined;
  messageQueue: Promise<void>;
  closed: boolean;
}

interface StagedNodeIdentity {
  certificate: SignedCertificate;
  csrSha256: string;
  stagedAt: number;
  expiry: NodeJS.Timeout;
}

interface AuthenticatedNodeIdentity {
  nodeId: string;
  serialNumber: string;
  fingerprintSha256: string;
  certificateExpiresAt: number;
  stagedIdentity: StagedNodeIdentity | undefined;
  activatedStagedIdentity: StagedNodeIdentity | undefined;
}

interface RotationWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function settlePending(
  pendingMap: Map<string, PendingRequest>,
  id: string,
  outcome: { value: unknown } | { error: Error }
): boolean {
  const pending = pendingMap.get(id);
  if (!pending) return false;
  pendingMap.delete(id);
  clearTimeout(pending.timer);
  if (pending.signal && pending.abortListener)
    pending.signal.removeEventListener('abort', pending.abortListener);
  if ('error' in outcome) pending.reject(outcome.error);
  else pending.resolve(outcome.value);
  return true;
}

function rejectAllPending(pendingMap: Map<string, PendingRequest>, error: Error): void {
  for (const id of [...pendingMap.keys()]) settlePending(pendingMap, id, { error });
}

function countMessage(window: RateWindow, maximum = MAX_MESSAGES_PER_MINUTE): void {
  const now = Date.now();
  if (now - window.messageWindowStartedAt >= 60_000) {
    window.messageWindowStartedAt = now;
    window.messageCount = 0;
  }
  window.messageCount += 1;
  if (window.messageCount > maximum) throw new Error('Agent protocol message rate limit exceeded');
}

export function agentMessageLimitForWorkers(
  maxWorkers: number,
  baseline = MAX_MESSAGES_PER_MINUTE
): number {
  const workers = Math.min(
    MAX_DECLARED_WORKERS,
    Math.max(1, Number.isFinite(maxWorkers) ? Math.floor(maxWorkers) : 1)
  );
  return Math.max(baseline, workers * CORRELATED_RESPONSES_PER_WORKER_MINUTE);
}

function validateMessageTiming(message: AgentEnvelope, lastSequence: number): void {
  if (message.sequence <= lastSequence) throw new Error('Replayed agent protocol message');
  if (Math.abs(Date.now() - Date.parse(message.sentAt)) > 60_000)
    throw new Error('Agent protocol timestamp is outside the allowed clock skew');
}

function protocolError(
  code: string,
  message: string,
  retryable = false
): { ok: false; error: { code: string; message: string; retryable: boolean } } {
  return { ok: false, error: { code, message: redact(message), retryable } };
}

function normalizeSerial(value: string): string {
  return value.replaceAll(':', '').toLowerCase().replace(/^0+/, '') || '0';
}

function stagedCertificateMatchesPeer(
  staged: StagedNodeIdentity,
  fingerprintSha256: string
): boolean {
  return staged.certificate.fingerprintSha256.toLowerCase() === fingerprintSha256.toLowerCase();
}

export class AgentController implements RemoteSegmentDispatcher, RemoteProviderGateway {
  readonly #connections = new Map<string, AgentConnection>();
  readonly #candidateConnections = new Set<AgentConnection>();
  readonly #stagedIdentities = new Map<string, StagedNodeIdentity>();
  readonly #lastCertificateRotation = new Map<string, number>();
  readonly #rotationWaiters = new Map<string, RotationWaiter>();
  #server: HttpsServer | undefined;
  #unsubscribe: (() => Promise<void>) | undefined;
  #ensureHandler?: (token: string, segmentIndex: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly cluster: ClusterService,
    private readonly certificates: CertificateAuthority,
    private readonly coordination: {
      subscribe(channel: string, listener: (payload: string) => void): Promise<() => Promise<void>>;
    },
    private readonly options: {
      maxMessagesPerMinute?: number;
      stagedIdentityTtlMs?: number;
      rotationCooldownMs?: number;
    } = {}
  ) {}

  get #stagedIdentityTtlMs(): number {
    return this.options.stagedIdentityTtlMs ?? STAGED_IDENTITY_TTL_MS;
  }

  connected(nodeId: string): boolean {
    return this.#connections.get(nodeId)?.socket.readyState === WebSocket.OPEN;
  }

  pendingRequestCount(nodeId: string): number {
    return this.#connections.get(nodeId)?.pending.size ?? 0;
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
          'HTTP/1.1 ' + status + ' ' + reason + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
        );
      };
      if (request.url !== '/api/v1/nodes/connect') return rejectUpgrade(404, 'Not Found');
      void this.#authenticate(request)
        .then((identity) => {
          if (!identity) return rejectUpgrade(401, 'Unauthorized');
          sockets.handleUpgrade(request, socket, head, (ws) => this.#accept(identity, ws));
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
        const parsed = z
          .object({ nodeId: z.string().min(1) })
          .passthrough()
          .parse(JSON.parse(payload));
        this.disconnect(parsed.nodeId, 'Certificate revoked');
        this.#disconnectCandidates(parsed.nodeId, 'Certificate revoked');
      } catch {
        // Ignore malformed external coordination events.
      }
    });
  }

  async stop(): Promise<void> {
    for (const nodeId of [...this.#connections.keys()])
      this.disconnect(nodeId, 'Controller shutting down');
    for (const connection of [...this.#candidateConnections])
      this.#closeConnection(connection, 'Controller shutting down', 1001);
    this.#candidateConnections.clear();
    for (const staged of this.#stagedIdentities.values()) clearTimeout(staged.expiry);
    this.#stagedIdentities.clear();
    this.#lastCertificateRotation.clear();
    for (const [nodeId, waiter] of this.#rotationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Controller shutting down'));
      this.#rotationWaiters.delete(nodeId);
    }
    await this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#server)
      await new Promise<void>((resolve, reject) =>
        this.#server!.close((error) => (error ? reject(error) : resolve()))
      );
    this.#server = undefined;
  }

  disconnect(nodeId: string, reason: string): void {
    const connection = this.#connections.get(nodeId);
    if (!connection) return;
    this.#closeConnection(connection, reason);
  }

  #disconnectCandidates(nodeId: string, reason: string, except?: AgentConnection): void {
    for (const connection of [...this.#candidateConnections]) {
      if (connection.nodeId === nodeId && connection !== except)
        this.#closeConnection(connection, reason);
    }
  }

  #releaseConnection(connection: AgentConnection, reason: string): boolean {
    if (connection.closed) return false;
    connection.closed = true;
    if (connection.helloDeadline) clearTimeout(connection.helloDeadline);
    if (connection.certificateExpiry) clearTimeout(connection.certificateExpiry);
    connection.helloDeadline = undefined;
    connection.certificateExpiry = undefined;
    this.#candidateConnections.delete(connection);
    if (this.#connections.get(connection.nodeId) === connection)
      this.#connections.delete(connection.nodeId);
    rejectAllPending(connection.pending, new Error(reason));
    return true;
  }

  #closeConnection(connection: AgentConnection, reason: string, code = 1008): void {
    if (!this.#releaseConnection(connection, reason)) return;
    if (
      connection.socket.readyState === WebSocket.OPEN ||
      connection.socket.readyState === WebSocket.CONNECTING
    )
      connection.socket.close(code, reason.slice(0, 120));
  }

  #armCertificateExpiry(connection: AgentConnection): void {
    if (connection.closed) return;
    if (connection.certificateExpiry) clearTimeout(connection.certificateExpiry);
    const remaining = connection.certificateExpiresAt - Date.now();
    if (remaining <= 0) {
      this.#closeConnection(connection, 'Certificate expired');
      return;
    }
    connection.certificateExpiry = setTimeout(
      () => {
        connection.certificateExpiry = undefined;
        if (connection.certificateExpiresAt > Date.now()) this.#armCertificateExpiry(connection);
        else this.#closeConnection(connection, 'Certificate expired');
      },
      Math.min(MAX_TIMER_MS, remaining)
    );
    connection.certificateExpiry.unref();
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

  async dispatchProducer(
    nodeId: string,
    command: RemoteSegmentCommand,
    signal?: AbortSignal
  ): Promise<void> {
    await this.request(
      nodeId,
      'producer.start',
      command as unknown as Record<string, unknown>,
      REQUEST_TIMEOUT_MS,
      signal
    );
  }

  async stopProducer(nodeId: string, sessionId: string): Promise<void> {
    await this.request(nodeId, 'producer.stop', { sessionId }, 30_000).catch(() => undefined);
  }

  async cancel(nodeId: string, jobId: string): Promise<void> {
    await this.request(nodeId, 'job.cancel', { jobId }, 10_000).catch(() => undefined);
  }

  async setDrain(
    nodeId: string,
    draining: boolean
  ): Promise<{ persisted: true; acknowledged: boolean }> {
    await this.cluster.drain(nodeId, draining);
    const acknowledged = await this.request(nodeId, 'drain', { draining }, 30_000).then(
      () => true,
      () => false
    );
    return { persisted: true, acknowledged };
  }

  async rotateCertificate(nodeId: string, timeoutMs = 60_000): Promise<void> {
    if (this.#rotationWaiters.has(nodeId))
      throw new Error('Certificate rotation is already pending for node ' + nodeId);
    let resolveActivation!: () => void;
    let rejectActivation!: (error: Error) => void;
    const activation = new Promise<void>((resolve, reject) => {
      resolveActivation = resolve;
      rejectActivation = reject;
    });
    const timer = setTimeout(() => {
      const waiter = this.#rotationWaiters.get(nodeId);
      if (!waiter) return;
      this.#rotationWaiters.delete(nodeId);
      waiter.reject(new Error('Certificate rotation activation timed out'));
    }, timeoutMs);
    this.#rotationWaiters.set(nodeId, {
      resolve: resolveActivation,
      reject: rejectActivation,
      timer
    });
    try {
      await this.request(
        nodeId,
        'certificate.rotate',
        { reason: 'administrative' },
        Math.min(30_000, timeoutMs)
      );
      await activation;
    } catch (error) {
      const waiter = this.#rotationWaiters.get(nodeId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.#rotationWaiters.delete(nodeId);
      }
      throw error;
    }
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

  async cacheInventory(
    nodeId: string,
    signal?: AbortSignal
  ): Promise<{ items: CachedObject[]; totalBytes: number }> {
    return AgentCacheInventoryResultSchema.parse(
      await this.request(nodeId, 'cache.inventory', {}, 30_000, signal)
    );
  }

  async evictCache(
    nodeId: string,
    filter: { sessionId?: string; profileId?: string; all?: boolean },
    signal?: AbortSignal
  ): Promise<{ removed: number }> {
    return AgentCacheEvictionResultSchema.parse(
      await this.request(
        nodeId,
        'cache.evict',
        {
          ...(filter.all !== undefined ? { all: filter.all } : {}),
          ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
          ...(filter.profileId ? { profileId: filter.profileId } : {})
        },
        30_000,
        signal
      )
    );
  }

  async request(
    nodeId: string,
    kind: AgentMessageKind,
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
    signal?: AbortSignal
  ): Promise<AgentJsonObject> {
    const connection = this.#connections.get(nodeId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN)
      throw new Error('Node ' + nodeId + ' is not connected');
    const result = await this.#requestConnection(connection, kind, payload, timeoutMs, signal);
    return result && typeof result === 'object' && !Array.isArray(result)
      ? (result as AgentJsonObject)
      : {};
  }

  async #requestConnection(
    connection: AgentConnection,
    kind: AgentMessageKind,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error('Request aborted');
    if (connection.pending.size >= MAX_PENDING_REQUESTS)
      throw new Error('Node request concurrency limit exceeded');
    const id = randomUUID();
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          settlePending(connection.pending, id, {
            error: new Error('Node request timed out: ' + kind)
          }),
        timeoutMs
      );
      const pending: PendingRequest = {
        kind,
        resolve,
        reject,
        timer,
        ...(signal ? { signal } : {}),
        ...((kind === 'job.offer' || kind === 'producer.start') && typeof payload.jobId === 'string'
          ? { jobId: payload.jobId }
          : {})
      };
      if (signal) {
        pending.abortListener = () =>
          settlePending(connection.pending, id, {
            error: signal.reason instanceof Error ? signal.reason : new Error('Request aborted')
          });
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      connection.pending.set(id, pending);
    });
    try {
      this.#send(connection, kind, payload, { id, deadlineAt });
    } catch (error) {
      settlePending(connection.pending, id, {
        error: error instanceof Error ? error : new Error('Node request could not be sent')
      });
    }
    return promise;
  }

  async #authenticate(request: IncomingMessage): Promise<AuthenticatedNodeIdentity | undefined> {
    const socket = request.socket as TLSSocket;
    if (!socket.authorized) return undefined;
    const peer = socket.getPeerCertificate();
    const commonName = Array.isArray(peer.subject?.CN) ? peer.subject.CN[0] : peer.subject?.CN;
    const cnNodeId = commonName?.startsWith('node:') ? commonName.slice(5) : undefined;
    const uriNodeId = peer.subjectaltname
      ?.split(', ')
      .find((value) => value.startsWith('URI:urn:vrrelay:node:'))
      ?.slice('URI:urn:vrrelay:node:'.length);
    if (cnNodeId && uriNodeId && cnNodeId !== uriNodeId) return undefined;
    const nodeId = cnNodeId ?? uriNodeId;
    if (!nodeId || !peer.serialNumber || !peer.raw) return undefined;
    const serial = normalizeSerial(peer.serialNumber);
    const fingerprint = createHash('sha256').update(peer.raw).digest('hex');
    const certificateExpiresAt = new X509Certificate(peer.raw).validToDate.getTime();
    if (!Number.isFinite(certificateExpiresAt) || certificateExpiresAt <= Date.now())
      return undefined;
    let staged = this.#stagedIdentities.get(nodeId);
    if (staged && Date.now() - staged.stagedAt >= this.#stagedIdentityTtlMs) {
      clearTimeout(staged.expiry);
      this.#stagedIdentities.delete(nodeId);
      staged = undefined;
    }
    if (await this.cluster.certificateIsActive(nodeId, serial, fingerprint)) {
      let activatedStagedIdentity: StagedNodeIdentity | undefined;
      if (staged && stagedCertificateMatchesPeer(staged, fingerprint))
        activatedStagedIdentity = staged;
      return {
        nodeId,
        serialNumber: serial,
        fingerprintSha256: fingerprint,
        certificateExpiresAt,
        stagedIdentity: undefined,
        activatedStagedIdentity
      };
    }
    if (
      staged &&
      this.#stagedIdentities.get(nodeId) === staged &&
      stagedCertificateMatchesPeer(staged, fingerprint)
    )
      return {
        nodeId,
        serialNumber: serial,
        fingerprintSha256: fingerprint,
        certificateExpiresAt,
        stagedIdentity: staged,
        activatedStagedIdentity: undefined
      };
    return undefined;
  }

  #accept(identity: AuthenticatedNodeIdentity, socket: WebSocket): void {
    const { nodeId } = identity;
    const connection: AgentConnection = {
      socket,
      nodeId,
      serialNumber: identity.serialNumber,
      fingerprintSha256: identity.fingerprintSha256,
      certificateExpiresAt: identity.certificateExpiresAt,
      lastSequence: 0,
      nextSequence: 1,
      connectedAt: new Date().toISOString(),
      messageWindowStartedAt: Date.now(),
      messageCount: 0,
      pending: new Map(),
      correlatedResponses: {
        messageWindowStartedAt: Date.now(),
        messageCount: 0
      },
      declaredMaxWorkers: 1,
      stagedIdentity: identity.stagedIdentity,
      activatedStagedIdentity: identity.activatedStagedIdentity,
      helloReceived: false,
      helloDeadline: undefined,
      certificateExpiry: undefined,
      messageQueue: Promise.resolve(),
      closed: false
    };
    this.#candidateConnections.add(connection);
    connection.helloDeadline = setTimeout(
      () => this.#closeConnection(connection, 'Agent hello deadline expired'),
      HELLO_TIMEOUT_MS
    );
    connection.helloDeadline.unref();
    this.#armCertificateExpiry(connection);
    socket.on('message', (data, binary) => {
      const raw = rawText(data);
      if (binary || Buffer.byteLength(raw) > MAX_MESSAGE_BYTES)
        return this.#closeConnection(connection, 'Message too large', 1009);
      try {
        this.#receive(connection, raw);
      } catch {
        this.#closeConnection(connection, 'Invalid agent message');
      }
    });
    const closed = () => {
      this.#releaseConnection(connection, 'Node connection closed');
    };
    socket.once('close', closed);
    socket.once('error', closed);
  }

  #requireOpenCandidate(connection: AgentConnection): void {
    if (
      connection.closed ||
      connection.socket.readyState !== WebSocket.OPEN ||
      !this.#candidateConnections.has(connection) ||
      connection.certificateExpiresAt <= Date.now()
    )
      throw new Error('Agent candidate connection is no longer eligible for promotion');
  }

  #receive(connection: AgentConnection, raw: string): void {
    const message = AgentEnvelopeSchema.parse(JSON.parse(raw));
    const isCorrelatedResponse = Boolean(
      message.replyTo && connection.pending.has(message.replyTo)
    );
    const correlatedLimit = agentMessageLimitForWorkers(
      connection.declaredMaxWorkers,
      this.options.maxMessagesPerMinute ?? MAX_MESSAGES_PER_MINUTE
    );
    countMessage(
      isCorrelatedResponse ? connection.correlatedResponses : connection,
      isCorrelatedResponse
        ? correlatedLimit
        : (this.options.maxMessagesPerMinute ?? MAX_MESSAGES_PER_MINUTE)
    );
    validateMessageTiming(message, connection.lastSequence);
    if (message.deadlineAt && Date.parse(message.deadlineAt) < Date.now())
      throw new Error('Expired agent message');
    connection.lastSequence = message.sequence;
    if (message.kind === 'hello' || message.kind === 'heartbeat' || message.kind === 'capabilities')
      connection.declaredMaxWorkers = message.payload.capabilities.maxWorkers;

    if (message.replyTo) {
      this.#handleReply(connection, message);
      return;
    }
    const queued = connection.messageQueue.then(async () => {
      if (!connection.closed) await this.#message(connection, message);
    });
    connection.messageQueue = queued;
    void queued.catch(() => this.#closeConnection(connection, 'Invalid agent message'));
  }

  #handleReply(connection: AgentConnection, message: AgentEnvelope): void {
    if (!message.replyTo) throw new Error('Agent response is missing its correlation identifier');
    const pending = connection.pending.get(message.replyTo);
    if (!pending) return;
    if (pending.kind === 'job.offer' || pending.kind === 'producer.start') {
      if (
        ['job.accept', 'job.progress', 'job.complete', 'job.reject', 'job.fail'].includes(
          message.kind
        )
      ) {
        if ('jobId' in message.payload && message.payload.jobId !== pending.jobId)
          throw new Error('Job response identifier does not match its request');
        if (message.kind === 'job.accept' || message.kind === 'job.progress') return;
        if (message.kind === 'job.reject' || message.kind === 'job.fail') {
          settlePending(connection.pending, message.replyTo, {
            error: new Error(message.payload.error.message)
          });
          return;
        }
        settlePending(connection.pending, message.replyTo, { value: {} });
        return;
      }
      throw new Error('Unexpected job request response');
    }
    if (message.kind === 'error') {
      settlePending(connection.pending, message.replyTo, {
        error: new Error(message.payload.error.message)
      });
      return;
    }
    if (message.kind !== 'response') throw new Error('Unexpected node request response');
    settlePending(connection.pending, message.replyTo, {
      value: message.payload.result ?? {}
    });
  }

  async #message(connection: AgentConnection, message: AgentEnvelope): Promise<void> {
    if (connection.stagedIdentity) {
      const staged = connection.stagedIdentity;
      if (
        message.kind !== 'hello' ||
        message.payload.nodeId !== connection.nodeId ||
        this.#stagedIdentities.get(connection.nodeId) !== staged ||
        Date.now() - staged.stagedAt >= this.#stagedIdentityTtlMs
      )
        throw new Error('Staged identity must prove itself with a timely hello request');
      const desiredDraining = await this.#authoritativeDrainState(connection.nodeId);
      await this.cluster.heartbeat(
        connection.nodeId,
        message.payload.capabilities,
        desiredDraining ? 'draining' : 'online'
      );
      if (message.payload.draining !== desiredDraining)
        await this.#requestConnection(connection, 'drain', { draining: desiredDraining }, 30_000);
      this.#requireOpenCandidate(connection);
      await this.cluster.activateNodeCertificate(connection.nodeId, staged.certificate);
      this.disconnect(connection.nodeId, 'Replaced by rotated certificate');
      this.#disconnectCandidates(
        connection.nodeId,
        'Certificate replaced by rotated identity',
        connection
      );
      if (
        !(await this.cluster.certificateIsActive(
          connection.nodeId,
          connection.serialNumber,
          connection.fingerprintSha256
        ))
      )
        throw new Error('Staged agent certificate did not become active');
      this.#requireOpenCandidate(connection);
      clearTimeout(staged.expiry);
      this.#stagedIdentities.delete(connection.nodeId);
      connection.stagedIdentity = undefined;
      connection.helloReceived = true;
      if (connection.helloDeadline) clearTimeout(connection.helloDeadline);
      connection.helloDeadline = undefined;
      this.#candidateConnections.delete(connection);
      this.#connections.set(connection.nodeId, connection);
      const waiter = this.#rotationWaiters.get(connection.nodeId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.#rotationWaiters.delete(connection.nodeId);
        waiter.resolve();
      }
      this.#replySuccess(connection, message);
      return;
    }

    if (!connection.helloReceived) {
      if (message.kind !== 'hello')
        throw new Error('The first agent protocol message must be hello');
      connection.helloReceived = true;
    } else if (message.kind === 'hello') {
      throw new Error('Duplicate agent hello message');
    }

    if (
      message.kind === 'hello' ||
      message.kind === 'heartbeat' ||
      message.kind === 'capabilities'
    ) {
      if (message.kind === 'hello' && message.payload.nodeId !== connection.nodeId)
        throw new Error('Hello node identifier does not match the certificate identity');
      const desiredDraining = await this.#authoritativeDrainState(connection.nodeId);
      await this.cluster.heartbeat(
        connection.nodeId,
        message.payload.capabilities,
        desiredDraining ? 'draining' : 'online'
      );
      if (message.kind === 'hello') {
        if (message.payload.draining !== desiredDraining)
          await this.#requestConnection(connection, 'drain', { draining: desiredDraining }, 30_000);
        if (
          !(await this.cluster.certificateIsActive(
            connection.nodeId,
            connection.serialNumber,
            connection.fingerprintSha256
          ))
        )
          throw new Error('Agent certificate is no longer active');
        this.#requireOpenCandidate(connection);
        this.disconnect(connection.nodeId, 'Replaced by a newer connection');
        this.#disconnectCandidates(connection.nodeId, 'Replaced by a newer connection', connection);
        if (connection.helloDeadline) clearTimeout(connection.helloDeadline);
        connection.helloDeadline = undefined;
        this.#candidateConnections.delete(connection);
        this.#connections.set(connection.nodeId, connection);
        if (connection.activatedStagedIdentity) {
          const activated = connection.activatedStagedIdentity;
          connection.activatedStagedIdentity = undefined;
          if (
            this.#stagedIdentities.get(connection.nodeId) === activated &&
            Date.now() - activated.stagedAt < this.#stagedIdentityTtlMs
          ) {
            clearTimeout(activated.expiry);
            this.#stagedIdentities.delete(connection.nodeId);
            const waiter = this.#rotationWaiters.get(connection.nodeId);
            if (waiter) {
              clearTimeout(waiter.timer);
              this.#rotationWaiters.delete(connection.nodeId);
              waiter.resolve();
            }
          }
        }
      }
      this.#replySuccess(connection, message);
      if (message.kind !== 'hello' && message.payload.draining !== desiredDraining)
        void this.#requestConnection(
          connection,
          'drain',
          { draining: desiredDraining },
          30_000
        ).catch(() => undefined);
      return;
    }

    if (message.kind === 'certificate.rotate') {
      if (!('csrPem' in message.payload))
        throw new Error('A node rotation request must contain a CSR');
      const now = Date.now();
      const csrSha256 = createHash('sha256').update(message.payload.csrPem).digest('hex');
      const currentStage = this.#stagedIdentities.get(connection.nodeId);
      if (currentStage && now - currentStage.stagedAt < this.#stagedIdentityTtlMs) {
        if (currentStage.csrSha256 === csrSha256) {
          this.#send(
            connection,
            'certificate.rotated',
            { ok: true, certificate: currentStage.certificate },
            { replyTo: message.id }
          );
        } else {
          this.#send(
            connection,
            'error',
            protocolError(
              'certificate_rotation_pending',
              'A different certificate rotation is already staged for this node',
              true
            ),
            { replyTo: message.id }
          );
        }
        return;
      }
      if (currentStage) {
        clearTimeout(currentStage.expiry);
        this.#stagedIdentities.delete(connection.nodeId);
      }
      const previous = this.#lastCertificateRotation.get(connection.nodeId) ?? 0;
      if (now - previous < (this.options.rotationCooldownMs ?? ROTATION_COOLDOWN_MS))
        throw new Error('Certificate rotation rate limit exceeded');
      const certificate = await this.cluster.signNodeCertificate(
        connection.nodeId,
        message.payload.csrPem
      );
      const expiry = setTimeout(() => {
        const current = this.#stagedIdentities.get(connection.nodeId);
        if (current?.certificate.fingerprintSha256 !== certificate.fingerprintSha256) return;
        this.#stagedIdentities.delete(connection.nodeId);
        const waiter = this.#rotationWaiters.get(connection.nodeId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.#rotationWaiters.delete(connection.nodeId);
          waiter.reject(new Error('Staged certificate reconnect window expired'));
        }
      }, this.#stagedIdentityTtlMs);
      expiry.unref();
      const staged: StagedNodeIdentity = { certificate, csrSha256, stagedAt: now, expiry };
      this.#stagedIdentities.set(connection.nodeId, staged);
      this.#lastCertificateRotation.set(connection.nodeId, now);
      this.#send(
        connection,
        'certificate.rotated',
        { ok: true, certificate },
        {
          replyTo: message.id
        }
      );
      return;
    }

    if (
      message.kind === 'job.progress' &&
      'action' in message.payload &&
      message.payload.action === 'ensure'
    ) {
      if (!this.#ensureHandler) throw new Error('Segment ensure handler is unavailable');
      void this.#ensureSegment(
        connection,
        message,
        message.payload.token,
        message.payload.segmentIndex
      );
      return;
    }

    if (message.kind === 'log') {
      await this.cluster.recordLog({
        id: message.id,
        nodeId: connection.nodeId,
        level: message.payload.level,
        message: redact(message.payload.message),
        context: redactAgentContext(message.payload.context),
        timestamp: message.sentAt
      });
      this.#replySuccess(connection, message);
      return;
    }

    throw new Error('Unexpected unsolicited agent message: ' + message.kind);
  }

  async #ensureSegment(
    connection: AgentConnection,
    request: AgentEnvelope,
    token: string,
    segmentIndex: number
  ): Promise<void> {
    const handler = this.#ensureHandler;
    if (!handler) return;
    let failure: unknown;
    for (let attempt = 0; attempt <= SEGMENT_ENSURE_RETRY_DELAYS_MS.length; attempt += 1) {
      if (connection.closed) return;
      if (attempt > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, SEGMENT_ENSURE_RETRY_DELAYS_MS[attempt - 1])
        );
      if (connection.closed) return;
      try {
        await handler(token, segmentIndex);
        if (!connection.closed) this.#replySuccess(connection, request);
        return;
      } catch (error) {
        failure = error;
      }
    }
    if (connection.closed) return;
    this.#send(
      connection,
      'error',
      protocolError(
        'segment_ensure_failed',
        errorMessage(failure, 'Segment ensure request failed'),
        true
      ),
      { replyTo: request.id }
    );
  }

  async #authoritativeDrainState(nodeId: string): Promise<boolean> {
    const node = await this.cluster.get(nodeId);
    if (!node || node.state === 'revoked') throw new Error('Active cluster node was not found');
    return node.state === 'draining';
  }

  #replySuccess(
    connection: AgentConnection,
    request: AgentEnvelope,
    result?: AgentJsonObject
  ): void {
    this.#send(
      connection,
      'response',
      { ok: true, ...(result ? { result } : {}) },
      { replyTo: request.id }
    );
  }

  #send(
    connection: AgentConnection,
    kind: AgentMessageKind,
    payload: unknown,
    extra: { id?: string; replyTo?: string; deadlineAt?: string } = {}
  ): void {
    const message = AgentEnvelopeSchema.parse({
      version: 1,
      id: extra.id ?? randomUUID(),
      sequence: connection.nextSequence++,
      kind,
      sentAt: new Date().toISOString(),
      ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
      ...(extra.deadlineAt ? { deadlineAt: extra.deadlineAt } : {}),
      payload
    });
    connection.socket.send(JSON.stringify(message));
  }
}

const NodeIdentitySchema = AgentSignedCertificateSchema.extend({
  privateKeyPem: z
    .string()
    .min(1)
    .max(64 * 1024)
}).strict();
const StoredNodeAgentStateSchema = z
  .object({
    version: z.literal(1),
    nodeId: z.string().min(1).max(200),
    active: NodeIdentitySchema,
    pending: NodeIdentitySchema.optional(),
    pendingStagedAt: z.iso.datetime().optional(),
    draining: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.pending) !== Boolean(value.pendingStagedAt))
      context.addIssue({
        code: 'custom',
        message: 'Pending node identity and staging timestamp must be stored together'
      });
  });
type StoredNodeAgentState = z.infer<typeof StoredNodeAgentStateSchema>;

const LegacyNodeIdentitySchema = NodeIdentitySchema.extend({
  nodeId: z.string().min(1).max(200)
}).strict();

const PendingEnrollmentSchema = z
  .object({
    version: z.literal(1),
    privateKeyPem: z
      .string()
      .min(1)
      .max(64 * 1024),
    csrPem: z
      .string()
      .min(1)
      .max(16 * 1024)
  })
  .strict();

const PendingNodeRotationRequestSchema = z
  .object({
    version: z.literal(1),
    nodeId: z.string().min(1).max(200),
    privateKeyPem: z
      .string()
      .min(1)
      .max(64 * 1024),
    csrPem: z
      .string()
      .min(1)
      .max(16 * 1024),
    createdAt: z.iso.datetime()
  })
  .strict();
export type PendingNodeRotationRequest = z.infer<typeof PendingNodeRotationRequestSchema>;

async function readNodeRotationRequest(
  secretStore: SecretStore,
  nodeId: string
): Promise<PendingNodeRotationRequest | undefined> {
  let serialized: string;
  try {
    serialized = await secretStore.get(NODE_ROTATION_REFERENCE);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Secret not found:')) return undefined;
    throw error;
  }
  const request = PendingNodeRotationRequestSchema.parse(JSON.parse(serialized));
  if (request.nodeId !== nodeId)
    throw new Error('Stored node rotation request belongs to a different node');
  return request;
}

export async function prepareNodeRotationRequest(
  secretStore: SecretStore,
  nodeId: string
): Promise<PendingNodeRotationRequest> {
  const existing = await readNodeRotationRequest(secretStore, nodeId);
  if (existing) return existing;
  const created = createCertificateSigningRequest('node:' + nodeId);
  const request = PendingNodeRotationRequestSchema.parse({
    version: 1,
    nodeId,
    ...created,
    createdAt: new Date().toISOString()
  });
  await secretStore.put(NODE_ROTATION_REFERENCE, JSON.stringify(request));
  return request;
}

interface NodeAgentConnection extends RateWindow {
  socket: WebSocket;
  identitySlot: 'active' | 'pending';
  declaredMaxWorkers: number;
  nextSequence: number;
  lastReceivedSequence: number;
  pending: Map<string, PendingRequest>;
  opened: boolean;
  closed: boolean;
  heartbeat: NodeJS.Timeout | undefined;
  rotation: NodeJS.Timeout | undefined;
  commandQueue: Promise<void>;
}

export interface NodeAgentOptions {
  controllerUrl: string;
  enrollmentUrl: string;
  joinToken?: string;
  nodeName: string;
  publicUrl: string;
  internalUrl?: string;
  maxMessagesPerMinute?: number;
  stagedIdentityTtlMs?: number;
  secretStore: SecretStore;
  capabilities: () => Promise<NodeCapability>;
  onSegment: (command: RemoteSegmentCommand, signal: AbortSignal) => Promise<void>;
  onCancel: (jobId: string) => Promise<void>;
  onProducerStop?: (sessionId: string) => Promise<void>;
  onDrain?: (draining: boolean) => Promise<void>;
  onDisconnect?: () => Promise<void>;
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
  onCache: (
    operation: 'cache.inventory' | 'cache.evict',
    payload: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
}

export class NodeAgent {
  #connection: NodeAgentConnection | undefined;
  #state?: StoredNodeAgentState;
  #stopping = false;
  #reconnect: NodeJS.Timeout | undefined;
  #attempt = 0;
  #preferActiveIdentity = false;
  #rotationInFlight: Promise<void> | undefined;
  #stateMutation: Promise<void> = Promise.resolve();
  readonly #jobs = new Map<string, AbortController>();

  constructor(private readonly options: NodeAgentOptions) {}

  pendingRequestCount(): number {
    return this.#connection?.pending.size ?? 0;
  }

  connected(): boolean {
    const connection = this.#connection;
    return Boolean(
      connection?.opened && !connection.closed && connection.socket.readyState === WebSocket.OPEN
    );
  }

  async prepareIdentity(): Promise<string> {
    return (await this.#loadState()).nodeId;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#connect();
  }

  async ensure(token: string, segmentIndex: number, signal?: AbortSignal): Promise<void> {
    const connection = this.#openConnection();
    await this.#request(
      connection,
      'job.progress',
      { action: 'ensure', token, segmentIndex },
      125_000,
      signal
    );
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    for (const job of this.#jobs.values()) job.abort(new Error('Node agent stopped'));
    this.#jobs.clear();
    const connection = this.#connection;
    if (connection) {
      this.#clearConnectionTimers(connection);
      rejectAllPending(connection.pending, new Error('Node agent stopped'));
      connection.closed = true;
      connection.socket.close(1000, 'Node stopping');
      if (this.#connection === connection) this.#connection = undefined;
    }
  }

  async #loadState(): Promise<StoredNodeAgentState> {
    if (this.#state) return this.#state;
    let raw: string;
    try {
      raw = await this.options.secretStore.get(NODE_IDENTITY_REFERENCE);
    } catch (error) {
      if (!this.options.joinToken) throw error;
      return this.#enroll();
    }
    const parsed = JSON.parse(raw) as unknown;
    const state = StoredNodeAgentStateSchema.safeParse(parsed);
    if (state.success) {
      this.#state = state.data;
      void this.options.secretStore.delete(NODE_ENROLLMENT_REFERENCE).catch(() => undefined);
      return state.data;
    }
    const legacy = LegacyNodeIdentitySchema.safeParse(parsed);
    if (!legacy.success) throw new Error('Stored node identity is malformed');
    const { nodeId, ...active } = legacy.data;
    return this.#persistState({ version: 1, nodeId, active, draining: false });
  }

  async #enroll(): Promise<StoredNodeAgentState> {
    const enrollmentUrl = new URL(
      this.options.enrollmentUrl.replace(/\/$/, '') + '/api/v1/nodes/enroll'
    );
    if (enrollmentUrl.protocol !== 'https:' && enrollmentUrl.protocol !== 'http:')
      throw new Error('Node enrollment URL must use HTTP or HTTPS');
    let serializedSigningRequest: string | undefined;
    try {
      serializedSigningRequest = await this.options.secretStore.get(NODE_ENROLLMENT_REFERENCE);
    } catch {
      // A missing enrollment record is expected on first boot.
    }
    let signingRequest: z.infer<typeof PendingEnrollmentSchema>;
    if (serializedSigningRequest) {
      signingRequest = PendingEnrollmentSchema.parse(JSON.parse(serializedSigningRequest));
    } else {
      const created = createCertificateSigningRequest('node:enrollment');
      signingRequest = { version: 1, ...created };
      await this.options.secretStore.put(NODE_ENROLLMENT_REFERENCE, JSON.stringify(signingRequest));
    }
    const response = await fetchWithTimeout(
      enrollmentUrl,
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: this.options.joinToken,
          name: this.options.nodeName,
          publicUrl: this.options.publicUrl,
          ...(this.options.internalUrl ? { internalUrl: this.options.internalUrl } : {}),
          capabilities: await this.options.capabilities(),
          csrPem: signingRequest.csrPem
        })
      },
      30_000
    );
    if (!response.ok) throw new Error('Node enrollment failed (' + response.status + ')');
    const body = z
      .object({
        node: z.object({ id: z.string().min(1).max(200) }).passthrough(),
        certificate: AgentSignedCertificateSchema
      })
      .passthrough()
      .parse(await response.json());
    const state = await this.#persistState({
      version: 1,
      nodeId: body.node.id,
      active: { ...body.certificate, privateKeyPem: signingRequest.privateKeyPem },
      draining: false
    });
    await this.options.secretStore.delete(NODE_ENROLLMENT_REFERENCE).catch(() => undefined);
    return state;
  }

  async #persistState(state: StoredNodeAgentState): Promise<StoredNodeAgentState> {
    const parsed = StoredNodeAgentStateSchema.parse(state);
    await this.options.secretStore.put(NODE_IDENTITY_REFERENCE, JSON.stringify(parsed));
    this.#state = parsed;
    return parsed;
  }

  async #mutateState(
    transform: (state: StoredNodeAgentState) => StoredNodeAgentState
  ): Promise<StoredNodeAgentState> {
    const mutation = this.#stateMutation.then(async () => {
      const state = await this.#loadState();
      return this.#persistState(transform(state));
    });
    this.#stateMutation = mutation.then(
      () => undefined,
      () => undefined
    );
    return mutation;
  }

  async #connect(): Promise<void> {
    if (this.#stopping) return;
    const state = await this.#loadState();
    const identitySlot = state.pending && !this.#preferActiveIdentity ? 'pending' : 'active';
    const identity = identitySlot === 'pending' ? state.pending! : state.active;
    const socket = new WebSocket(this.options.controllerUrl, {
      cert: identity.certificatePem,
      key: identity.privateKeyPem,
      ca: identity.caCertificatePem,
      rejectUnauthorized: true,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 15_000
    });
    const connection: NodeAgentConnection = {
      socket,
      identitySlot,
      declaredMaxWorkers: 1,
      nextSequence: 1,
      lastReceivedSequence: 0,
      messageWindowStartedAt: Date.now(),
      messageCount: 0,
      pending: new Map(),
      opened: false,
      closed: false,
      heartbeat: undefined,
      rotation: undefined,
      commandQueue: Promise.resolve()
    };
    this.#connection = connection;
    socket.once('open', () => {
      void this.#opened(connection).catch((error) => {
        this.#log(connection, 'error', errorMessage(error, 'Node connection setup failed'));
        socket.close(1008, 'Node connection setup failed');
      });
    });
    socket.on('message', (data, binary) => {
      const raw = rawText(data);
      if (binary || Buffer.byteLength(raw) > MAX_MESSAGE_BYTES)
        return socket.close(1009, 'Message too large');
      try {
        this.#receive(connection, raw);
      } catch (error) {
        this.#log(connection, 'error', errorMessage(error, 'Invalid controller message'));
        socket.close(1008, 'Invalid controller message');
      }
    });
    const closed = () => void this.#connectionClosed(connection);
    socket.once('close', closed);
    socket.once('error', closed);
  }

  async #opened(connection: NodeAgentConnection): Promise<void> {
    if (this.#connection !== connection || connection.closed) return;
    let state = await this.#loadState();
    const initialCapabilities = await this.options.capabilities();
    connection.declaredMaxWorkers = initialCapabilities.maxWorkers;
    await this.#request(
      connection,
      'hello',
      {
        nodeId: state.nodeId,
        capabilities: initialCapabilities,
        draining: state.draining
      },
      15_000
    );
    if (connection.identitySlot === 'pending') {
      state = await this.#mutateState((current) => {
        if (!current.pending) throw new Error('Pending node identity disappeared during reconnect');
        return {
          version: 1,
          nodeId: current.nodeId,
          active: current.pending,
          draining: current.draining
        };
      });
      await this.options.secretStore.delete(NODE_ROTATION_REFERENCE).catch(() => undefined);
      connection.identitySlot = 'active';
      this.#preferActiveIdentity = false;
    } else if (state.pending) {
      const stagingAge = Date.now() - Date.parse(state.pendingStagedAt!);
      if (stagingAge >= (this.options.stagedIdentityTtlMs ?? STAGED_IDENTITY_TTL_MS)) {
        state = await this.#mutateState((current) => ({
          version: 1,
          nodeId: current.nodeId,
          active: current.active,
          draining: current.draining
        }));
      } else {
        this.#preferActiveIdentity = false;
        connection.rotation = setTimeout(() => {
          connection.rotation = undefined;
          if (this.#connection === connection && connection.socket.readyState === WebSocket.OPEN)
            connection.socket.close(1012, 'Retrying staged node identity');
        }, 250);
        connection.rotation.unref();
      }
    }
    connection.opened = true;
    this.#attempt = 0;
    connection.heartbeat = setInterval(
      () =>
        void this.options
          .capabilities()
          .then((capabilities) => {
            connection.declaredMaxWorkers = capabilities.maxWorkers;
            this.#send(connection, 'heartbeat', {
              capabilities,
              draining: this.#state?.draining ?? false
            });
          })
          .catch((error) =>
            this.#log(connection, 'warn', errorMessage(error, 'Capability update failed'))
          ),
      15_000
    );
    connection.heartbeat.unref();
    if (!state.pending) {
      const pendingRotation = await readNodeRotationRequest(this.options.secretStore, state.nodeId);
      if (pendingRotation) this.#schedulePendingRotation(connection);
      else this.#scheduleRotation(connection, state.active.expiresAt);
    }
  }

  async #connectionClosed(connection: NodeAgentConnection): Promise<void> {
    if (connection.closed) return;
    connection.closed = true;
    this.#clearConnectionTimers(connection);
    rejectAllPending(connection.pending, new Error('Controller connection closed'));
    const wasCurrentConnection = this.#connection === connection;
    if (wasCurrentConnection) {
      this.#connection = undefined;
      for (const job of this.#jobs.values()) job.abort(new Error('Controller connection closed'));
      this.#jobs.clear();
    }
    if (connection.identitySlot === 'pending' && !connection.opened)
      this.#preferActiveIdentity = true;
    else if (connection.identitySlot === 'active' && !connection.opened)
      this.#preferActiveIdentity = false;
    if (connection.opened && wasCurrentConnection)
      await this.options
        .onDisconnect?.()
        .catch((error) =>
          this.#log(connection, 'warn', errorMessage(error, 'Disconnect cleanup failed'))
        );
    this.#scheduleReconnect();
  }

  #clearConnectionTimers(connection: NodeAgentConnection): void {
    if (connection.heartbeat) clearInterval(connection.heartbeat);
    if (connection.rotation) clearTimeout(connection.rotation);
    connection.heartbeat = undefined;
    connection.rotation = undefined;
  }

  #scheduleReconnect(): void {
    if (this.#stopping || this.#reconnect) return;
    const delay =
      Math.min(30_000, 1_000 * 2 ** Math.min(this.#attempt++, 5)) + Math.floor(Math.random() * 500);
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      void this.#connect().catch(() => this.#scheduleReconnect());
    }, delay);
    this.#reconnect.unref();
  }

  #scheduleRotation(connection: NodeAgentConnection, expiresAt: string): void {
    if (connection.rotation) clearTimeout(connection.rotation);
    const remaining = Date.parse(expiresAt) - ROTATE_BEFORE_MS - Date.now();
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, remaining));
    connection.rotation = setTimeout(() => {
      connection.rotation = undefined;
      if (remaining > MAX_TIMER_MS) {
        this.#scheduleRotation(connection, expiresAt);
        return;
      }
      void this.#rotateAndReconnect(connection).catch((error) => {
        this.#log(connection, 'warn', errorMessage(error, 'Certificate rotation failed'));
        if (!connection.closed)
          connection.rotation = setTimeout(
            () => this.#scheduleRotation(connection, expiresAt),
            ROTATION_COOLDOWN_MS
          );
      });
    }, delay);
    connection.rotation.unref();
  }

  #schedulePendingRotation(connection: NodeAgentConnection, delayMs = 0): void {
    if (connection.rotation) clearTimeout(connection.rotation);
    connection.rotation = setTimeout(() => {
      connection.rotation = undefined;
      void this.#rotateAndReconnect(connection).catch((error) => {
        this.#log(connection, 'warn', errorMessage(error, 'Certificate rotation retry failed'));
        if (
          !connection.closed &&
          this.#connection === connection &&
          connection.socket.readyState === WebSocket.OPEN
        )
          this.#schedulePendingRotation(connection, ROTATION_RETRY_MS);
      });
    }, delayMs);
    connection.rotation.unref();
  }

  async #rotateAndReconnect(connection: NodeAgentConnection): Promise<void> {
    await this.#stageRotation(connection);
    if (this.#connection === connection && connection.socket.readyState === WebSocket.OPEN)
      connection.socket.close(1012, 'Reconnecting with rotated identity');
  }

  async #stageRotation(connection: NodeAgentConnection): Promise<void> {
    if (this.#rotationInFlight) return this.#rotationInFlight;
    const rotation = (async () => {
      const state = await this.#loadState();
      const signingRequest = await prepareNodeRotationRequest(
        this.options.secretStore,
        state.nodeId
      );
      const response = await this.#request(
        connection,
        'certificate.rotate',
        { csrPem: signingRequest.csrPem },
        30_000
      );
      const certificate = AgentSignedCertificateSchema.parse(response);
      await this.#mutateState((current) => ({
        ...current,
        pending: { ...certificate, privateKeyPem: signingRequest.privateKeyPem },
        pendingStagedAt: new Date().toISOString()
      }));
      await this.options.secretStore.delete(NODE_ROTATION_REFERENCE).catch(() => undefined);
    })();
    this.#rotationInFlight = rotation;
    try {
      await rotation;
    } finally {
      if (this.#rotationInFlight === rotation) this.#rotationInFlight = undefined;
    }
  }

  #receive(connection: NodeAgentConnection, raw: string): void {
    const defaultLimit = agentMessageLimitForWorkers(connection.declaredMaxWorkers);
    countMessage(connection, this.options.maxMessagesPerMinute ?? defaultLimit);
    const message = AgentEnvelopeSchema.parse(JSON.parse(raw));
    validateMessageTiming(message, connection.lastReceivedSequence);
    connection.lastReceivedSequence = message.sequence;
    if (message.deadlineAt && Date.parse(message.deadlineAt) < Date.now()) {
      this.#replyError(connection, message, 'command_expired', 'Command deadline expired');
      return;
    }

    if (message.replyTo) {
      this.#handleReply(connection, message);
      return;
    }
    const queued = connection.commandQueue.then(async () => {
      if (!connection.closed) await this.#message(connection, message);
    });
    connection.commandQueue = queued;
    void queued.catch((error) => {
      this.#log(connection, 'error', errorMessage(error, 'Invalid controller message'));
      connection.socket.close(1008, 'Invalid controller message');
    });
  }

  #handleReply(connection: NodeAgentConnection, message: AgentEnvelope): void {
    if (!message.replyTo)
      throw new Error('Controller response is missing its correlation identifier');
    const pending = connection.pending.get(message.replyTo);
    if (!pending) return;
    if (message.kind === 'error') {
      settlePending(connection.pending, message.replyTo, {
        error: new Error(message.payload.error.message)
      });
      return;
    }
    if (pending.kind === 'certificate.rotate' && message.kind === 'certificate.rotated') {
      settlePending(connection.pending, message.replyTo, {
        value: message.payload.certificate
      });
      return;
    }
    if (message.kind !== 'response') throw new Error('Unexpected controller request response');
    settlePending(connection.pending, message.replyTo, {
      value: message.payload.result ?? {}
    });
  }

  async #message(connection: NodeAgentConnection, message: AgentEnvelope): Promise<void> {
    if (message.kind === 'job.offer' || message.kind === 'producer.start') {
      const { jobId, sessionId, contentKey, segmentIndex, sourceCredential } = message.payload;
      if (this.#state?.draining) {
        this.#send(
          connection,
          'job.reject',
          {
            ok: false,
            jobId,
            error: {
              code: 'node_draining',
              message: 'Node is draining and cannot accept new jobs',
              retryable: true
            }
          },
          { replyTo: message.id }
        );
        return;
      }
      if (this.#jobs.has(jobId)) {
        this.#send(
          connection,
          'job.reject',
          {
            ok: false,
            jobId,
            error: {
              code: 'job_already_running',
              message: 'Segment job is already running',
              retryable: false
            }
          },
          { replyTo: message.id }
        );
        return;
      }
      const command: RemoteSegmentCommand = {
        jobId,
        sessionId,
        contentKey,
        segmentIndex,
        ...(sourceCredential ? { sourceCredential } : {})
      };
      const controller = new AbortController();
      this.#jobs.set(command.jobId, controller);
      this.#send(connection, 'job.accept', { ok: true, jobId }, { replyTo: message.id });
      this.#send(
        connection,
        'job.progress',
        { ok: true, jobId, state: 'running' },
        { replyTo: message.id }
      );
      void this.#runSegment(connection, message.id, command, controller);
      return;
    }

    if (message.kind === 'job.cancel') {
      const { jobId } = message.payload;
      this.#jobs.get(jobId)?.abort(new Error('Job cancelled by controller'));
      await this.options.onCancel(jobId);
      this.#replySuccess(connection, message);
      return;
    }

    if (message.kind === 'producer.stop') {
      await this.options.onProducerStop?.(message.payload.sessionId);
      this.#replySuccess(connection, message);
      return;
    }

    if (message.kind === 'drain') {
      await this.#mutateState((state) => ({ ...state, draining: message.payload.draining }));
      await this.options.onDrain?.(message.payload.draining);
      this.#replySuccess(connection, message);
      return;
    }

    if (message.kind === 'certificate.rotate') {
      if (!('reason' in message.payload))
        throw new Error('Controller rotation command is malformed');
      await this.#stageRotation(connection);
      this.#replySuccess(connection, message);
      setTimeout(() => {
        if (this.#connection === connection && connection.socket.readyState === WebSocket.OPEN)
          connection.socket.close(1012, 'Reconnecting with rotated identity');
      }, 0);
      return;
    }

    if (
      message.kind === 'provider.bind' ||
      message.kind === 'provider.unbind' ||
      message.kind === 'provider.browse' ||
      message.kind === 'provider.item' ||
      message.kind === 'provider.validate' ||
      message.kind === 'provider.activity'
    ) {
      void this.options
        .onProvider(message.kind, message.payload)
        .then((result) => {
          if (!connection.closed)
            this.#replySuccess(connection, message, result as AgentJsonObject);
        })
        .catch((error) => {
          if (!connection.closed)
            this.#replyError(
              connection,
              message,
              'provider_operation_failed',
              errorMessage(error, 'Provider operation failed')
            );
        });
      return;
    }

    if (message.kind === 'cache.inventory' || message.kind === 'cache.evict') {
      void this.options
        .onCache(message.kind, message.payload)
        .then((result) => {
          if (!connection.closed)
            this.#replySuccess(connection, message, result as AgentJsonObject);
        })
        .catch((error) => {
          if (!connection.closed)
            this.#replyError(
              connection,
              message,
              'cache_operation_failed',
              errorMessage(error, 'Cache operation failed')
            );
        });
      return;
    }

    throw new Error('Unexpected unsolicited controller message: ' + message.kind);
  }

  async #runSegment(
    connection: NodeAgentConnection,
    requestId: string,
    command: RemoteSegmentCommand,
    controller: AbortController
  ): Promise<void> {
    try {
      await this.options.onSegment(command, controller.signal);
      if (!connection.closed && connection.socket.readyState === WebSocket.OPEN)
        this.#send(
          connection,
          'job.complete',
          { ok: true, jobId: command.jobId },
          { replyTo: requestId }
        );
    } catch (error) {
      if (!connection.closed && connection.socket.readyState === WebSocket.OPEN)
        this.#send(
          connection,
          'job.fail',
          {
            ok: false,
            jobId: command.jobId,
            error: protocolError('job_failed', errorMessage(error, 'Segment job failed')).error
          },
          { replyTo: requestId }
        );
    } finally {
      this.#jobs.delete(command.jobId);
    }
  }

  #replySuccess(
    connection: NodeAgentConnection,
    request: AgentEnvelope,
    result?: AgentJsonObject
  ): void {
    this.#send(
      connection,
      'response',
      { ok: true, ...(result ? { result } : {}) },
      { replyTo: request.id }
    );
  }

  #replyError(
    connection: NodeAgentConnection,
    request: AgentEnvelope,
    code: string,
    message: string,
    retryable = false
  ): void {
    this.#send(connection, 'error', protocolError(code, message, retryable), {
      replyTo: request.id
    });
  }

  #log(
    connection: NodeAgentConnection,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string
  ): void {
    if (connection.socket.readyState === WebSocket.OPEN)
      this.#send(connection, 'log', { level, message: redact(message), context: {} });
  }

  #send(
    connection: NodeAgentConnection,
    kind: AgentMessageKind,
    payload: unknown,
    extra: { id?: string; replyTo?: string; deadlineAt?: string } = {}
  ): void {
    if (connection.socket.readyState !== WebSocket.OPEN)
      throw new Error('Controller agent connection is unavailable');
    const envelope = AgentEnvelopeSchema.parse({
      version: 1,
      id: extra.id ?? randomUUID(),
      sequence: connection.nextSequence++,
      kind,
      sentAt: new Date().toISOString(),
      ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
      ...(extra.deadlineAt ? { deadlineAt: extra.deadlineAt } : {}),
      payload
    });
    connection.socket.send(JSON.stringify(envelope));
  }

  async #request(
    connection: NodeAgentConnection,
    kind: AgentMessageKind,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (connection.socket.readyState !== WebSocket.OPEN)
      throw new Error('Controller agent connection is unavailable');
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error('Request aborted');
    if (connection.pending.size >= MAX_PENDING_REQUESTS)
      throw new Error('Controller request concurrency limit exceeded');
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          settlePending(connection.pending, id, {
            error: new Error('Controller request timed out: ' + kind)
          }),
        timeoutMs
      );
      const pending: PendingRequest = {
        kind,
        resolve,
        reject,
        timer,
        ...(signal ? { signal } : {})
      };
      if (signal) {
        pending.abortListener = () =>
          settlePending(connection.pending, id, {
            error: signal.reason instanceof Error ? signal.reason : new Error('Request aborted')
          });
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      connection.pending.set(id, pending);
    });
    try {
      this.#send(connection, kind, payload, {
        id,
        deadlineAt: new Date(Date.now() + timeoutMs).toISOString()
      });
    } catch (error) {
      settlePending(connection.pending, id, {
        error: error instanceof Error ? error : new Error('Controller request could not be sent')
      });
    }
    return promise;
  }

  #openConnection(): NodeAgentConnection {
    const connection = this.#connection;
    if (!connection || !connection.opened || connection.socket.readyState !== WebSocket.OPEN)
      throw new Error('Controller agent connection is unavailable');
    return connection;
  }
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bvrr_(?:join_)?[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\/internal\/source\/[A-Za-z0-9._~-]+/gi, '/internal/source/[REDACTED]')
    .replace(/\/play\/[A-Za-z0-9._~-]+/gi, '/play/[REDACTED]')
    .replace(/\b(?:https?|wss?|rtsp|rtmp|srt):\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
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
        /authorization|credential|password|token|secret|private.?key|api.?key/i.test(key)
          ? '[REDACTED]'
          : redactValue(item, depth + 1)
      ])
  );
}

export function redactAgentContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return redactValue(value) as Record<string, unknown>;
}
