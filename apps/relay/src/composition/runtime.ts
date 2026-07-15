// SPDX-License-Identifier: GPL-3.0-or-later
import {
  DefaultProviderRegistry,
  FFmpegLiveNormalizer,
  FFmpegTranscoder,
  FileCertificateAuthority,
  JellyfinProvider,
  PrometheusMetricsSink,
  validateProviderUrl
} from '@vrrelay/adapters';
import {
  BuiltinTrafficDirector,
  AuditService,
  ClusterService,
  InMemoryEventBus,
  LiveService,
  ProfileService,
  ProviderService,
  SessionService,
  SwitchableMetricsExporter,
  SwitchableTrafficDirector,
  type MediaCapabilities,
  type ProviderRegistry,
  type Transcoder
} from '@vrrelay/application';
import type { NodeCapability } from '@vrrelay/domain';
import type { CatalogQuery, CreateProviderRequest } from '@vrrelay/contracts';
import { AgentController, NodeAgent, type NodeAgentOptions } from '../agent-transport.js';
import { AuthService } from '../auth.js';
import { BackendService, resolveConfiguredObjectStore } from '../backend-service.js';
import type { RelayConfig } from '../config.js';
import { parseListenAddress } from '../config.js';
import { ManagedMediaMtx } from '../media-runtime.js';
import { createServer } from '../server.js';
import {
  createBootstrapObjectStores,
  createCoordinationStore,
  createSecretStore,
  resolveSecretBackend
} from './infrastructure.js';
import { createRepository } from './repository.js';
import { ROLE_PLANS, type RolePlan } from './role-plan.js';
import { createRoleServer } from './role-server.js';
import { repositorySchemaStartupMethod } from './schema-startup.js';
import { createShutdownSequence } from './shutdown.js';

export const RUNTIME_SHUTDOWN_ORDER = [
  'background-timers',
  'live-service',
  'managed-mediamtx',
  'node-agent',
  'agent-controller',
  'backend-service',
  'http-server',
  'repository'
] as const;

const EDGE_CAPABILITIES: MediaCapabilities = {
  ffmpegVersion: 'not-loaded',
  encoders: [],
  muxers: [],
  filters: [],
  pixelFormats: []
};

const EDGE_PROVIDERS: ProviderRegistry = {
  register: () => {
    throw new Error('Provider registration is unavailable on an edge');
  },
  get: () => {
    throw new Error('Provider access is unavailable on an edge');
  }
};

const EDGE_TRANSCODER: Transcoder = {
  discover: async () => EDGE_CAPABILITIES,
  generateSegment: async () => {
    throw new Error('Transcoding is unavailable on an edge');
  },
  streamFragmentedMp4: async () => {
    throw new Error('Fragmented MP4 transcoding is unavailable on an edge');
  }
};

function liveService(
  config: RelayConfig,
  repository: ReturnType<typeof createRepository>,
  events: InMemoryEventBus,
  normalizer: FFmpegLiveNormalizer | undefined,
  metrics: PrometheusMetricsSink
): LiveService {
  return new LiveService(
    repository,
    {
      publicUrl: config.publicUrl,
      rtmpUrl: config.mediaMtxRtmpUrl,
      srtUrl: config.mediaMtxSrtUrl,
      whipUrl: config.mediaMtxWhipUrl,
      hlsUrl: config.mediaMtxHlsUrl,
      internalRtspUrl: config.mediaMtxRtspUrl,
      allowUnauthenticatedInternalRead: config.mediaMtxAllowInternalRead,
      ...(config.backupRtmpUrl ? { backupRtmpUrl: config.backupRtmpUrl } : {}),
      ...(config.backupSrtUrl ? { backupSrtUrl: config.backupSrtUrl } : {})
    },
    normalizer,
    events,
    repository,
    metrics
  );
}

function nodeCapabilities(
  config: RelayConfig,
  capabilities: MediaCapabilities,
  sessions?: SessionService,
  providerIds: () => Promise<string[]> = async () => []
): () => Promise<NodeCapability> {
  return async () => ({
    encoders: capabilities.encoders
      .filter((encoder) => encoder.available)
      .map((encoder) => encoder.name),
    hardwareDevices: capabilities.encoders
      .filter((encoder) => encoder.available && encoder.hardware)
      .map((encoder) => encoder.name),
    maxWorkers: sessions ? config.maxWorkers : 0,
    activeWorkers: sessions?.capacity().active ?? 0,
    queuedWorkers: sessions?.capacity().queued ?? 0,
    cacheBytes: sessions ? await sessions.cacheUsageBytes() : 0,
    cacheLimitBytes: sessions ? config.cacheLimitBytes : 0,
    egressMbps: sessions?.egressMbps() ?? 0,
    providerIds: await providerIds()
  });
}

function providerAgentHandler(providers: ProviderService): NodeAgentOptions['onProvider'] {
  return async (operation, payload) => {
    if (operation === 'provider.bind') {
      const input = payload.input as CreateProviderRequest;
      const policy = await validateProviderUrl(input.baseUrl, input.allowPublicHttp);
      const creationMode = payload.creationMode;
      const expectedProviderRevision = payload.expectedProviderRevision;
      if (
        (creationMode !== 'new' && creationMode !== 'existing') ||
        (creationMode === 'new' && expectedProviderRevision !== null) ||
        (creationMode === 'existing' &&
          (!Number.isInteger(expectedProviderRevision) || Number(expectedProviderRevision) < 1))
      )
        throw new Error('Provider binding creation intent is invalid');
      return await providers.createBinding(
        {
          ...input,
          normalizedBaseUrl: policy.normalizedUrl,
          ...(policy.securityNotice ? { securityNotice: policy.securityNotice } : {})
        },
        String(payload.nodeId),
        String(payload.providerId),
        String(payload.bindingId),
        creationMode === 'new'
          ? { mode: 'new', expectedProviderRevision: null }
          : { mode: 'existing', expectedProviderRevision: Number(expectedProviderRevision) }
      );
    }
    if (operation === 'provider.unbind') {
      await providers.removeBinding(String(payload.bindingId));
      return {};
    }
    if (operation === 'provider.browse')
      return await providers.browse(String(payload.providerId), payload.query as CatalogQuery);
    if (operation === 'provider.item')
      return await providers.item(String(payload.providerId), String(payload.itemId));
    if (operation === 'provider.activity') {
      await providers.reportActivity(String(payload.providerId), {
        sessionId: String(payload.sessionId),
        itemId: String(payload.itemId),
        positionTicks: Number(payload.positionTicks),
        paused: Boolean(payload.paused),
        event: payload.event as 'start' | 'progress' | 'stop'
      });
      return {};
    }
    await providers.validate(String(payload.providerId));
    return {};
  };
}

function cacheAgentHandler(sessions: SessionService): NodeAgentOptions['onCache'] {
  return async (operation, payload) => {
    if (operation === 'cache.inventory') {
      const items = await sessions.cacheInventory();
      return { items, totalBytes: items.reduce((sum, item) => sum + item.size, 0) };
    }
    return {
      removed: await sessions.evictCache({
        ...(payload.all !== undefined ? { all: Boolean(payload.all) } : {}),
        ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
        ...(typeof payload.profileId === 'string' ? { profileId: payload.profileId } : {})
      })
    };
  };
}

export function nodeRoutingPublicUrl(config: Pick<RelayConfig, 'playbackUrl'>): string {
  return config.playbackUrl;
}

export function configuredNodeAgentOptions(
  config: RelayConfig,
  secrets: NodeAgentOptions['secretStore'],
  capabilities: () => Promise<NodeCapability>,
  handlers: Pick<NodeAgentOptions, 'onSegment' | 'onCancel' | 'onProvider' | 'onCache'>,
  internalUrl?: string
): NodeAgentOptions | undefined {
  if (!config.controllerAgentUrl || !config.controllerEnrollmentUrl) return undefined;
  return {
    controllerUrl: config.controllerAgentUrl,
    enrollmentUrl: config.controllerEnrollmentUrl,
    ...(config.nodeJoinToken ? { joinToken: config.nodeJoinToken } : {}),
    nodeName: config.nodeName,
    publicUrl: nodeRoutingPublicUrl(config),
    ...(internalUrl ? { internalUrl } : {}),
    secretStore: secrets,
    capabilities,
    ...handlers
  };
}

function configuredNodeAgent(
  config: RelayConfig,
  secrets: NodeAgentOptions['secretStore'],
  capabilities: () => Promise<NodeCapability>,
  handlers: Pick<NodeAgentOptions, 'onSegment' | 'onCancel' | 'onProvider' | 'onCache'>,
  internalUrl?: string
): NodeAgent | undefined {
  const options = configuredNodeAgentOptions(config, secrets, capabilities, handlers, internalUrl);
  return options ? new NodeAgent(options) : undefined;
}

function bindShutdown(shutdown: () => Promise<void>): void {
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

async function startControlPlaneRuntime(config: RelayConfig, plan: RolePlan): Promise<void> {
  if (!plan.hostsController)
    throw new Error('The control-plane runtime requires a controller or standalone role plan');
  const listen = parseListenAddress(config.listenAddr);
  const repository = createRepository(config);
  const schemaStartupMethod = repositorySchemaStartupMethod(plan);
  if (schemaStartupMethod === 'migrate') await repository.migrate();
  else await repository.assertSchemaCurrent();

  const secretBackend = resolveSecretBackend(config);
  const secrets = createSecretStore(config, secretBackend);
  const registry = new DefaultProviderRegistry();
  registry.register(new JellyfinProvider(config.applicationVersion));
  const transcoder = new FFmpegTranscoder({ ffmpegPath: config.ffmpegPath });
  const capabilities = await transcoder.discover();
  const events = new InMemoryEventBus();
  const coordination = createCoordinationStore(config);
  const bootstrapObjectStores = createBootstrapObjectStores(config);
  const objectStore = await resolveConfiguredObjectStore(
    repository,
    secrets,
    bootstrapObjectStores.local,
    bootstrapObjectStores.configured,
    config.nodeId
  );
  const metrics = new PrometheusMetricsSink({ node: config.nodeId, region: config.nodeRegion });
  const metricsExporter = new SwitchableMetricsExporter();
  const routing = new SwitchableTrafficDirector(new BuiltinTrafficDirector());
  const backends = new BackendService(
    repository,
    secrets,
    objectStore,
    coordination,
    routing,
    metricsExporter,
    {
      repositoryKind: config.repositoryDriver,
      secretKind: secretBackend,
      localObjectStore: bootstrapObjectStores.local,
      metrics,
      nodeId: config.nodeId
    }
  );
  await backends.load();
  const certificateAuthority = new FileCertificateAuthority(secrets);
  const cluster = new ClusterService(
    repository,
    coordination,
    routing,
    events,
    certificateAuthority,
    {
      agentLogRetentionRows: config.agentLogRetentionRows,
      agentLogQueryLimit: config.agentLogQueryLimit,
      metrics
    }
  );
  const agentController = plan.hostsController
    ? new AgentController(cluster, certificateAuthority, coordination)
    : undefined;
  const providers = new ProviderService(repository, secrets, registry, {
    nodeId: config.nodeId,
    ...(agentController ? { remote: agentController } : {})
  });
  const profiles = new ProfileService(repository);
  await profiles.seed(capabilities);

  const sessions = new SessionService(
    repository,
    secrets,
    registry,
    transcoder,
    events,
    {
      publicUrl: config.playbackUrl,
      internalUrl: `http://127.0.0.1:${listen.port}`,
      cacheDir: config.cacheDir,
      cacheTtlMs: config.cacheTtlMs,
      cacheLimitBytes: config.cacheLimitBytes,
      maxWorkers: config.maxWorkers,
      nodeId: config.nodeId,
      roles: config.nodeRoles,
      jobLogRetentionRows: config.jobLogRetentionRows,
      jobLogQueryLimit: config.jobLogQueryLimit
    },
    {
      objectStore,
      coordination,
      clusterRepository: repository,
      metrics,
      ...(agentController ? { dispatcher: agentController, providerGateway: agentController } : {})
    }
  );
  agentController?.setEnsureHandler((token, index, signal) =>
    sessions.segment(token, index, signal).then(() => undefined)
  );

  const liveNormalizer = plan.managesLiveIngest
    ? new FFmpegLiveNormalizer({
        ffmpegPath: config.ffmpegPath
      })
    : undefined;
  const live = liveService(config, repository, events, liveNormalizer, metrics);
  await live.scrubPersistedPublisherCredentials();
  await sessions.recover();

  const auth = new AuthService(repository);
  const audit = new AuditService(repository);
  const app = await createServer(
    config,
    {
      repository,
      auth,
      audit,
      providers,
      profiles,
      sessions,
      live,
      events,
      capabilities,
      cluster,
      objectStore,
      coordination,
      metrics,
      backends,
      ...(agentController ? { agentController } : {})
    },
    plan.kind === 'controller' ? 'controller' : 'standalone'
  );
  const currentNodeCapabilities = nodeCapabilities(config, capabilities, sessions, async () =>
    (
      await Promise.all(
        (await repository.listProviderBindings()).map(async (binding) => {
          if (binding.deletionPending) return undefined;
          try {
            await secrets.get(binding.secretRef);
            return binding.providerId;
          } catch {
            return undefined;
          }
        })
      )
    ).filter((providerId): providerId is string => Boolean(providerId))
  );
  if (plan.hostsController) {
    await cluster.registerLocal({
      id: config.nodeId,
      name: config.nodeName,
      roles: config.nodeRoles,
      region: config.nodeRegion,
      publicUrl: nodeRoutingPublicUrl(config),
      state: 'online',
      capabilities: await currentNodeCapabilities(),
      weight: 100
    });
  }

  await app.listen(listen);
  // Assigned after the managed runtime exists; its exit callback closes over this hook.
  // eslint-disable-next-line prefer-const
  let shutdown: (() => Promise<void>) | undefined;
  let runtimeFailure: Error | undefined;
  const managedMediaMtx =
    plan.managesLiveIngest && config.mediaMtxExecutable && config.mediaMtxConfig
      ? new ManagedMediaMtx({
          executable: config.mediaMtxExecutable,
          configPath: config.mediaMtxConfig,
          relayPort: listen.port,
          onUnexpectedExit: (error) => {
            runtimeFailure = error;
            process.exitCode = 1;
            app.log.error({ err: error }, 'managed MediaMTX stopped');
            if (shutdown) void shutdown();
          }
        })
      : undefined;
  await managedMediaMtx?.start();
  if (managedMediaMtx)
    app.log.info({ executable: config.mediaMtxExecutable }, 'managed MediaMTX started');
  if (agentController) {
    const agentListen = parseListenAddress(config.agentListenAddr);
    await agentController.start(agentListen.host, agentListen.port, config.agentTlsNames);
    app.log.info({ address: config.agentListenAddr }, 'mTLS node agent listener ready');
  }

  const cleanup = setInterval(() => {
    auth.cleanup();
    void sessions
      .cleanupExpiredCache()
      .catch((error) => app.log.error({ err: error }, 'cache cleanup failed'));
  }, 60_000);
  cleanup.unref();
  const heartbeat = plan.hostsController
    ? setInterval(() => {
        void currentNodeCapabilities()
          .then((value) => cluster.heartbeat(config.nodeId, value, 'online'))
          .catch((error) => app.log.error({ err: error }, 'node heartbeat failed'));
      }, 15_000)
    : undefined;
  heartbeat?.unref();
  const livePoll = plan.managesLiveIngest
    ? setInterval(() => {
        void fetch(`${config.mediaMtxApiUrl}/v3/paths/list`)
          .then(async (response) => {
            if (!response.ok) throw new Error(`MediaMTX API returned ${response.status}`);
            const body = (await response.json()) as {
              items?: Array<{ name?: string; ready?: boolean }>;
            };
            return live.reconcilePublisherPaths(
              new Set(
                (body.items ?? [])
                  .filter((path) => path.ready && path.name)
                  .map((path) => path.name!)
              )
            );
          })
          .catch((error) => app.log.debug({ err: error }, 'MediaMTX publisher status unavailable'));
      }, 3_000)
    : undefined;
  livePoll?.unref();

  const shutdownSequence = createShutdownSequence([
    {
      name: 'background-timers',
      stop: () => {
        clearInterval(cleanup);
        if (heartbeat) clearInterval(heartbeat);
        if (livePoll) clearInterval(livePoll);
      }
    },
    { name: 'live-service', stop: () => live.stop() },
    { name: 'managed-mediamtx', stop: () => managedMediaMtx?.stop() },
    { name: 'agent-controller', stop: () => agentController?.stop() },
    { name: 'backend-service', stop: () => backends.close() },
    { name: 'http-server', stop: () => app.close() },
    { name: 'repository', stop: () => repository.close() }
  ]);
  shutdown = () => shutdownSequence.run();

  bindShutdown(() => shutdown?.() ?? Promise.resolve());
  if (runtimeFailure) void shutdown();
}

export async function startControllerRuntime(config: RelayConfig): Promise<void> {
  await startControlPlaneRuntime(config, ROLE_PLANS.controller);
}

export async function startStandaloneRuntime(config: RelayConfig): Promise<void> {
  await startControlPlaneRuntime(config, ROLE_PLANS.standalone);
}

export async function startSourceWorkerRuntime(config: RelayConfig): Promise<void> {
  const listen = parseListenAddress(config.listenAddr);
  const repository = createRepository(config);
  await repository.assertSchemaCurrent();
  const secretBackend = resolveSecretBackend(config);
  const secrets = createSecretStore(config, secretBackend);
  const events = new InMemoryEventBus();
  const metrics = new PrometheusMetricsSink({ node: config.nodeId, region: config.nodeRegion });
  const coordination = createCoordinationStore(config);
  const bootstrapObjectStores = createBootstrapObjectStores(config);
  const objectStore = await resolveConfiguredObjectStore(
    repository,
    secrets,
    bootstrapObjectStores.local,
    bootstrapObjectStores.configured,
    config.nodeId
  );
  const registry = new DefaultProviderRegistry();
  registry.register(new JellyfinProvider(config.applicationVersion));
  const providers = new ProviderService(repository, secrets, registry, {
    nodeId: config.nodeId
  });
  const transcoder = new FFmpegTranscoder({ ffmpegPath: config.ffmpegPath });
  const capabilities = await transcoder.discover();
  const sessions = new SessionService(
    repository,
    secrets,
    registry,
    transcoder,
    events,
    {
      publicUrl: config.playbackUrl,
      internalUrl: `http://127.0.0.1:${listen.port}`,
      cacheDir: config.cacheDir,
      cacheTtlMs: config.cacheTtlMs,
      cacheLimitBytes: config.cacheLimitBytes,
      maxWorkers: config.maxWorkers,
      nodeId: config.nodeId,
      roles: ['source-worker'],
      jobLogRetentionRows: config.jobLogRetentionRows,
      jobLogQueryLimit: config.jobLogQueryLimit
    },
    { objectStore, coordination, clusterRepository: repository, metrics }
  );
  const currentNodeCapabilities = nodeCapabilities(config, capabilities, sessions, async () =>
    (
      await Promise.all(
        (await repository.listProviderBindings()).map(async (binding) => {
          if (binding.deletionPending) return undefined;
          try {
            await secrets.get(binding.secretRef);
            return binding.providerId;
          } catch {
            return undefined;
          }
        })
      )
    ).filter((providerId): providerId is string => Boolean(providerId))
  );
  const app = await createRoleServer(config, {
    kind: 'source-worker',
    sessions,
    capabilities,
    metrics
  });
  await app.listen(listen);
  const nodeAgent = configuredNodeAgent(
    config,
    secrets,
    currentNodeCapabilities,
    {
      onSegment: (command, signal) => sessions.executeRemoteSegment(command, signal),
      onCancel: (jobId) => sessions.cancelJob(jobId),
      onProvider: providerAgentHandler(providers),
      onCache: cacheAgentHandler(sessions)
    },
    `http://127.0.0.1:${listen.port}`
  );
  await nodeAgent?.start();

  const cleanup = setInterval(() => {
    void sessions
      .cleanupExpiredCache()
      .catch((error) => app.log.error({ err: error }, 'cache cleanup failed'));
  }, 60_000);
  cleanup.unref();
  const shutdown = createShutdownSequence([
    { name: 'background-timers', stop: () => clearInterval(cleanup) },
    { name: 'node-agent', stop: () => nodeAgent?.stop() },
    { name: 'http-server', stop: () => app.close() },
    { name: 'repository', stop: () => repository.close() }
  ]);
  bindShutdown(() => shutdown.run());
}

export async function startIngestOriginRuntime(config: RelayConfig): Promise<void> {
  const listen = parseListenAddress(config.listenAddr);
  const repository = createRepository(config);
  await repository.assertSchemaCurrent();
  const secretBackend = resolveSecretBackend(config);
  const secrets = createSecretStore(config, secretBackend);
  const events = new InMemoryEventBus();
  const metrics = new PrometheusMetricsSink({ node: config.nodeId, region: config.nodeRegion });
  const transcoder = new FFmpegTranscoder({ ffmpegPath: config.ffmpegPath });
  const capabilities = await transcoder.discover();
  const normalizer = new FFmpegLiveNormalizer({
    ffmpegPath: config.ffmpegPath
  });
  const live = liveService(config, repository, events, normalizer, metrics);
  await live.scrubPersistedPublisherCredentials();
  const currentNodeCapabilities = nodeCapabilities(config, capabilities);
  const app = await createRoleServer(config, {
    kind: 'ingest-origin',
    live,
    capabilities,
    metrics
  });
  await app.listen(listen);

  // Assigned after the managed runtime exists; its exit callback closes over this hook.
  // eslint-disable-next-line prefer-const
  let shutdown: (() => Promise<void>) | undefined;
  let runtimeFailure: Error | undefined;
  const managedMediaMtx =
    config.mediaMtxExecutable && config.mediaMtxConfig
      ? new ManagedMediaMtx({
          executable: config.mediaMtxExecutable,
          configPath: config.mediaMtxConfig,
          relayPort: listen.port,
          onUnexpectedExit: (error) => {
            runtimeFailure = error;
            process.exitCode = 1;
            app.log.error({ err: error }, 'managed MediaMTX stopped');
            if (shutdown) void shutdown();
          }
        })
      : undefined;
  await managedMediaMtx?.start();
  if (managedMediaMtx)
    app.log.info({ executable: config.mediaMtxExecutable }, 'managed MediaMTX started');
  const nodeAgent = configuredNodeAgent(config, secrets, currentNodeCapabilities, {
    onSegment: async () => {
      throw new Error('Segment jobs are unavailable on an ingest origin');
    },
    onCancel: async () => undefined,
    onProvider: async () => {
      throw new Error('Provider operations are unavailable on an ingest origin');
    },
    onCache: async () => {
      throw new Error('Cache operations are unavailable on an ingest origin');
    }
  });
  await nodeAgent?.start();
  const livePoll = setInterval(() => {
    void fetch(`${config.mediaMtxApiUrl}/v3/paths/list`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`MediaMTX API returned ${response.status}`);
        const body = (await response.json()) as {
          items?: Array<{ name?: string; ready?: boolean }>;
        };
        return live.reconcilePublisherPaths(
          new Set(
            (body.items ?? []).filter((path) => path.ready && path.name).map((path) => path.name!)
          )
        );
      })
      .catch((error) => app.log.debug({ err: error }, 'MediaMTX publisher status unavailable'));
  }, 3_000);
  livePoll.unref();
  const shutdownSequence = createShutdownSequence([
    { name: 'background-timers', stop: () => clearInterval(livePoll) },
    { name: 'live-service', stop: () => live.stop() },
    { name: 'managed-mediamtx', stop: () => managedMediaMtx?.stop() },
    { name: 'node-agent', stop: () => nodeAgent?.stop() },
    { name: 'http-server', stop: () => app.close() },
    { name: 'repository', stop: () => repository.close() }
  ]);
  shutdown = () => shutdownSequence.run();
  bindShutdown(() => shutdown?.() ?? Promise.resolve());
  if (runtimeFailure) void shutdown();
}

export async function startEdgeRuntime(config: RelayConfig): Promise<void> {
  const listen = parseListenAddress(config.listenAddr);
  const repository = createRepository(config);
  await repository.assertSchemaCurrent();
  const secretBackend = resolveSecretBackend(config);
  const secrets = createSecretStore(config, secretBackend);
  const events = new InMemoryEventBus();
  const metrics = new PrometheusMetricsSink({ node: config.nodeId, region: config.nodeRegion });
  const coordination = createCoordinationStore(config);
  const bootstrapObjectStores = createBootstrapObjectStores(config);
  const objectStore = await resolveConfiguredObjectStore(
    repository,
    secrets,
    bootstrapObjectStores.local,
    bootstrapObjectStores.configured,
    config.nodeId
  );
  // Assigned after the edge session service exists; its requester closes over the agent.
  // eslint-disable-next-line prefer-const
  let nodeAgent: NodeAgent | undefined;
  const sessions = new SessionService(
    repository,
    secrets,
    EDGE_PROVIDERS,
    EDGE_TRANSCODER,
    events,
    {
      publicUrl: config.playbackUrl,
      internalUrl: `http://127.0.0.1:${listen.port}`,
      cacheDir: config.cacheDir,
      cacheTtlMs: config.cacheTtlMs,
      cacheLimitBytes: config.cacheLimitBytes,
      maxWorkers: config.maxWorkers,
      nodeId: config.nodeId,
      roles: ['edge'],
      jobLogRetentionRows: config.jobLogRetentionRows,
      jobLogQueryLimit: config.jobLogQueryLimit
    },
    {
      objectStore,
      coordination,
      clusterRepository: repository,
      metrics,
      ensureRequester: {
        ensure: (token, index, signal) => {
          if (!nodeAgent) throw new Error('Controller agent connection is unavailable');
          return nodeAgent.ensure(token, index, signal);
        }
      }
    }
  );
  const currentNodeCapabilities = nodeCapabilities(config, EDGE_CAPABILITIES, sessions);
  const app = await createRoleServer(config, {
    kind: 'edge',
    sessions,
    capabilities: EDGE_CAPABILITIES,
    metrics
  });
  await app.listen(listen);
  nodeAgent = configuredNodeAgent(config, secrets, currentNodeCapabilities, {
    onSegment: async () => {
      throw new Error('Segment transcoding is unavailable on an edge');
    },
    onCancel: async () => undefined,
    onProvider: async () => {
      throw new Error('Provider operations are unavailable on an edge');
    },
    onCache: cacheAgentHandler(sessions)
  });
  await nodeAgent?.start();

  const cleanup = setInterval(() => {
    void sessions
      .cleanupExpiredCache()
      .catch((error) => app.log.error({ err: error }, 'cache cleanup failed'));
  }, 60_000);
  cleanup.unref();
  const shutdown = createShutdownSequence([
    { name: 'background-timers', stop: () => clearInterval(cleanup) },
    { name: 'node-agent', stop: () => nodeAgent?.stop() },
    { name: 'http-server', stop: () => app.close() },
    { name: 'repository', stop: () => repository.close() }
  ]);
  bindShutdown(() => shutdown.run());
}
