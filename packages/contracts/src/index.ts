// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';
import {
  AuthenticationModeSchema,
  CompatibilityResultSchema,
  MediaSourceRefSchema,
  PlatformModeSchema,
  ProcessingSettingsSchema,
  VideoSettingsSchema,
  AudioSettingsSchema,
  DeliverySettingsSchema,
  ScopeSchema,
  NodeRoleSchema,
  NodeCapabilitySchema,
  HttpUrlSchema,
  PlacementPolicySchema,
  UserRoleSchema
} from '@vrrelay/domain';
import { AgentEnvelopeSchema } from './agent-protocol.js';

export * from './agent-protocol.js';

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const CreateProviderRequestSchema = z
  .object({
    type: z.literal('jellyfin'),
    name: z.string().min(1).max(100),
    baseUrl: z.url(),
    authMode: AuthenticationModeSchema,
    username: z.string().optional(),
    password: z.string().optional(),
    apiKey: z.string().optional(),
    allowPublicHttp: z.boolean().default(false)
  })
  .superRefine((value, context) => {
    if (value.authMode === 'user_token' && (!value.username || !value.password)) {
      context.addIssue({ code: 'custom', message: 'Username and password are required' });
    }
    if (value.authMode === 'api_key' && !value.apiKey) {
      context.addIssue({ code: 'custom', message: 'API key is required' });
    }
  });
export type CreateProviderRequest = z.infer<typeof CreateProviderRequestSchema>;

export const CatalogQuerySchema = z.object({
  section: z.enum(['continue_watching', 'next_up', 'recently_added']).optional(),
  parentId: z.string().optional(),
  search: z.string().max(200).optional(),
  kinds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0)
});
export type CatalogQuery = z.infer<typeof CatalogQuerySchema>;

export const ProfileInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  platform: PlatformModeSchema,
  state: z.enum(['experimental', 'verified']),
  video: VideoSettingsSchema,
  audio: AudioSettingsSchema,
  delivery: DeliverySettingsSchema,
  processing: ProcessingSettingsSchema
});
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export const CreateSessionRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('vod'),
    name: z.string().min(1).max(160).optional(),
    source: MediaSourceRefSchema,
    profileId: z.string(),
    platformMode: PlatformModeSchema,
    pinned: z.boolean().default(false),
    reportActivity: z.boolean().default(true),
    placementPolicy: PlacementPolicySchema.default('local'),
    preferredNodeId: z.string().optional(),
    placementLocked: z.boolean().default(false),
    preferredRegion: z.string().optional(),
    playbackTtlSeconds: z.number().int().min(60).max(31_536_000).nullable().default(null)
  }),
  z.object({
    kind: z.literal('live'),
    name: z.string().min(1).max(160),
    liveChannelId: z.string(),
    profileId: z.string(),
    platformMode: PlatformModeSchema,
    pinned: z.boolean().default(true),
    reportActivity: z.literal(false).default(false),
    placementPolicy: PlacementPolicySchema.default('auto'),
    preferredNodeId: z.string().optional(),
    placementLocked: z.boolean().default(false),
    preferredRegion: z.string().optional(),
    playbackTtlSeconds: z.number().int().min(60).max(31_536_000).nullable().default(null)
  })
]);
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const CreateLiveChannelRequestSchema = z.object({
  name: z.string().min(1).max(120),
  preferredRegion: z.string().optional(),
  normalize: z.boolean().default(true)
});
export type CreateLiveChannelRequest = z.infer<typeof CreateLiveChannelRequestSchema>;

export const CreateCompatibilityResultRequestSchema = CompatibilityResultSchema.omit({
  id: true,
  testedAt: true
});
export type CreateCompatibilityResultRequest = z.infer<
  typeof CreateCompatibilityResultRequestSchema
>;

export const FirstRunRequestSchema = z.object({
  password: z.string().min(12).max(256),
  setupToken: z.string().min(32).optional()
});
export type FirstRunRequest = z.infer<typeof FirstRunRequestSchema>;
export const LoginRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('recovery'), password: z.string().min(1).max(256) }),
  z.object({
    method: z.literal('jellyfin'),
    username: z.string().min(1).max(256),
    password: z.string().min(1).max(256)
  })
]);
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const UpdateUserRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  roles: z.array(UserRoleSchema).min(1),
  allowedProfileIds: z.array(z.string().min(1)),
  defaultProfileId: z.string().min(1).optional()
});
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const SignInConfigurationRequestSchema = z
  .object({
    providerId: z.string().min(1),
    defaultProfileId: z.string().min(1),
    allowedProfileIds: z.array(z.string().min(1)).min(1),
    reportPlaybackActivity: z.boolean().default(true)
  })
  .superRefine((value, context) => {
    if (!value.allowedProfileIds.includes(value.defaultProfileId))
      context.addIssue({
        code: 'custom',
        path: ['defaultProfileId'],
        message: 'The default profile must be included in the allowed profiles'
      });
  });
export type SignInConfigurationRequest = z.infer<typeof SignInConfigurationRequestSchema>;

export const RetentionConfigurationSchema = z
  .object({
    sessionInactivityDeletionHours: z.number().int().min(1).max(8_760).nullable().default(null),
    staleUserPurgeDays: z.number().int().min(30).max(3_650).nullable().default(null)
  })
  .strict();
export type RetentionConfiguration = z.infer<typeof RetentionConfigurationSchema>;
export const UpdateRetentionConfigurationRequestSchema = z
  .object({
    sessionInactivityDeletionHours: z.number().int().min(1).max(8_760).nullable(),
    staleUserPurgeDays: z.number().int().min(30).max(3_650).nullable()
  })
  .strict();
export type UpdateRetentionConfigurationRequest = z.infer<
  typeof UpdateRetentionConfigurationRequestSchema
>;

export const DeleteUserQuerySchema = z
  .object({
    expectedRevision: z.coerce.number().int().positive()
  })
  .strict();
export type DeleteUserQuery = z.infer<typeof DeleteUserQuerySchema>;

export const CreatePersonalTokenRequestSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ScopeSchema).min(1),
  expiresAt: z.iso.datetime().nullable().default(null)
});
export type CreatePersonalTokenRequest = z.infer<typeof CreatePersonalTokenRequestSchema>;

export const CreateNodeJoinTokenRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    roles: z.array(NodeRoleSchema).min(1),
    region: z.string().min(1).max(80),
    expiresInSeconds: z.number().int().min(60).max(3600).default(600)
  })
  .strict();
export type CreateNodeJoinTokenRequest = z.infer<typeof CreateNodeJoinTokenRequestSchema>;

export const EnrollNodeRequestSchema = z
  .object({
    token: z.string().min(32),
    name: z.string().min(1).max(120),
    publicUrl: HttpUrlSchema,
    internalUrl: HttpUrlSchema.optional(),
    capabilities: NodeCapabilitySchema,
    csrPem: z
      .string()
      .min(1)
      .max(16 * 1024)
  })
  .strict();
export type EnrollNodeRequest = z.infer<typeof EnrollNodeRequestSchema>;

export const AgentProtocolMessageSchema = AgentEnvelopeSchema;
export type AgentProtocolMessage = z.infer<typeof AgentProtocolMessageSchema>;

export const CreateProviderBindingRequestSchema = z
  .object({
    providerId: z.string().min(1).optional(),
    nodeId: z.string().min(1),
    type: z.literal('jellyfin'),
    name: z.string().min(1).max(100),
    baseUrl: z.url(),
    authMode: AuthenticationModeSchema,
    username: z.string().optional(),
    password: z.string().optional(),
    apiKey: z.string().optional(),
    allowPublicHttp: z.boolean().default(false)
  })
  .superRefine((value, context) => {
    if (value.authMode === 'delegated')
      context.addIssue({
        code: 'custom',
        path: ['authMode'],
        message: 'Delegated user authentication is only available for interactive sign-in'
      });
    if (value.authMode === 'user_token' && (!value.username || !value.password))
      context.addIssue({ code: 'custom', message: 'Username and password are required' });
    if (value.authMode === 'api_key' && !value.apiKey)
      context.addIssue({ code: 'custom', message: 'API key is required' });
  });
export type CreateProviderBindingRequest = z.infer<typeof CreateProviderBindingRequestSchema>;

export const DeleteProviderBindingQuerySchema = z.object({
  acknowledgeOrphanedCredential: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true')
});
export type DeleteProviderBindingQuery = z.infer<typeof DeleteProviderBindingQuerySchema>;

export const RotateNodeCertificateRequestSchema = z.object({}).strict();
export type RotateNodeCertificateRequest = z.infer<typeof RotateNodeCertificateRequestSchema>;
export const NodeLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional()
});
export type NodeLogsQuery = z.infer<typeof NodeLogsQuerySchema>;
export const JobLogsQuerySchema = NodeLogsQuerySchema;
export type JobLogsQuery = z.infer<typeof JobLogsQuerySchema>;
export const CacheInventoryQuerySchema = z.object({
  nodeId: z.string().min(1).optional()
});
export type CacheInventoryQuery = z.infer<typeof CacheInventoryQuerySchema>;
export const CacheEvictionRequestSchema = z
  .object({
    nodeId: z.string().min(1).optional(),
    all: z.boolean().optional(),
    sessionId: z.string().optional(),
    profileId: z.string().optional()
  })
  .refine(
    (value) => value.all || value.sessionId || value.profileId,
    'A cache eviction scope is required'
  );
export type CacheEvictionRequest = z.infer<typeof CacheEvictionRequestSchema>;

export const BackendValidationRequestSchema = z
  .object({
    category: z.enum([
      'object-store',
      'coordination',
      'repository',
      'routing',
      'secrets',
      'metrics'
    ]),
    kind: z.enum([
      'local',
      's3',
      'azure-blob',
      'gcs',
      'postgres',
      'valkey',
      'builtin',
      'static',
      'webhook',
      'sqlite',
      'keychain',
      'dpapi',
      'encrypted-file',
      'prometheus'
    ]),
    endpoint: z.url().optional(),
    secretRef: z.string().min(1).max(200).optional(),
    nodeId: z.string().min(1).max(200).optional(),
    bucket: z.string().min(1).max(255).optional(),
    container: z.string().min(1).max(255).optional(),
    region: z.string().min(1).max(100).optional(),
    prefix: z.string().min(1).max(500).optional(),
    projectId: z.string().min(1).max(200).optional(),
    forcePathStyle: z.boolean().optional(),
    intervalSeconds: z.number().int().min(5).max(300).optional()
  })
  .strict();
export type BackendValidationRequest = z.infer<typeof BackendValidationRequestSchema>;
export const BackendActivationRequestSchema = BackendValidationRequestSchema;
export type BackendActivationRequest = z.infer<typeof BackendActivationRequestSchema>;

const ListenerAddressSchema = z
  .string()
  .min(3)
  .max(260)
  .refine((value) => /^.+:\d+$/.test(value), 'Listener address must use host:port format');

export const RuntimeConfigurationSchema = z
  .object({
    logLevel: z.enum(['info', 'debug']).default('info'),
    listenAddr: ListenerAddressSchema,
    publicUrl: z.url(),
    adminUrl: z.url(),
    playbackUrl: z.url(),
    trustedProxyCidrs: z.array(z.string().min(1).max(100)).max(32),
    viewerRegionHeader: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .default('x-vrrelay-region'),
    agentListenAddr: ListenerAddressSchema,
    maxWorkers: z.number().int().min(1).max(32),
    cacheTtlMs: z
      .number()
      .int()
      .min(1_000)
      .max(7 * 24 * 60 * 60 * 1_000),
    cacheLimitBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024 * 1024 * 1024),
    vodProducerIdleTimeoutMs: z.number().int().min(15_000).max(600_000).default(60_000),
    vodProducerBufferLowWatermarkMs: z.number().int().min(4_000).max(300_000).default(30_000),
    vodProducerBufferHighWatermarkMs: z.number().int().min(8_000).max(600_000).default(60_000),
    vodProducerMaxCatchupRate: z.number().min(1).max(2).default(2),
    videoEncoder: z
      .enum(['auto', 'software', 'videotoolbox', 'nvenc', 'qsv', 'vaapi', 'amf'])
      .default('auto'),
    vodProducerMaxConcurrent: z.number().int().min(1).max(32).default(2),
    vodProducerMaxPerProvider: z.number().int().min(1).max(32).default(2),
    liveMaxChannelsTotal: z.number().int().min(1).max(1_000).default(32),
    liveMaxChannelsPerOwner: z.number().int().min(1).max(100).default(4),
    liveNormalizerMaxConcurrent: z.number().int().min(1).max(32).default(2),
    liveNormalizerMaxPerOwner: z.number().int().min(1).max(32).default(1),
    agentLogRetentionRows: z.number().int().min(100).max(50_000).default(1_000),
    agentLogQueryLimit: z.number().int().min(1).max(1_000).default(200),
    jobLogRetentionRows: z.number().int().min(100).max(50_000).default(1_000),
    jobLogQueryLimit: z.number().int().min(1).max(1_000).default(200),
    nodeName: z.string().trim().min(1).max(100),
    nodeRegion: z.string().trim().min(1).max(100)
  })
  .superRefine((value, context) => {
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
  });
export type RuntimeConfiguration = z.infer<typeof RuntimeConfigurationSchema>;

export const RuntimeConfigurationUpdateRequestSchema = RuntimeConfigurationSchema;
export type RuntimeConfigurationUpdateRequest = z.infer<
  typeof RuntimeConfigurationUpdateRequestSchema
>;

export const NodeHeartbeatRequestSchema = z.object({
  capabilities: NodeCapabilitySchema,
  state: z.enum(['online', 'degraded', 'draining']).default('online')
});
export type NodeHeartbeatRequest = z.infer<typeof NodeHeartbeatRequestSchema>;

export const NodeDrainRequestSchema = z.object({ draining: z.boolean() });
export type NodeDrainRequest = z.infer<typeof NodeDrainRequestSchema>;

export const SessionControlRequestSchema = z
  .object({
    pinned: z.boolean().optional(),
    state: z.enum(['idle', 'live', 'stopped']).optional()
  })
  .refine(
    (value) => value.pinned !== undefined || value.state !== undefined,
    'At least one control field is required'
  );
export type SessionControlRequest = z.infer<typeof SessionControlRequestSchema>;

export const PlacementPreviewRequestSchema = z.object({
  providerId: z.string().optional(),
  profileId: z.string(),
  placementPolicy: PlacementPolicySchema,
  preferredNodeId: z.string().optional(),
  preferredRegion: z.string().optional()
});
export type PlacementPreviewRequest = z.infer<typeof PlacementPreviewRequestSchema>;

export const RelayEventSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  type: z.enum([
    'session.created',
    'session.updated',
    'session.deleted',
    'worker.started',
    'worker.completed',
    'worker.failed',
    'cache.hit',
    'cache.evicted',
    'viewer.joined',
    'viewer.left',
    'live.publisher.connected',
    'live.publisher.disconnected',
    'live.normalizer.failed',
    'live.channel.deleted',
    'system.capacity',
    'node.joined',
    'node.heartbeat',
    'node.draining',
    'node.offline',
    'node.log',
    'job.log',
    'job.queued',
    'job.leased',
    'job.completed',
    'job.failed',
    'route.selected',
    'storage.uploaded',
    'storage.invalidated'
  ]),
  timestamp: z.iso.datetime(),
  sessionId: z.string().optional(),
  payload: z.record(z.string(), z.unknown())
});
export type RelayEvent = z.infer<typeof RelayEventSchema>;

export const API_VERSION = 'v1';
