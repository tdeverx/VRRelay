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
  type ClusterRepository,
  InMemoryEventBus,
  LiveService,
  ProfileService,
  ProviderService,
  SessionService,
  SwitchableMetricsExporter,
  SwitchableTrafficDirector,
  type MediaCapabilities,
  type ProviderRegistry,
  type Repository,
  type SecretStore,
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
import { RetentionService } from '../retention-service.js';
import { createServer, registerStandaloneInternalRoutes } from '../server.js';
import { startLoopbackCompanion } from '../loopback-companion.js';
import {
  createBootstrapObjectStores,
  createCoordinationStore,
  createSecretStore,
  resolveSecretBackend
} from './infrastructure.js';
import { createRepository } from './repository.js';
import { ROLE_PLANS, type RolePlan } from './role-plan.js';
import {
  createRoleServer,
  registerRoleInternalRoutes,
  type RoleReadinessDependency
} from './role-server.js';
import { repositorySchemaStartupMethod } from './schema-startup.js';
import { createShutdownSequence, createStartupRollback } from './shutdown.js';
import { fetchWithTimeout } from '../fetch-timeout.js';

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
  produceVod: async () => {
    throw new Error('Transcoding is unavailable on an edge');
  },
  generateSegment: async () => {
    throw new Error('Transcoding is unavailable on an edge');
  }
};

export function advertisedIngestUrl(configuredUrl: string, publicUrl: string): string {
  const configured = new URL(configuredUrl);
  const publicOrigin = new URL(publicUrl);
  const loopback = (hostname: string) =>
    hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
  if (loopback(configured.hostname) && !loopback(publicOrigin.hostname))
    configured.hostname = publicOrigin.hostname;
  return configured.toString().replace(/\/$/, '');
}

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
      rtmpUrl: advertisedIngestUrl(config.mediaMtxRtmpUrl, config.publicUrl),
      srtUrl: advertisedIngestUrl(config.mediaMtxSrtUrl, config.publicUrl),
      whipUrl: advertisedIngestUrl(config.mediaMtxWhipUrl, config.publicUrl),
      hlsUrl: config.mediaMtxHlsUrl,
      internalRtspUrl: config.mediaMtxRtspUrl,
      allowUnauthenticatedInternalRead: config.mediaMtxAllowInternalRead,
      maxChannelsTotal: config.liveMaxChannelsTotal,
      maxChannelsPerOwner: config.liveMaxChannelsPerOwner,
      ...(config.backupRtmpUrl ? { backupRtmpUrl: config.backupRtmpUrl } : {}),
      ...(config.backupSrtUrl ? { backupSrtUrl: config.backupSrtUrl } : {})
    },
    normalizer,
    events,
    repository,
    metrics
  );
}

function createNonOverlappingInterval(
  intervalMs: number,
  operation: () => Promise<void>,
  onError: (error: unknown) => void
): NodeJS.Timeout {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void operation()
      .catch(onError)
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}

async function reconcileMediaMtxPublisherPaths(apiUrl: string, live: LiveService): Promise<void> {
  const response = await fetchWithTimeout(`${apiUrl}/v3/paths/list`, {}, 5_000);
  if (!response.ok) throw new Error(`MediaMTX API returned ${response.status}`);
  const body = (await response.json()) as {
    items?: Array<{ name?: string; ready?: boolean }>;
  };
  await live.reconcilePublisherPaths(
    new Set((body.items ?? []).filter((path) => path.ready && path.name).map((path) => path.name!))
  );
}

async function mediaMtxAvailable(apiUrl: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${apiUrl}/v3/paths/list`, {}, 750);
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export async function startCriticalResourcesBeforeHttp(
  operations: ReadonlyArray<() => Promise<void>>,
  exposeHttp: () => Promise<unknown>
): Promise<void> {
  for (const operation of operations) await operation();
  await exposeHttp();
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
    providerIds: await providerIds(),
    vodProducerVersion: config.nodeRoles.includes('source-worker') ? 1 : 0
  });
}

export async function locallyAvailableProviderIds(
  repository: Pick<Repository, 'listProviders'> & Pick<ClusterRepository, 'listProviderBindings'>,
  secrets: Pick<SecretStore, 'get'>
): Promise<string[]> {
  const [providers, bindings] = await Promise.all([
    repository.listProviders(),
    repository.listProviderBindings()
  ]);
  const candidates = [
    ...providers.map((provider) => ({ providerId: provider.id, secretRef: provider.secretRef })),
    ...bindings
      .filter((binding) => !binding.deletionPending)
      .map((binding) => ({ providerId: binding.providerId, secretRef: binding.secretRef }))
  ];
  const available = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await secrets.get(candidate.secretRef);
        return candidate.providerId;
      } catch {
        return undefined;
      }
    })
  );
  return [...new Set(available.filter((providerId): providerId is string => Boolean(providerId)))];
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
  handlers: Pick<
    NodeAgentOptions,
    | 'onSegment'
    | 'onCancel'
    | 'onProducerStop'
    | 'onDrain'
    | 'onDisconnect'
    | 'onProvider'
    | 'onCache'
  >,
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
  handlers: Pick<
    NodeAgentOptions,
    | 'onSegment'
    | 'onCancel'
    | 'onProducerStop'
    | 'onDrain'
    | 'onDisconnect'
    | 'onProvider'
    | 'onCache'
  >,
  internalUrl?: string
): NodeAgent | undefined {
  const options = configuredNodeAgentOptions(config, secrets, capabilities, handlers, internalUrl);
  return options ? new NodeAgent(options) : undefined;
}

function bindShutdown(shutdown: () => Promise<void>): void {
  const run = () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
      process.stderr.write('VRRelay shutdown completed with one or more failures.\n');
    });
  };
  process.once('SIGINT', run);
  process.once('SIGTERM', run);
}

async function startControlPlaneRuntime(config: RelayConfig, plan: RolePlan): Promise<void> {
  if (!plan.hostsController)
    throw new Error('The control-plane runtime requires a controller or standalone role plan');
  const listen = parseListenAddress(config.listenAddr);
  const repository = createRepository(config);
  const startup = createStartupRollback();
  startup.defer({ name: 'repository', stop: () => repository.close() });
  try {
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
    startup.defer({ name: 'backend-service', stop: () => backends.close() });
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
    // Standalone dispatches work in-process. Starting the cluster agent listener here would make a
    // default desktop install depend on certificate provisioning even though it has no remote nodes.
    const agentController =
      plan.kind === 'controller'
        ? new AgentController(cluster, certificateAuthority, coordination)
        : undefined;
    startup.defer({ name: 'agent-controller', stop: () => agentController?.stop() });
    const providers = new ProviderService(repository, secrets, registry, {
      nodeId: config.nodeId,
      ...(agentController ? { remote: agentController } : {})
    });
    const profiles = new ProfileService(repository, capabilities, config.vodProducerEncoder);
    await profiles.seed();

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
        vodProducerIdleTimeoutMs: config.vodProducerIdleTimeoutMs,
        vodProducerBufferLowWatermarkMs: config.vodProducerBufferLowWatermarkMs,
        vodProducerBufferHighWatermarkMs: config.vodProducerBufferHighWatermarkMs,
        vodProducerMaxCatchupRate: config.vodProducerMaxCatchupRate,
        vodProducerMaxConcurrent: config.vodProducerMaxConcurrent,
        vodProducerMaxPerProvider: config.vodProducerMaxPerProvider,
        jobLogRetentionRows: config.jobLogRetentionRows,
        jobLogQueryLimit: config.jobLogQueryLimit
      },
      {
        objectStore,
        coordination,
        clusterRepository: repository,
        metrics,
        ...(agentController
          ? { dispatcher: agentController, providerGateway: agentController }
          : {})
      }
    );
    startup.defer({ name: 'vod-producers', stop: () => sessions.close() });
    agentController?.setEnsureHandler((token, index, signal) =>
      sessions.segment(token, index, signal).then(() => undefined)
    );

    const liveNormalizer = plan.managesLiveIngest
      ? new FFmpegLiveNormalizer({
          ffmpegPath: config.ffmpegPath,
          maxConcurrent: config.liveNormalizerMaxConcurrent,
          maxConcurrentPerOwner: config.liveNormalizerMaxPerOwner
        })
      : undefined;
    const live = liveService(config, repository, events, liveNormalizer, metrics);
    startup.defer({ name: 'live-service', stop: () => live.stop() });
    await live.scrubPersistedPublisherCredentials();
    await sessions.recover();

    const auth = new AuthService(repository, secrets, providers);
    await auth.recover();
    const audit = new AuditService(repository);
    let reportRetentionFailure: (
      error: unknown,
      target: { type: 'session' | 'user'; id: string }
    ) => void = () => undefined;
    const retention = new RetentionService(repository, sessions, auth, audit, (error, target) =>
      reportRetentionFailure(error, target)
    );
    const currentNodeCapabilities = nodeCapabilities(config, capabilities, sessions, () =>
      locallyAvailableProviderIds(repository, secrets)
    );
    const heartbeatLocalNode = async (): Promise<void> => {
      await cluster.heartbeat(config.nodeId, await currentNodeCapabilities(), 'online');
    };
    const managedMediaMtxRef: { current: ManagedMediaMtx | undefined } = {
      current: undefined
    };
    const app = await createServer(
      config,
      {
        repository,
        auth,
        audit,
        retention,
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
        ...(plan.managesLiveIngest
          ? {
              readiness: async (): Promise<RoleReadinessDependency[]> => [
                {
                  category: 'routing',
                  kind: 'mediamtx',
                  healthy:
                    (managedMediaMtxRef.current?.running() ?? true) &&
                    (await mediaMtxAvailable(config.mediaMtxApiUrl)),
                  checkedAt: new Date().toISOString()
                }
              ]
            }
          : {}),
        ...(plan.kind === 'standalone' ? { refreshLocalNodeCapabilities: heartbeatLocalNode } : {}),
        ...(agentController ? { agentController } : {})
      },
      plan.kind === 'controller' ? 'controller' : 'standalone'
    );
    reportRetentionFailure = (error, target) =>
      app.log.error({ err: error, ...target }, 'retention sweep item failed');
    startup.defer({ name: 'http-server', stop: () => app.close() });
    const loopbackApp =
      plan.kind === 'standalone'
        ? await startLoopbackCompanion(listen, (internal) =>
            registerStandaloneInternalRoutes(internal, config, { live, sessions })
          )
        : undefined;
    startup.defer({ name: 'loopback-http-server', stop: () => loopbackApp?.close() });
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
    managedMediaMtxRef.current = managedMediaMtx;
    startup.defer({ name: 'managed-mediamtx', stop: () => managedMediaMtx?.stop() });
    await startCriticalResourcesBeforeHttp(
      [
        async () => {
          await managedMediaMtx?.start();
          if (managedMediaMtx)
            app.log.info({ executable: config.mediaMtxExecutable }, 'managed MediaMTX started');
        },
        async () => {
          if (!agentController) return;
          const agentListen = parseListenAddress(config.agentListenAddr);
          await agentController.start(agentListen.host, agentListen.port, config.agentTlsNames);
          app.log.info({ address: config.agentListenAddr }, 'mTLS node agent listener ready');
        }
      ],
      () => app.listen(listen)
    );

    const cleanup = setInterval(() => {
      void auth.cleanup().catch((error) => app.log.error({ err: error }, 'auth cleanup failed'));
      void sessions
        .cleanupExpiredCache()
        .catch((error) => app.log.error({ err: error }, 'cache cleanup failed'));
    }, 60_000);
    cleanup.unref();
    const retentionSweep = createNonOverlappingInterval(
      60_000,
      () => retention.sweep().then(() => undefined),
      (error) => app.log.error({ err: error }, 'retention sweep failed')
    );
    const heartbeat = plan.hostsController
      ? setInterval(() => {
          void heartbeatLocalNode().catch((error) =>
            app.log.error({ err: error }, 'node heartbeat failed')
          );
        }, 15_000)
      : undefined;
    heartbeat?.unref();
    const livePoll = plan.managesLiveIngest
      ? createNonOverlappingInterval(
          3_000,
          () => reconcileMediaMtxPublisherPaths(config.mediaMtxApiUrl, live),
          (error) => app.log.debug({ err: error }, 'MediaMTX publisher status unavailable')
        )
      : undefined;

    const shutdownSequence = createShutdownSequence([
      {
        name: 'background-timers',
        stop: () => {
          clearInterval(cleanup);
          clearInterval(retentionSweep);
          if (heartbeat) clearInterval(heartbeat);
          if (livePoll) clearInterval(livePoll);
        }
      },
      { name: 'live-service', stop: () => live.stop() },
      { name: 'managed-mediamtx', stop: () => managedMediaMtx?.stop() },
      { name: 'agent-controller', stop: () => agentController?.stop() },
      { name: 'backend-service', stop: () => backends.close() },
      { name: 'vod-producers', stop: () => sessions.close() },
      {
        name: 'http-server',
        stop: () => Promise.all([app.close(), loopbackApp?.close()]).then(() => undefined)
      },
      { name: 'repository', stop: () => repository.close() }
    ]);
    shutdown = () => shutdownSequence.run();

    bindShutdown(() => shutdown?.() ?? Promise.resolve());
    startup.commit();
    if (runtimeFailure) void shutdown();
  } catch (error) {
    await startup.rollback(error);
  }
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
  const startup = createStartupRollback();
  startup.defer({ name: 'repository', stop: () => repository.close() });
  try {
    await repository.assertSchemaCurrent();
    const secretBackend = resolveSecretBackend(config);
    const secrets = createSecretStore(config, secretBackend);
    const events = new InMemoryEventBus();
    const transcoder = new FFmpegTranscoder({ ffmpegPath: config.ffmpegPath });
    const capabilities = await transcoder.discover();
    const services: {
      sessions?: SessionService;
      providers?: ProviderService;
    } = {};
    const currentNodeCapabilities = () =>
      nodeCapabilities(config, capabilities, services.sessions, () =>
        locallyAvailableProviderIds(repository, secrets)
      )();
    const nodeAgent = configuredNodeAgent(
      config,
      secrets,
      currentNodeCapabilities,
      {
        onSegment: (command, signal) => {
          if (!services.sessions) throw new Error('Source-worker session service is unavailable');
          return services.sessions.executeRemoteSegment(command, signal);
        },
        onCancel: (jobId) => {
          if (!services.sessions) throw new Error('Source-worker session service is unavailable');
          return services.sessions.cancelJob(jobId);
        },
        onProducerStop: (sessionId) => {
          if (!services.sessions) throw new Error('Source-worker session service is unavailable');
          return services.sessions.stopProducer(sessionId);
        },
        onDrain: (draining) => {
          if (!services.sessions) throw new Error('Source-worker session service is unavailable');
          return draining ? services.sessions.drainProducers() : Promise.resolve();
        },
        // A controller restart is a temporary transport loss. Fence active
        // producers without permanently closing the reusable worker runtime.
        onDisconnect: () => services.sessions?.drainProducers() ?? Promise.resolve(),
        onProvider: (operation, payload) => {
          if (!services.providers) throw new Error('Source-worker provider service is unavailable');
          return providerAgentHandler(services.providers)(operation, payload);
        },
        onCache: (operation, payload) => {
          if (!services.sessions) throw new Error('Source-worker session service is unavailable');
          return cacheAgentHandler(services.sessions)(operation, payload);
        }
      },
      `http://127.0.0.1:${listen.port}`
    );
    startup.defer({ name: 'node-agent', stop: () => nodeAgent?.stop() });
    const runtimeNodeId = (await nodeAgent?.prepareIdentity()) ?? config.nodeId;
    const roleConfig = { ...config, nodeId: runtimeNodeId };
    const metrics = new PrometheusMetricsSink({
      node: runtimeNodeId,
      region: config.nodeRegion
    });
    const coordination = createCoordinationStore(config);
    const bootstrapObjectStores = createBootstrapObjectStores(config);
    const objectStore = await resolveConfiguredObjectStore(
      repository,
      secrets,
      bootstrapObjectStores.local,
      bootstrapObjectStores.configured,
      runtimeNodeId
    );
    const registry = new DefaultProviderRegistry();
    registry.register(new JellyfinProvider(config.applicationVersion));
    services.providers = new ProviderService(repository, secrets, registry, {
      nodeId: runtimeNodeId
    });
    services.sessions = new SessionService(
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
        nodeId: runtimeNodeId,
        roles: ['source-worker'],
        vodProducerIdleTimeoutMs: config.vodProducerIdleTimeoutMs,
        vodProducerBufferLowWatermarkMs: config.vodProducerBufferLowWatermarkMs,
        vodProducerBufferHighWatermarkMs: config.vodProducerBufferHighWatermarkMs,
        vodProducerMaxCatchupRate: config.vodProducerMaxCatchupRate,
        vodProducerMaxConcurrent: config.vodProducerMaxConcurrent,
        vodProducerMaxPerProvider: config.vodProducerMaxPerProvider,
        jobLogRetentionRows: config.jobLogRetentionRows,
        jobLogQueryLimit: config.jobLogQueryLimit
      },
      { objectStore, coordination, clusterRepository: repository, metrics }
    );
    const sessions = services.sessions;
    startup.defer({ name: 'vod-producers', stop: () => sessions.close() });
    await sessions.recover();
    const nodeAgentRef: { current: NodeAgent | undefined } = { current: undefined };
    const roleServices = {
      kind: 'source-worker',
      sessions,
      capabilities,
      metrics,
      readiness: async (): Promise<RoleReadinessDependency[]> => [
        {
          category: 'coordination',
          kind: 'controller-agent',
          healthy: nodeAgentRef.current?.connected() ?? false,
          checkedAt: new Date().toISOString()
        }
      ]
    } as const;
    const app = await createRoleServer(roleConfig, roleServices);
    startup.defer({ name: 'http-server', stop: () => app.close() });
    const loopbackApp = await startLoopbackCompanion(listen, (internal) =>
      registerRoleInternalRoutes(internal, roleConfig, roleServices)
    );
    startup.defer({ name: 'loopback-http-server', stop: () => loopbackApp?.close() });
    nodeAgentRef.current = nodeAgent;
    await startCriticalResourcesBeforeHttp([async () => void (await nodeAgent?.start())], () =>
      app.listen(listen)
    );

    const cleanup = setInterval(() => {
      void sessions
        .cleanupExpiredCache()
        .catch((error) => app.log.error({ err: error }, 'cache cleanup failed'));
    }, 60_000);
    cleanup.unref();
    const shutdown = createShutdownSequence([
      { name: 'background-timers', stop: () => clearInterval(cleanup) },
      { name: 'node-agent', stop: () => nodeAgent?.stop() },
      { name: 'vod-producers', stop: () => sessions.close() },
      {
        name: 'http-server',
        stop: () => Promise.all([app.close(), loopbackApp?.close()]).then(() => undefined)
      },
      { name: 'repository', stop: () => repository.close() }
    ]);
    bindShutdown(() => shutdown.run());
    startup.commit();
  } catch (error) {
    await startup.rollback(error);
  }
}

export async function startIngestOriginRuntime(config: RelayConfig): Promise<void> {
  const listen = parseListenAddress(config.listenAddr);
  const repository = createRepository(config);
  const startup = createStartupRollback();
  startup.defer({ name: 'repository', stop: () => repository.close() });
  try {
    await repository.assertSchemaCurrent();
    const secretBackend = resolveSecretBackend(config);
    const secrets = createSecretStore(config, secretBackend);
    const events = new InMemoryEventBus();
    const metrics = new PrometheusMetricsSink({ node: config.nodeId, region: config.nodeRegion });
    const transcoder = new FFmpegTranscoder({ ffmpegPath: config.ffmpegPath });
    const capabilities = await transcoder.discover();
    const normalizer = new FFmpegLiveNormalizer({
      ffmpegPath: config.ffmpegPath,
      maxConcurrent: config.liveNormalizerMaxConcurrent,
      maxConcurrentPerOwner: config.liveNormalizerMaxPerOwner
    });
    const live = liveService(config, repository, events, normalizer, metrics);
    startup.defer({ name: 'live-service', stop: () => live.stop() });
    await live.scrubPersistedPublisherCredentials();
    const currentNodeCapabilities = nodeCapabilities(config, capabilities);
    const nodeAgentRef: { current: NodeAgent | undefined } = { current: undefined };
    const managedMediaMtxRef: { current: ManagedMediaMtx | undefined } = {
      current: undefined
    };
    const roleServices = {
      kind: 'ingest-origin',
      live,
      capabilities,
      metrics,
      readiness: async (): Promise<RoleReadinessDependency[]> => {
        const checkedAt = new Date().toISOString();
        return [
          {
            category: 'coordination',
            kind: 'controller-agent',
            healthy: nodeAgentRef.current?.connected() ?? false,
            checkedAt
          },
          {
            category: 'routing',
            kind: 'mediamtx',
            healthy:
              (managedMediaMtxRef.current?.running() ?? true) &&
              (await mediaMtxAvailable(config.mediaMtxApiUrl)),
            checkedAt
          }
        ];
      }
    } as const;
    const app = await createRoleServer(config, roleServices);
    startup.defer({ name: 'http-server', stop: () => app.close() });
    const loopbackApp = await startLoopbackCompanion(listen, (internal) =>
      registerRoleInternalRoutes(internal, config, roleServices)
    );
    startup.defer({ name: 'loopback-http-server', stop: () => loopbackApp?.close() });

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
    managedMediaMtxRef.current = managedMediaMtx;
    startup.defer({ name: 'managed-mediamtx', stop: () => managedMediaMtx?.stop() });
    const nodeAgent = configuredNodeAgent(config, secrets, currentNodeCapabilities, {
      onSegment: async () => {
        throw new Error('Segment jobs are unavailable on an ingest origin');
      },
      onCancel: async () => undefined,
      onProducerStop: async () => undefined,
      onDrain: async () => undefined,
      onProvider: async () => {
        throw new Error('Provider operations are unavailable on an ingest origin');
      },
      onCache: async () => {
        throw new Error('Cache operations are unavailable on an ingest origin');
      }
    });
    nodeAgentRef.current = nodeAgent;
    startup.defer({ name: 'node-agent', stop: () => nodeAgent?.stop() });
    await startCriticalResourcesBeforeHttp(
      [
        async () => {
          await managedMediaMtx?.start();
          if (managedMediaMtx)
            app.log.info({ executable: config.mediaMtxExecutable }, 'managed MediaMTX started');
        },
        async () => void (await nodeAgent?.start())
      ],
      () => app.listen(listen)
    );
    const livePoll = createNonOverlappingInterval(
      3_000,
      () => reconcileMediaMtxPublisherPaths(config.mediaMtxApiUrl, live),
      (error) => app.log.debug({ err: error }, 'MediaMTX publisher status unavailable')
    );
    const shutdownSequence = createShutdownSequence([
      { name: 'background-timers', stop: () => clearInterval(livePoll) },
      { name: 'live-service', stop: () => live.stop() },
      { name: 'managed-mediamtx', stop: () => managedMediaMtx?.stop() },
      { name: 'node-agent', stop: () => nodeAgent?.stop() },
      {
        name: 'http-server',
        stop: () => Promise.all([app.close(), loopbackApp?.close()]).then(() => undefined)
      },
      { name: 'repository', stop: () => repository.close() }
    ]);
    shutdown = () => shutdownSequence.run();
    bindShutdown(() => shutdown?.() ?? Promise.resolve());
    startup.commit();
    if (runtimeFailure) void shutdown();
  } catch (error) {
    await startup.rollback(error);
  }
}

export async function startEdgeRuntime(config: RelayConfig): Promise<void> {
  const listen = parseListenAddress(config.listenAddr);
  const repository = createRepository(config);
  const startup = createStartupRollback();
  startup.defer({ name: 'repository', stop: () => repository.close() });
  try {
    await repository.assertSchemaCurrent();
    const secretBackend = resolveSecretBackend(config);
    const secrets = createSecretStore(config, secretBackend);
    const events = new InMemoryEventBus();
    const services: { sessions?: SessionService } = {};
    const currentNodeCapabilities = () =>
      nodeCapabilities(config, EDGE_CAPABILITIES, services.sessions)();
    const nodeAgent = configuredNodeAgent(config, secrets, currentNodeCapabilities, {
      onSegment: async () => {
        throw new Error('Segment transcoding is unavailable on an edge');
      },
      onCancel: async () => undefined,
      onProvider: async () => {
        throw new Error('Provider operations are unavailable on an edge');
      },
      onCache: (operation, payload) => {
        if (!services.sessions) throw new Error('Edge session service is unavailable');
        return cacheAgentHandler(services.sessions)(operation, payload);
      }
    });
    startup.defer({ name: 'node-agent', stop: () => nodeAgent?.stop() });
    const runtimeNodeId = (await nodeAgent?.prepareIdentity()) ?? config.nodeId;
    const roleConfig = { ...config, nodeId: runtimeNodeId };
    const metrics = new PrometheusMetricsSink({
      node: runtimeNodeId,
      region: config.nodeRegion
    });
    const coordination = createCoordinationStore(config);
    const bootstrapObjectStores = createBootstrapObjectStores(config);
    const objectStore = await resolveConfiguredObjectStore(
      repository,
      secrets,
      bootstrapObjectStores.local,
      bootstrapObjectStores.configured,
      runtimeNodeId
    );
    services.sessions = new SessionService(
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
        nodeId: runtimeNodeId,
        roles: ['edge'],
        vodProducerIdleTimeoutMs: config.vodProducerIdleTimeoutMs,
        vodProducerBufferLowWatermarkMs: config.vodProducerBufferLowWatermarkMs,
        vodProducerBufferHighWatermarkMs: config.vodProducerBufferHighWatermarkMs,
        vodProducerMaxCatchupRate: config.vodProducerMaxCatchupRate,
        vodProducerMaxConcurrent: config.vodProducerMaxConcurrent,
        vodProducerMaxPerProvider: config.vodProducerMaxPerProvider,
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
    const sessions = services.sessions;
    startup.defer({ name: 'vod-producers', stop: () => sessions.close() });
    const roleServices = {
      kind: 'edge',
      sessions,
      capabilities: EDGE_CAPABILITIES,
      metrics,
      readiness: async (): Promise<RoleReadinessDependency[]> => {
        const checkedAt = new Date().toISOString();
        return [
          {
            category: 'coordination',
            kind: 'controller-agent',
            healthy: nodeAgent?.connected() ?? false,
            checkedAt
          },
          {
            category: 'routing',
            kind: 'mediamtx',
            healthy: await mediaMtxAvailable(config.mediaMtxApiUrl),
            checkedAt
          }
        ];
      }
    } as const;
    const app = await createRoleServer(roleConfig, roleServices);
    startup.defer({ name: 'http-server', stop: () => app.close() });
    const loopbackApp = await startLoopbackCompanion(listen, (internal) =>
      registerRoleInternalRoutes(internal, roleConfig, roleServices)
    );
    startup.defer({ name: 'loopback-http-server', stop: () => loopbackApp?.close() });
    await startCriticalResourcesBeforeHttp([async () => void (await nodeAgent?.start())], () =>
      app.listen(listen)
    );

    const cleanup = setInterval(() => {
      void sessions
        .cleanupExpiredCache()
        .catch((error) => app.log.error({ err: error }, 'cache cleanup failed'));
    }, 60_000);
    cleanup.unref();
    const shutdown = createShutdownSequence([
      { name: 'background-timers', stop: () => clearInterval(cleanup) },
      { name: 'node-agent', stop: () => nodeAgent?.stop() },
      { name: 'vod-producers', stop: () => sessions.close() },
      {
        name: 'http-server',
        stop: () => Promise.all([app.close(), loopbackApp?.close()]).then(() => undefined)
      },
      { name: 'repository', stop: () => repository.close() }
    ]);
    bindShutdown(() => shutdown.run());
    startup.commit();
  } catch (error) {
    await startup.rollback(error);
  }
}
