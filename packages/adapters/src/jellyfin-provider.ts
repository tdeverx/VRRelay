// SPDX-License-Identifier: GPL-3.0-or-later
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import type {
  MediaArtwork,
  MediaProvider,
  PlaybackEvent,
  ProviderCredentials,
  ProviderIdentity,
  ProviderTransportPolicy,
  ResolvedSource
} from '@vrrelay/application';
import type {
  MediaItem,
  MediaSourceRef,
  MediaTrack,
  MediaVersion,
  ProviderCapability,
  ProviderConnection
} from '@vrrelay/domain';
import { providerAllowsPublicHttp } from '@vrrelay/domain';
import type { CatalogQuery } from '@vrrelay/contracts';
import { resolveProviderRequestTarget, type PinnedProviderTarget } from './network-policy.js';

interface JellyfinSystemInfo {
  ServerName?: string;
  Version?: string;
}

interface JellyfinAuthResult {
  AccessToken?: string;
  User?: { Id?: string; Name?: string };
}

interface JellyfinMediaStream {
  Index?: number;
  Type?: string;
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  Title?: string;
  Channels?: number;
  IsExternal?: boolean;
  IsDefault?: boolean;
  IsForced?: boolean;
  VideoRangeType?: string;
  Width?: number;
  Height?: number;
}

interface JellyfinMediaSource {
  Id?: string;
  Name?: string;
  Container?: string;
  Bitrate?: number;
  Size?: number;
  ETag?: string;
  MediaStreams?: JellyfinMediaStream[];
}

interface JellyfinItem {
  Id?: string;
  Name?: string;
  Type?: string;
  Overview?: string;
  ProductionYear?: number;
  RunTimeTicks?: number;
  ParentId?: string;
  SeriesName?: string;
  SeasonName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  CollectionType?: string;
  ImageTags?: Record<string, string>;
  MediaSources?: JellyfinMediaSource[];
  MediaStreams?: JellyfinMediaStream[];
  RecursiveItemCount?: number;
  ChildCount?: number;
  LocationType?: string;
  IsPlaceHolder?: boolean;
  UserData?: {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
  };
}

function isPlayableCatalogItem(item: JellyfinItem): boolean {
  if (item.IsPlaceHolder || item.LocationType === 'Virtual') return false;
  if (item.Type === 'Movie' || item.Type === 'Episode') return (item.MediaSources?.length ?? 0) > 0;
  if (item.Type === 'Series' || item.Type === 'Season') {
    const descendants = item.RecursiveItemCount ?? item.ChildCount;
    return descendants === undefined || descendants > 0;
  }
  return true;
}

interface JellyfinItemsResult {
  Items?: JellyfinItem[];
  TotalRecordCount?: number;
}

export interface JellyfinProviderOptions {
  resolveTarget?: (rawUrl: string) => Promise<PinnedProviderTarget>;
  requestConnector?: JellyfinRequestConnector;
  requestTimeoutMs?: number;
}

export interface JellyfinConnectorRequest {
  url: URL;
  options: RequestOptions;
  body?: string;
}

export type JellyfinRequestConnector = (
  request: JellyfinConnectorRequest
) => Promise<IncomingMessage>;

const nodeRequestConnector: JellyfinRequestConnector = ({ url, options, body }) =>
  new Promise<IncomingMessage>((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = request(url, options, resolve);
    outgoing.once('error', reject);
    outgoing.end(body);
  });

async function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class JellyfinProvider implements MediaProvider {
  readonly #applicationVersion: string;
  readonly #resolveTarget: (rawUrl: string) => Promise<PinnedProviderTarget>;
  readonly #requestConnector: JellyfinRequestConnector;
  readonly #requestTimeoutMs: number;

  constructor(applicationVersion = '0.1.0', options: JellyfinProviderOptions = {}) {
    this.#applicationVersion = applicationVersion;
    this.#resolveTarget = options.resolveTarget ?? resolveProviderRequestTarget;
    this.#requestConnector = options.requestConnector ?? nodeRequestConnector;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }
  readonly type = 'jellyfin' as const;
  readonly capabilities = [
    'search',
    'hierarchy',
    'multiple_versions',
    'activity_reporting',
    'artwork',
    'external_subtitles',
    'direct_source'
  ] as const satisfies readonly ProviderCapability[];

  async authenticate(
    baseUrl: string,
    credentials: ProviderCredentials,
    signal?: AbortSignal,
    transportPolicy: ProviderTransportPolicy = { allowPublicHttp: false }
  ): Promise<ProviderIdentity> {
    const system = await this.#request<JellyfinSystemInfo>(baseUrl, '/System/Info/Public', {
      signal,
      allowPublicHttp: transportPolicy.allowPublicHttp
    });

    if (credentials.apiKey) {
      await this.#request(baseUrl, '/System/Info', {
        token: credentials.apiKey,
        signal,
        allowPublicHttp: transportPolicy.allowPublicHttp
      });
      return {
        accessToken: credentials.apiKey,
        serverName: system.ServerName ?? 'Jellyfin',
        serverVersion: system.Version ?? 'unknown'
      };
    }

    if (!credentials.username || !credentials.password) {
      throw new Error('Jellyfin username and password are required');
    }
    const result = await this.#request<JellyfinAuthResult>(baseUrl, '/Users/AuthenticateByName', {
      method: 'POST',
      signal,
      allowPublicHttp: transportPolicy.allowPublicHttp,
      body: { Username: credentials.username, Pw: credentials.password }
    });
    if (!result.AccessToken || !result.User?.Id)
      throw new Error('Jellyfin did not return an access token');
    return {
      userId: result.User.Id,
      username: result.User.Name ?? credentials.username,
      accessToken: result.AccessToken,
      serverName: system.ServerName ?? 'Jellyfin',
      serverVersion: system.Version ?? 'unknown'
    };
  }

  async validate(
    connection: ProviderConnection,
    secret: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.#request(connection.baseUrl, '/System/Info', {
      token: secret,
      signal,
      allowPublicHttp: providerAllowsPublicHttp(connection)
    });
  }

  async browse(
    connection: ProviderConnection,
    secret: string,
    query: CatalogQuery,
    signal?: AbortSignal
  ): Promise<{ items: MediaItem[]; total: number }> {
    const params = new URLSearchParams({
      Recursive: query.parentId ? 'false' : 'true',
      Fields: 'Overview,MediaSources,MediaStreams,PrimaryImageAspectRatio',
      EnableImages: 'true',
      ExcludeLocationTypes: 'Virtual',
      IsMissing: 'false',
      IsPlaceHolder: 'false',
      StartIndex: String(query.offset ?? 0),
      Limit: String(query.limit ?? 50),
      SortBy: query.search ? 'SortName' : 'DateCreated,SortName',
      SortOrder: 'Descending'
    });
    if (query.parentId) params.set('ParentId', query.parentId);
    if (query.search) params.set('SearchTerm', query.search);
    if ((query.kinds?.length ?? 0) > 0) params.set('IncludeItemTypes', query.kinds.join(','));
    let path = connection.userId ? `/Users/${connection.userId}/Items` : '/Items';
    if (query.section === 'continue_watching' && connection.userId) {
      path = `/Users/${connection.userId}/Items/Resume`;
      params.set('MediaTypes', 'Video');
    } else if (query.section === 'next_up' && connection.userId) {
      path = '/Shows/NextUp';
      params.set('UserId', connection.userId);
    } else if (query.section === 'recently_added') {
      params.set('Recursive', 'true');
      if ((query.kinds?.length ?? 0) === 0) params.set('IncludeItemTypes', 'Movie,Episode');
    }
    const result = await this.#request<JellyfinItemsResult>(
      connection.baseUrl,
      `${path}?${params}`,
      {
        token: secret,
        signal,
        allowPublicHttp: providerAllowsPublicHttp(connection)
      }
    );
    return {
      items: (result.Items ?? [])
        .filter(isPlayableCatalogItem)
        .map((item) => this.#mapItem(connection.id, item)),
      total: result.TotalRecordCount ?? 0
    };
  }

  async item(
    connection: ProviderConnection,
    secret: string,
    itemId: string,
    signal?: AbortSignal
  ): Promise<MediaItem> {
    const params = new URLSearchParams({ Fields: 'Overview,MediaSources,MediaStreams' });
    const path = connection.userId
      ? `/Users/${connection.userId}/Items/${encodeURIComponent(itemId)}`
      : `/Items/${encodeURIComponent(itemId)}`;
    return this.#mapItem(
      connection.id,
      await this.#request<JellyfinItem>(connection.baseUrl, `${path}?${params}`, {
        token: secret,
        signal,
        allowPublicHttp: providerAllowsPublicHttp(connection)
      })
    );
  }

  async artwork(
    connection: ProviderConnection,
    secret: string,
    itemId: string,
    signal?: AbortSignal
  ): Promise<MediaArtwork> {
    const params = new URLSearchParams({ fillWidth: '640', quality: '90' });
    const response = await this.#send(
      `${connection.baseUrl.replace(/\/$/, '')}/Items/${encodeURIComponent(itemId)}/Images/Primary?${params}`,
      {
        headers: {
          Accept: 'image/*',
          Authorization: this.#authorization(secret),
          'X-Emby-Token': secret
        },
        ...(signal ? { signal } : {}),
        allowPublicHttp: providerAllowsPublicHttp(connection)
      }
    );
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      response.resume();
      throw new Error('Jellyfin redirects are not allowed; configure the canonical server URL');
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`Jellyfin artwork request failed (${status})`);
    }
    const headers = response.headers as Record<string, string | string[] | undefined>;
    const header = headers['content-type'];
    const contentTypeValue = typeof header === 'string' ? header : header?.[0];
    const contentType = contentTypeValue?.split(';', 1)[0]?.trim();
    if (!contentType?.startsWith('image/')) {
      response.resume();
      throw new Error('Jellyfin artwork response was not an image');
    }
    return { data: await this.#readBinary(response), contentType };
  }

  async resolveSource(
    connection: ProviderConnection,
    secret: string,
    source: MediaSourceRef,
    signal?: AbortSignal
  ): Promise<ResolvedSource> {
    const item = await this.item(connection, secret, source.itemId, signal);
    const version =
      item.versions?.find((candidate) => candidate.id === source.versionId) ?? item.versions?.[0];
    const params = new URLSearchParams({ static: 'true' });
    if (version?.id) params.set('MediaSourceId', version.id);
    const selectedAudio = item.audioTracks?.find((track) => track.id === source.audioTrackId);
    const selectedSubtitle = item.subtitleTracks?.find(
      (track) => track.id === source.subtitleTrackId
    );
    return {
      url: `${connection.baseUrl}/Videos/${encodeURIComponent(source.itemId)}/stream?${params}`,
      headers: { 'X-Emby-Token': secret },
      durationSeconds: item.durationSeconds ?? 0,
      fingerprint:
        source.sourceFingerprint ??
        version?.fingerprint ??
        createHash('sha256')
          .update(
            `${connection.id}:${source.itemId}:${version?.id ?? 'default'}:${item.durationSeconds ?? 0}`
          )
          .digest('hex'),
      ...(version?.container ? { container: version.container } : {}),
      ...(selectedAudio ? { defaultAudio: selectedAudio.index } : {}),
      ...(selectedSubtitle ? { defaultSubtitle: selectedSubtitle.index } : {}),
      ...(providerAllowsPublicHttp(connection) ? { allowPublicHttp: true } : {})
    };
  }

  async openSource(source: ResolvedSource, range?: string, signal?: AbortSignal) {
    const response = await this.#send(source.url, {
      headers: { ...source.headers, ...(range ? { Range: range } : {}) },
      allowPublicHttp: source.allowPublicHttp === true,
      streamingResponse: true,
      ...(signal ? { signal } : {})
    });
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      response.resume();
      throw new Error('Jellyfin redirects are not allowed; configure the canonical server URL');
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`Jellyfin source request failed (${status})`);
    }
    const headers: Record<string, string> = {};
    for (const name of ['accept-ranges', 'content-length', 'content-range', 'content-type']) {
      const value = response.headers[name];
      if (typeof value === 'string') headers[name] = value;
      else if (Array.isArray(value) && value[0]) headers[name] = value[0];
    }
    return { stream: response as Readable, status, headers };
  }

  async reportPlayback(
    connection: ProviderConnection,
    secret: string,
    event: PlaybackEvent,
    signal?: AbortSignal
  ): Promise<void> {
    const endpoint =
      event.event === 'start'
        ? '/Sessions/Playing'
        : event.event === 'stop'
          ? '/Sessions/Playing/Stopped'
          : '/Sessions/Playing/Progress';
    await this.#request(connection.baseUrl, endpoint, {
      method: 'POST',
      token: secret,
      signal,
      allowPublicHttp: providerAllowsPublicHttp(connection),
      body: {
        ItemId: event.itemId,
        PositionTicks: event.positionTicks,
        IsPaused: event.paused,
        PlayMethod: 'Transcode',
        CanSeek: true
      }
    });
  }

  #mapItem(providerId: string, item: JellyfinItem): MediaItem {
    const streams = item.MediaStreams ?? item.MediaSources?.[0]?.MediaStreams ?? [];
    const video = streams.find((stream) => stream.Type === 'Video');
    const versions: MediaVersion[] = (item.MediaSources ?? []).map((source, index) => {
      const sourceVideo = source.MediaStreams?.find((stream) => stream.Type === 'Video');
      const sourceAudio = source.MediaStreams?.find((stream) => stream.Type === 'Audio');
      return {
        id: source.Id ?? String(index),
        name: source.Name ?? source.Container ?? `Version ${index + 1}`,
        ...(source.Container ? { container: source.Container } : {}),
        ...(sourceVideo?.Codec ? { videoCodec: sourceVideo.Codec } : {}),
        ...(sourceAudio?.Codec ? { audioCodec: sourceAudio.Codec } : {}),
        ...(source.Bitrate ? { bitrate: source.Bitrate } : {}),
        ...(sourceVideo?.Width ? { width: sourceVideo.Width } : {}),
        ...(sourceVideo?.Height ? { height: sourceVideo.Height } : {}),
        fingerprint:
          source.ETag ?? `${source.Id ?? index}:${source.Size ?? 0}:${source.Bitrate ?? 0}`
      };
    });
    const mapTrack = (stream: JellyfinMediaStream, kind: 'audio' | 'subtitle'): MediaTrack => ({
      id: `${kind}:${stream.Index ?? 0}`,
      index: stream.Index ?? 0,
      kind,
      title:
        stream.DisplayTitle ?? stream.Title ?? stream.Language ?? `${kind} ${stream.Index ?? 0}`,
      ...(stream.Language ? { language: stream.Language } : {}),
      ...(stream.Codec ? { codec: stream.Codec } : {}),
      ...(stream.Channels ? { channels: stream.Channels } : {}),
      external: stream.IsExternal ?? false,
      isDefault: stream.IsDefault ?? false,
      isForced: stream.IsForced ?? false
    });
    const firstAudio = streams.find((stream) => stream.Type === 'Audio');
    return {
      id: item.Id ?? '',
      providerId,
      name: item.Name ?? 'Untitled',
      kind: item.Type ?? 'Unknown',
      ...(item.Overview ? { overview: item.Overview } : {}),
      ...(item.ProductionYear ? { productionYear: item.ProductionYear } : {}),
      ...(item.RunTimeTicks ? { durationSeconds: item.RunTimeTicks / 10_000_000 } : {}),
      ...(item.UserData?.PlaybackPositionTicks
        ? { playbackPositionSeconds: item.UserData.PlaybackPositionTicks / 10_000_000 }
        : {}),
      ...(item.UserData?.PlayedPercentage !== undefined
        ? { playedPercentage: item.UserData.PlayedPercentage }
        : {}),
      ...(item.ParentId ? { parentId: item.ParentId } : {}),
      ...(item.SeriesName ? { seriesName: item.SeriesName } : {}),
      ...(item.SeasonName ? { seasonName: item.SeasonName } : {}),
      ...(item.IndexNumber !== undefined ? { indexNumber: item.IndexNumber } : {}),
      ...(item.ParentIndexNumber !== undefined
        ? { parentIndexNumber: item.ParentIndexNumber }
        : {}),
      ...(item.CollectionType ? { collectionType: item.CollectionType } : {}),
      ...(video?.Codec ? { videoCodec: video.Codec } : {}),
      ...(firstAudio?.Codec ? { audioCodec: firstAudio.Codec } : {}),
      ...(video?.Width ? { width: video.Width } : {}),
      ...(video?.Height ? { height: video.Height } : {}),
      ...(video?.VideoRangeType ? { hdr: video.VideoRangeType } : {}),
      versions,
      audioTracks: streams
        .filter((stream) => stream.Type === 'Audio')
        .map((stream) => mapTrack(stream, 'audio')),
      subtitleTracks: streams
        .filter((stream) => stream.Type === 'Subtitle')
        .map((stream) => mapTrack(stream, 'subtitle'))
    };
  }

  async #request<T = unknown>(
    baseUrl: string,
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: unknown;
      signal?: AbortSignal | undefined;
      allowPublicHttp?: boolean;
    } = {}
  ): Promise<T> {
    const response = await this.#send(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: this.#authorization(options.token),
        ...(options.token ? { 'X-Emby-Token': options.token } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      allowPublicHttp: options.allowPublicHttp === true
    });
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      response.resume();
      throw new Error('Jellyfin redirects are not allowed; configure the canonical server URL');
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`Jellyfin request failed (${status})`);
    }
    if (status === 204) {
      response.resume();
      return undefined as T;
    }
    return this.#readJson<T>(response);
  }

  async #send(
    rawUrl: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
      allowPublicHttp?: boolean;
      streamingResponse?: boolean;
    }
  ): Promise<IncomingMessage> {
    // Resolve and validate immediately before opening the socket, then make
    // Node's connector use only that result. Host and TLS SNI remain bound to
    // the administrator-approved hostname while DNS cannot be queried again.
    const streamingTimeout = options.streamingResponse ? new AbortController() : undefined;
    const timeoutHandle = streamingTimeout
      ? setTimeout(() => streamingTimeout.abort(), this.#requestTimeoutMs)
      : undefined;
    timeoutHandle?.unref();
    const timeoutSignal = streamingTimeout?.signal ?? AbortSignal.timeout(this.#requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    try {
      const target = await awaitWithSignal(this.#resolveTarget(rawUrl), signal);
      if (
        target.url.protocol === 'http:' &&
        !target.privateNetwork &&
        options.allowPublicHttp !== true
      )
        throw new Error('Jellyfin public HTTP transport requires explicit unsafe approval');
      const hostname = target.url.hostname.replace(/^\[|\]$/g, '');
      const headers = Object.fromEntries(
        Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'host')
      );
      headers.Host = target.url.host;
      try {
        return await this.#requestConnector({
          url: target.url,
          options: {
            method: options.method ?? 'GET',
            headers,
            agent: false,
            signal,
            ...(target.url.protocol === 'https:' && isIP(hostname) === 0
              ? { servername: hostname }
              : {}),
            lookup: (_hostname, lookupOptions, callback) => {
              if (lookupOptions.all) {
                callback(null, [{ address: target.address, family: target.family }]);
                return;
              }
              callback(null, target.address, target.family);
            }
          },
          ...(options.body ? { body: options.body } : {})
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'request_error';
        throw new Error(`Jellyfin transport failed (${code})`, { cause: error });
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async #readJson<T>(response: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > 16 * 1024 * 1024) {
        response.destroy();
        throw new Error('Jellyfin response exceeded the 16 MiB JSON limit');
      }
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  }

  async #readBinary(response: IncomingMessage): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > 8 * 1024 * 1024) {
        response.destroy();
        throw new Error('Jellyfin artwork exceeded the 8 MiB limit');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  #authorization(token?: string): string {
    const fields = [
      'Client="VRRelay"',
      'Device="VRRelay Server"',
      'DeviceId="vrrelay-server"',
      `Version="${this.#applicationVersion}"`
    ];
    if (token) fields.push(`Token="${token}"`);
    return `MediaBrowser ${fields.join(', ')}`;
  }
}
