import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BuiltinTrafficDirector,
  SwitchableMetricsExporter,
  SwitchableTrafficDirector,
  type SecretStore
} from '@vrrelay/application';
import {
  LocalObjectStore,
  MemoryCoordinationStore,
  PrometheusMetricsSink,
  SqliteRepository
} from '@vrrelay/adapters';
import type { ClusterNode } from '@vrrelay/domain';
import {
  BackendService,
  OBJECT_STORE_APPLIED_SETTING,
  OBJECT_STORE_SETTING,
  createConfiguredObjectStore,
  resolveConfiguredObjectStore
} from './backend-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllGlobals();
});

describe('backend service', () => {
  it('validates, activates, and reloads an authenticated routing webhook', async () => {
    const authorization: string[] = [];
    const webhook = createServer((request, response) => {
      authorization.push(request.headers.authorization ?? '');
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const message = JSON.parse(body) as { type: string; candidates?: Array<{ id: string }> };
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify(
            message.type === 'health'
              ? { healthy: true, message: 'ready' }
              : { nodeId: message.candidates?.[0]?.id }
          )
        );
      });
    });
    await new Promise<void>((resolve) => webhook.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => webhook.close(() => resolve())));
    const address = webhook.address();
    if (!address || typeof address === 'string') throw new Error('Webhook did not bind TCP');

    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-backends-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const repository = new SqliteRepository(join(dir, 'state.sqlite3'));
    await repository.migrate();
    cleanups.push(async () => repository.close());
    const values = new Map([['routing-token', 'test-routing-secret']]);
    const secrets: SecretStore = {
      put: async (ref, value) => void values.set(ref, value),
      get: async (ref) => {
        const value = values.get(ref);
        if (!value) throw new Error('Secret not found');
        return value;
      },
      delete: async (ref) => void values.delete(ref)
    };
    const objectStore = new LocalObjectStore(join(dir, 'objects'));
    const coordination = new MemoryCoordinationStore();
    const routing = new SwitchableTrafficDirector(new BuiltinTrafficDirector());
    const metrics = new PrometheusMetricsSink();
    const service = new BackendService(
      repository,
      secrets,
      objectStore,
      coordination,
      routing,
      new SwitchableMetricsExporter(),
      {
        repositoryKind: 'sqlite',
        secretKind: 'encrypted-file',
        metrics
      }
    );
    const configuration = {
      category: 'routing' as const,
      kind: 'webhook' as const,
      endpoint: `http://127.0.0.1:${address.port}`,
      secretRef: 'routing-token'
    };

    await expect(service.validate(configuration)).resolves.toMatchObject({ healthy: true });
    await expect(service.activate(configuration)).resolves.toMatchObject({ healthy: true });
    expect(await repository.getSetting('backend.routing')).not.toContain('test-routing-secret');
    expect((await service.list()).items.map((status) => status.category)).toEqual([
      'object-store',
      'coordination',
      'repository',
      'routing',
      'secrets',
      'metrics'
    ]);

    const edge = {
      id: 'edge-a',
      name: 'Edge A',
      roles: ['edge'],
      region: 'local',
      publicUrl: 'https://edge.example',
      state: 'online',
      weight: 100,
      capabilities: {
        encoders: [],
        hardwareDevices: [],
        maxWorkers: 2,
        activeWorkers: 0,
        queuedWorkers: 0,
        cacheBytes: 0,
        cacheLimitBytes: 1024,
        egressMbps: 0,
        providerIds: []
      },
      lastHeartbeatAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } satisfies ClusterNode;
    await expect(routing.selectEdge('session-a', [edge])).resolves.toMatchObject({ id: 'edge-a' });

    const reloaded = new SwitchableTrafficDirector(new BuiltinTrafficDirector());
    const reloadedService = new BackendService(
      repository,
      secrets,
      objectStore,
      coordination,
      reloaded,
      new SwitchableMetricsExporter(),
      { repositoryKind: 'sqlite', secretKind: 'encrypted-file', metrics }
    );
    await reloadedService.load();
    await expect(reloaded.selectEdge('session-a', [edge])).resolves.toMatchObject({ id: 'edge-a' });
    expect(authorization).toEqual([
      'Bearer test-routing-secret',
      'Bearer test-routing-secret',
      'Bearer test-routing-secret',
      'Bearer test-routing-secret',
      'Bearer test-routing-secret'
    ]);
    await service.close();
    await reloadedService.close();
  });

  it('activates, reloads, and stops an authenticated metrics webhook', async () => {
    const requests: Array<{ type: string | undefined; authorization: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { type?: string };
        requests.push({
          type: body.type,
          authorization: new Headers(init?.headers).get('authorization')
        });
        return body.type === 'health'
          ? Response.json({ healthy: true, message: 'ready' })
          : new Response(null, { status: 204 });
      })
    );
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-backends-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const repository = new SqliteRepository(join(dir, 'state.sqlite3'));
    await repository.migrate();
    cleanups.push(async () => repository.close());
    const values = new Map([['metrics-token', 'test-metrics-secret']]);
    const secrets: SecretStore = {
      put: async (ref, value) => void values.set(ref, value),
      get: async (ref) => {
        const value = values.get(ref);
        if (!value) throw new Error('Secret not found');
        return value;
      },
      delete: async (ref) => void values.delete(ref)
    };
    const objectStore = new LocalObjectStore(join(dir, 'objects'));
    const coordination = new MemoryCoordinationStore();
    const metrics = new PrometheusMetricsSink();
    const metricsExporter = new SwitchableMetricsExporter();
    const service = new BackendService(
      repository,
      secrets,
      objectStore,
      coordination,
      new SwitchableTrafficDirector(new BuiltinTrafficDirector()),
      metricsExporter,
      {
        repositoryKind: 'sqlite',
        secretKind: 'encrypted-file',
        metrics
      }
    );
    cleanups.push(() => service.close());
    const configuration = {
      category: 'metrics' as const,
      kind: 'webhook' as const,
      endpoint: 'https://127.0.0.1:9443/metrics',
      secretRef: 'metrics-token',
      intervalSeconds: 5
    };

    await expect(service.validate(configuration)).resolves.toMatchObject({ healthy: true });
    await expect(service.activate(configuration)).resolves.toMatchObject({ healthy: true });
    expect(metricsExporter.kind).toBe('webhook');
    expect(await repository.getSetting('backend.metrics')).not.toContain('test-metrics-secret');
    await expect(service.list()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ category: 'metrics', kind: 'webhook', healthy: true })
      ])
    });
    await service.close();
    expect(metricsExporter.kind).toBe('prometheus');

    const reloadedExporter = new SwitchableMetricsExporter();
    const reloadedService = new BackendService(
      repository,
      secrets,
      objectStore,
      coordination,
      new SwitchableTrafficDirector(new BuiltinTrafficDirector()),
      reloadedExporter,
      {
        repositoryKind: 'sqlite',
        secretKind: 'encrypted-file',
        metrics
      }
    );
    cleanups.push(() => reloadedService.close());
    await reloadedService.load();
    expect(reloadedExporter.kind).toBe('webhook');
    await reloadedService.close();

    expect(requests.filter(({ type }) => type === 'metrics')).toHaveLength(2);
    expect(
      requests.every(({ authorization }) => authorization === 'Bearer test-metrics-secret')
    ).toBe(true);
  });

  it('marks non-hot-swappable activation as restart-required', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-backends-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const repository = new SqliteRepository(join(dir, 'state.sqlite3'));
    await repository.migrate();
    cleanups.push(async () => repository.close());
    const secrets: SecretStore = {
      put: async () => undefined,
      get: async () => '',
      delete: async () => undefined
    };
    const service = new BackendService(
      repository,
      secrets,
      new LocalObjectStore(join(dir, 'objects')),
      new MemoryCoordinationStore(),
      new SwitchableTrafficDirector(new BuiltinTrafficDirector()),
      new SwitchableMetricsExporter(),
      {
        repositoryKind: 'sqlite',
        secretKind: 'encrypted-file',
        metrics: new PrometheusMetricsSink()
      }
    );
    await expect(
      service.activate({ category: 'repository', kind: 'postgres' })
    ).resolves.toMatchObject({ healthy: false, restartRequired: true });
  });

  it('stages a validated object store and clears restart-required after startup applies it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vrrelay-backends-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const repository = new SqliteRepository(join(dir, 'state.sqlite3'));
    await repository.migrate();
    cleanups.push(async () => repository.close());
    const values = new Map<string, string>();
    const secrets: SecretStore = {
      put: async (ref, value) => void values.set(ref, value),
      get: async (ref) => {
        const value = values.get(ref);
        if (!value) throw new Error('Secret not found');
        return value;
      },
      delete: async (ref) => void values.delete(ref)
    };
    const local = new LocalObjectStore(join(dir, 'objects'));
    const service = new BackendService(
      repository,
      secrets,
      local,
      new MemoryCoordinationStore(),
      new SwitchableTrafficDirector(new BuiltinTrafficDirector()),
      new SwitchableMetricsExporter(),
      {
        repositoryKind: 'sqlite',
        secretKind: 'encrypted-file',
        localObjectStore: local,
        metrics: new PrometheusMetricsSink()
      }
    );

    await expect(
      service.activate({ category: 'object-store', kind: 'local' })
    ).resolves.toMatchObject({ healthy: true, restartRequired: true });
    expect(await repository.getSetting(OBJECT_STORE_SETTING)).toBe(
      JSON.stringify({ category: 'object-store', kind: 'local' })
    );
    await expect(service.list()).resolves.toMatchObject({ restartRequired: true });

    const resolved = await resolveConfiguredObjectStore(repository, secrets, local, local);
    expect(resolved).toBe(local);
    expect(await repository.getSetting(OBJECT_STORE_APPLIED_SETTING)).toBe(
      await repository.getSetting(OBJECT_STORE_SETTING)
    );
    await expect(service.list()).resolves.toMatchObject({ restartRequired: false });
  });

  it('rejects incomplete or malformed cloud object-store credentials before use', async () => {
    const local = new LocalObjectStore('/tmp/vrrelay-unused-object-store');
    const secrets: SecretStore = {
      put: async () => undefined,
      get: async () => '{"accessKeyId":"only-one-field"}',
      delete: async () => undefined
    };
    await expect(
      createConfiguredObjectStore({ category: 'object-store', kind: 's3' }, secrets, local)
    ).rejects.toThrow('S3 bucket is required');
    await expect(
      createConfiguredObjectStore(
        {
          category: 'object-store',
          kind: 's3',
          bucket: 'media',
          secretRef: 'bad-s3-secret'
        },
        secrets,
        local
      )
    ).rejects.toThrow('documented JSON credential fields');
  });
});
