// SPDX-License-Identifier: GPL-3.0-or-later
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { RuntimeConfigurationSchema, type RuntimeConfiguration } from '@vrrelay/contracts';
import { APPLICATION_VERSION, SEMANTIC_VERSION_PATTERN } from './version.js';

const duration = z.union([
  z.number().int().nonnegative(),
  z.string().transform((value, context) => {
    const match = value.match(/^(\d+)(ms|s|m|h)$/);
    if (!match) {
      context.addIssue({ code: 'custom', message: 'Expected duration like 30m, 10s, or 1h' });
      return z.NEVER;
    }
    const amount = Number(match[1]);
    return (
      amount * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h']
    );
  })
]);

const environmentBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return value;
}, z.boolean());

const optionalSrtPassphrase = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(10).max(79).optional()
);

const serviceUrl = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    context.addIssue({ code: 'custom', message: 'URL must use HTTP or HTTPS' });
  if (url.username || url.password)
    context.addIssue({ code: 'custom', message: 'URL must not contain credentials' });
  if (url.search || url.hash)
    context.addIssue({ code: 'custom', message: 'URL must not contain a query or fragment' });
});

const agentUrl = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
    context.addIssue({ code: 'custom', message: 'Agent URL must use WS or WSS' });
  if (url.username || url.password)
    context.addIssue({ code: 'custom', message: 'Agent URL must not contain credentials' });
  if (url.search || url.hash)
    context.addIssue({ code: 'custom', message: 'Agent URL must not contain a query or fragment' });
});

const trustedProxyCidr = z.string().refine(
  (value) => {
    const separator = value.lastIndexOf('/');
    if (separator <= 0) return false;
    const address = value.slice(0, separator);
    const family = isIP(address);
    const prefix = Number(value.slice(separator + 1));
    return (
      (family === 4 && Number.isInteger(prefix) && prefix >= 1 && prefix <= 32) ||
      (family === 6 && Number.isInteger(prefix) && prefix >= 1 && prefix <= 128)
    );
  },
  { message: 'Trusted proxies must be explicit IPv4 or IPv6 CIDR ranges' }
);

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === 'secret' ||
    normalized === 'password' ||
    normalized === 'token' ||
    normalized === 'default' ||
    normalized === 'changeme' ||
    normalized === 'minioadmin' ||
    normalized === 'postgres' ||
    normalized === 'vrrelay' ||
    normalized.includes('change-me') ||
    normalized.includes('development-read-token')
  );
}

function optionalEnvironmentValue(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function isFalseEnvironmentValue(value: string): boolean {
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

const liveOriginUrl = z
  .string()
  .refine((value) => value.startsWith('rtsp://') || value.startsWith('srt://'), {
    message: 'Live origin URL must use rtsp:// or srt://'
  });

const ConfigSchema = z
  .object({
    environment: z.enum(['development', 'production']).default('development'),
    applicationVersion: z.string().regex(SEMANTIC_VERSION_PATTERN).default(APPLICATION_VERSION),
    runtimeConfigPath: z.string().min(1).optional(),
    restartMode: z.enum(['none', 'exit']).default('none'),
    logLevel: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    listenAddr: z.string().default('127.0.0.1:8099'),
    publicUrl: serviceUrl.default('http://127.0.0.1:8099'),
    adminUrl: serviceUrl.default('http://127.0.0.1:8099'),
    playbackUrl: serviceUrl.default('http://127.0.0.1:8099'),
    setupToken: z.string().min(32).optional(),
    dataDir: z.string().default('.data'),
    cacheDir: z.string().default('.cache'),
    ffmpegPath: z.string().default('ffmpeg'),
    maxWorkers: z.coerce.number().int().min(1).max(32).default(2),
    cacheTtlMs: duration.default(1_800_000),
    cacheLimitBytes: z.coerce
      .number()
      .int()
      .positive()
      .default(20 * 1024 * 1024 * 1024),
    vodProducerIdleTimeoutMs: duration
      .pipe(z.number().int().min(15_000).max(600_000))
      .default(60_000),
    vodProducerBufferLowWatermarkMs: duration
      .pipe(z.number().int().min(4_000).max(300_000))
      .default(30_000),
    vodProducerBufferHighWatermarkMs: duration
      .pipe(z.number().int().min(8_000).max(600_000))
      .default(60_000),
    vodProducerMaxCatchupRate: z.coerce.number().min(1).max(2).default(2),
    videoEncoder: z
      .enum(['auto', 'software', 'videotoolbox', 'nvenc', 'qsv', 'vaapi', 'amf'])
      .default('auto'),
    vodProducerMaxConcurrent: z.coerce.number().int().min(1).max(32).default(2),
    vodProducerMaxPerProvider: z.coerce.number().int().min(1).max(32).default(2),
    liveMaxChannelsTotal: z.coerce.number().int().min(1).max(1_000).default(32),
    liveMaxChannelsPerOwner: z.coerce.number().int().min(1).max(100).default(4),
    liveNormalizerMaxConcurrent: z.coerce.number().int().min(1).max(32).default(2),
    liveNormalizerMaxPerOwner: z.coerce.number().int().min(1).max(32).default(1),
    masterKey: z.string().optional(),
    secretBackend: z.enum(['auto', 'keychain', 'dpapi', 'encrypted-file']).default('auto'),
    mediaMtxHlsUrl: z.url().default('http://127.0.0.1:8888'),
    mediaMtxRtmpUrl: z.string().default('rtmp://127.0.0.1:1935'),
    mediaMtxSrtUrl: z.string().default('srt://127.0.0.1:8890'),
    mediaMtxWhipUrl: z.url().default('http://127.0.0.1:8889'),
    mediaMtxRtspUrl: z.url().default('rtsp://127.0.0.1:8554'),
    mediaMtxApiUrl: z.url().default('http://127.0.0.1:9997'),
    mediaMtxExecutable: z.string().min(1).optional(),
    mediaMtxConfig: z.string().min(1).optional(),
    liveOriginUrl: liveOriginUrl.optional(),
    liveOriginSrtPassphrase: optionalSrtPassphrase,
    backupRtmpUrl: z.string().optional(),
    backupSrtUrl: z.string().optional(),
    mediaMtxAllowInternalRead: environmentBoolean.default(false),
    mediaMtxReadToken: z.string().min(16).default('development-read-token-change-me'),
    trustedProxyCidrs: z.array(trustedProxyCidr).default([]),
    viewerRegionHeader: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .default('x-vrrelay-region'),
    nodeId: z.string().default('standalone'),
    nodeName: z.string().default('VRRelay node'),
    nodeRegion: z.string().default('local'),
    nodeRoles: z
      .array(z.enum(['controller', 'source-worker', 'ingest-origin', 'edge']))
      .default(['controller', 'source-worker', 'ingest-origin', 'edge']),
    metricsToken: z.string().min(32).optional(),
    agentListenAddr: z.string().default('127.0.0.1:8100'),
    agentTlsNames: z.array(z.string().min(1)).default(['localhost']),
    controllerAgentUrl: agentUrl.optional(),
    controllerEnrollmentUrl: serviceUrl.optional(),
    nodeJoinToken: z.string().min(32).optional(),
    agentLogRetentionRows: z.coerce.number().int().min(100).max(50_000).default(1000),
    agentLogQueryLimit: z.coerce.number().int().min(1).max(1000).default(200),
    jobLogRetentionRows: z.coerce.number().int().min(100).max(50_000).default(1000),
    jobLogQueryLimit: z.coerce.number().int().min(1).max(1000).default(200),
    repositoryDriver: z.enum(['sqlite', 'postgres']).default('sqlite'),
    postgresUrl: z.string().optional(),
    pgDumpPath: z.string().min(1).default('pg_dump'),
    pgDumpTimeoutMs: duration.default(30 * 60_000),
    coordinationDriver: z.enum(['memory', 'valkey']).default('memory'),
    valkeyUrl: z.string().optional(),
    objectStoreDriver: z.enum(['local', 's3', 'azure-blob', 'gcs']).default('local'),
    objectStorePath: z.string().optional(),
    objectStoreBucket: z.string().optional(),
    objectStorePrefix: z.string().default('vrrelay'),
    s3Endpoint: z.url().optional(),
    s3Region: z.string().default('us-east-1'),
    s3AccessKeyId: z.string().optional(),
    s3SecretAccessKey: z.string().optional(),
    azureAccountUrl: z.url().optional(),
    azureAccountName: z.string().optional(),
    azureAccountKey: z.string().optional(),
    gcsProjectId: z.string().optional(),
    gcsKeyFilename: z.string().optional()
  })
  .superRefine((value, context) => {
    if (Boolean(value.mediaMtxExecutable) !== Boolean(value.mediaMtxConfig))
      context.addIssue({
        code: 'custom',
        path: ['mediaMtxExecutable'],
        message:
          'VRRELAY_MEDIAMTX_EXECUTABLE and VRRELAY_MEDIAMTX_CONFIG must be configured together'
      });

    if (value.vodProducerBufferLowWatermarkMs >= value.vodProducerBufferHighWatermarkMs)
      context.addIssue({
        code: 'custom',
        path: ['vodProducerBufferHighWatermarkMs'],
        message: 'VOD producer high watermark must be greater than the low watermark'
      });

    if (value.liveNormalizerMaxPerOwner > value.liveNormalizerMaxConcurrent)
      context.addIssue({
        code: 'custom',
        path: ['liveNormalizerMaxPerOwner'],
        message: 'Per-owner live normalizer capacity cannot exceed global capacity'
      });

    if (value.environment !== 'production') return;

    for (const [field, url] of [
      ['publicUrl', value.publicUrl],
      ['adminUrl', value.adminUrl],
      ['playbackUrl', value.playbackUrl]
    ] as const) {
      if (new URL(url).protocol !== 'https:')
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Production public, administration, and playback URLs must use HTTPS'
        });
    }
    if (value.trustedProxyCidrs.length === 0)
      context.addIssue({
        code: 'custom',
        path: ['trustedProxyCidrs'],
        message: 'Production requires at least one explicit trusted-proxy CIDR'
      });

    const dedicatedDataPlane = !value.nodeRoles.includes('controller');
    if (dedicatedDataPlane && !value.controllerEnrollmentUrl)
      context.addIssue({
        code: 'custom',
        path: ['controllerEnrollmentUrl'],
        message: 'Production data-plane nodes require an HTTPS controller enrollment URL'
      });
    if (dedicatedDataPlane && !value.controllerAgentUrl)
      context.addIssue({
        code: 'custom',
        path: ['controllerAgentUrl'],
        message: 'Production data-plane nodes require a WSS controller agent URL'
      });
    if (
      value.controllerEnrollmentUrl &&
      new URL(value.controllerEnrollmentUrl).protocol !== 'https:'
    )
      context.addIssue({
        code: 'custom',
        path: ['controllerEnrollmentUrl'],
        message: 'Production enrollment must use HTTPS'
      });
    if (value.controllerAgentUrl && new URL(value.controllerAgentUrl).protocol !== 'wss:')
      context.addIssue({
        code: 'custom',
        path: ['controllerAgentUrl'],
        message: 'Production agent transport must use WSS'
      });

    const secrets = [
      ['setupToken', value.setupToken],
      ['masterKey', value.masterKey],
      ['liveOriginSrtPassphrase', value.liveOriginSrtPassphrase],
      ['mediaMtxReadToken', value.mediaMtxReadToken],
      ['metricsToken', value.metricsToken],
      ['nodeJoinToken', value.nodeJoinToken],
      ['s3AccessKeyId', value.s3AccessKeyId],
      ['s3SecretAccessKey', value.s3SecretAccessKey],
      ['azureAccountKey', value.azureAccountKey]
    ] as const;
    for (const [field, secret] of secrets) {
      if (secret && isPlaceholderSecret(secret))
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Production secrets must not use a default or placeholder value'
        });
    }
    for (const [field, connectionUrl] of [
      ['postgresUrl', value.postgresUrl],
      ['valkeyUrl', value.valkeyUrl]
    ] as const) {
      if (!connectionUrl) continue;
      try {
        const password = decodeURIComponent(new URL(connectionUrl).password);
        if (password && isPlaceholderSecret(password))
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Production connection URLs must not use default or placeholder passwords'
          });
      } catch {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Production connection URL is invalid'
        });
      }
    }
    if (value.mediaMtxReadToken.length < 32)
      context.addIssue({
        code: 'custom',
        path: ['mediaMtxReadToken'],
        message: 'Production MediaMTX read tokens must contain at least 32 characters'
      });
  });

export type RelayConfig = z.infer<typeof ConfigSchema>;

export function validateRuntimeConfiguration(
  current: RelayConfig,
  input: RuntimeConfiguration
): RuntimeConfiguration {
  const runtime = RuntimeConfigurationSchema.parse(input);
  const listener = parseListenAddress(runtime.listenAddr);
  if (!isLoopbackRuntimeHost(listener.host) && isIP(listener.host) === 0)
    throw new Error(
      'Dashboard/API listener host must be localhost or a literal IPv4 or IPv6 address'
    );
  parseListenAddress(runtime.agentListenAddr);
  ConfigSchema.parse({ ...current, ...runtime });
  return runtime;
}

function isLoopbackRuntimeHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    (isIP(normalized) === 4 && normalized.startsWith('127.'))
  );
}

function readRuntimeConfiguration(path: string | undefined): RuntimeConfiguration | undefined {
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // Keep an existing runtime file effective while moving the dashboard label
    // from an opaque aggressiveness value to a per-stream maximum.
    if (
      parsed.vodProducerMaxCatchupRate === undefined &&
      parsed.vodProducerCatchupRate !== undefined
    )
      parsed.vodProducerMaxCatchupRate = parsed.vodProducerCatchupRate;
    return RuntimeConfigurationSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      `VRRELAY_RUNTIME_CONFIG could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

export function loadConfig(environment = process.env): RelayConfig {
  if (
    environment.VRRELAY_TRUST_PROXY !== undefined &&
    !isFalseEnvironmentValue(environment.VRRELAY_TRUST_PROXY)
  )
    throw new Error(
      'VRRELAY_TRUST_PROXY no longer enables proxy trust; remove it and configure explicit VRRELAY_TRUSTED_PROXY_CIDRS instead'
    );
  const root = process.cwd();
  const runtimeConfigPath = optionalEnvironmentValue(environment.VRRELAY_RUNTIME_CONFIG);
  const runtime = readRuntimeConfiguration(runtimeConfigPath);
  const publicUrl = environment.VRRELAY_PUBLIC_URL ?? runtime?.publicUrl;
  return ConfigSchema.parse({
    environment: environment.VRRELAY_ENVIRONMENT,
    applicationVersion: environment.VRRELAY_VERSION,
    runtimeConfigPath,
    restartMode: environment.VRRELAY_RESTART_MODE,
    logLevel: environment.VRRELAY_LOG_LEVEL ?? runtime?.logLevel,
    listenAddr: environment.VRRELAY_LISTEN_ADDR ?? runtime?.listenAddr,
    publicUrl,
    adminUrl:
      optionalEnvironmentValue(environment.VRRELAY_ADMIN_URL) ?? runtime?.adminUrl ?? publicUrl,
    playbackUrl:
      optionalEnvironmentValue(environment.VRRELAY_PLAYBACK_URL) ??
      runtime?.playbackUrl ??
      publicUrl,
    setupToken: optionalEnvironmentValue(environment.VRRELAY_SETUP_TOKEN),
    dataDir: environment.VRRELAY_DATA_DIR ? resolve(root, environment.VRRELAY_DATA_DIR) : undefined,
    cacheDir: environment.VRRELAY_CACHE_DIR
      ? resolve(root, environment.VRRELAY_CACHE_DIR)
      : undefined,
    ffmpegPath: environment.VRRELAY_FFMPEG,
    maxWorkers: environment.VRRELAY_MAX_WORKERS ?? runtime?.maxWorkers,
    cacheTtlMs: environment.VRRELAY_CACHE_TTL ?? runtime?.cacheTtlMs,
    cacheLimitBytes: environment.VRRELAY_CACHE_LIMIT_BYTES ?? runtime?.cacheLimitBytes,
    vodProducerIdleTimeoutMs:
      environment.VRRELAY_VOD_PRODUCER_IDLE_TIMEOUT ?? runtime?.vodProducerIdleTimeoutMs,
    vodProducerBufferLowWatermarkMs:
      environment.VRRELAY_VOD_PRODUCER_BUFFER_LOW_WATERMARK ??
      runtime?.vodProducerBufferLowWatermarkMs,
    vodProducerBufferHighWatermarkMs:
      environment.VRRELAY_VOD_PRODUCER_BUFFER_HIGH_WATERMARK ??
      runtime?.vodProducerBufferHighWatermarkMs,
    vodProducerMaxCatchupRate:
      environment.VRRELAY_VOD_PRODUCER_MAX_CATCHUP_RATE ??
      environment.VRRELAY_VOD_PRODUCER_CATCHUP_RATE ??
      runtime?.vodProducerMaxCatchupRate,
    videoEncoder: environment.VRRELAY_VIDEO_ENCODER ?? runtime?.videoEncoder,
    vodProducerMaxConcurrent:
      environment.VRRELAY_VOD_PRODUCER_MAX_CONCURRENT ?? runtime?.vodProducerMaxConcurrent,
    vodProducerMaxPerProvider:
      environment.VRRELAY_VOD_PRODUCER_MAX_PER_PROVIDER ?? runtime?.vodProducerMaxPerProvider,
    liveMaxChannelsTotal:
      environment.VRRELAY_LIVE_MAX_CHANNELS_TOTAL ?? runtime?.liveMaxChannelsTotal,
    liveMaxChannelsPerOwner:
      environment.VRRELAY_LIVE_MAX_CHANNELS_PER_OWNER ?? runtime?.liveMaxChannelsPerOwner,
    liveNormalizerMaxConcurrent:
      environment.VRRELAY_LIVE_NORMALIZER_MAX_CONCURRENT ?? runtime?.liveNormalizerMaxConcurrent,
    liveNormalizerMaxPerOwner:
      environment.VRRELAY_LIVE_NORMALIZER_MAX_PER_OWNER ?? runtime?.liveNormalizerMaxPerOwner,
    masterKey: optionalEnvironmentValue(environment.VRRELAY_MASTER_KEY),
    secretBackend: environment.VRRELAY_SECRET_BACKEND,
    mediaMtxHlsUrl: environment.VRRELAY_MEDIAMTX_HLS_URL,
    mediaMtxRtmpUrl: environment.VRRELAY_MEDIAMTX_RTMP_URL,
    mediaMtxSrtUrl: environment.VRRELAY_MEDIAMTX_SRT_URL,
    mediaMtxWhipUrl: environment.VRRELAY_MEDIAMTX_WHIP_URL,
    mediaMtxRtspUrl: environment.VRRELAY_MEDIAMTX_RTSP_URL,
    mediaMtxApiUrl: environment.VRRELAY_MEDIAMTX_API_URL,
    mediaMtxExecutable: optionalEnvironmentValue(environment.VRRELAY_MEDIAMTX_EXECUTABLE),
    mediaMtxConfig: optionalEnvironmentValue(environment.VRRELAY_MEDIAMTX_CONFIG),
    liveOriginUrl: optionalEnvironmentValue(environment.VRRELAY_LIVE_ORIGIN_URL),
    liveOriginSrtPassphrase: optionalEnvironmentValue(environment.VRRELAY_LIVE_SRT_PASSPHRASE),
    backupRtmpUrl: optionalEnvironmentValue(environment.VRRELAY_BACKUP_RTMP_URL),
    backupSrtUrl: optionalEnvironmentValue(environment.VRRELAY_BACKUP_SRT_URL),
    mediaMtxAllowInternalRead: environment.VRRELAY_MEDIAMTX_ALLOW_INTERNAL_READ,
    mediaMtxReadToken: optionalEnvironmentValue(environment.VRRELAY_MEDIAMTX_READ_TOKEN),
    trustedProxyCidrs:
      environment.VRRELAY_TRUSTED_PROXY_CIDRS?.split(',')
        .map((value) => value.trim())
        .filter(Boolean) ?? runtime?.trustedProxyCidrs,
    viewerRegionHeader:
      optionalEnvironmentValue(environment.VRRELAY_VIEWER_REGION_HEADER) ??
      runtime?.viewerRegionHeader,
    nodeId: environment.VRRELAY_NODE_ID,
    nodeName: environment.VRRELAY_NODE_NAME ?? runtime?.nodeName,
    nodeRegion: environment.VRRELAY_NODE_REGION ?? runtime?.nodeRegion,
    nodeRoles: environment.VRRELAY_NODE_ROLES?.split(',')
      .map((role) => role.trim())
      .filter(Boolean),
    metricsToken: optionalEnvironmentValue(environment.VRRELAY_METRICS_TOKEN),
    agentListenAddr: environment.VRRELAY_AGENT_LISTEN_ADDR ?? runtime?.agentListenAddr,
    agentTlsNames: environment.VRRELAY_AGENT_TLS_NAMES?.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    controllerAgentUrl: optionalEnvironmentValue(environment.VRRELAY_CONTROLLER_AGENT_URL),
    controllerEnrollmentUrl: optionalEnvironmentValue(
      environment.VRRELAY_CONTROLLER_ENROLLMENT_URL
    ),
    nodeJoinToken: optionalEnvironmentValue(environment.VRRELAY_NODE_JOIN_TOKEN),
    agentLogRetentionRows:
      environment.VRRELAY_AGENT_LOG_RETENTION_ROWS ?? runtime?.agentLogRetentionRows,
    agentLogQueryLimit: environment.VRRELAY_AGENT_LOG_QUERY_LIMIT ?? runtime?.agentLogQueryLimit,
    jobLogRetentionRows: environment.VRRELAY_JOB_LOG_RETENTION_ROWS ?? runtime?.jobLogRetentionRows,
    jobLogQueryLimit: environment.VRRELAY_JOB_LOG_QUERY_LIMIT ?? runtime?.jobLogQueryLimit,
    repositoryDriver: environment.VRRELAY_REPOSITORY_DRIVER,
    postgresUrl: optionalEnvironmentValue(environment.VRRELAY_POSTGRES_URL),
    pgDumpPath: optionalEnvironmentValue(environment.VRRELAY_PG_DUMP),
    pgDumpTimeoutMs: environment.VRRELAY_PG_DUMP_TIMEOUT,
    coordinationDriver: environment.VRRELAY_COORDINATION_DRIVER,
    valkeyUrl: optionalEnvironmentValue(environment.VRRELAY_VALKEY_URL),
    objectStoreDriver: environment.VRRELAY_OBJECT_STORE_DRIVER,
    objectStorePath: environment.VRRELAY_OBJECT_STORE_PATH
      ? resolve(root, environment.VRRELAY_OBJECT_STORE_PATH)
      : undefined,
    objectStoreBucket: optionalEnvironmentValue(environment.VRRELAY_OBJECT_STORE_BUCKET),
    objectStorePrefix: environment.VRRELAY_OBJECT_STORE_PREFIX,
    s3Endpoint: optionalEnvironmentValue(environment.VRRELAY_S3_ENDPOINT),
    s3Region: environment.VRRELAY_S3_REGION,
    s3AccessKeyId: optionalEnvironmentValue(environment.VRRELAY_S3_ACCESS_KEY_ID),
    s3SecretAccessKey: optionalEnvironmentValue(environment.VRRELAY_S3_SECRET_ACCESS_KEY),
    azureAccountUrl: optionalEnvironmentValue(environment.VRRELAY_AZURE_ACCOUNT_URL),
    azureAccountName: optionalEnvironmentValue(environment.VRRELAY_AZURE_ACCOUNT_NAME),
    azureAccountKey: optionalEnvironmentValue(environment.VRRELAY_AZURE_ACCOUNT_KEY),
    gcsProjectId: optionalEnvironmentValue(environment.VRRELAY_GCS_PROJECT_ID),
    gcsKeyFilename: optionalEnvironmentValue(environment.VRRELAY_GCS_KEY_FILENAME)
  });
}

export function requiresSetupToken(publicUrl: string): boolean {
  const hostname = new URL(publicUrl).hostname.toLowerCase();
  return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

export function parseListenAddress(value: string): { host: string; port: number } {
  const index = value.lastIndexOf(':');
  if (index <= 0) throw new Error('VRRELAY_LISTEN_ADDR must be host:port');
  const rawHost = value.slice(0, index);
  const hasOpeningBracket = rawHost.startsWith('[');
  const hasClosingBracket = rawHost.endsWith(']');
  if (hasOpeningBracket !== hasClosingBracket)
    throw new Error('VRRELAY_LISTEN_ADDR has invalid IPv6 brackets');
  const host = hasOpeningBracket ? rawHost.slice(1, -1) : rawHost;
  if (!host) throw new Error('VRRELAY_LISTEN_ADDR host must not be empty');
  if (hasOpeningBracket && isIP(host) !== 6)
    throw new Error('VRRELAY_LISTEN_ADDR brackets may only contain an IPv6 address');
  const portText = value.slice(index + 1);
  if (!/^\d+$/.test(portText)) throw new Error('VRRELAY_LISTEN_ADDR port must be an integer');
  const port = Number(portText);
  if (port < 1 || port > 65_535)
    throw new Error('VRRELAY_LISTEN_ADDR port must be between 1 and 65535');
  return { host, port };
}
