// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

export const ProviderTypeSchema = z.enum(['jellyfin', 'fake']);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const AuthenticationModeSchema = z.enum(['user_token', 'api_key']);
export type AuthenticationMode = z.infer<typeof AuthenticationModeSchema>;

export const UNSAFE_PUBLIC_HTTP_SECURITY_NOTICE = 'Unsafe public HTTP transport is enabled.';

export const ProviderCapabilitySchema = z.enum([
  'search',
  'hierarchy',
  'multiple_versions',
  'activity_reporting',
  'artwork',
  'external_subtitles',
  'direct_source'
]);
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export const ProviderConnectionSchema = z.object({
  id: z.string().min(1),
  type: ProviderTypeSchema,
  name: z.string().min(1).max(100),
  baseUrl: z.url().refine((value) => value.startsWith('http://') || value.startsWith('https://')),
  authMode: AuthenticationModeSchema,
  secretRef: z.string().min(1),
  userId: z.string().optional(),
  username: z.string().optional(),
  serverName: z.string().optional(),
  serverVersion: z.string().optional(),
  capabilities: z.array(ProviderCapabilitySchema),
  healthy: z.boolean(),
  allowPublicHttp: z.boolean().optional(),
  securityNotice: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;
export type PublicProviderConnection = Omit<ProviderConnection, 'secretRef' | 'allowPublicHttp'>;

export function providerAllowsPublicHttp(
  provider: Pick<ProviderConnection, 'allowPublicHttp' | 'securityNotice'>
): boolean {
  return provider.allowPublicHttp ?? provider.securityNotice === UNSAFE_PUBLIC_HTTP_SECURITY_NOTICE;
}

export const MediaSourceRefSchema = z.object({
  providerId: z.string().min(1),
  itemId: z.string().min(1),
  versionId: z.string().optional(),
  sourceFingerprint: z.string().optional(),
  audioTrackId: z.string().optional(),
  subtitleTrackId: z.string().optional()
});
export type MediaSourceRef = z.infer<typeof MediaSourceRefSchema>;

export const MediaVersionSchema = z.object({
  id: z.string(),
  name: z.string(),
  container: z.string().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  bitrate: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  fingerprint: z.string().optional()
});
export type MediaVersion = z.infer<typeof MediaVersionSchema>;

export const MediaTrackSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  kind: z.enum(['audio', 'subtitle']),
  title: z.string(),
  language: z.string().optional(),
  codec: z.string().optional(),
  channels: z.number().int().nonnegative().optional(),
  external: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  isForced: z.boolean().optional()
});
export type MediaTrack = z.infer<typeof MediaTrackSchema>;

export const MediaItemSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  name: z.string(),
  kind: z.string(),
  overview: z.string().optional(),
  productionYear: z.number().int().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  imageUrl: z.string().optional(),
  parentId: z.string().optional(),
  collectionType: z.string().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  hdr: z.string().optional(),
  versions: z.array(MediaVersionSchema).optional(),
  audioTracks: z.array(MediaTrackSchema).optional(),
  subtitleTracks: z.array(MediaTrackSchema).optional()
});
export type MediaItem = z.infer<typeof MediaItemSchema>;

export const PlatformModeSchema = z.enum(['universal', 'pc', 'quest', 'dual']);
export type PlatformMode = z.infer<typeof PlatformModeSchema>;

export const CompatibilityStateSchema = z.enum(['experimental', 'verified', 'broken', 'retired']);
export type CompatibilityState = z.infer<typeof CompatibilityStateSchema>;

export const VideoSettingsSchema = z.object({
  codec: z.enum(['h264', 'h265', 'av1', 'copy']),
  encoder: z.string().min(1),
  hardwareMode: z.enum(['auto', 'software', 'videotoolbox', 'qsv', 'vaapi', 'nvenc', 'amf']),
  decodeMode: z
    .enum(['auto', 'software', 'videotoolbox', 'd3d11va', 'qsv', 'vaapi', 'cuda'])
    .default('auto'),
  profile: z.string().optional(),
  level: z.string().optional(),
  pixelFormat: z.string().min(1),
  width: z.number().int().min(16).max(7680),
  height: z.number().int().min(16).max(4320),
  frameRate: z.number().int().min(1).max(120),
  bitrateKbps: z.number().int().min(64).max(100_000),
  maxrateKbps: z.number().int().min(64).max(120_000),
  bufferKbps: z.number().int().min(64).max(240_000),
  quality: z.number().int().min(0).max(63).optional(),
  preset: z.string().optional(),
  tune: z.string().optional(),
  gop: z.number().int().min(1).max(600),
  bFrames: z.number().int().min(0).max(16)
});
export type VideoSettings = z.infer<typeof VideoSettingsSchema>;

export const AudioSettingsSchema = z.object({
  codec: z.enum(['aac', 'opus', 'ac3', 'copy']),
  channels: z.number().int().min(1).max(8),
  layout: z.string().min(1),
  sampleRate: z.number().int().min(8_000).max(192_000),
  bitrateKbps: z.number().int().min(32).max(1_536)
});
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;

export const DeliverySettingsSchema = z.object({
  method: z.enum(['hls', 'fragmented_mp4', 'rtsp', 'mpegts_http']),
  container: z.enum(['mpegts', 'fmp4', 'mp4']),
  segmentType: z.enum(['mpegts', 'fmp4', 'none']),
  segmentDuration: z.number().min(1).max(30),
  playlistType: z.enum(['vod', 'event', 'live']),
  latencyMode: z.enum(['standard', 'low'])
});
export type DeliverySettings = z.infer<typeof DeliverySettingsSchema>;

export const ProcessingSettingsSchema = z.object({
  toneMap: z.boolean(),
  burnSubtitles: z.boolean(),
  passthrough: z.enum(['never', 'compatible', 'always']),
  maxWorkers: z.number().int().min(1).max(32)
});
export type ProcessingSettings = z.infer<typeof ProcessingSettingsSchema>;

export const ProfileRevisionSchema = z.object({
  profileId: z.string().min(1),
  revision: z.number().int().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  platform: PlatformModeSchema,
  state: CompatibilityStateSchema,
  video: VideoSettingsSchema,
  audio: AudioSettingsSchema,
  delivery: DeliverySettingsSchema,
  processing: ProcessingSettingsSchema,
  disabledReason: z.string().optional(),
  createdAt: z.iso.datetime()
});
export type ProfileRevision = z.infer<typeof ProfileRevisionSchema>;

export const SessionKindSchema = z.enum(['vod', 'live']);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const PlacementPolicySchema = z.enum(['local', 'hosted', 'auto']);
export type PlacementPolicy = z.infer<typeof PlacementPolicySchema>;

export const SessionStateSchema = z.enum([
  'idle',
  'queued',
  'starting',
  'active',
  'live',
  'error',
  'stopped'
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const RelaySessionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(160),
    kind: SessionKindSchema,
    source: MediaSourceRefSchema.optional(),
    liveChannelId: z.string().optional(),
    profileId: z.string(),
    profileRevision: z.number().int().min(1),
    platformMode: PlatformModeSchema,
    state: SessionStateSchema,
    durationSeconds: z.number().positive().optional(),
    pinned: z.boolean(),
    reportActivity: z.boolean(),
    viewers: z.number().int().nonnegative(),
    placementPolicy: PlacementPolicySchema.default('local'),
    assignedNodeId: z.string().optional(),
    placementLocked: z.boolean().default(false),
    preferredRegion: z.string().optional(),
    outputUrls: z.record(z.string(), z.url()),
    errorMessage: z.string().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime()
  })
  .superRefine((value, context) => {
    if (value.kind === 'vod' && (!value.source || !value.durationSeconds)) {
      context.addIssue({ code: 'custom', message: 'VOD sessions require a source and duration' });
    }
    if (value.kind === 'live' && !value.liveChannelId) {
      context.addIssue({ code: 'custom', message: 'Live sessions require a channel' });
    }
  });
export type RelaySession = z.infer<typeof RelaySessionSchema>;

export const PlaybackGrantSchema = z.object({
  tokenHash: z.string(),
  sessionId: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime()
});
export type PlaybackGrant = z.infer<typeof PlaybackGrantSchema>;

export const LiveChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  ingestPath: z.string().optional(),
  originNodeId: z.string().optional(),
  region: z.string().optional(),
  normalizationProfileId: z.string().optional(),
  normalizationProfileRevision: z.number().int().min(1).optional(),
  normalize: z.boolean().default(true),
  publisherState: z.enum(['offline', 'online', 'reconnecting', 'error']).default('offline'),
  publisherUpdatedAt: z.iso.datetime().optional(),
  publishTokenHash: z.string(),
  replacementPublishTokenHash: z.string().optional(),
  publisherReplacementRequestedAt: z.iso.datetime().optional(),
  rtmpUrl: z.url(),
  srtUrl: z.url(),
  whipUrl: z.url(),
  backupRtmpUrl: z.url().optional(),
  backupSrtUrl: z.url().optional(),
  createdAt: z.iso.datetime()
});
export type LiveChannel = z.infer<typeof LiveChannelSchema>;
export const PublicLiveChannelSchema = LiveChannelSchema.omit({
  publishTokenHash: true,
  replacementPublishTokenHash: true
});
export type PublicLiveChannel = z.infer<typeof PublicLiveChannelSchema>;

export function publicLiveChannel(channel: LiveChannel): PublicLiveChannel {
  const { publishTokenHash: _publishTokenHash, ...safe } = channel;
  return safe;
}

export const CompatibilityResultSchema = z.object({
  id: z.string(),
  applicationVersion: z.string(),
  platform: z.enum(['pc', 'quest']),
  player: z.string(),
  profileId: z.string(),
  profileRevision: z.number().int().min(1),
  state: CompatibilityStateSchema,
  startup: z.boolean(),
  duration: z.boolean(),
  pause: z.boolean(),
  forwardSeek: z.boolean(),
  backwardSeek: z.boolean(),
  lateJoin: z.boolean(),
  completion: z.boolean(),
  audio: z.boolean(),
  video: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  notes: z.string().max(2_000).optional(),
  testedAt: z.iso.datetime()
});
export type CompatibilityResult = z.infer<typeof CompatibilityResultSchema>;

export const NodeRoleSchema = z.enum(['controller', 'source-worker', 'ingest-origin', 'edge']);
export type NodeRole = z.infer<typeof NodeRoleSchema>;

export const HttpUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    context.addIssue({ code: 'custom', message: 'URL must use HTTP or HTTPS' });
  if (url.username || url.password)
    context.addIssue({ code: 'custom', message: 'URL must not contain credentials' });
  if (url.search || url.hash)
    context.addIssue({ code: 'custom', message: 'URL must not contain a query or fragment' });
});

export const NodeStateSchema = z.enum([
  'joining',
  'online',
  'degraded',
  'draining',
  'offline',
  'revoked'
]);
export type NodeState = z.infer<typeof NodeStateSchema>;

export const NodeCapabilitySchema = z.object({
  encoders: z.array(z.string()),
  hardwareDevices: z.array(z.string()),
  maxWorkers: z.number().int().min(0),
  activeWorkers: z.number().int().min(0),
  queuedWorkers: z.number().int().min(0),
  cacheBytes: z.number().int().min(0),
  cacheLimitBytes: z.number().int().min(0).nullable(),
  egressMbps: z.number().min(0),
  providerIds: z.array(z.string())
});
export type NodeCapability = z.infer<typeof NodeCapabilitySchema>;

export const ClusterNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  roles: z.array(NodeRoleSchema).min(1),
  region: z.string().min(1).max(80),
  publicUrl: HttpUrlSchema,
  internalUrl: HttpUrlSchema.optional(),
  state: NodeStateSchema,
  capabilities: NodeCapabilitySchema,
  weight: z.number().int().min(1).max(100).default(100),
  certificateExpiresAt: z.iso.datetime().optional(),
  lastHeartbeatAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});
export type ClusterNode = z.infer<typeof ClusterNodeSchema>;

export const ProviderBindingSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  nodeId: z.string(),
  secretRef: z.string(),
  reachable: z.boolean(),
  state: z.enum(['pending', 'healthy', 'degraded', 'revoked']).default('pending'),
  deletionPending: z.boolean().default(false),
  lastError: z.string().max(500).optional(),
  validatedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>;
export const PublicProviderBindingSchema = ProviderBindingSchema.omit({ secretRef: true });
export type PublicProviderBinding = z.infer<typeof PublicProviderBindingSchema>;

export const NodeCertificateStateSchema = z.object({
  nodeId: z.string(),
  serialNumber: z.string(),
  fingerprintSha256: z.string(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime()
});
export type NodeCertificateState = z.infer<typeof NodeCertificateStateSchema>;

export const SegmentJobStateSchema = z.enum([
  'queued',
  'leased',
  'running',
  'complete',
  'failed',
  'cancelled'
]);
export const SegmentJobAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  nodeId: z.string(),
  state: z.enum(['running', 'complete', 'failed', 'cancelled']),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  errorMessage: z.string().optional()
});
export type SegmentJobAttempt = z.infer<typeof SegmentJobAttemptSchema>;
export const SegmentJobSchema = z.object({
  id: z.string(),
  contentKey: z.string(),
  sessionId: z.string(),
  segmentIndex: z.number().int().nonnegative(),
  state: SegmentJobStateSchema,
  attempts: z.number().int().min(0).default(0),
  ownerNodeId: z.string().optional(),
  leaseExpiresAt: z.iso.datetime().optional(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  errorMessage: z.string().optional(),
  workerHistory: z.array(SegmentJobAttemptSchema).default([]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});
export type SegmentJob = z.infer<typeof SegmentJobSchema>;

export const AgentLogEntrySchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().max(2_000),
  context: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.iso.datetime()
});
export type AgentLogEntry = z.infer<typeof AgentLogEntrySchema>;

export const AuditCategorySchema = z.enum([
  'authentication',
  'authorization',
  'cluster',
  'provider',
  'backend',
  'session',
  'token',
  'system'
]);
export type AuditCategory = z.infer<typeof AuditCategorySchema>;

export const AuditActorSchema = z.object({
  type: z.enum(['administrator', 'token', 'node', 'system']),
  id: z.string().min(1).max(200).optional()
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditTargetSchema = z.object({
  type: z.string().min(1).max(100),
  id: z.string().min(1).max(200).optional()
});
export type AuditTarget = z.infer<typeof AuditTargetSchema>;

const AuditContextValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const AuditEventSchema = z.object({
  id: z.string().min(1),
  operationId: z.string().uuid(),
  category: AuditCategorySchema,
  action: z.string().min(1).max(160),
  outcome: z.enum(['attempt', 'success', 'denied', 'failure']),
  actor: AuditActorSchema,
  target: AuditTargetSchema.optional(),
  message: z.string().max(500).optional(),
  context: z.record(z.string(), AuditContextValueSchema).default({}),
  occurredAt: z.iso.datetime()
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const CachedObjectSchema = z.object({
  key: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  etag: z.string().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  lastAccessedAt: z.iso.datetime()
});
export type CachedObject = z.infer<typeof CachedObjectSchema>;

export const EdgeRouteSchema = z.object({
  sessionId: z.string(),
  nodeId: z.string(),
  publicUrl: HttpUrlSchema,
  reason: z.string(),
  expiresAt: z.iso.datetime()
});
export type EdgeRoute = z.infer<typeof EdgeRouteSchema>;

export const BackendKindSchema = z.enum([
  'local',
  's3',
  'azure-blob',
  'gcs',
  'postgres',
  'valkey',
  'builtin',
  'webhook',
  'sqlite',
  'keychain',
  'dpapi',
  'encrypted-file',
  'prometheus'
]);
export type BackendKind = z.infer<typeof BackendKindSchema>;

export const BackendStatusSchema = z.object({
  category: z.enum(['object-store', 'coordination', 'repository', 'routing', 'secrets', 'metrics']),
  kind: BackendKindSchema,
  healthy: z.boolean(),
  message: z.string().optional(),
  checkedAt: z.iso.datetime(),
  restartRequired: z.boolean().optional()
});
export type BackendStatus = z.infer<typeof BackendStatusSchema>;

export const ScopeSchema = z.enum([
  'catalog:read',
  'sessions:create',
  'sessions:read',
  'sessions:control',
  'admin'
]);
export type Scope = z.infer<typeof ScopeSchema>;

export const PersonalAccessTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenHash: z.string(),
  scopes: z.array(ScopeSchema),
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime()
});
export type PersonalAccessToken = z.infer<typeof PersonalAccessTokenSchema>;

export function publicProvider(provider: ProviderConnection): PublicProviderConnection {
  const { secretRef: _secretRef, allowPublicHttp: _allowPublicHttp, ...safe } = provider;
  return safe;
}

export function publicProviderBinding(binding: ProviderBinding): PublicProviderBinding {
  const { secretRef: _secretRef, ...safe } = binding;
  return { ...safe, deletionPending: binding.deletionPending === true };
}
