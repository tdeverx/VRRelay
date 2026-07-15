// SPDX-License-Identifier: GPL-3.0-or-later
import { resolve } from 'node:path';
import { z } from 'zod';
import { APPLICATION_VERSION, SEMANTIC_VERSION_PATTERN } from './version.js';

const duration = z.string().transform((value, context) => {
  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) {
    context.addIssue({ code: 'custom', message: 'Expected duration like 30m, 10s, or 1h' });
    return z.NEVER;
  }
  const amount = Number(match[1]);
  return amount * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
});

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

function optionalEnvironmentValue(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

const liveOriginUrl = z
  .string()
  .refine((value) => value.startsWith('rtsp://') || value.startsWith('srt://'), {
    message: 'Live origin URL must use rtsp:// or srt://'
  });

const ConfigSchema = z
  .object({
    applicationVersion: z.string().regex(SEMANTIC_VERSION_PATTERN).default(APPLICATION_VERSION),
    listenAddr: z.string().default('127.0.0.1:8099'),
    publicUrl: z.url().default('http://127.0.0.1:8099'),
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
    trustProxy: environmentBoolean.default(false),
    nodeId: z.string().default('standalone'),
    nodeName: z.string().default('VRRelay node'),
    nodeRegion: z.string().default('local'),
    nodeRoles: z
      .array(z.enum(['controller', 'source-worker', 'ingest-origin', 'edge']))
      .default(['controller', 'source-worker', 'ingest-origin', 'edge']),
    metricsToken: z.string().min(32).optional(),
    agentListenAddr: z.string().default('127.0.0.1:8100'),
    agentTlsNames: z.array(z.string().min(1)).default(['localhost']),
    controllerAgentUrl: z.url().optional(),
    controllerEnrollmentUrl: z.url().optional(),
    nodeJoinToken: z.string().min(32).optional(),
    repositoryDriver: z.enum(['sqlite', 'postgres']).default('sqlite'),
    postgresUrl: z.string().optional(),
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
  });

export type RelayConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(environment = process.env): RelayConfig {
  const root = process.cwd();
  return ConfigSchema.parse({
    applicationVersion: environment.VRRELAY_VERSION,
    listenAddr: environment.VRRELAY_LISTEN_ADDR,
    publicUrl: environment.VRRELAY_PUBLIC_URL,
    setupToken: optionalEnvironmentValue(environment.VRRELAY_SETUP_TOKEN),
    dataDir: environment.VRRELAY_DATA_DIR ? resolve(root, environment.VRRELAY_DATA_DIR) : undefined,
    cacheDir: environment.VRRELAY_CACHE_DIR
      ? resolve(root, environment.VRRELAY_CACHE_DIR)
      : undefined,
    ffmpegPath: environment.VRRELAY_FFMPEG,
    maxWorkers: environment.VRRELAY_MAX_WORKERS,
    cacheTtlMs: environment.VRRELAY_CACHE_TTL,
    cacheLimitBytes: environment.VRRELAY_CACHE_LIMIT_BYTES,
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
    trustProxy: environment.VRRELAY_TRUST_PROXY,
    nodeId: environment.VRRELAY_NODE_ID,
    nodeName: environment.VRRELAY_NODE_NAME,
    nodeRegion: environment.VRRELAY_NODE_REGION,
    nodeRoles: environment.VRRELAY_NODE_ROLES?.split(',')
      .map((role) => role.trim())
      .filter(Boolean),
    metricsToken: optionalEnvironmentValue(environment.VRRELAY_METRICS_TOKEN),
    agentListenAddr: environment.VRRELAY_AGENT_LISTEN_ADDR,
    agentTlsNames: environment.VRRELAY_AGENT_TLS_NAMES?.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    controllerAgentUrl: optionalEnvironmentValue(environment.VRRELAY_CONTROLLER_AGENT_URL),
    controllerEnrollmentUrl: optionalEnvironmentValue(
      environment.VRRELAY_CONTROLLER_ENROLLMENT_URL
    ),
    nodeJoinToken: optionalEnvironmentValue(environment.VRRELAY_NODE_JOIN_TOKEN),
    repositoryDriver: environment.VRRELAY_REPOSITORY_DRIVER,
    postgresUrl: optionalEnvironmentValue(environment.VRRELAY_POSTGRES_URL),
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
  const host = value.slice(0, index);
  const portText = value.slice(index + 1);
  if (!/^\d+$/.test(portText)) throw new Error('VRRELAY_LISTEN_ADDR port must be an integer');
  const port = Number(portText);
  if (port < 1 || port > 65_535)
    throw new Error('VRRELAY_LISTEN_ADDR port must be between 1 and 65535');
  return { host, port };
}
