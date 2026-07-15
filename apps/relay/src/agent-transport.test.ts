// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { AgentController, NodeAgent, redactAgentContext } from './agent-transport.js';
import {
  EncryptedFileSecretStore,
  FileCertificateAuthority,
  MemorySecretStore,
  MemoryCoordinationStore,
  SqliteRepository
} from '@vrrelay/adapters';
import { BuiltinTrafficDirector, ClusterService, InMemoryEventBus } from '@vrrelay/application';
import type { AgentEnvelope, NodeCapability } from '@vrrelay/domain';

const directories: string[] = [];
afterEach(async () => {
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
        message: 'failed token=vrr_join_reusable-secret'
      })
    ).toEqual({
      request: {
        headers: { authorization: '[REDACTED]' },
        body: { password: '[REDACTED]', nested: [{ apiKey: '[REDACTED]' }] }
      },
      message: 'failed token=[REDACTED]'
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
    const enrollment = await cluster.enroll({
      token: joinToken.token,
      name: 'Worker',
      publicUrl: 'https://worker.invalid',
      capabilities
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
        capabilities
      })
    ).rejects.toThrow(/invalid|used/);
    const controller = new AgentController(cluster, ca, coordination);
    await controller.start('127.0.0.1', 0, ['127.0.0.1']);
    const port = controller.address()!.port;
    const certificate = enrollment.certificate!;
    const socket = new WebSocket(`wss://127.0.0.1:${port}/api/v1/nodes/connect`, {
      cert: certificate.certificatePem,
      key: certificate.privateKeyPem,
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
      payload: { capabilities }
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
      JSON.stringify({ nodeId: enrollment.node.id, ...certificate })
    );
    let releaseSegment!: () => void;
    let signalSegmentStarted!: () => void;
    const segmentStarted = new Promise<void>((resolve) => {
      signalSegmentStarted = resolve;
    });
    const segmentRelease = new Promise<void>((resolve) => {
      releaseSegment = resolve;
    });
    const agent = new NodeAgent({
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
    });
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
    await controller.request(enrollment.node.id, 'certificate.rotate', {}, 5_000);
    const rotated = JSON.parse(await nodeSecrets.get('cluster:node-identity')) as {
      nodeId: string;
      serialNumber: string;
    };
    expect(rotated.serialNumber).not.toBe(certificate.serialNumber);
    expect(await cluster.certificateIsActive(rotated.nodeId, rotated.serialNumber)).toBe(true);
    await agent.stop();
    await cluster.revoke(enrollment.node.id);
    const revoked = new WebSocket(`wss://127.0.0.1:${port}/api/v1/nodes/connect`, {
      cert: certificate.certificatePem,
      key: certificate.privateKeyPem,
      ca: certificate.caCertificatePem,
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
  });
});
