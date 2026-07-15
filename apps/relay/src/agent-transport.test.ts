// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type ClientOptions } from 'ws';
import {
  AgentController,
  NodeAgent,
  redactAgentContext,
  type NodeAgentOptions
} from './agent-transport.js';
import {
  EncryptedFileSecretStore,
  FileCertificateAuthority,
  createCertificateSigningRequest,
  MemorySecretStore,
  MemoryCoordinationStore,
  SqliteRepository
} from '@vrrelay/adapters';
import { BuiltinTrafficDirector, ClusterService, InMemoryEventBus } from '@vrrelay/application';
import type { NodeCapability } from '@vrrelay/domain';
import { AgentEnvelopeSchema, type AgentEnvelope } from '@vrrelay/contracts';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('agent log redaction', () => {
  it('redacts nested secret-bearing keys and token-shaped strings', () => {
    expect(
      redactAgentContext({
        request: {
          headers: { authorization: 'Bearer abc.def.ghi' },
          body: { password: 'fixture-password', nested: [{ apiKey: 'fixture-api-key' }] }
        },
        message:
          'failed token=vrr_join_reusable-secret https://private.invalid/media /internal/source/source-grant /play/playback-grant'
      })
    ).toEqual({
      request: {
        headers: { authorization: '[REDACTED]' },
        body: { password: '[REDACTED]', nested: [{ apiKey: '[REDACTED]' }] }
      },
      message: 'failed token=[REDACTED] [REDACTED_URL] /internal/source/[REDACTED] /play/[REDACTED]'
    });
  });
});

const capabilities: NodeCapability = {
  encoders: ['libx264'],
  hardwareDevices: [],
  maxWorkers: 2,
  activeWorkers: 0,
  queuedWorkers: 0,
  cacheBytes: 0,
  cacheLimitBytes: null,
  egressMbps: 0,
  providerIds: []
};

describe('mTLS node agent transport', () => {
  it('reuses a locally persisted enrollment key and CSR after a lost response', async () => {
    const nodeSecrets = new MemorySecretStore();
    const ca = new FileCertificateAuthority(new MemorySecretStore());
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        expect(body).not.toHaveProperty('privateKeyPem');
        if (requests.length === 1) throw new Error('enrollment response was lost');
        const signed = await ca.signCsr('node:node-retry', String(body.csrPem), 60_000);
        return new Response(JSON.stringify({ node: { id: 'node-retry' }, certificate: signed }), {
          status: 201,
          headers: { 'content-type': 'application/json' }
        });
      })
    );
    const options: NodeAgentOptions = {
      controllerUrl: 'wss://127.0.0.1:1/api/v1/nodes/connect',
      enrollmentUrl: 'https://controller.invalid',
      joinToken: 'vrr_join_' + 'x'.repeat(36),
      nodeName: 'Retry Worker',
      publicUrl: 'https://worker.invalid',
      secretStore: nodeSecrets,
      capabilities: async () => capabilities,
      onSegment: async () => {},
      onCancel: async () => {},
      onProvider: async () => ({})
    };
    const first = new NodeAgent(options);
    await expect(first.start()).rejects.toThrow(/response was lost/);
    const pending = JSON.parse(await nodeSecrets.get('cluster:node-enrollment')) as {
      csrPem: string;
      privateKeyPem: string;
    };
    expect(pending.csrPem).toContain('CERTIFICATE REQUEST');
    expect(pending.privateKeyPem).toContain('PRIVATE KEY');

    const restarted = new NodeAgent(options);
    await restarted.start();
    expect(requests[1]?.csrPem).toBe(requests[0]?.csrPem);
    const identity = JSON.parse(await nodeSecrets.get('cluster:node-identity')) as {
      nodeId: string;
      active: { privateKeyPem: string };
    };
    expect(identity.nodeId).toBe('node-retry');
    expect(identity.active.privateKeyPem).toBe(pending.privateKeyPem);
    await expect(nodeSecrets.get('cluster:node-enrollment')).rejects.toThrow();
    await restarted.stop();
  });

  it('authenticates issued certificates, rejects replay, and stores the CA encrypted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-agent-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const coordination = new MemoryCoordinationStore();
    const secretsPath = join(directory, 'secrets.json');
    const secrets = new EncryptedFileSecretStore(
      secretsPath,
      'correct horse battery staple for tests'
    );
    const ca = new FileCertificateAuthority(secrets);
    const cluster = new ClusterService(
      repository,
      coordination,
      new BuiltinTrafficDirector(),
      new InMemoryEventBus(),
      ca
    );
    const joinToken = await cluster.createJoinToken({
      name: 'Worker',
      roles: ['source-worker'],
      region: 'test',
      expiresInSeconds: 60
    });
    const signingRequest = createCertificateSigningRequest('node:enrollment');
    const enrollment = await cluster.enroll({
      token: joinToken.token,
      name: 'Worker',
      publicUrl: 'https://worker.invalid',
      capabilities,
      csrPem: signingRequest.csrPem
    });
    expect(enrollment.certificate).toBeDefined();
    expect(
      await cluster.certificateIsActive(enrollment.node.id, enrollment.certificate!.serialNumber)
    ).toBe(true);
    await expect(
      cluster.enroll({
        token: joinToken.token,
        name: 'Replay',
        publicUrl: 'https://worker.invalid',
        capabilities,
        csrPem: createCertificateSigningRequest('node:replay').csrPem
      })
    ).rejects.toThrow(/invalid|used/);
    const controller = new AgentController(cluster, ca, coordination);
    await controller.start('127.0.0.1', 0, ['127.0.0.1']);
    const port = controller.address()!.port;
    const certificate = enrollment.certificate!;
    const socket = new WebSocket(`wss://127.0.0.1:${port}/api/v1/nodes/connect`, {
      cert: certificate.certificatePem,
      key: signingRequest.privateKeyPem,
      ca: certificate.caCertificatePem,
      rejectUnauthorized: true
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const hello: AgentEnvelope = {
      version: 1,
      id: 'hello-1',
      sequence: 1,
      kind: 'hello',
      sentAt: new Date().toISOString(),
      payload: { nodeId: enrollment.node.id, capabilities, draining: false }
    };
    socket.send(JSON.stringify(hello));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('heartbeat response timed out')), 2_000);
      socket.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    expect(controller.connected(enrollment.node.id)).toBe(true);
    socket.send(JSON.stringify(hello));
    const closeCode = await new Promise<number>((resolve) => socket.once('close', resolve));
    expect(closeCode).toBe(1008);
    expect(await readFile(secretsPath, 'utf8')).not.toContain('PRIVATE KEY');

    const nodeSecrets = new MemorySecretStore();
    await nodeSecrets.put(
      'cluster:node-identity',
      JSON.stringify({
        nodeId: enrollment.node.id,
        ...certificate,
        privateKeyPem: signingRequest.privateKeyPem
      })
    );
    let releaseSegment!: () => void;
    let signalSegmentStarted!: () => void;
    const segmentStarted = new Promise<void>((resolve) => {
      signalSegmentStarted = resolve;
    });
    const segmentRelease = new Promise<void>((resolve) => {
      releaseSegment = resolve;
    });
    const agentOptions: NodeAgentOptions = {
      controllerUrl: `wss://127.0.0.1:${port}/api/v1/nodes/connect`,
      enrollmentUrl: 'https://unused.invalid',
      nodeName: 'Worker',
      publicUrl: 'https://worker.invalid',
      secretStore: nodeSecrets,
      capabilities: async () => capabilities,
      onSegment: async () => {
        signalSegmentStarted();
        await segmentRelease;
      },
      onCancel: async () => {},
      onProvider: async () => ({})
    };
    const agent = new NodeAgent(agentOptions);
    await agent.start();
    for (let attempt = 0; attempt < 20 && !controller.connected(enrollment.node.id); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(controller.connected(enrollment.node.id)).toBe(true);
    const command = {
      jobId: 'job-lifecycle',
      sessionId: 'session-lifecycle',
      contentKey: 'vod/lifecycle.ts',
      segmentIndex: 0
    };
    let dispatchCompleted = false;
    const dispatch = controller.dispatch(enrollment.node.id, command).then(() => {
      dispatchCompleted = true;
    });
    await segmentStarted;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(dispatchCompleted).toBe(false);
    await expect(controller.dispatch(enrollment.node.id, command)).rejects.toThrow(
      /already running/
    );
    releaseSegment();
    await dispatch;
    expect(dispatchCompleted).toBe(true);
    await controller.rotateCertificate(enrollment.node.id, 30_000);
    let rotated = JSON.parse(await nodeSecrets.get('cluster:node-identity')) as {
      nodeId: string;
      active: {
        serialNumber: string;
        certificatePem: string;
        privateKeyPem: string;
        caCertificatePem: string;
      };
    };
    for (
      let attempt = 0;
      attempt < 100 && rotated.active.serialNumber === certificate.serialNumber;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      rotated = JSON.parse(await nodeSecrets.get('cluster:node-identity')) as typeof rotated;
    }
    expect(rotated.active.serialNumber).not.toBe(certificate.serialNumber);
    expect(await cluster.certificateIsActive(rotated.nodeId, rotated.active.serialNumber)).toBe(
      true
    );
    const replacedIdentity = new WebSocket(`wss://127.0.0.1:${port}/api/v1/nodes/connect`, {
      cert: certificate.certificatePem,
      key: signingRequest.privateKeyPem,
      ca: certificate.caCertificatePem,
      rejectUnauthorized: true
    });
    const replacedResult = await new Promise<'opened' | 'rejected'>((resolve) => {
      replacedIdentity.once('open', () => resolve('opened'));
      replacedIdentity.on('error', () => resolve('rejected'));
      replacedIdentity.once('close', () => resolve('rejected'));
    });
    expect(replacedResult).toBe('rejected');

    await controller.setDrain(enrollment.node.id, true);
    expect(
      JSON.parse(await nodeSecrets.get('cluster:node-identity')) as { draining: boolean }
    ).toMatchObject({ draining: true });
    await expect(
      controller.dispatch(enrollment.node.id, { ...command, jobId: 'job-while-draining' })
    ).rejects.toThrow(/draining/);

    await agent.stop();
    for (let attempt = 0; attempt < 40 && controller.connected(enrollment.node.id); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(controller.setDrain(enrollment.node.id, false)).resolves.toEqual({
      persisted: true,
      acknowledged: false
    });

    const restartedAgent = new NodeAgent(agentOptions);
    await restartedAgent.start();
    for (let attempt = 0; attempt < 80 && !controller.connected(enrollment.node.id); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const state = JSON.parse(await nodeSecrets.get('cluster:node-identity')) as {
        draining: boolean;
      };
      if (!state.draining) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      JSON.parse(await nodeSecrets.get('cluster:node-identity')) as { draining: boolean }
    ).toMatchObject({ draining: false });
    await controller.dispatch(enrollment.node.id, { ...command, jobId: 'job-after-undrain' });
    await restartedAgent.stop();

    await cluster.revoke(enrollment.node.id);
    const revoked = new WebSocket(`wss://127.0.0.1:${port}/api/v1/nodes/connect`, {
      cert: rotated.active.certificatePem,
      key: rotated.active.privateKeyPem,
      ca: rotated.active.caCertificatePem,
      rejectUnauthorized: true
    });
    const revokedResult = await new Promise<'opened' | 'rejected'>((resolve) => {
      revoked.once('open', () => resolve('opened'));
      revoked.on('error', () => resolve('rejected'));
      revoked.once('close', () => resolve('rejected'));
    });
    expect(revokedResult).toBe('rejected');
    await controller.stop();
    repository.close();
  }, 45_000);

  it('keeps the old identity active until staged hello proof and expires abandoned stages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-agent-stage-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const coordination = new MemoryCoordinationStore();
    const ca = new FileCertificateAuthority(new MemorySecretStore());
    const cluster = new ClusterService(
      repository,
      coordination,
      new BuiltinTrafficDirector(),
      new InMemoryEventBus(),
      ca
    );
    const token = await cluster.createJoinToken({
      name: 'Worker',
      roles: ['source-worker'],
      region: 'test',
      expiresInSeconds: 60
    });
    const originalKeys = createCertificateSigningRequest('node:enrollment');
    const enrollment = await cluster.enroll({
      token: token.token,
      name: 'Worker',
      publicUrl: 'https://worker.invalid',
      capabilities,
      csrPem: originalKeys.csrPem
    });
    const stagedIdentityTtlMs = 2_000;
    const controller = new AgentController(cluster, ca, coordination, {
      stagedIdentityTtlMs,
      rotationCooldownMs: 0
    });
    await controller.start('127.0.0.1', 0, ['127.0.0.1']);
    const url = `wss://127.0.0.1:${controller.address()!.port}/api/v1/nodes/connect`;
    const original = new WebSocket(url, {
      cert: enrollment.certificate.certificatePem,
      key: originalKeys.privateKeyPem,
      ca: enrollment.certificate.caCertificatePem,
      rejectUnauthorized: true
    });
    await new Promise<void>((resolve, reject) => {
      original.once('open', resolve);
      original.once('error', reject);
    });
    const response = (socket: WebSocket) =>
      new Promise<AgentEnvelope>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('message', (data) =>
          resolve(AgentEnvelopeSchema.parse(JSON.parse(data.toString())))
        );
      });
    const send = (
      socket: WebSocket,
      sequence: number,
      kind: AgentEnvelope['kind'],
      payload: Record<string, unknown>
    ) => {
      socket.send(
        JSON.stringify({
          version: 1,
          id: `request-${sequence}`,
          sequence,
          kind,
          sentAt: new Date().toISOString(),
          payload
        })
      );
    };
    let reply = response(original);
    send(original, 1, 'hello', {
      nodeId: enrollment.node.id,
      capabilities,
      draining: false
    });
    await reply;

    const abandonedKeys = createCertificateSigningRequest(`node:${enrollment.node.id}`);
    reply = response(original);
    send(original, 2, 'certificate.rotate', { csrPem: abandonedKeys.csrPem });
    const abandonedReply = await reply;
    expect(abandonedReply.kind).toBe('certificate.rotated');
    if (abandonedReply.kind !== 'certificate.rotated') throw new Error('Rotation reply missing');
    const abandoned = abandonedReply.payload.certificate;
    const unproven = new WebSocket(url, {
      cert: abandoned.certificatePem,
      key: abandonedKeys.privateKeyPem,
      ca: abandoned.caCertificatePem,
      rejectUnauthorized: true
    });
    await new Promise<void>((resolve, reject) => {
      unproven.once('open', resolve);
      unproven.once('error', reject);
    });
    unproven.close(1000, 'proof intentionally omitted');
    await new Promise<void>((resolve) => unproven.once('close', () => resolve()));
    expect(
      await cluster.certificateIsActive(enrollment.node.id, enrollment.certificate.serialNumber)
    ).toBe(true);
    expect(await cluster.certificateIsActive(enrollment.node.id, abandoned.serialNumber)).toBe(
      false
    );

    await new Promise((resolve) => setTimeout(resolve, stagedIdentityTtlMs + 150));
    const late = new WebSocket(url, {
      cert: abandoned.certificatePem,
      key: abandonedKeys.privateKeyPem,
      ca: abandoned.caCertificatePem,
      rejectUnauthorized: true
    });
    const lateResult = await new Promise<'opened' | 'rejected'>((resolve) => {
      late.once('open', () => resolve('opened'));
      late.on('error', () => resolve('rejected'));
      late.once('close', () => resolve('rejected'));
    });
    expect(lateResult).toBe('rejected');
    expect(
      await cluster.certificateIsActive(enrollment.node.id, enrollment.certificate.serialNumber)
    ).toBe(true);

    const replacementKeys = createCertificateSigningRequest(`node:${enrollment.node.id}`);
    reply = response(original);
    send(original, 3, 'certificate.rotate', { csrPem: replacementKeys.csrPem });
    const replacementReply = await reply;
    expect(replacementReply.kind).toBe('certificate.rotated');
    if (replacementReply.kind !== 'certificate.rotated')
      throw new Error('Replacement reply missing');
    const replacement = replacementReply.payload.certificate;
    const replacementSocket = new WebSocket(url, {
      cert: replacement.certificatePem,
      key: replacementKeys.privateKeyPem,
      ca: replacement.caCertificatePem,
      rejectUnauthorized: true
    });
    await new Promise<void>((resolve, reject) => {
      replacementSocket.once('open', resolve);
      replacementSocket.once('error', reject);
    });
    const originalClosed = new Promise<void>((resolve) => original.once('close', () => resolve()));
    reply = response(replacementSocket);
    send(replacementSocket, 1, 'hello', {
      nodeId: enrollment.node.id,
      capabilities,
      draining: false
    });
    await reply;
    await originalClosed;
    expect(await cluster.certificateIsActive(enrollment.node.id, replacement.serialNumber)).toBe(
      true
    );
    expect(
      await cluster.certificateIsActive(enrollment.node.id, enrollment.certificate.serialNumber)
    ).toBe(false);

    replacementSocket.close();
    await controller.stop();
    repository.close();
  });

  it('rejects transport abuse and cleans connection-scoped pending requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-agent-abuse-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const coordination = new MemoryCoordinationStore();
    const ca = new FileCertificateAuthority(new MemorySecretStore());
    const cluster = new ClusterService(
      repository,
      coordination,
      new BuiltinTrafficDirector(),
      new InMemoryEventBus(),
      ca
    );
    const token = await cluster.createJoinToken({
      name: 'Worker',
      roles: ['source-worker'],
      region: 'test',
      expiresInSeconds: 60
    });
    const keys = createCertificateSigningRequest('node:enrollment');
    const enrollment = await cluster.enroll({
      token: token.token,
      name: 'Worker',
      publicUrl: 'https://worker.invalid',
      capabilities,
      csrPem: keys.csrPem
    });
    const controller = new AgentController(cluster, ca, coordination);
    controller.setEnsureHandler(async () => new Promise<void>(() => undefined));
    await controller.start('127.0.0.1', 0, ['127.0.0.1', 'localhost']);
    const port = controller.address()!.port;
    const url = 'wss://127.0.0.1:' + port + '/api/v1/nodes/connect';
    const tls = {
      cert: enrollment.certificate.certificatePem,
      key: keys.privateKeyPem,
      ca: enrollment.certificate.caCertificatePem,
      rejectUnauthorized: true
    };
    const open = async (target = url, options: ClientOptions = tls) => {
      const socket = new WebSocket(target, options);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      return socket;
    };
    const rejected = async (socket: WebSocket) =>
      new Promise<'opened' | 'rejected'>((resolve) => {
        socket.once('open', () => resolve('opened'));
        socket.on('error', () => resolve('rejected'));
        socket.once('close', () => resolve('rejected'));
      });
    const connectionResult = async (options: ClientOptions) => {
      try {
        return await rejected(new WebSocket(url, options));
      } catch {
        return 'rejected' as const;
      }
    };
    const sendHello = async (socket: WebSocket, nodeId = enrollment.node.id) => {
      const reply = new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('message', () => resolve());
      });
      socket.send(
        JSON.stringify({
          version: 1,
          id: 'hello',
          sequence: 1,
          kind: 'hello',
          sentAt: new Date().toISOString(),
          payload: { nodeId, capabilities, draining: false }
        })
      );
      await reply;
    };

    const silent = await open();
    await sendHello(silent);
    const abortController = new AbortController();
    const aborted = controller.request(
      enrollment.node.id,
      'drain',
      { draining: true },
      5_000,
      abortController.signal
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.pendingRequestCount(enrollment.node.id)).toBe(1);
    abortController.abort(new Error('test abort'));
    await expect(aborted).rejects.toThrow(/test abort/);
    expect(controller.pendingRequestCount(enrollment.node.id)).toBe(0);

    await expect(
      controller.request(enrollment.node.id, 'drain', { draining: true }, 20)
    ).rejects.toThrow(/timed out/);
    expect(controller.pendingRequestCount(enrollment.node.id)).toBe(0);

    const disconnected = controller.request(enrollment.node.id, 'drain', { draining: true }, 5_000);
    silent.close();
    await expect(disconnected).rejects.toThrow(/closed/);
    expect(controller.pendingRequestCount(enrollment.node.id)).toBe(0);

    const nodeSecrets = new MemorySecretStore();
    await nodeSecrets.put(
      'cluster:node-identity',
      JSON.stringify({
        nodeId: enrollment.node.id,
        ...enrollment.certificate,
        privateKeyPem: keys.privateKeyPem
      })
    );
    const agent = new NodeAgent({
      controllerUrl: url,
      enrollmentUrl: 'https://unused.invalid',
      nodeName: 'Worker',
      publicUrl: 'https://worker.invalid',
      secretStore: nodeSecrets,
      capabilities: async () => capabilities,
      maxMessagesPerMinute: 4,
      onSegment: async () => {},
      onCancel: async () => {},
      onProvider: async () => ({})
    });
    await agent.start();
    for (let attempt = 0; attempt < 80 && !controller.connected(enrollment.node.id); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));

    const ensureAbort = new AbortController();
    const ensure = agent.ensure('ensure-grant', 0, ensureAbort.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.pendingRequestCount()).toBe(1);
    ensureAbort.abort(new Error('ensure aborted'));
    await expect(ensure).rejects.toThrow(/ensure aborted/);
    expect(agent.pendingRequestCount()).toBe(0);

    for (let index = 0; index < 3; index += 1)
      await controller.request(enrollment.node.id, 'drain', { draining: index % 2 === 0 });
    await expect(
      controller.request(enrollment.node.id, 'drain', { draining: false }, 2_000)
    ).rejects.toThrow(/closed|not connected/);
    expect(agent.pendingRequestCount()).toBe(0);
    await agent.stop();

    const malformed = await open();
    const malformedClosed = new Promise<number>((resolve) => malformed.once('close', resolve));
    malformed.send(
      JSON.stringify({
        version: 1,
        id: 'malformed',
        sequence: 1,
        kind: 'hello',
        sentAt: new Date().toISOString(),
        payload: {
          nodeId: enrollment.node.id,
          capabilities,
          draining: false,
          unexpected: true
        }
      })
    );
    expect(await malformedClosed).toBe(1008);

    const mismatched = await open();
    const mismatchedClosed = new Promise<number>((resolve) => mismatched.once('close', resolve));
    mismatched.send(
      JSON.stringify({
        version: 1,
        id: 'mismatch',
        sequence: 1,
        kind: 'hello',
        sentAt: new Date().toISOString(),
        payload: { nodeId: 'another-node', capabilities, draining: false }
      })
    );
    expect(await mismatchedClosed).toBe(1008);

    const oversized = await open();
    const oversizedClosed = new Promise<number>((resolve) => oversized.once('close', resolve));
    oversized.send(Buffer.alloc(256 * 1024 + 1));
    expect([1009, 1006]).toContain(await oversizedClosed);

    const stolenKeys = createCertificateSigningRequest('node:stolen');
    expect(
      await connectionResult({
        ...tls,
        key: stolenKeys.privateKeyPem
      })
    ).toBe('rejected');

    const expiredKeys = createCertificateSigningRequest('node:' + enrollment.node.id);
    const expired = await ca.signCsr('node:' + enrollment.node.id, expiredKeys.csrPem, 1);

    const rogueCa = new FileCertificateAuthority(new MemorySecretStore());
    const forgedKeys = createCertificateSigningRequest('node:' + enrollment.node.id);
    const forged = await rogueCa.signCsr('node:' + enrollment.node.id, forgedKeys.csrPem, 60_000);
    expect(
      await connectionResult({
        cert: forged.certificatePem,
        key: forgedKeys.privateKeyPem,
        ca: enrollment.certificate.caCertificatePem,
        rejectUnauthorized: true
      })
    ).toBe('rejected');

    const hostname = await open('wss://localhost:' + port + '/api/v1/nodes/connect', {
      ...tls,
      createConnection: ((options: object, callback: () => void) =>
        tlsConnect(
          { ...options, host: '127.0.0.1', servername: 'localhost' } as ConnectionOptions,
          callback
        )) as unknown as NonNullable<ClientOptions['createConnection']>
    });
    await sendHello(hostname);
    expect(controller.connected(enrollment.node.id)).toBe(true);
    hostname.close();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await cluster.activateNodeCertificate(enrollment.node.id, expired);
    expect(
      await connectionResult({
        cert: expired.certificatePem,
        key: expiredKeys.privateKeyPem,
        ca: expired.caCertificatePem,
        rejectUnauthorized: true
      })
    ).toBe('rejected');

    await controller.stop();
    repository.close();
  });
});
