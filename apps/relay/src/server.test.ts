// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  ApplicationError,
  AuditService,
  BuiltinTrafficDirector,
  ClusterService,
  InMemoryEventBus
} from '@vrrelay/application';
import { MemoryCoordinationStore, SqliteRepository } from '@vrrelay/adapters';
import { DeleteProviderBindingQuerySchema } from '@vrrelay/contracts';
import type { AuditEvent, ClusterNode, ProviderBinding, ProviderConnection } from '@vrrelay/domain';
import { loadConfig } from './config.js';
import {
  assertSetupAuthorized,
  assertProductionNodePublicUrl,
  auditActor,
  auditedOperation,
  createServer,
  cacheInventoryWithNodeTarget,
  deleteProviderBindingWithCredentialCleanup,
  evictCacheWithNodeTarget,
  isInternalPeer,
  isLoopbackPeer,
  liveHlsUpstreamUrl,
  liveOriginSourceUrl,
  meteredReadable,
  placementNodeConnectivity,
  providerBindingDeletionAuditContext,
  redactRequestUrl,
  rotateNodeCertificateWithDelivery,
  setNodeDrainWithDelivery,
  shouldRateLimitRequest,
  type ControlPlaneHttpSurface,
  type ServerServices
} from './server.js';

const temporaryDirectories: string[] = [];
const inertServerServices = {
  repository: {},
  auth: {},
  providers: {},
  profiles: {},
  sessions: {},
  live: {},
  events: {},
  capabilities: {},
  cluster: {},
  objectStore: {},
  coordination: {},
  metrics: {},
  audit: {},
  backends: {}
} as ServerServices;

afterEach(async () =>
  Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
);

async function bindingCleanupFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vrrelay-binding-api-'));
  temporaryDirectories.push(directory);
  const repository = new SqliteRepository(join(directory, 'state.sqlite'));
  await repository.migrate();
  const now = new Date().toISOString();
  const node: ClusterNode = {
    id: 'binding-worker',
    name: 'Binding worker',
    roles: ['source-worker'],
    region: 'local',
    publicUrl: 'https://binding-worker.example',
    state: 'online',
    capabilities: {
      encoders: ['libx264'],
      hardwareDevices: [],
      maxWorkers: 2,
      activeWorkers: 0,
      queuedWorkers: 0,
      cacheBytes: 0,
      cacheLimitBytes: null,
      egressMbps: 0,
      providerIds: ['provider-binding-api']
    },
    weight: 100,
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now
  };
  const provider: ProviderConnection = {
    id: 'provider-binding-api',
    type: 'jellyfin',
    name: 'Binding API provider',
    baseUrl: 'https://jellyfin.example',
    authMode: 'user_token',
    secretRef: 'provider-binding:api',
    capabilities: ['search'],
    healthy: true,
    createdAt: now,
    updatedAt: now
  };
  const binding: ProviderBinding = {
    id: 'binding-api',
    providerId: provider.id,
    nodeId: node.id,
    secretRef: 'provider-binding:api:worker',
    reachable: true,
    state: 'healthy',
    deletionPending: false,
    validatedAt: now,
    createdAt: now,
    updatedAt: now
  };
  await repository.createNode(node);
  await repository.createProviderBinding(provider, binding, null);
  const cluster = new ClusterService(
    repository,
    new MemoryCoordinationStore(),
    new BuiltinTrafficDirector(),
    new InMemoryEventBus()
  );
  return { repository, cluster, node, binding };
}

describe('payload metering', () => {
  it('records chunks that are actually consumed', async () => {
    let bytes = 0;
    const output: Buffer[] = [];
    for await (const chunk of meteredReadable(Readable.from(['hello', ' world']), (size) => {
      bytes += size;
    })) {
      output.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(output).toString()).toBe('hello world');
    expect(bytes).toBe(11);
  });
});

describe('HTTP log redaction', () => {
  it('removes playback and source grants while preserving route context', () => {
    expect(redactRequestUrl('/play/secret-grant/segment/3.ts?cache=1')).toBe(
      '/play/[REDACTED]/segment/3.ts?cache=1'
    );
    expect(redactRequestUrl('/internal/source/source-grant')).toBe('/internal/source/[REDACTED]');
    expect(redactRequestUrl('/api/v1/sessions')).toBe('/api/v1/sessions');
  });
});

describe('control-plane HTTP surface matrix', () => {
  it('treats the standalone runtime as connected without weakening controller placement', () => {
    const disconnected = () => false;
    const standalone = placementNodeConnectivity('standalone', 'local-node', disconnected);
    const controller = placementNodeConnectivity('controller', 'local-node', disconnected);

    expect(standalone?.('local-node')).toBe(true);
    expect(standalone?.('remote-node')).toBe(false);
    expect(controller?.('local-node')).toBe(false);
    expect(placementNodeConnectivity('controller', 'local-node')).toBeUndefined();
  });

  it.each([
    {
      surface: 'controller',
      expected: {
        administration: true,
        vodManifest: true,
        liveManifest: true,
        segment: false,
        liveMedia: false,
        sourceGrant: false,
        ingestAuth: false
      }
    },
    {
      surface: 'standalone',
      expected: {
        administration: true,
        vodManifest: true,
        liveManifest: true,
        segment: true,
        liveMedia: true,
        sourceGrant: true,
        ingestAuth: true
      }
    }
  ] satisfies Array<{
    surface: ControlPlaneHttpSurface;
    expected: Record<string, boolean>;
  }>)('registers the least surface for $surface', async ({ surface, expected }) => {
    const app = await createServer(loadConfig({}), inertServerServices, surface);
    await app.ready();
    expect({
      administration: app.hasRoute({ method: 'GET', url: '/api/v1/providers' }),
      vodManifest: app.hasRoute({ method: 'GET', url: '/play/:token/index.m3u8' }),
      liveManifest: app.hasRoute({ method: 'GET', url: '/play/:token/live.m3u8' }),
      segment: app.hasRoute({ method: 'GET', url: '/play/:token/segment/:index.ts' }),
      liveMedia: app.hasRoute({ method: 'GET', url: '/play/:token/live/*' }),
      sourceGrant: app.hasRoute({ method: 'GET', url: '/internal/source/:token' }),
      ingestAuth: app.hasRoute({ method: 'POST', url: '/internal/mediamtx/auth' })
    }).toEqual(expected);
    await app.close();
  });

  it.each([
    {
      name: 'local HTTP',
      environment: {}
    },
    {
      name: 'public HTTPS advertised URL reached through local recovery',
      environment: {
        VRRELAY_PUBLIC_URL: 'https://relay.example.test',
        VRRELAY_ADMIN_URL: 'https://relay.example.test',
        VRRELAY_PLAYBACK_URL: 'https://relay.example.test',
        VRRELAY_SETUP_TOKEN: 's'.repeat(40)
      }
    },
    {
      name: 'local HTTP administration with public HTTPS playback',
      environment: {
        VRRELAY_PUBLIC_URL: 'https://relay.example.test',
        VRRELAY_ADMIN_URL: 'http://127.0.0.1:8099',
        VRRELAY_PLAYBACK_URL: 'https://play.example.test',
        VRRELAY_SETUP_TOKEN: 's'.repeat(40)
      }
    }
  ])('keeps same-origin dashboard assets usable for $name', async ({ environment }) => {
    const app = await createServer(loadConfig(environment), inertServerServices, 'standalone');
    const response = await app.inject({ method: 'GET', url: '/' });
    const policy = response.headers['content-security-policy'];

    expect(policy).toEqual(expect.any(String));
    expect(policy).not.toContain('upgrade-insecure-requests');
    await app.close();
  });

  it('recognizes the complete loopback range without trusting private-network peers', () => {
    expect(['127.0.0.1', '127.20.30.40', '::1', '::ffff:127.0.0.9'].every(isLoopbackPeer)).toBe(
      true
    );
    expect(isLoopbackPeer('10.0.0.4')).toBe(false);
    expect(isLoopbackPeer('203.0.113.10')).toBe(false);
    expect(isInternalPeer('10.0.0.4')).toBe(true);
    expect(isInternalPeer('fd00::10')).toBe(true);
    expect(isInternalPeer('203.0.113.10')).toBe(false);
  });

  it('rate limits APIs and media paths without charging dashboard assets', () => {
    expect(shouldRateLimitRequest('/api/v1/sessions?limit=20')).toBe(true);
    expect(shouldRateLimitRequest('/internal/agent')).toBe(true);
    expect(shouldRateLimitRequest('/play/session/index.m3u8')).toBe(true);
    expect(shouldRateLimitRequest('/')).toBe(false);
    expect(shouldRateLimitRequest('/_app/immutable/chunks/app.js')).toBe(false);
  });

  it('reports redacted dependency-aware readiness separately from liveness', async () => {
    const checkedAt = new Date().toISOString();
    const app = await createServer(loadConfig({}), {
      ...inertServerServices,
      sessions: { capacity: () => ({ active: 1, limit: 4, queued: 0 }) },
      backends: {
        list: async () => ({
          restartRequired: false,
          items: [
            {
              category: 'object-store',
              kind: 'local',
              healthy: true,
              message: 'internal storage path is intentionally not public',
              checkedAt
            }
          ]
        })
      }
    } as unknown as ServerServices);

    const live = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'ok' });

    const ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ready',
      workers: { active: 1, limit: 4, queued: 0 },
      restartRequired: false,
      dependencies: [{ category: 'object-store', kind: 'local', healthy: true, checkedAt }]
    });
    expect(ready.payload).not.toContain('internal storage path');
    await app.close();
  });

  it('marks readiness degraded for unhealthy dependencies or pending backend restarts', async () => {
    const checkedAt = new Date().toISOString();
    const app = await createServer(loadConfig({}), {
      ...inertServerServices,
      sessions: { capacity: () => ({ active: 0, limit: 4, queued: 2 }) },
      backends: {
        list: async () => ({
          restartRequired: true,
          items: [
            {
              category: 'coordination',
              kind: 'valkey',
              healthy: false,
              message: 'redis://secret-hostname:6379 is unavailable',
              checkedAt
            }
          ]
        })
      }
    } as unknown as ServerServices);

    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      restartRequired: true,
      dependencies: [{ category: 'coordination', kind: 'valkey', healthy: false, checkedAt }]
    });
    expect(response.payload).not.toContain('secret-hostname');
    await app.close();
  });

  it('fails closed instead of serving controller-local media when no edge is available', async () => {
    let manifestCalls = 0;
    const app = await createServer(
      loadConfig({ VRRELAY_NODE_ROLES: 'controller' }),
      {
        ...inertServerServices,
        sessions: {
          touchViewer: async () => ({ id: 'session-1', preferredRegion: undefined }),
          manifest: async () => {
            manifestCalls += 1;
            return '#EXTM3U';
          }
        },
        cluster: { selectEdge: async () => undefined }
      } as unknown as ServerServices,
      'controller'
    );
    const response = await app.inject({ method: 'GET', url: '/play/grant/index.m3u8' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'edge_unavailable' } });
    expect(manifestCalls).toBe(0);
    await app.close();
  });

  it('uses signed edge grants when a controller playlist routes VOD traffic to an edge', async () => {
    const calls: Array<{ token: string; edgeNodeId: string }> = [];
    let manifestToken: string | undefined;
    let manifestBase: string | undefined;
    const app = await createServer(
      loadConfig({ VRRELAY_NODE_ROLES: 'controller', VRRELAY_NODE_ID: 'controller-node' }),
      {
        ...inertServerServices,
        sessions: {
          touchViewer: async () => ({ id: 'session-1', preferredRegion: 'eu-west' }),
          createEdgePlaybackGrant: async (token: string, edgeNodeId: string) => {
            calls.push({ token, edgeNodeId });
            return 'signed-edge-token';
          },
          manifest: async (token: string, base?: string) => {
            manifestToken = token;
            manifestBase = base;
            return `#EXTM3U\n${base}/0.ts\n`;
          },
          recordEgress: () => undefined
        },
        cluster: {
          selectEdge: async (_sessionId: string, preferredRegion?: string) => {
            expect(preferredRegion).toBe('eu-west');
            return { nodeId: 'edge-1', publicUrl: 'https://edge.example' };
          }
        }
      } as unknown as ServerServices,
      'controller'
    );

    const response = await app.inject({ method: 'GET', url: '/play/controller-token/index.m3u8' });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{ token: 'controller-token', edgeNodeId: 'edge-1' }]);
    expect(manifestToken).toBe('controller-token');
    expect(manifestBase).toBe('https://edge.example/play/signed-edge-token/segment');
    expect(response.body).toContain('signed-edge-token');
    expect(response.body).not.toContain('controller-token/segment');
    await app.close();
  });

  it('accepts forwarding headers only from configured proxy CIDRs', async () => {
    const identities: string[] = [];
    const app = await createServer(
      loadConfig({ VRRELAY_TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }),
      {
        ...inertServerServices,
        sessions: {
          touchViewer: async (_token: string, identity: string) => {
            identities.push(identity);
            return { id: `session-${identities.length}`, preferredRegion: undefined };
          },
          manifest: async () => '#EXTM3U',
          recordEgress: () => undefined
        },
        cluster: { selectEdge: async () => undefined }
      } as unknown as ServerServices,
      'standalone'
    );
    const trusted = await app.inject({
      method: 'GET',
      url: '/play/grant-1/index.m3u8',
      remoteAddress: '10.20.30.40',
      headers: { 'x-forwarded-for': '198.51.100.7', 'user-agent': 'fixture' }
    });
    const untrusted = await app.inject({
      method: 'GET',
      url: '/play/grant-2/index.m3u8',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '127.0.0.1', 'user-agent': 'fixture' }
    });
    expect([trusted.statusCode, untrusted.statusCode]).toEqual([200, 200]);
    expect(identities).toEqual(['198.51.100.7|fixture', '203.0.113.9|fixture']);
    await app.close();
  });
});

describe('first-run setup authorization', () => {
  it('allows setup on a loopback public URL without a token', () => {
    expect(() =>
      assertSetupAuthorized(loadConfig({ VRRELAY_PUBLIC_URL: 'http://127.0.0.1:8099' }), undefined)
    ).not.toThrow();
  });

  it('requires a configured token for remotely reachable setup', () => {
    expect(() =>
      assertSetupAuthorized(
        loadConfig({ VRRELAY_PUBLIC_URL: 'https://relay.example.com' }),
        undefined
      )
    ).toThrow(/VRRELAY_SETUP_TOKEN/);
  });

  it('uses the configured token for remotely reachable setup', () => {
    const token = 'a-secure-bootstrap-token-with-32-characters';
    const config = loadConfig({
      VRRELAY_PUBLIC_URL: 'https://relay.example.com',
      VRRELAY_SETUP_TOKEN: token
    });
    expect(() => assertSetupAuthorized(config, token)).not.toThrow();
    expect(() => assertSetupAuthorized(config, `${token}x`)).toThrow(/invalid/);
  });
});

describe('production node enrollment transport', () => {
  it('allows development overlay HTTP but requires an HTTPS public node URL in production', () => {
    expect(() =>
      assertProductionNodePublicUrl({ environment: 'development' }, 'http://worker.internal:8099')
    ).not.toThrow();
    expect(() =>
      assertProductionNodePublicUrl({ environment: 'production' }, 'http://worker.internal:8099')
    ).toThrow(/must use HTTPS/);
    expect(() =>
      assertProductionNodePublicUrl({ environment: 'production' }, 'https://worker.example.test')
    ).not.toThrow();
  });

  it('forwards the CSR and enforces the production URL policy at the HTTP boundary', async () => {
    const now = new Date().toISOString();
    const node: ClusterNode = {
      id: 'csr-node',
      name: 'CSR node',
      roles: ['source-worker'],
      region: 'local',
      publicUrl: 'https://worker.example.test',
      state: 'online',
      capabilities: {
        encoders: [],
        hardwareDevices: [],
        maxWorkers: 1,
        activeWorkers: 0,
        queuedWorkers: 0,
        cacheBytes: 0,
        cacheLimitBytes: 0,
        egressMbps: 0,
        providerIds: []
      },
      weight: 100,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now
    };
    const certificate = {
      certificatePem: 'fixture-certificate',
      caCertificatePem: 'fixture-ca',
      expiresAt: now,
      serialNumber: '01',
      fingerprintSha256: 'fixture-fingerprint'
    };
    const events: AuditEvent[] = [];
    let enrollmentInput: unknown;
    const services = {
      ...inertServerServices,
      audit: new AuditService({
        appendAuditEvent: async (event) => void events.push(event),
        listAuditEvents: async () => events
      }),
      cluster: {
        enroll: async (input: unknown) => {
          enrollmentInput = input;
          return { node, certificate };
        }
      }
    } as unknown as ServerServices;
    const payload = {
      token: 't'.repeat(32),
      name: node.name,
      publicUrl: node.publicUrl,
      capabilities: node.capabilities,
      csrPem: '-----BEGIN CERTIFICATE REQUEST-----\nfixture\n-----END CERTIFICATE REQUEST-----'
    };

    const development = await createServer(loadConfig({}), services, 'controller');
    const accepted = await development.inject({
      method: 'POST',
      url: '/api/v1/nodes/enroll',
      payload
    });
    expect(accepted.statusCode).toBe(201);
    expect(enrollmentInput).toMatchObject({ csrPem: payload.csrPem, publicUrl: payload.publicUrl });
    await development.close();

    enrollmentInput = undefined;
    const production = await createServer(
      loadConfig({
        VRRELAY_ENVIRONMENT: 'production',
        VRRELAY_PUBLIC_URL: 'https://relay.example.test',
        VRRELAY_ADMIN_URL: 'https://admin.example.test',
        VRRELAY_PLAYBACK_URL: 'https://play.example.test',
        VRRELAY_TRUSTED_PROXY_CIDRS: '10.20.0.0/16',
        VRRELAY_MEDIAMTX_READ_TOKEN: 'm'.repeat(32),
        VRRELAY_NODE_ROLES: 'controller'
      }),
      services,
      'controller'
    );
    const rejected = await production.inject({
      method: 'POST',
      url: '/api/v1/nodes/enroll',
      payload: { ...payload, publicUrl: 'http://worker.internal:8099' }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: 'insecure_node_public_url' } });
    expect(enrollmentInput).toBeUndefined();
    await production.close();
  });
});

describe('node drain command delivery', () => {
  const node = {
    id: 'drain-node',
    state: 'draining'
  } as ClusterNode;

  it('uses the agent controller as the single durable mutation and delivery authority', async () => {
    let directDrainCalls = 0;
    const commands: Array<{ nodeId: string; draining: boolean }> = [];
    const result = await setNodeDrainWithDelivery(
      {
        cluster: {
          drain: async () => {
            directDrainCalls += 1;
            return node;
          },
          get: async () => node
        },
        agentController: {
          setDrain: async (nodeId, draining) => {
            commands.push({ nodeId, draining });
            return { persisted: true as const, acknowledged: true };
          }
        }
      },
      node.id,
      true
    );
    expect(result).toEqual({ node, commandAcknowledged: true });
    expect(commands).toEqual([{ nodeId: node.id, draining: true }]);
    expect(directDrainCalls).toBe(0);
  });

  it('falls back to the repository-backed cluster service without an agent controller', async () => {
    let directDrainCalls = 0;
    const result = await setNodeDrainWithDelivery(
      {
        cluster: {
          drain: async () => {
            directDrainCalls += 1;
            return node;
          },
          get: async () => undefined
        }
      },
      node.id,
      false
    );
    expect(result).toEqual({ node, commandAcknowledged: null });
    expect(directDrainCalls).toBe(1);
  });

  it('updates the standalone node directly instead of sending to a nonexistent local agent', async () => {
    let directDrainCalls = 0;
    let agentDrainCalls = 0;
    const resumed = { ...node, id: 'standalone', state: 'online' } as ClusterNode;
    const result = await setNodeDrainWithDelivery(
      {
        cluster: {
          drain: async () => {
            directDrainCalls += 1;
            return resumed;
          },
          get: async () => resumed
        },
        agentController: {
          setDrain: async () => {
            agentDrainCalls += 1;
            return { persisted: true, acknowledged: false };
          }
        }
      },
      'standalone',
      false,
      'standalone'
    );

    expect(result).toEqual({ node: resumed, commandAcknowledged: null });
    expect(directDrainCalls).toBe(1);
    expect(agentDrainCalls).toBe(0);
  });

  it('returns a durable result when command acknowledgement is deferred to reconnect', async () => {
    const result = await setNodeDrainWithDelivery(
      {
        cluster: {
          drain: async () => node,
          get: async () => node
        },
        agentController: {
          setDrain: async () => ({ persisted: true, acknowledged: false })
        }
      },
      node.id,
      true
    );

    expect(result).toEqual({ node, commandAcknowledged: false });
  });
});

describe('node certificate rotation delivery', () => {
  it('waits for transport activation before returning the persisted expiry', async () => {
    const calls: string[] = [];
    const result = await rotateNodeCertificateWithDelivery(
      {
        cluster: {
          get: async (nodeId) => {
            calls.push(`get:${nodeId}`);
            return {
              id: nodeId,
              certificateExpiresAt: '2030-01-01T00:00:00.000Z'
            } as ClusterNode;
          }
        },
        agentController: {
          connected: () => true,
          rotateCertificate: async (nodeId, timeoutMs) => {
            calls.push(`rotate:${nodeId}:${timeoutMs}`);
          }
        }
      },
      'rotation-node'
    );

    expect(calls).toEqual(['rotate:rotation-node:60000', 'get:rotation-node']);
    expect(result).toEqual({ certificateExpiresAt: '2030-01-01T00:00:00.000Z' });
  });

  it('fails closed before rotation when the node is disconnected', async () => {
    let rotated = false;
    await expect(
      rotateNodeCertificateWithDelivery(
        {
          cluster: { get: async () => undefined },
          agentController: {
            connected: () => false,
            rotateCertificate: async () => {
              rotated = true;
            }
          }
        },
        'offline-node'
      )
    ).rejects.toMatchObject({ code: 'node_unavailable', statusCode: 409 });
    expect(rotated).toBe(false);
  });

  it('audits HTTP rotation success and transport timeout with one correlated outcome each', async () => {
    const events: AuditEvent[] = [];
    let failRotation = false;
    const node = {
      id: 'rotation-audit-node',
      certificateExpiresAt: '2030-01-01T00:00:00.000Z'
    } as ClusterNode;
    const services = {
      ...inertServerServices,
      auth: {
        authenticate: async () => ({
          kind: 'personal_token' as const,
          id: 'rotation-auditor',
          scopes: ['admin'] as const
        }),
        requireCsrf: () => undefined
      },
      audit: new AuditService({
        appendAuditEvent: async (event) => void events.push(event),
        listAuditEvents: async () => events
      }),
      cluster: { get: async () => node },
      agentController: {
        connected: () => true,
        rotateCertificate: async () => {
          if (failRotation) throw new Error('Certificate rotation activation timed out');
        }
      }
    } as unknown as ServerServices;
    const app = await createServer(loadConfig({}), services, 'controller');

    const succeeded = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${node.id}/certificate/rotate`,
      payload: {}
    });
    expect(succeeded.statusCode).toBe(200);
    failRotation = true;
    const failed = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${node.id}/certificate/rotate`,
      payload: {}
    });
    expect(failed.statusCode).toBe(500);
    await app.close();

    expect(events.map(({ outcome }) => outcome)).toEqual([
      'attempt',
      'success',
      'attempt',
      'failure'
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'cluster',
          action: 'node.certificate.rotate',
          outcome: 'success',
          actor: { type: 'token', id: 'rotation-auditor' },
          target: { type: 'node', id: node.id },
          context: { expiresAt: node.certificateExpiresAt }
        }),
        expect.objectContaining({
          category: 'cluster',
          action: 'node.certificate.rotate',
          outcome: 'failure',
          actor: { type: 'token', id: 'rotation-auditor' },
          target: { type: 'node', id: node.id },
          context: { errorType: 'Error' }
        })
      ])
    );
    expect(events[0]?.operationId).toBe(events[1]?.operationId);
    expect(events[2]?.operationId).toBe(events[3]?.operationId);
  });
});

describe('node-targeted cache administration', () => {
  const cached = {
    key: 'session-1/profile-r1/0.ts',
    size: 42,
    contentType: 'video/mp2t',
    expiresAt: '2030-01-01T00:00:00.000Z',
    createdAt: '2026-07-15T00:00:00.000Z',
    lastAccessedAt: '2026-07-15T00:00:00.000Z'
  };

  it('routes inventory and eviction to a connected node when nodeId is supplied', async () => {
    const calls: string[] = [];
    const services = {
      sessions: {
        cacheInventory: async () => {
          calls.push('local-inventory');
          return [];
        },
        evictCache: async () => {
          calls.push('local-evict');
          return 0;
        }
      },
      agentController: {
        connected: (nodeId: string) => {
          calls.push(`connected:${nodeId}`);
          return true;
        },
        cacheInventory: async (nodeId: string) => {
          calls.push(`remote-inventory:${nodeId}`);
          return { items: [cached], totalBytes: cached.size };
        },
        evictCache: async (
          nodeId: string,
          filter: { sessionId?: string; profileId?: string; all?: boolean }
        ) => {
          calls.push(`remote-evict:${nodeId}:${JSON.stringify(filter)}`);
          return { removed: 1 };
        }
      }
    };

    await expect(cacheInventoryWithNodeTarget(services, 'edge-1')).resolves.toEqual({
      items: [cached],
      totalBytes: cached.size
    });
    await expect(
      evictCacheWithNodeTarget(services, { nodeId: 'edge-1', sessionId: 'session-1' })
    ).resolves.toEqual({ removed: 1 });
    expect(calls).toEqual([
      'connected:edge-1',
      'remote-inventory:edge-1',
      'connected:edge-1',
      'remote-evict:edge-1:{"sessionId":"session-1"}'
    ]);
  });

  it('fails closed instead of falling back locally for a disconnected node target', async () => {
    let localEvicted = false;
    const services = {
      sessions: {
        cacheInventory: async () => [],
        evictCache: async () => {
          localEvicted = true;
          return 1;
        }
      },
      agentController: {
        connected: () => false,
        cacheInventory: async () => ({ items: [], totalBytes: 0 }),
        evictCache: async () => ({ removed: 0 })
      }
    };

    await expect(cacheInventoryWithNodeTarget(services, 'offline-edge')).rejects.toMatchObject({
      code: 'node_unavailable',
      statusCode: 409
    });
    await expect(
      evictCacheWithNodeTarget(services, { nodeId: 'offline-edge', all: true })
    ).rejects.toMatchObject({
      code: 'node_unavailable',
      statusCode: 409
    });
    expect(localEvicted).toBe(false);
  });
});

describe('live edge origin sources', () => {
  it('builds an authenticated SRT reader URL', () => {
    expect(liveOriginSourceUrl('srt://origin.example:8890', 'live-channel_1', 'read-token')).toBe(
      'srt://origin.example:8890?streamid=read:live-channel_1:vrrelay-read:read-token'
    );
  });

  it('keeps SRT encryption material separate from the origin address', () => {
    expect(
      liveOriginSourceUrl(
        'srt://origin.example:8890',
        'live-channel_1',
        'read-token',
        'fixture passphrase'
      )
    ).toBe(
      'srt://origin.example:8890?passphrase=fixture%20passphrase&streamid=read:live-channel_1:vrrelay-read:read-token'
    );
  });

  it('builds an authenticated RTSP reader URL without losing a base path', () => {
    expect(
      liveOriginSourceUrl('rtsp://origin.example:8554/relay', 'live-channel_1', 'read-token')
    ).toBe('rtsp://vrrelay-read:read-token@origin.example:8554/relay/live-channel_1');
  });

  it('rejects unsafe path input', () => {
    expect(() => liveOriginSourceUrl('srt://origin:8890', '../admin', 'read-token')).toThrow(
      /Invalid live path/
    );
  });
});

describe('live HLS proxy targets', () => {
  it('forwards MediaMTX session and low-latency cursor parameters', () => {
    expect(
      liveHlsUpstreamUrl('http://mediamtx:8888', 'live-channel_1', 'main_stream.m3u8', {
        session: 'session-id',
        _HLS_msn: '4',
        token: 'must-not-forward'
      })
    ).toBe('http://mediamtx:8888/live-channel_1/main_stream.m3u8?session=session-id&_HLS_msn=4');
  });

  it('rejects traversal and unsafe live paths', () => {
    expect(() =>
      liveHlsUpstreamUrl('http://mediamtx:8888', 'live-channel_1', '../config', {})
    ).toThrow(/Invalid live HLS resource/);
    expect(() =>
      liveHlsUpstreamUrl('http://mediamtx:8888', '../channel', 'index.m3u8', {})
    ).toThrow(/Invalid live path/);
  });
});

describe('administrative operation auditing', () => {
  function durableAudit(events: AuditEvent[]) {
    return new AuditService({
      appendAuditEvent: async (event) => void events.push(event),
      listAuditEvents: async () => events
    });
  }

  it('persists a structured success event without retaining sensitive operation output', async () => {
    const events: AuditEvent[] = [];
    const audit = durableAudit(events);
    const sensitiveToken = 'vrr_sensitive_personal_token';
    const sensitivePassword = 'temporary-password';

    const result = await auditedOperation(
      audit,
      {
        category: 'token',
        action: 'personal-token.create',
        actor: { type: 'administrator', id: 'local-admin' },
        context: { secretRef: sensitiveToken },
        success: (created) => ({
          target: { type: 'personal-token', id: created.id },
          context: { scopeCount: 2 }
        })
      },
      async () => ({ id: 'token-1', token: sensitiveToken, password: sensitivePassword })
    );

    expect(result.token).toBe(sensitiveToken);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      category: 'token',
      action: 'personal-token.create',
      outcome: 'attempt',
      actor: { type: 'administrator', id: 'local-admin' },
      context: { secretRef: '[redacted]' }
    });
    expect(events[1]).toMatchObject({
      category: 'token',
      action: 'personal-token.create',
      outcome: 'success',
      actor: { type: 'administrator', id: 'local-admin' },
      target: { type: 'personal-token', id: 'token-1' },
      context: { secretRef: '[redacted]', scopeCount: 2 }
    });
    expect(events[0]?.operationId).toBe(events[1]?.operationId);
    expect(JSON.stringify(events)).not.toContain(sensitiveToken);
    expect(JSON.stringify(events)).not.toContain(sensitivePassword);
  });

  it('persists a sanitized failure event and rethrows the operation error', async () => {
    const events: AuditEvent[] = [];
    const audit = durableAudit(events);
    const operationError = new ApplicationError(
      'node_unavailable',
      'temporary-password must not enter the audit log',
      409
    );

    await expect(
      auditedOperation(
        audit,
        {
          category: 'cluster',
          action: 'node.drain',
          actor: { type: 'token', id: 'pat-1' },
          target: { type: 'node', id: 'node-1' }
        },
        async () => {
          throw operationError;
        }
      )
    ).rejects.toBe(operationError);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      category: 'cluster',
      action: 'node.drain',
      outcome: 'attempt',
      actor: { type: 'token', id: 'pat-1' },
      target: { type: 'node', id: 'node-1' }
    });
    expect(events[1]).toMatchObject({
      category: 'cluster',
      action: 'node.drain',
      outcome: 'failure',
      actor: { type: 'token', id: 'pat-1' },
      target: { type: 'node', id: 'node-1' },
      context: { errorType: 'node_unavailable' }
    });
    expect(events[0]?.operationId).toBe(events[1]?.operationId);
    expect(JSON.stringify(events)).not.toContain('temporary-password');
  });

  it('preserves the original failure when failure-audit persistence also fails', async () => {
    const original = new Error('original operation error');
    let writes = 0;
    const audit = new AuditService({
      appendAuditEvent: async () => {
        writes += 1;
        if (writes === 2) throw new Error('audit storage unavailable');
      },
      listAuditEvents: async () => []
    });

    await expect(
      auditedOperation(
        audit,
        {
          category: 'backend',
          action: 'backend.activate',
          actor: auditActor({ kind: 'personal_token', id: 'pat-2', scopes: ['admin'] })
        },
        async () => {
          throw original;
        }
      )
    ).rejects.toBe(original);
  });
});

describe('provider binding deletion API lifecycle', () => {
  it('parses explicit orphan acknowledgement without coercing false to true', () => {
    expect(DeleteProviderBindingQuerySchema.parse({})).toEqual({
      acknowledgeOrphanedCredential: false
    });
    expect(
      DeleteProviderBindingQuerySchema.parse({ acknowledgeOrphanedCredential: 'false' })
    ).toEqual({ acknowledgeOrphanedCredential: false });
    expect(
      DeleteProviderBindingQuerySchema.parse({ acknowledgeOrphanedCredential: 'true' })
    ).toEqual({ acknowledgeOrphanedCredential: true });
  });

  it('retains a visible pending binding after worker cleanup failure and resumes safely', async () => {
    const { repository, cluster, binding } = await bindingCleanupFixture();
    let calls = 0;
    const agentController = {
      connected: () => true,
      call: async () => {
        calls += 1;
        if (calls === 1) throw new Error('simulated worker cleanup failure');
        return {};
      }
    };

    await expect(
      deleteProviderBindingWithCredentialCleanup({ cluster, agentController }, binding.id, false)
    ).rejects.toThrow('simulated worker cleanup failure');
    await expect(repository.getProviderBinding(binding.id)).resolves.toBeUndefined();
    await expect(
      repository.getProviderBinding(binding.id, { includeDeletionPending: true })
    ).resolves.toMatchObject({ deletionPending: true, state: 'revoked', reachable: false });

    await expect(
      deleteProviderBindingWithCredentialCleanup({ cluster, agentController }, binding.id, false)
    ).resolves.toEqual({
      cleanupMode: 'worker-confirmed',
      nodeId: binding.nodeId,
      orphanAcknowledged: false
    });
    await expect(
      deleteProviderBindingWithCredentialCleanup({ cluster, agentController }, binding.id, false)
    ).resolves.toEqual({ cleanupMode: 'already-finalized', orphanAcknowledged: false });
    expect(calls).toBe(2);
    repository.close();
  });

  it('requires reconnect or revocation and audits explicit orphan acknowledgement', async () => {
    const { repository, cluster, node, binding } = await bindingCleanupFixture();
    const disconnected = { connected: () => false, call: async () => ({}) };
    await expect(
      deleteProviderBindingWithCredentialCleanup(
        { cluster, agentController: disconnected },
        binding.id,
        true
      )
    ).rejects.toThrow('Reconnect the source worker');
    await cluster.revoke(node.id);
    await expect(
      deleteProviderBindingWithCredentialCleanup(
        { cluster, agentController: disconnected },
        binding.id,
        false
      )
    ).rejects.toThrow('acknowledgeOrphanedCredential=true');

    const events: AuditEvent[] = [];
    const audit = new AuditService({
      appendAuditEvent: async (event) => void events.push(event),
      listAuditEvents: async () => events
    });
    const outcome = await auditedOperation(
      audit,
      {
        category: 'provider',
        action: 'provider-binding.delete',
        actor: { type: 'administrator' },
        target: { type: 'provider-binding', id: binding.id },
        context: { orphanAcknowledgementRequested: true },
        success: (result) => ({ context: providerBindingDeletionAuditContext(result) })
      },
      () =>
        deleteProviderBindingWithCredentialCleanup(
          { cluster, agentController: disconnected },
          binding.id,
          true
        )
    );
    expect(outcome).toEqual({
      cleanupMode: 'administrator-acknowledged-orphan',
      nodeId: binding.nodeId,
      orphanAcknowledged: true
    });
    expect(events.at(-1)).toMatchObject({
      outcome: 'success',
      context: {
        orphanAcknowledgementRequested: true,
        cleanupMode: 'administrator-acknowledged-orphan',
        orphanAcknowledged: true,
        nodeId: binding.nodeId
      }
    });
    repository.close();
  });

  it('permits acknowledged finalization when the node record is already absent', async () => {
    const now = new Date().toISOString();
    const value: ProviderBinding = {
      id: 'orphan-binding',
      providerId: 'orphan-provider',
      nodeId: 'missing-node',
      secretRef: 'provider-binding:orphan',
      reachable: false,
      state: 'revoked',
      deletionPending: true,
      lastError: 'cleanup pending',
      validatedAt: null,
      createdAt: now,
      updatedAt: now
    };
    let finalized = false;
    const outcome = await deleteProviderBindingWithCredentialCleanup(
      {
        cluster: {
          beginBindingDeletion: async () => ({ value, revision: 2 }),
          finalizeBindingDeletion: async () => void (finalized = true),
          list: async () => []
        }
      },
      value.id,
      true
    );
    expect(finalized).toBe(true);
    expect(outcome.cleanupMode).toBe('administrator-acknowledged-orphan');
  });
});
