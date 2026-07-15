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
  AgentEnvelopeSchema
} from '@vrrelay/domain';

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
  parentId: z.string().optional(),
  search: z.string().max(200).optional(),
  kinds: z.array(z.string()).default([]),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0)
});
export type CatalogQuery = z.infer<typeof CatalogQuerySchema>;

export const CreateProfileRevisionRequestSchema = z.object({
  profileId: z.string().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  platform: PlatformModeSchema,
  state: z.enum(['experimental', 'verified']),
  video: VideoSettingsSchema,
  audio: AudioSettingsSchema,
  delivery: DeliverySettingsSchema,
  processing: ProcessingSettingsSchema
});
export type CreateProfileRevisionRequest = z.infer<typeof CreateProfileRevisionRequestSchema>;

export const CreateSessionRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('vod'),
    name: z.string().min(1).max(160).optional(),
    source: MediaSourceRefSchema,
    profileId: z.string(),
    profileRevision: z.number().int().min(1),
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
    profileRevision: z.number().int().min(1),
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
export const LoginRequestSchema = z.object({
  password: z.string().min(1).max(256)
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const CreatePersonalTokenRequestSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ScopeSchema).min(1),
  expiresAt: z.iso.datetime().nullable().default(null)
});
export type CreatePersonalTokenRequest = z.infer<typeof CreatePersonalTokenRequestSchema>;

export const CreateNodeJoinTokenRequestSchema = z.object({
  name: z.string().min(1).max(120),
  roles: z.array(NodeRoleSchema).min(1),
  region: z.string().min(1).max(80),
  expiresInSeconds: z.number().int().min(60).max(3600).default(600)
});
export type CreateNodeJoinTokenRequest = z.infer<typeof CreateNodeJoinTokenRequestSchema>;

export const EnrollNodeRequestSchema = z.object({
  token: z.string().min(32),
  name: z.string().min(1).max(120),
  publicUrl: HttpUrlSchema,
  internalUrl: HttpUrlSchema.optional(),
  capabilities: NodeCapabilitySchema
});
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

export const RotateNodeCertificateRequestSchema = z.object({ force: z.boolean().default(false) });
export type RotateNodeCertificateRequest = z.infer<typeof RotateNodeCertificateRequestSchema>;
export const CacheEvictionRequestSchema = z
  .object({
    all: z.boolean().optional(),
    sessionId: z.string().optional(),
    profileId: z.string().optional()
  })
  .refine(
    (value) => value.all || value.sessionId || value.profileId,
    'A cache eviction scope is required'
  );
export type CacheEvictionRequest = z.infer<typeof CacheEvictionRequestSchema>;

export const BackendValidationRequestSchema = z.object({
  category: z.enum(['object-store', 'coordination', 'repository', 'routing', 'secrets', 'metrics']),
  kind: z.enum([
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
  ]),
  endpoint: z.url().optional(),
  secretRef: z.string().min(1).max(200).optional(),
  bucket: z.string().min(1).max(255).optional(),
  container: z.string().min(1).max(255).optional(),
  region: z.string().min(1).max(100).optional(),
  prefix: z.string().min(1).max(500).optional(),
  projectId: z.string().min(1).max(200).optional(),
  forcePathStyle: z.boolean().optional(),
  intervalSeconds: z.number().int().min(5).max(300).optional()
});
export type BackendValidationRequest = z.infer<typeof BackendValidationRequestSchema>;
export const BackendActivationRequestSchema = BackendValidationRequestSchema;
export type BackendActivationRequest = z.infer<typeof BackendActivationRequestSchema>;

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
    state: z.enum(['idle', 'stopped']).optional()
  })
  .refine(
    (value) => value.pinned !== undefined || value.state !== undefined,
    'At least one control field is required'
  );
export type SessionControlRequest = z.infer<typeof SessionControlRequestSchema>;

export const PlacementPreviewRequestSchema = z.object({
  providerId: z.string().optional(),
  profileId: z.string(),
  profileRevision: z.number().int().min(1),
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
    'live.channel.deleted',
    'system.capacity',
    'node.joined',
    'node.heartbeat',
    'node.draining',
    'node.offline',
    'job.queued',
    'job.leased',
    'job.completed',
    'job.failed',
    'route.selected',
    'storage.uploaded'
  ]),
  timestamp: z.iso.datetime(),
  sessionId: z.string().optional(),
  payload: z.record(z.string(), z.unknown())
});
export type RelayEvent = z.infer<typeof RelayEventSchema>;

export const API_VERSION = 'v1';
