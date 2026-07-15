// SPDX-License-Identifier: GPL-3.0-or-later
import 'dotenv/config';
import { join } from 'node:path';
import {
  FFmpegTranscoder,
  FFmpegLiveNormalizer,
  JellyfinProvider,
  MacKeychainSecretStore,
  WindowsDpapiSecretStore,
  EncryptedFileSecretStore,
  SqliteRepository,
  PostgresRepository,
  LocalObjectStore,
  S3ObjectStore,
  AzureBlobObjectStore,
  GcsObjectStore,
  MemoryCoordinationStore,
  RedisCoordinationStore,
  PrometheusMetricsSink,
  FileCertificateAuthority,
  validateProviderUrl,
  DefaultProviderRegistry
} from '@vrrelay/adapters';
import {
  InMemoryEventBus,
  BuiltinTrafficDirector,
  SwitchableMetricsExporter,
  SwitchableTrafficDirector,
  ClusterService,
  LiveService,
  ProfileService,
  ProviderService,
  SessionService
} from '@vrrelay/application';
import type {
  ClusterRepository,
  CoordinationStore,
  ObjectStore,
  Repository
} from '@vrrelay/application';
import type { NodeCapability } from '@vrrelay/domain';
import type { CatalogQuery, CreateProviderRequest } from '@vrrelay/contracts';
import { AuthService } from './auth.js';
import { loadConfig, parseListenAddress } from './config.js';
import { createServer } from './server.js';
import { AgentController, NodeAgent } from './agent-transport.js';
import { ManagedMediaMtx } from './media-runtime.js';
import { BackendService, resolveConfiguredObjectStore } from './backend-service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const listen = parseListenAddress(config.listenAddr);
  const repository: Repository & ClusterRepository & { close(): void | Promise<void> } =
    config.repositoryDriver === 'postgres'
      ? new PostgresRepository(
          config.postgresUrl ??
            (() => {
              throw new Error('VRRELAY_POSTGRES_URL is required for PostgreSQL');
            })()
        )
      : new SqliteRepository(join(config.dataDir, 'vrrelay.sqlite3'));
  await repository.migrate();
  if (process.argv[2] === 'migrate') {
    await repository.close();
    return;
  }
  const secretBackend =
    config.secretBackend === 'auto'
      ? process.platform === 'darwin'
        ? 'keychain'
        : process.platform === 'win32'
          ? 'dpapi'
          : 'encrypted-file'
      : config.secretBackend;
  const secrets = (() => {
    if (secretBackend === 'keychain') return new MacKeychainSecretStore();
    if (secretBackend === 'dpapi')
      return new WindowsDpapiSecretStore(join(config.dataDir, 'secrets.dpapi.json'));
    return new EncryptedFileSecretStore(
      join(config.dataDir, 'secrets.json'),
      config.masterKey ??
        (() => {
          throw new Error('VRRELAY_MASTER_KEY is required for encrypted-file secrets');
        })()
    );
  })();
  const registry = new DefaultProviderRegistry();
  registry.register(new JellyfinProvider(config.applicationVersion));
  const transcoder = new FFmpegTranscoder({ ffmpegPath: config.ffmpegPath });
  const capabilities = await transcoder.discover();
  const events = new InMemoryEventBus();
  const coordination: CoordinationStore =
    config.coordinationDriver === 'valkey'
      ? new RedisCoordinationStore(
          config.valkeyUrl ??
            (() => {
              throw new Error('VRRELAY_VALKEY_URL is required for Valkey');
            })()
        )
      : new MemoryCoordinationStore();
  const localObjectStore = new LocalObjectStore(
    config.objectStorePath ?? join(config.dataDir, 'objects')
  );
  const bootstrapObjectStore: ObjectStore = (() => {
    switch (config.objectStoreDriver) {
      case 's3':
        return new S3ObjectStore({
          bucket:
            config.objectStoreBucket ??
            (() => {
              throw new Error('VRRELAY_OBJECT_STORE_BUCKET is required for S3');
            })(),
          region: config.s3Region,
          prefix: config.objectStorePrefix,
          ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
          ...(config.s3AccessKeyId ? { accessKeyId: config.s3AccessKeyId } : {}),
          ...(config.s3SecretAccessKey ? { secretAccessKey: config.s3SecretAccessKey } : {})
        });
      case 'azure-blob':
        return new AzureBlobObjectStore({
          accountUrl:
            config.azureAccountUrl ??
            (() => {
              throw new Error('VRRELAY_AZURE_ACCOUNT_URL is required for Azure Blob');
            })(),
          container:
            config.objectStoreBucket ??
            (() => {
              throw new Error('VRRELAY_OBJECT_STORE_BUCKET is required for Azure Blob');
            })(),
          prefix: config.objectStorePrefix,
          ...(config.azureAccountName ? { accountName: config.azureAccountName } : {}),
          ...(config.azureAccountKey ? { accountKey: config.azureAccountKey } : {})
        });
      case 'gcs':
        return new GcsObjectStore({
          bucket:
            config.objectStoreBucket ??
            (() => {
              throw new Error('VRRELAY_OBJECT_STORE_BUCKET is required for GCS');
            })(),
          prefix: config.objectStorePrefix,
          ...(config.gcsProjectId ? { projectId: config.gcsProjectId } : {}),
          ...(config.gcsKeyFilename ? { keyFilename: config.gcsKeyFilename } : {})
        });
      default:
        return localObjectStore;
    }
  })();
  const objectStore = await resolveConfiguredObjectStore(
    repository,
    secrets,
    localObjectStore,
    bootstrapObjectStore
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
      localObjectStore,
      metrics
    }
  );
  await backends.load();
  const certificateAuthority = new FileCertificateAuthority(secrets);
  const cluster = new ClusterService(
    repository,
    coordination,
    routing,
    events,
    certificateAuthority
  );
  const agentController = config.nodeRoles.includes('controller')
    ? new AgentController(cluster, certificateAuthority, coordination)
    : undefined;
  const providers = new ProviderService(repository, secrets, registry, {
    nodeId: config.nodeId,
    ...(agentController ? { remote: agentController } : {})
  });
  const profiles = new ProfileService(repository);
  await profiles.seed(capabilities);
  // Assigned after the HTTP server exists; the edge requester closes over it.
  // eslint-disable-next-line prefer-const
  let nodeAgent: NodeAgent | undefined;
  const sessions = new SessionService(
    repository,
    secrets,
    registry,
    transcoder,
    events,
    {
      publicUrl: config.publicUrl,
      internalUrl: `http://127.0.0.1:${listen.port}`,
      cacheDir: config.cacheDir,
      cacheTtlMs: config.cacheTtlMs,
      cacheLimitBytes: config.cacheLimitBytes,
      maxWorkers: config.maxWorkers,
      nodeId: config.nodeId,
      roles: config.nodeRoles
    },
    {
      objectStore,
      coordination,
      clusterRepository: repository,
      metrics,
      ...(agentController ? { dispatcher: agentController, providerGateway: agentController } : {}),
      ...(!config.nodeRoles.includes('controller')
        ? {
            ensureRequester: {
              ensure: (token: string, index: number, signal?: AbortSignal) => {
                if (!nodeAgent) throw new Error('Controller agent connection is unavailable');
                return nodeAgent.ensure(token, index, signal);
              }
            }
          }
        : {})
    }
  );
  agentController?.setEnsureHandler((token, index, signal) =>
    sessions.segment(token, index, signal).then(() => undefined)
  );
  const liveEncoderPreference =
    process.platform === 'darwin'
      ? ['h264_videotoolbox', 'libx264']
      : process.platform === 'win32'
        ? ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']
        : ['h264_nvenc', 'h264_qsv', 'h264_vaapi', 'libx264'];
  const liveEncoder =
    liveEncoderPreference.find((name) =>
      capabilities.encoders.some((encoder) => encoder.name === name && encoder.available)
    ) ?? 'libx264';
  const managesLiveIngest = config.nodeRoles.includes('ingest-origin');
  const liveNormalizer = managesLiveIngest
    ? new FFmpegLiveNormalizer({
        ffmpegPath: config.ffmpegPath,
        videoEncoder: liveEncoder
      })
    : undefined;
  const live = new LiveService(
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
    liveNormalizer,
    events
  );
  await live.scrubPersistedPublisherCredentials();
  await sessions.recover();
  const auth = new AuthService(repository);
  const app = await createServer(config, {
    repository,
    auth,
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
  });
  const nodeCapabilities = async (): Promise<NodeCapability> => ({
    encoders: capabilities.encoders
      .filter((encoder) => encoder.available)
      .map((encoder) => encoder.name),
    hardwareDevices: capabilities.encoders
      .filter((encoder) => encoder.available && encoder.hardware)
      .map((encoder) => encoder.name),
    maxWorkers: config.maxWorkers,
    activeWorkers: sessions.capacity().active,
    queuedWorkers: sessions.capacity().queued,
    cacheBytes: await sessions.cacheUsageBytes(),
    cacheLimitBytes: config.cacheLimitBytes,
    egressMbps: sessions.egressMbps(),
    providerIds: (
      await Promise.all(
        (await repository.listProviderBindings()).map(async (binding) => {
          try {
            await secrets.get(binding.secretRef);
            return binding.providerId;
          } catch {
            return undefined;
          }
        })
      )
    ).filter((providerId): providerId is string => Boolean(providerId))
  });
  if (config.nodeRoles.includes('controller')) {
    await cluster.registerLocal({
      id: config.nodeId,
      name: config.nodeName,
      roles: config.nodeRoles,
      region: config.nodeRegion,
      publicUrl: config.publicUrl,
      state: 'online',
      capabilities: await nodeCapabilities(),
      weight: 100
    });
  }
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
  if (agentController) {
    const agentListen = parseListenAddress(config.agentListenAddr);
    await agentController.start(agentListen.host, agentListen.port, config.agentTlsNames);
    app.log.info({ address: config.agentListenAddr }, 'mTLS node agent listener ready');
  }
  nodeAgent =
    !config.nodeRoles.includes('controller') &&
    config.controllerAgentUrl &&
    config.controllerEnrollmentUrl
      ? new NodeAgent({
          controllerUrl: config.controllerAgentUrl,
          enrollmentUrl: config.controllerEnrollmentUrl,
          ...(config.nodeJoinToken ? { joinToken: config.nodeJoinToken } : {}),
          nodeName: config.nodeName,
          publicUrl: config.publicUrl,
          secretStore: secrets,
          capabilities: nodeCapabilities,
          onSegment: (command, signal) => sessions.executeRemoteSegment(command, signal),
          onCancel: (jobId) => sessions.cancelJob(jobId),
          onProvider: async (operation, payload) => {
            if (operation === 'provider.bind') {
              const input = payload.input as CreateProviderRequest;
              const policy = await validateProviderUrl(input.baseUrl, input.allowPublicHttp);
              const result = await providers.createBinding(
                {
                  ...input,
                  normalizedBaseUrl: policy.normalizedUrl,
                  ...(policy.securityNotice ? { securityNotice: policy.securityNotice } : {})
                },
                String(payload.nodeId),
                String(payload.providerId),
                String(payload.bindingId)
              );
              return result;
            }
            if (operation === 'provider.unbind') {
              await providers.removeBinding(String(payload.bindingId));
              return {};
            }
            if (operation === 'provider.browse')
              return await providers.browse(
                String(payload.providerId),
                payload.query as CatalogQuery
              );
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
          }
        })
      : undefined;
  await nodeAgent?.start();
  const cleanup = setInterval(() => {
    auth.cleanup();
    void sessions
      .cleanupExpiredCache()
      .catch((error) => app.log.error({ err: error }, 'cache cleanup failed'));
  }, 60_000);
  cleanup.unref();
  const heartbeat = setInterval(() => {
    if (!config.nodeRoles.includes('controller')) return;
    void nodeCapabilities()
      .then((value) => cluster.heartbeat(config.nodeId, value, 'online'))
      .catch((error) => app.log.error({ err: error }, 'node heartbeat failed'));
  }, 15_000);
  heartbeat.unref();
  const livePoll = managesLiveIngest
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
  let shuttingDown = false;
  shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(cleanup);
    clearInterval(heartbeat);
    if (livePoll) clearInterval(livePoll);
    await live.stop();
    await managedMediaMtx?.stop();
    await nodeAgent?.stop();
    await agentController?.stop();
    await backends.close();
    await app.close();
    await repository.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  if (runtimeFailure) void shutdown();
}

await main();
