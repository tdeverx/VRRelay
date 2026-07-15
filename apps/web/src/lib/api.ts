import type {
  CompatibilityResult,
  BackendStatus,
  ClusterNode,
  PublicLiveChannel,
  MediaItem,
  ProfileRevision,
  PublicProviderConnection,
  RelaySession,
  SegmentJob,
  PublicProviderBinding,
  CachedObject,
  AgentLogEntry,
  PersonalAccessToken
} from '@vrrelay/domain';
import type {
  CreateProviderRequest,
  CreateProfileRevisionRequest,
  CreateSessionRequest,
  CreateCompatibilityResultRequest,
  CreatePersonalTokenRequest,
  CreateNodeJoinTokenRequest,
  CreateProviderBindingRequest,
  CacheEvictionRequest,
  BackendValidationRequest,
  BackendActivationRequest
} from '@vrrelay/contracts';
import { client as generatedClient } from '$lib/generated/vrrelay-api/client.gen';
import { jsonBodySerializer } from '$lib/generated/vrrelay-api/core/bodySerializer.gen';

// The generated client owns URL construction and transport. Domain responses and
// runtime-validated request payloads come from the shared provider-neutral packages.

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method?.toUpperCase() ?? 'GET') as
    'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD' | 'OPTIONS';
  const result = await generatedClient.request({
    url: path.replace(/^\/api\/v1/, ''),
    method,
    ...(init.body
      ? {
          body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
          bodySerializer: jsonBodySerializer.bodySerializer
        }
      : {}),
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && method !== 'HEAD' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...init.headers
    },
    responseStyle: 'fields'
  });
  const response = result.response;
  if (!response) throw new ApiClientError('The relay could not be reached', 0, 'network_error');
  if (response.status === 204) return undefined as T;
  const body: unknown = result.data ?? result.error;
  if (!response.ok) {
    const error = body as { error?: { message?: string; code?: string } };
    throw new ApiClientError(
      error.error?.message ?? `Request failed (${response.status})`,
      response.status,
      error.error?.code
    );
  }
  return body as T;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

export const api = {
  health: () =>
    request<{
      status: string;
      version: string;
      now: string;
      workers: { active: number; limit: number; queued: number };
    }>('/api/v1/health'),
  setupStatus: () => request<{ configured: boolean; requiresToken: boolean }>('/api/v1/setup'),
  setup: (password: string, setupToken?: string) =>
    request<{ configured: true; requiresToken: false }>(
      '/api/v1/setup',
      json('POST', { password, ...(setupToken ? { setupToken } : {}) })
    ),
  async login(password: string) {
    const result = await request<{ csrfToken: string; expiresAt: string }>(
      '/api/v1/auth/login',
      json('POST', { password })
    );
    csrfToken = result.csrfToken;
    sessionStorage.setItem('vrrelay.csrf', result.csrfToken);
    return result;
  },
  async logout() {
    await request<void>('/api/v1/auth/logout', json('POST'));
    csrfToken = '';
    sessionStorage.removeItem('vrrelay.csrf');
  },
  providers: () => request<{ items: PublicProviderConnection[] }>('/api/v1/providers'),
  createProvider: (body: CreateProviderRequest) =>
    request<PublicProviderConnection>('/api/v1/providers', json('POST', body)),
  deleteProvider: (providerId: string) =>
    request<void>(`/api/v1/providers/${providerId}`, json('DELETE')),
  catalog: (
    providerId: string,
    query: { search?: string; parentId?: string; limit?: number } = {}
  ) => {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if (query.parentId) params.set('parentId', query.parentId);
    params.set('limit', String(query.limit ?? 50));
    return request<{ items: MediaItem[]; total: number }>(
      `/api/v1/providers/${providerId}/catalog?${params}`
    );
  },
  item: (providerId: string, itemId: string) =>
    request<MediaItem>(`/api/v1/providers/${providerId}/items/${itemId}`),
  profiles: () => request<{ items: ProfileRevision[] }>('/api/v1/profiles'),
  createProfileRevision: (body: CreateProfileRevisionRequest) =>
    request<ProfileRevision>('/api/v1/profiles', json('POST', body)),
  capabilities: () =>
    request<{
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
    }>('/api/v1/capabilities'),
  sessions: () => request<{ items: RelaySession[] }>('/api/v1/sessions'),
  createVodSession: (
    body: Omit<
      Extract<CreateSessionRequest, { kind: 'vod' }>,
      'kind' | 'playbackTtlSeconds' | 'placementLocked'
    >
  ) =>
    request<RelaySession>(
      '/api/v1/sessions',
      json('POST', { kind: 'vod', ...body, playbackTtlSeconds: null })
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
    request<RelaySession>(
      '/api/v1/sessions',
      json('POST', {
        kind: 'live',
        placementPolicy: 'auto',
        ...body,
        pinned: true,
        reportActivity: false,
        playbackTtlSeconds: null
      })
    ),
  deleteSession: (sessionId: string) =>
    request<void>(`/api/v1/sessions/${sessionId}`, json('DELETE')),
  liveChannels: () => request<{ items: PublicLiveChannel[] }>('/api/v1/live-channels'),
  createLiveChannel: (name: string) =>
    request<{
      channel: PublicLiveChannel;
      publisher: {
        publishToken: string;
        rtmpUrl: string;
        srtUrl: string;
        whipUrl: string;
        backupRtmpUrl?: string;
        backupSrtUrl?: string;
      };
    }>('/api/v1/live-channels', json('POST', { name })),
  deleteLiveChannel: (channelId: string) =>
    request<void>(`/api/v1/live-channels/${channelId}`, json('DELETE')),
  compatibility: () => request<{ items: CompatibilityResult[] }>('/api/v1/compatibility'),
  createCompatibility: (body: CreateCompatibilityResultRequest) =>
    request<CompatibilityResult>('/api/v1/compatibility', json('POST', body)),
  createToken: (body: CreatePersonalTokenRequest) =>
    request<Omit<PersonalAccessToken, 'tokenHash'> & { token: string }>(
      '/api/v1/tokens',
      json('POST', body)
    ),
  tokens: () => request<{ items: Array<Omit<PersonalAccessToken, 'tokenHash'>> }>('/api/v1/tokens'),
  revokeToken: (tokenId: string) => request<void>(`/api/v1/tokens/${tokenId}`, json('DELETE')),
  recentEvents: () =>
    request<{
      items: Array<{
        version: 1;
        id: string;
        type: string;
        timestamp: string;
        sessionId?: string;
        payload: Record<string, unknown>;
      }>;
    }>('/api/v1/events/recent'),
  clusterNodes: () =>
    request<{
      items: Array<ClusterNode & { agent: { connected: boolean; connectedAt?: string } }>;
    }>('/api/v1/nodes'),
  clusterBackends: () => request<{ items: BackendStatus[] }>('/api/v1/backends'),
  validateBackend: (body: BackendValidationRequest) =>
    request<BackendStatus>('/api/v1/backends/validate', json('POST', body)),
  activateBackend: (body: BackendActivationRequest) =>
    request<BackendStatus>('/api/v1/backends/activate', json('POST', body)),
  segmentJobs: () => request<{ items: SegmentJob[] }>('/api/v1/jobs'),
  createNodeJoinToken: (body: CreateNodeJoinTokenRequest) =>
    request<{ token: string; expiresAt: string }>('/api/v1/nodes/join-tokens', json('POST', body)),
  drainNode: (nodeId: string, draining: boolean) =>
    request<ClusterNode>(`/api/v1/nodes/${nodeId}/drain`, json('POST', { draining })),
  removeNode: (nodeId: string) => request<void>(`/api/v1/nodes/${nodeId}`, json('DELETE')),
  cancelSegmentJob: (jobId: string) => request<void>(`/api/v1/jobs/${jobId}`, json('DELETE')),
  retrySegmentJob: (jobId: string) =>
    request<SegmentJob>(`/api/v1/jobs/${jobId}/retry`, json('POST', {})),
  providerBindings: (providerId?: string) =>
    request<{ items: PublicProviderBinding[] }>(
      `/api/v1/provider-bindings${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ''}`
    ),
  createProviderBinding: (body: CreateProviderBindingRequest) =>
    request<{ provider: PublicProviderConnection; binding: PublicProviderBinding }>(
      '/api/v1/provider-bindings',
      json('POST', body)
    ),
  deleteProviderBinding: (bindingId: string) =>
    request<void>(`/api/v1/provider-bindings/${bindingId}`, json('DELETE')),
  rotateNodeCertificate: (nodeId: string) =>
    request<{ certificateExpiresAt: string }>(
      `/api/v1/nodes/${nodeId}/certificate/rotate`,
      json('POST', {})
    ),
  revokeNode: (nodeId: string) =>
    request<ClusterNode>(`/api/v1/nodes/${nodeId}/revoke`, json('POST', {})),
  nodeLogs: (nodeId: string) => request<{ items: AgentLogEntry[] }>(`/api/v1/nodes/${nodeId}/logs`),
  cacheInventory: () => request<{ items: CachedObject[]; totalBytes: number }>('/api/v1/cache'),
  evictCache: (body: CacheEvictionRequest) =>
    request<{ removed: number }>('/api/v1/cache', json('DELETE', body))
};

export function isAuthenticatedError(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
}
