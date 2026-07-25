import type {
  AgentLogEntry,
  BackendStatus,
  CachedObject,
  ClusterNode,
  CompatibilityResult,
  JobLogEntry,
  MediaItem,
  PersonalAccessToken,
  ProfileRevision,
  PublicLiveChannel,
  PublicProviderBinding,
  PublicProviderConnection,
  RelaySession,
  SessionRuntimeStats,
  SegmentJob,
  VodProducer
} from '@vrrelay/domain';
import type {
  BackendActivationRequest,
  BackendValidationRequest,
  CacheEvictionRequest,
  CreateCompatibilityResultRequest,
  CreateNodeJoinTokenRequest,
  CreatePersonalTokenRequest,
  CreateProfileRevisionRequest,
  CreateProviderBindingRequest,
  CreateProviderRequest,
  CreateSessionRequest,
  SignInConfigurationRequest,
  RuntimeConfiguration,
  SessionControlRequest,
  UpdateUserRequest
} from '@vrrelay/contracts';
import { client as generatedClient } from '#lib/generated/vrrelay-api/client.gen';
import {
  activateBackend,
  browseCatalog,
  browseUserCatalog,
  cancelSegmentJob,
  controlSession,
  createLiveChannel,
  createNodeJoinToken,
  createPersonalToken,
  createProfileRevision,
  createProvider,
  createProviderBinding,
  createSession,
  deleteLiveChannel,
  deleteProvider,
  deleteProviderBinding,
  deleteSession,
  drainNode,
  evictCache,
  getHealth,
  getMediaCapabilities,
  getCurrentUser,
  getCatalogItem,
  getSignInConfiguration,
  getSignInStatus,
  getProviderItem,
  getReadiness,
  getRuntimeConfiguration,
  getSession,
  getVodProducer,
  getSetupStatus,
  initializeAdmin,
  listBackendHealth,
  listCacheInventory,
  listClusterNodes,
  listCompatibilityResults,
  listJobLogs,
  listLiveChannels,
  listNodeLogs,
  listPersonalTokens,
  listCatalogProfiles,
  listUsers,
  listProfiles,
  listProviderBindings,
  listProviders,
  listRecentEvents,
  listSegmentJobs,
  listSessions,
  listVodProducers,
  login as loginOperation,
  logout as logoutOperation,
  previewPlacement,
  recordCompatibilityResult,
  removeNode,
  replaceLivePublisher,
  retrySegmentJob,
  restartRuntime,
  revokeNode,
  revokePersonalToken,
  rotateNodeCertificate,
  validateBackend,
  validateProvider,
  validateRuntimeConfiguration,
  updateSignInConfiguration,
  updateUser,
  updateRuntimeConfiguration
} from '#lib/generated/vrrelay-api/sdk.gen';

// OpenAPI-generated operations own paths, methods, query serialization, and
// request bodies. This module only adds browser authentication concerns and a
// small domain-facing convenience surface for Svelte components.

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'request_failed',
    readonly details?: unknown
  ) {
    super(message);
  }
}

function cookieValue(name: string): string {
  if (typeof document === 'undefined') return '';
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

function browserCsrfToken(storageKey: string, cookieName: string): string {
  if (typeof sessionStorage === 'undefined') return '';
  const token = sessionStorage.getItem(storageKey) ?? cookieValue(cookieName);
  if (token) sessionStorage.setItem(storageKey, token);
  return token;
}

let csrfToken = browserCsrfToken('vrrelay.csrf', 'vrrelay_csrf');
generatedClient.setConfig({
  credentials: 'same-origin',
  headers: { Accept: 'application/json' },
  responseStyle: 'fields'
});

generatedClient.interceptors.request.use((request) => {
  if (request.method === 'GET' || request.method === 'HEAD') return request;
  if (!csrfToken) csrfToken = browserCsrfToken('vrrelay.csrf', 'vrrelay_csrf');
  if (!csrfToken) return request;
  const headers = new Headers(request.headers);
  headers.set('X-CSRF-Token', csrfToken);
  return new Request(request, { headers });
});

generatedClient.interceptors.error.use((error, response) => {
  if (error instanceof ApiClientError) return error;
  const body = error as { error?: { message?: string; code?: string } } | undefined;
  if (!response) return new ApiClientError('The relay could not be reached', 0, 'network_error');
  return new ApiClientError(
    body?.error?.message ?? `Request failed (${response.status})`,
    response.status,
    body?.error?.code,
    error
  );
});

async function result<T>(operation: Promise<{ data: unknown }>): Promise<T> {
  return (await operation).data as T;
}

const required = { throwOnError: true } as const;

interface ReadinessResponse {
  status: 'ready' | 'degraded';
  version: string;
  now: string;
  workers: { active: number; limit: number; queued: number };
  dependencies: Array<{
    category: string;
    kind: string;
    healthy: boolean;
    checkedAt: string;
    restartRequired?: boolean;
  }>;
  restartRequired: boolean;
}

function isReadinessResponse(value: unknown): value is ReadinessResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { dependencies?: unknown }).dependencies)
  );
}

export const api = {
  health: () =>
    result<{
      status: string;
      version: string;
      now: string;
      workers: { active: number; limit: number; queued: number };
    }>(getHealth(required)),
  readiness: async (): Promise<ReadinessResponse> => {
    try {
      return await result<ReadinessResponse>(getReadiness(required));
    } catch (reason) {
      if (reason instanceof ApiClientError && isReadinessResponse(reason.details))
        return reason.details;
      throw reason;
    }
  },
  runtimeConfiguration: () =>
    result<{
      configuration: RuntimeConfiguration;
      writable: boolean;
      restartSupported: boolean;
      restartRequired: boolean;
      environment: 'development' | 'production';
      version: string;
    }>(getRuntimeConfiguration(required)),
  validateRuntimeConfiguration: (body: RuntimeConfiguration) =>
    result<{ valid: true; configuration: RuntimeConfiguration }>(
      validateRuntimeConfiguration({ ...required, body })
    ),
  updateRuntimeConfiguration: (body: RuntimeConfiguration) =>
    result<{
      configuration: RuntimeConfiguration;
      writable: boolean;
      restartSupported: boolean;
      restartRequired: boolean;
      environment: 'development' | 'production';
      version: string;
    }>(updateRuntimeConfiguration({ ...required, body })),
  restartRuntime: () => result<{ restarting: true }>(restartRuntime(required)),
  setupStatus: () =>
    result<{ configured: boolean; requiresToken: boolean }>(getSetupStatus(required)),
  setup: (password: string, setupToken?: string) =>
    result<{ configured: true; requiresToken: false }>(
      initializeAdmin({
        ...required,
        body: { password, ...(setupToken ? { setupToken } : {}) }
      })
    ),
  async login(
    body:
      | { method: 'recovery'; password: string }
      | { method: 'jellyfin'; username: string; password: string }
  ) {
    const login = await result<{
      csrfToken: string;
      expiresAt: string;
      user: {
        id: string;
        displayName: string;
        authMethod: 'jellyfin' | 'recovery' | 'personal_token';
        roles: Array<'user' | 'operator' | 'admin' | 'owner'>;
        permissions: string[];
        providerId?: string;
      };
    }>(loginOperation({ ...required, body }));
    csrfToken = login.csrfToken;
    sessionStorage.setItem('vrrelay.csrf', login.csrfToken);
    return login;
  },
  async logout() {
    await result<void>(logoutOperation(required));
    csrfToken = '';
    sessionStorage.removeItem('vrrelay.csrf');
  },
  me: () =>
    result<{
      id: string;
      displayName: string;
      authMethod: 'jellyfin' | 'recovery' | 'personal_token';
      roles: Array<'user' | 'operator' | 'admin' | 'owner'>;
      permissions: string[];
      providerId?: string;
    }>(getCurrentUser(required)),
  signInStatus: () =>
    result<{ configured: boolean; providerName?: string }>(getSignInStatus(required)),
  signInConfiguration: () =>
    result<{ configuration: SignInConfigurationRequest | null }>(getSignInConfiguration(required)),
  updateSignInConfiguration: (body: SignInConfigurationRequest) =>
    result<SignInConfigurationRequest>(updateSignInConfiguration({ ...required, body })),
  userCatalog: (
    query: {
      section?: 'continue_watching' | 'next_up' | 'recently_added';
      search?: string;
      parentId?: string;
      kinds?: string[];
      limit?: number;
      offset?: number;
    } = {}
  ) =>
    result<{ items: MediaItem[]; total: number }>(
      browseUserCatalog({ ...required, query: { ...query, limit: query.limit ?? 50 } })
    ),
  catalogItem: (itemId: string) =>
    result<MediaItem>(getCatalogItem({ ...required, path: { itemId } })),
  catalogProfiles: () =>
    result<{ defaultProfileId?: string; items: ProfileRevision[] }>(listCatalogProfiles(required)),
  users: () =>
    result<{
      items: Array<{
        value: import('@vrrelay/domain').UserIdentity;
        revision: number;
      }>;
    }>(listUsers(required)),
  updateUser: (userId: string, body: UpdateUserRequest) =>
    result<{ value: import('@vrrelay/domain').UserIdentity; revision: number }>(
      updateUser({ ...required, path: { userId }, body })
    ),
  providers: () => result<{ items: PublicProviderConnection[] }>(listProviders(required)),
  createProvider: (body: CreateProviderRequest) =>
    result<PublicProviderConnection>(createProvider({ ...required, body })),
  validateProvider: (providerId: string) =>
    result<void>(validateProvider({ ...required, path: { providerId } })),
  deleteProvider: (providerId: string) =>
    result<void>(deleteProvider({ ...required, path: { providerId } })),
  catalog: (
    providerId: string,
    query: {
      search?: string;
      parentId?: string;
      kinds?: string[];
      limit?: number;
      offset?: number;
    } = {}
  ) =>
    result<{ items: MediaItem[]; total: number }>(
      browseCatalog({
        ...required,
        path: { providerId },
        query: { ...query, limit: query.limit ?? 50 }
      })
    ),
  item: (providerId: string, itemId: string) =>
    result<MediaItem>(getProviderItem({ ...required, path: { providerId, itemId } })),
  profiles: () => result<{ items: ProfileRevision[] }>(listProfiles(required)),
  createProfileRevision: (body: CreateProfileRevisionRequest) =>
    result<ProfileRevision>(createProfileRevision({ ...required, body })),
  capabilities: () =>
    result<{
      ffmpegVersion: string;
      encoders: Array<{
        name: string;
        codec: string;
        hardware: boolean;
        available: boolean;
        reason?: string;
      }>;
      muxers: string[];
      filters: string[];
      pixelFormats: string[];
    }>(getMediaCapabilities(required)),
  sessions: () =>
    result<{ items: RelaySession[]; runtime: SessionRuntimeStats[] }>(listSessions(required)),
  session: (sessionId: string) =>
    result<RelaySession>(getSession({ ...required, path: { sessionId } })),
  controlSession: (sessionId: string, body: SessionControlRequest) =>
    result<RelaySession>(controlSession({ ...required, path: { sessionId }, body })),
  createVodSession: (
    body: Omit<
      Extract<CreateSessionRequest, { kind: 'vod' }>,
      'kind' | 'playbackTtlSeconds' | 'placementLocked'
    >
  ) =>
    result<RelaySession>(
      createSession({
        ...required,
        body: { kind: 'vod', ...body, playbackTtlSeconds: null }
      })
    ),
  createLiveSession: (
    body: Omit<
      Extract<CreateSessionRequest, { kind: 'live' }>,
      | 'kind'
      | 'pinned'
      | 'reportActivity'
      | 'playbackTtlSeconds'
      | 'placementLocked'
      | 'placementPolicy'
    > & { placementPolicy?: Extract<CreateSessionRequest, { kind: 'live' }>['placementPolicy'] }
  ) =>
    result<RelaySession>(
      createSession({
        ...required,
        body: {
          kind: 'live',
          placementPolicy: 'auto',
          ...body,
          pinned: true,
          reportActivity: false,
          playbackTtlSeconds: null
        }
      })
    ),
  deleteSession: (sessionId: string) =>
    result<void>(deleteSession({ ...required, path: { sessionId } })),
  previewPlacement: (body: {
    providerId?: string;
    profileId: string;
    profileRevision: number;
    placementPolicy: 'local' | 'hosted' | 'auto';
    preferredNodeId?: string;
    preferredRegion?: string;
  }) =>
    result<{ node?: ClusterNode | null; reason: string }>(previewPlacement({ ...required, body })),
  liveChannels: () => result<{ items: PublicLiveChannel[] }>(listLiveChannels(required)),
  createLiveChannel: (name: string) =>
    result<{
      channel: PublicLiveChannel;
      publisher: {
        publishToken: string;
        rtmpUrl: string;
        srtUrl: string;
        whipUrl: string;
        backupRtmpUrl?: string;
        backupSrtUrl?: string;
      };
    }>(createLiveChannel({ ...required, body: { name } })),
  replaceLivePublisher: (channelId: string) =>
    result<{
      channel: PublicLiveChannel;
      publisher: {
        publishToken: string;
        rtmpUrl: string;
        srtUrl: string;
        whipUrl: string;
        backupRtmpUrl?: string;
        backupSrtUrl?: string;
      };
    }>(replaceLivePublisher({ ...required, path: { channelId } })),
  deleteLiveChannel: (channelId: string) =>
    result<void>(deleteLiveChannel({ ...required, path: { channelId } })),
  compatibility: () => result<{ items: CompatibilityResult[] }>(listCompatibilityResults(required)),
  createCompatibility: (body: CreateCompatibilityResultRequest) =>
    result<CompatibilityResult>(recordCompatibilityResult({ ...required, body })),
  createToken: (body: CreatePersonalTokenRequest) =>
    result<Omit<PersonalAccessToken, 'tokenHash'> & { token: string }>(
      createPersonalToken({ ...required, body })
    ),
  tokens: () =>
    result<{ items: Array<Omit<PersonalAccessToken, 'tokenHash'>> }>(listPersonalTokens(required)),
  revokeToken: (tokenId: string) =>
    result<void>(revokePersonalToken({ ...required, path: { tokenId } })),
  recentEvents: () =>
    result<{
      items: Array<{
        version: 1;
        id: string;
        type: string;
        timestamp: string;
        sessionId?: string;
        payload: Record<string, unknown>;
      }>;
    }>(listRecentEvents(required)),
  clusterNodes: () =>
    result<{
      items: Array<ClusterNode & { agent: { connected: boolean; connectedAt?: string } }>;
    }>(listClusterNodes(required)),
  clusterBackends: () => result<{ items: BackendStatus[] }>(listBackendHealth(required)),
  validateBackend: (body: BackendValidationRequest) =>
    result<BackendStatus>(validateBackend({ ...required, body })),
  activateBackend: (body: BackendActivationRequest) =>
    result<BackendStatus>(activateBackend({ ...required, body })),
  segmentJobs: () => result<{ items: SegmentJob[] }>(listSegmentJobs(required)),
  vodProducers: () => result<{ items: VodProducer[] }>(listVodProducers(required)),
  vodProducer: (sessionId: string) =>
    result<VodProducer>(getVodProducer({ ...required, path: { sessionId } })),
  createNodeJoinToken: (body: CreateNodeJoinTokenRequest) =>
    result<{ token: string; expiresAt: string }>(createNodeJoinToken({ ...required, body })),
  drainNode: (nodeId: string, draining: boolean) =>
    result<ClusterNode>(drainNode({ ...required, path: { nodeId }, body: { draining } })),
  removeNode: (nodeId: string) => result<void>(removeNode({ ...required, path: { nodeId } })),
  cancelSegmentJob: (jobId: string) =>
    result<void>(cancelSegmentJob({ ...required, path: { jobId } })),
  retrySegmentJob: (jobId: string) =>
    result<SegmentJob>(retrySegmentJob({ ...required, path: { jobId } })),
  jobLogs: (jobId: string, limit?: number) =>
    result<{ items: JobLogEntry[] }>(
      listJobLogs({
        ...required,
        path: { jobId },
        ...(limit === undefined ? {} : { query: { limit } })
      })
    ),
  providerBindings: (providerId?: string) =>
    result<{ items: PublicProviderBinding[] }>(
      listProviderBindings({
        ...required,
        ...(providerId === undefined ? {} : { query: { providerId } })
      })
    ),
  createProviderBinding: (body: CreateProviderBindingRequest) =>
    result<{ provider: PublicProviderConnection; binding: PublicProviderBinding }>(
      createProviderBinding({ ...required, body })
    ),
  deleteProviderBinding: (bindingId: string, acknowledgeOrphanedCredential = false) =>
    result<void>(
      deleteProviderBinding({
        ...required,
        path: { bindingId },
        ...(acknowledgeOrphanedCredential ? { query: { acknowledgeOrphanedCredential: true } } : {})
      })
    ),
  rotateNodeCertificate: (nodeId: string) =>
    result<{ certificateExpiresAt: string }>(
      rotateNodeCertificate({ ...required, path: { nodeId } })
    ),
  revokeNode: (nodeId: string) =>
    result<ClusterNode>(revokeNode({ ...required, path: { nodeId } })),
  nodeLogs: (nodeId: string, limit?: number) =>
    result<{ items: AgentLogEntry[] }>(
      listNodeLogs({
        ...required,
        path: { nodeId },
        ...(limit === undefined ? {} : { query: { limit } })
      })
    ),
  cacheInventory: (nodeId?: string) =>
    result<{ items: CachedObject[]; totalBytes: number }>(
      listCacheInventory({
        ...required,
        ...(nodeId === undefined ? {} : { query: { nodeId } })
      })
    ),
  evictCache: (body: CacheEvictionRequest) =>
    result<{ removed: number }>(evictCache({ ...required, body }))
};

export function isAuthenticatedError(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
}
