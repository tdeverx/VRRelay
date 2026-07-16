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
  SegmentJob
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
  RuntimeConfiguration,
  SessionControlRequest
} from '@vrrelay/contracts';
import { client as generatedClient } from '$lib/generated/vrrelay-api/client.gen';
import {
  activateBackend,
  browseCatalog,
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
  getProviderItem,
  getReadiness,
  getRuntimeConfiguration,
  getSession,
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
  listProfiles,
  listProviderBindings,
  listProviders,
  listRecentEvents,
  listSegmentJobs,
  listSessions,
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
  updateRuntimeConfiguration
} from '$lib/generated/vrrelay-api/sdk.gen';

// OpenAPI-generated operations own paths, methods, query serialization, and
// request bodies. This module only adds browser authentication concerns and a
// small domain-facing convenience surface for Svelte components.

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'request_failed'
  ) {
    super(message);
  }
}

let csrfToken =
  typeof sessionStorage === 'undefined' ? '' : (sessionStorage.getItem('vrrelay.csrf') ?? '');

generatedClient.setConfig({
  credentials: 'same-origin',
  headers: { Accept: 'application/json' },
  responseStyle: 'fields'
});

generatedClient.interceptors.request.use((request) => {
  if (!csrfToken || request.method === 'GET' || request.method === 'HEAD') return request;
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
    body?.error?.code
  );
});

async function result<T>(operation: Promise<{ data: unknown }>): Promise<T> {
  return (await operation).data as T;
}

const required = { throwOnError: true } as const;

export const api = {
  health: () =>
    result<{
      status: string;
      version: string;
      now: string;
      workers: { active: number; limit: number; queued: number };
    }>(getHealth(required)),
  readiness: () =>
    result<{
      status: string;
      checkedAt: string;
      dependencies: Array<{
        category: string;
        kind: string;
        healthy: boolean;
        checkedAt: string;
        restartRequired: boolean;
      }>;
    }>(getReadiness(required)),
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
  async login(password: string) {
    const login = await result<{ csrfToken: string; expiresAt: string }>(
      loginOperation({ ...required, body: { password } })
    );
    csrfToken = login.csrfToken;
    sessionStorage.setItem('vrrelay.csrf', login.csrfToken);
    return login;
  },
  async logout() {
    await result<void>(logoutOperation(required));
    csrfToken = '';
    sessionStorage.removeItem('vrrelay.csrf');
  },
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
  sessions: () => result<{ items: RelaySession[] }>(listSessions(required)),
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
