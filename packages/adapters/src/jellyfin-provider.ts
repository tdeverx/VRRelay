// SPDX-License-Identifier: GPL-3.0-or-later
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type {
  MediaProvider,
  PlaybackEvent,
  ProviderCredentials,
  ProviderIdentity,
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
import type { CatalogQuery } from '@vrrelay/contracts';

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
  CollectionType?: string;
  ImageTags?: Record<string, string>;
  MediaSources?: JellyfinMediaSource[];
  MediaStreams?: JellyfinMediaStream[];
}

interface JellyfinItemsResult {
  Items?: JellyfinItem[];
  TotalRecordCount?: number;
}

export class JellyfinProvider implements MediaProvider {
  readonly #applicationVersion: string;

  constructor(applicationVersion = '0.1.0') {
    this.#applicationVersion = applicationVersion;
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
    signal?: AbortSignal
  ): Promise<ProviderIdentity> {
    const system = await this.#request<JellyfinSystemInfo>(baseUrl, '/System/Info/Public', {
      signal
    });

    if (credentials.apiKey) {
      await this.#request(baseUrl, '/System/Info', { token: credentials.apiKey, signal });
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
    await this.#request(connection.baseUrl, '/System/Info', { token: secret, signal });
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
      StartIndex: String(query.offset ?? 0),
      Limit: String(query.limit ?? 50),
      SortBy: query.search ? 'SortName' : 'DateCreated,SortName',
      SortOrder: 'Descending'
    });
    if (query.parentId) params.set('ParentId', query.parentId);
    if (query.search) params.set('SearchTerm', query.search);
    if ((query.kinds?.length ?? 0) > 0) params.set('IncludeItemTypes', query.kinds.join(','));
    const path = connection.userId ? `/Users/${connection.userId}/Items` : '/Items';
    const result = await this.#request<JellyfinItemsResult>(
      connection.baseUrl,
      `${path}?${params}`,
      {
        token: secret,
        signal
      }
    );
    return {
      items: (result.Items ?? []).map((item) => this.#mapItem(connection.id, item)),
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
        signal
      })
    );
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
      ...(selectedSubtitle ? { defaultSubtitle: selectedSubtitle.index } : {})
    };
  }

  async openSource(source: ResolvedSource, range?: string, signal?: AbortSignal) {
    const response = await fetch(source.url, {
      headers: { ...source.headers, ...(range ? { Range: range } : {}) },
      redirect: 'manual',
      ...(signal ? { signal } : {})
    });
    if (!response.ok || !response.body)
      throw new Error(`Jellyfin source request failed (${response.status})`);
    const headers: Record<string, string> = {};
    for (const name of ['accept-ranges', 'content-length', 'content-range', 'content-type']) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    return { stream: Readable.fromWeb(response.body as never), status: response.status, headers };
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
      ...(item.ParentId ? { parentId: item.ParentId } : {}),
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
    } = {}
  ): Promise<T> {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: options.method ?? 'GET',
      // A provider redirect must never forward its bearer token to another
      // origin or turn an administrator-approved provider into an SSRF hop.
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        Authorization: this.#authorization(options.token),
        ...(options.token ? { 'X-Emby-Token': options.token } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Jellyfin redirects are not allowed; configure the canonical server URL');
    }
    if (!response.ok) throw new Error(`Jellyfin request failed (${response.status})`);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
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
