import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../adapters/src/sqlite-repository.js';
import { MemoryCoordinationStore } from '../../adapters/src/local-infrastructure.js';
import { BuiltinTrafficDirector, ClusterService } from './cluster-service.js';
import { InMemoryEventBus, type CertificateAuthority } from './index.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
);

const capabilities = {
  encoders: ['libx264'],
  hardwareDevices: [],
  maxWorkers: 4,
  activeWorkers: 0,
  queuedWorkers: 0,
  cacheBytes: 0,
  cacheLimitBytes: null,
  egressMbps: 0,
  providerIds: ['provider-1']
};

class FakeCertificateAuthority implements CertificateAuthority {
  issued = 0;

  async issue(_commonName: string, ttlMs: number) {
    const serialNumber = `serial-${++this.issued}`;
    return {
      certificatePem: `certificate-${serialNumber}`,
      privateKeyPem: `private-key-${serialNumber}`,
      caCertificatePem: 'test-ca',
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      serialNumber,
      fingerprintSha256: `fingerprint-${serialNumber}`
    };
  }

  async caCertificate(): Promise<string> {
    return 'test-ca';
  }
}

describe('cluster service', () => {
  it('routes new sessions away from saturated edges', async () => {
    const now = new Date().toISOString();
    const director = new BuiltinTrafficDirector();
    const selected = await director.selectEdge('capacity-sensitive-session', [
      {
        id: 'saturated',
        name: 'Saturated edge',
        roles: ['edge'],
        region: 'local',
        publicUrl: 'https://saturated.example',
        state: 'online',
        capabilities: {
          ...capabilities,
          activeWorkers: 4,
          cacheBytes: 100,
          cacheLimitBytes: 100,
          egressMbps: 1_000_000
        },
        weight: 100,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'available',
        name: 'Available edge',
        roles: ['edge'],
        region: 'local',
        publicUrl: 'https://available.example',
        state: 'online',
        capabilities,
        weight: 100,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now
      }
    ]);

    expect(selected?.id).toBe('available');
  });

  it('consumes join tokens once and honors draining edges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-cluster-'));
    dirs.push(dir);
    const repository = new SqliteRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    const claim = await cluster.createJoinToken({
      name: 'London edge',
      roles: ['edge'],
      region: 'eu-west',
      expiresInSeconds: 60
    });
    const enrolled = await cluster.enroll({
      token: claim.token,
      name: 'London edge',
      publicUrl: 'https://edge.example',
      capabilities
    });
    await expect(
      cluster.enroll({
        token: claim.token,
        name: 'Duplicate',
        publicUrl: 'https://duplicate.example',
        capabilities
      })
    ).rejects.toThrow(/already used/);
    expect((await cluster.selectEdge('session-a', 'eu-west'))?.nodeId).toBe(enrolled.node.id);
    await cluster.drain(enrolled.node.id, true);
    expect(await cluster.selectEdge('session-a', 'eu-west')).toBeUndefined();
  });

  it('retries heartbeat conflicts without clearing durable drain state', async () => {
    class DrainDuringHeartbeatRepository extends SqliteRepository {
      injectedConflict = false;

      override async recordNodeHeartbeat(
        update: Parameters<SqliteRepository['recordNodeHeartbeat']>[0]
      ) {
        if (!this.injectedConflict) {
          this.injectedConflict = true;
          const current = (await this.getVersionedNode(update.nodeId))!;
          await super.setNodeDrain({
            nodeId: update.nodeId,
            expectedRevision: current.revision,
            draining: true,
            updatedAt: new Date().toISOString()
          });
          return {
            applied: false as const,
            reason: 'revision-conflict' as const,
            current: (await this.getVersionedNode(update.nodeId))!
          };
        }
        return super.recordNodeHeartbeat(update);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-heartbeat-cas-'));
    dirs.push(dir);
    const repository = new DrainDuringHeartbeatRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    await cluster.registerLocal({
      id: 'edge-cas',
      name: 'Edge CAS',
      roles: ['edge'],
      region: 'local',
      publicUrl: 'https://edge-cas.example',
      state: 'online',
      capabilities,
      weight: 100
    });

    const heartbeat = await cluster.heartbeat(
      'edge-cas',
      { ...capabilities, activeWorkers: 2 },
      'online'
    );
    expect(repository.injectedConflict).toBe(true);
    expect(heartbeat.state).toBe('draining');
    expect(heartbeat.capabilities.activeWorkers).toBe(2);

    const heartbeatRecord = (await repository.getVersionedNode(heartbeat.id))!;
    const staleHeartbeatAt = new Date(Date.now() - 120_000).toISOString();
    await repository.recordNodeHeartbeat({
      nodeId: heartbeat.id,
      expectedRevision: heartbeatRecord.revision,
      capabilities: heartbeat.capabilities,
      reportedState: 'online',
      lastHeartbeatAt: staleHeartbeatAt,
      updatedAt: staleHeartbeatAt
    });
    expect((await cluster.list()).find((node) => node.id === heartbeat.id)?.state).toBe('draining');
  });

  it('reports bounded heartbeat contention after five revision conflicts', async () => {
    class ContendedHeartbeatRepository extends SqliteRepository {
      attempts = 0;

      override async recordNodeHeartbeat(
        update: Parameters<SqliteRepository['recordNodeHeartbeat']>[0]
      ) {
        this.attempts += 1;
        return {
          applied: false as const,
          reason: 'revision-conflict' as const,
          current: (await this.getVersionedNode(update.nodeId))!
        };
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-heartbeat-contention-'));
    dirs.push(dir);
    const repository = new ContendedHeartbeatRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    await cluster.registerLocal({
      id: 'contended',
      name: 'Contended',
      roles: ['edge'],
      region: 'local',
      publicUrl: 'https://contended.example',
      state: 'online',
      capabilities,
      weight: 100
    });

    await expect(cluster.heartbeat('contended', capabilities, 'online')).rejects.toThrow(
      /repeated concurrent updates/
    );
    expect(repository.attempts).toBe(5);
  });

  it('requires revocation and retries a concurrent update before removing a node', async () => {
    class ConflictOnceRepository extends SqliteRepository {
      removalAttempts = 0;

      override async removeNode(
        id: string,
        expectedRevision: number
      ): ReturnType<SqliteRepository['removeNode']> {
        this.removalAttempts += 1;
        if (this.removalAttempts === 1)
          return {
            applied: false as const,
            reason: 'revision-conflict' as const,
            current: (await this.getVersionedNode(id))!
          };
        return super.removeNode(id, expectedRevision);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-node-remove-cas-'));
    dirs.push(dir);
    const repository = new ConflictOnceRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    await cluster.registerLocal({
      id: 'removable-node',
      name: 'Removable node',
      roles: ['source-worker'],
      region: 'local',
      publicUrl: 'https://worker.example',
      state: 'online',
      capabilities,
      weight: 100
    });

    await expect(cluster.remove('removable-node')).rejects.toThrow(
      'Revoke the cluster node before removing it'
    );
    await cluster.revoke('removable-node');
    await expect(cluster.remove('removable-node')).resolves.toBeUndefined();
    expect(repository.removalAttempts).toBe(2);
    await expect(repository.getNode('removable-node')).resolves.toBeUndefined();
  });

  it('reports provider-binding dependencies when removing a revoked node', async () => {
    class DependencyRepository extends SqliteRepository {
      override async removeNode(
        id: string,
        _expectedRevision: number
      ): ReturnType<SqliteRepository['removeNode']> {
        return {
          applied: false as const,
          reason: 'dependency-conflict' as const,
          current: (await this.getVersionedNode(id))!,
          dependencies: ['binding-1']
        };
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-node-remove-dependency-'));
    dirs.push(dir);
    const repository = new DependencyRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    await cluster.registerLocal({
      id: 'bound-node',
      name: 'Bound node',
      roles: ['source-worker'],
      region: 'local',
      publicUrl: 'https://bound-worker.example',
      state: 'online',
      capabilities,
      weight: 100
    });
    await cluster.revoke('bound-node');

    await expect(cluster.remove('bound-node')).rejects.toThrow(
      'Delete every provider binding for this node before removing it'
    );
  });

  it('reconciles ambiguous binding begin and finalize commits', async () => {
    class AmbiguousBindingRepository extends SqliteRepository {
      throwAfterBegin = true;
      throwAfterFinalize = true;

      override async beginProviderBindingDeletion(
        ...args: Parameters<SqliteRepository['beginProviderBindingDeletion']>
      ) {
        const result = await super.beginProviderBindingDeletion(...args);
        if (result.applied && this.throwAfterBegin) {
          this.throwAfterBegin = false;
          throw new Error('simulated ambiguous binding begin');
        }
        return result;
      }

      override async finalizeProviderBindingDeletion(
        ...args: Parameters<SqliteRepository['finalizeProviderBindingDeletion']>
      ) {
        const result = await super.finalizeProviderBindingDeletion(...args);
        if (result.applied && this.throwAfterFinalize) {
          this.throwAfterFinalize = false;
          throw new Error('simulated ambiguous binding finalize');
        }
        return result;
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-binding-ambiguous-'));
    dirs.push(dir);
    const repository = new AmbiguousBindingRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    const node = await cluster.registerLocal({
      id: 'binding-ambiguous-worker',
      name: 'Binding ambiguous worker',
      roles: ['source-worker'],
      region: 'local',
      publicUrl: 'https://binding-ambiguous.example',
      state: 'online',
      capabilities,
      weight: 100
    });
    const now = new Date().toISOString();
    const provider = {
      id: 'provider-binding-ambiguous',
      type: 'jellyfin' as const,
      name: 'Ambiguous provider',
      baseUrl: 'https://jellyfin.example',
      authMode: 'user_token' as const,
      secretRef: 'provider-binding:ambiguous',
      capabilities: ['search' as const],
      healthy: true,
      createdAt: now,
      updatedAt: now
    };
    await repository.createProviderBinding(
      provider,
      {
        id: 'binding-ambiguous',
        providerId: provider.id,
        nodeId: node.id,
        secretRef: 'provider-binding:ambiguous:worker',
        reachable: true,
        state: 'healthy',
        deletionPending: false,
        validatedAt: now,
        createdAt: now,
        updatedAt: now
      },
      null
    );

    const deleting = await cluster.beginBindingDeletion('binding-ambiguous');
    expect(repository.throwAfterBegin).toBe(false);
    expect(deleting).toMatchObject({
      revision: 2,
      value: { deletionPending: true, state: 'revoked' }
    });
    await expect(
      cluster.finalizeBindingDeletion('binding-ambiguous', deleting!.revision)
    ).resolves.toBeUndefined();
    expect(repository.throwAfterFinalize).toBe(false);
    await expect(
      repository.getProviderBinding('binding-ambiguous', { includeDeletionPending: true })
    ).resolves.toBeUndefined();
  });

  it('retries certificate rotation without clearing a concurrent drain', async () => {
    class DrainDuringRotationRepository extends SqliteRepository {
      injectedConflict = false;

      override async rotateNodeCertificate(
        update: Parameters<SqliteRepository['rotateNodeCertificate']>[0]
      ) {
        if (!this.injectedConflict) {
          this.injectedConflict = true;
          const current = (await this.getVersionedNode(update.nodeId))!;
          await super.setNodeDrain({
            nodeId: update.nodeId,
            expectedRevision: current.revision,
            draining: true,
            updatedAt: new Date().toISOString()
          });
          return {
            applied: false as const,
            reason: 'revision-conflict' as const,
            current: (await this.getVersionedNode(update.nodeId))!
          };
        }
        return super.rotateNodeCertificate(update);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-certificate-drain-race-'));
    dirs.push(dir);
    const repository = new DrainDuringRotationRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const certificates = new FakeCertificateAuthority();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus(),
      certificates
    );
    const claim = await cluster.createJoinToken({
      name: 'Certificate node',
      roles: ['source-worker'],
      region: 'local',
      expiresInSeconds: 60
    });
    const enrolled = await cluster.enroll({
      token: claim.token,
      name: 'Certificate node',
      publicUrl: 'https://certificate-node.example',
      capabilities
    });

    const rotated = await cluster.rotateCertificate(enrolled.node.id);
    expect(repository.injectedConflict).toBe(true);
    await expect(repository.getNode(enrolled.node.id)).resolves.toMatchObject({
      state: 'draining',
      certificateExpiresAt: rotated.expiresAt
    });
    expect(await repository.listNodeCertificates(enrolled.node.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serialNumber: 'serial-1', revokedAt: expect.any(String) }),
        expect.objectContaining({ serialNumber: 'serial-2', revokedAt: null })
      ])
    );
  });

  it('cannot activate a rotated certificate after concurrent node revocation', async () => {
    class RevokeDuringRotationRepository extends SqliteRepository {
      injectedConflict = false;

      override async rotateNodeCertificate(
        update: Parameters<SqliteRepository['rotateNodeCertificate']>[0]
      ) {
        if (!this.injectedConflict) {
          this.injectedConflict = true;
          const current = (await this.getVersionedNode(update.nodeId))!;
          await super.revokeNode({
            nodeId: update.nodeId,
            expectedRevision: current.revision,
            revokedAt: new Date().toISOString()
          });
          return {
            applied: false as const,
            reason: 'revision-conflict' as const,
            current: (await this.getVersionedNode(update.nodeId))!
          };
        }
        return super.rotateNodeCertificate(update);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-certificate-revoke-race-'));
    dirs.push(dir);
    const repository = new RevokeDuringRotationRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const certificates = new FakeCertificateAuthority();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus(),
      certificates
    );
    const claim = await cluster.createJoinToken({
      name: 'Revoked node',
      roles: ['source-worker'],
      region: 'local',
      expiresInSeconds: 60
    });
    const enrolled = await cluster.enroll({
      token: claim.token,
      name: 'Revoked node',
      publicUrl: 'https://revoked-node.example',
      capabilities
    });

    await expect(cluster.rotateCertificate(enrolled.node.id)).rejects.toThrow(
      'Active cluster node was not found'
    );
    await expect(repository.getNode(enrolled.node.id)).resolves.toMatchObject({ state: 'revoked' });
    const storedCertificates = await repository.listNodeCertificates(enrolled.node.id);
    expect(storedCertificates).toHaveLength(1);
    expect(storedCertificates[0]).toMatchObject({
      serialNumber: 'serial-1',
      revokedAt: expect.any(String)
    });
  });

  it('retries revocation after a concurrent rotation and revokes the replacement', async () => {
    class RotateDuringRevocationRepository extends SqliteRepository {
      injectedConflict = false;

      override async revokeNode(update: Parameters<SqliteRepository['revokeNode']>[0]) {
        if (!this.injectedConflict) {
          this.injectedConflict = true;
          const current = (await this.getVersionedNode(update.nodeId))!;
          const createdAt = new Date().toISOString();
          await super.rotateNodeCertificate({
            nodeId: update.nodeId,
            expectedRevision: current.revision,
            certificate: {
              nodeId: update.nodeId,
              serialNumber: 'concurrent-rotation',
              fingerprintSha256: 'concurrent-fingerprint',
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              revokedAt: null,
              createdAt
            },
            updatedAt: createdAt
          });
          return {
            applied: false as const,
            reason: 'revision-conflict' as const,
            current: (await this.getVersionedNode(update.nodeId))!
          };
        }
        return super.revokeNode(update);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-revoke-rotation-race-'));
    dirs.push(dir);
    const repository = new RotateDuringRevocationRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const certificates = new FakeCertificateAuthority();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus(),
      certificates
    );
    const claim = await cluster.createJoinToken({
      name: 'Rotating node',
      roles: ['source-worker'],
      region: 'local',
      expiresInSeconds: 60
    });
    const enrolled = await cluster.enroll({
      token: claim.token,
      name: 'Rotating node',
      publicUrl: 'https://rotating-node.example',
      capabilities
    });

    await expect(cluster.revoke(enrolled.node.id)).resolves.toMatchObject({ state: 'revoked' });
    expect(repository.injectedConflict).toBe(true);
    expect(
      (await repository.listNodeCertificates(enrolled.node.id)).every((item) => item.revokedAt)
    ).toBe(true);
  });

  it('allows only one concurrent consumer of a join token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-cluster-race-'));
    dirs.push(dir);
    const repository = new SqliteRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    const claim = await cluster.createJoinToken({
      name: 'Worker',
      roles: ['source-worker'],
      region: 'local',
      expiresInSeconds: 60
    });
    const attempt = (name: string) =>
      cluster.enroll({
        token: claim.token,
        name,
        publicUrl: `https://${name.toLowerCase()}.example`,
        capabilities
      });

    const results = await Promise.allSettled([attempt('WorkerA'), attempt('WorkerB')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await repository.listNodes()).toHaveLength(1);
  });

  it('fails explicit placement when the requested encoder is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-placement-'));
    dirs.push(dir);
    const repository = new SqliteRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    await cluster.registerLocal({
      id: 'worker',
      name: 'Worker',
      roles: ['source-worker'],
      region: 'local',
      publicUrl: 'https://worker.example',
      state: 'online',
      capabilities,
      weight: 100
    });
    const result = await cluster.previewPlacement({
      policy: 'hosted',
      preferredNodeId: 'worker',
      providerId: 'provider-1',
      profile: {
        profileId: 'hevc',
        revision: 1,
        name: 'HEVC',
        platform: 'pc',
        state: 'experimental',
        video: {
          codec: 'h265',
          encoder: 'hevc_nvenc',
          hardwareMode: 'nvenc',
          decodeMode: 'auto',
          pixelFormat: 'yuv420p',
          width: 1920,
          height: 1080,
          frameRate: 30,
          bitrateKbps: 6000,
          maxrateKbps: 7000,
          bufferKbps: 12000,
          gop: 60,
          bFrames: 0
        },
        audio: { codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, bitrateKbps: 192 },
        delivery: {
          method: 'hls',
          container: 'mpegts',
          segmentType: 'mpegts',
          segmentDuration: 4,
          playlistType: 'vod',
          latencyMode: 'standard'
        },
        processing: { toneMap: false, burnSubtitles: false, passthrough: 'never', maxWorkers: 1 },
        createdAt: new Date().toISOString()
      }
    });
    expect(result).toEqual({ reason: 'preferred-node-unavailable' });
  });

  it('degrades nodes after 45 seconds and marks them offline after 90 seconds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-heartbeat-'));
    dirs.push(dir);
    const repository = new SqliteRepository(join(dir, 'state.sqlite'));
    await repository.migrate();
    const cluster = new ClusterService(
      repository,
      new MemoryCoordinationStore(),
      new BuiltinTrafficDirector(),
      new InMemoryEventBus()
    );
    const node = await cluster.registerLocal({
      id: 'edge',
      name: 'Edge',
      roles: ['edge'],
      region: 'local',
      publicUrl: 'https://edge.example',
      state: 'online',
      capabilities,
      weight: 100
    });
    const online = (await repository.getVersionedNode(node.id))!;
    const degradedHeartbeatAt = new Date(Date.now() - 46_000).toISOString();
    await repository.recordNodeHeartbeat({
      nodeId: node.id,
      expectedRevision: online.revision,
      capabilities: online.value.capabilities,
      reportedState: 'online',
      lastHeartbeatAt: degradedHeartbeatAt,
      updatedAt: degradedHeartbeatAt
    });
    expect((await cluster.list())[0]?.state).toBe('degraded');
    expect(await cluster.selectEdge('session')).toBeUndefined();
    const degraded = (await repository.getVersionedNode(node.id))!;
    const offlineHeartbeatAt = new Date(Date.now() - 91_000).toISOString();
    await repository.recordNodeHeartbeat({
      nodeId: node.id,
      expectedRevision: degraded.revision,
      capabilities: degraded.value.capabilities,
      reportedState: 'online',
      lastHeartbeatAt: offlineHeartbeatAt,
      updatedAt: offlineHeartbeatAt
    });
    expect((await cluster.list())[0]?.state).toBe('offline');
  });
});
