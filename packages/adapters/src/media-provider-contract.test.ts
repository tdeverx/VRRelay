// SPDX-License-Identifier: GPL-3.0-or-later
import type { IncomingMessage, RequestOptions } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type {
  MediaProvider,
  PlaybackEvent,
  ProviderCredentials,
  ProviderIdentity,
  ResolvedSource,
  SourceResponse
} from '@vrrelay/application';
import type { CatalogQuery } from '@vrrelay/contracts';
import {
  MediaItemSchema,
  ProviderCapabilitySchema,
  ProviderTypeSchema,
  type MediaItem,
  type MediaSourceRef,
  type ProviderConnection
} from '@vrrelay/domain';
import {
  JellyfinProvider,
  type JellyfinConnectorRequest,
  type JellyfinRequestConnector
} from './jellyfin-provider.js';

const BASE_IDENTITY = {
  userId: 'contract-user',
  username: 'Contract User',
  serverName: 'Contract Media Server',
  serverVersion: '1.2.3'
} as const;
const USER_CREDENTIALS = {
  username: 'contract-user',
  password: 'test-only-password'
} as const;
const VALID_SECRET = 'test-only-access-value';
const INVALID_SECRET = 'invalid-test-only-access-value';
const SOURCE_BYTES = Buffer.from('VRRelay provider contract source fixture', 'utf8');

interface PlaybackObservation {
  itemId: string;
  positionTicks: number;
  paused: boolean;
  event: PlaybackEvent['event'];
}

interface MediaProviderContractFixture {
  provider: MediaProvider;
  baseUrl: string;
  connection: ProviderConnection;
  secret: string;
  playback: PlaybackObservation[];
}

interface MediaProviderContractHarness {
  name: string;
  create(): MediaProviderContractFixture;
}

function contractItems(providerId: string): MediaItem[] {
  const movie = {
    id: 'movie-1',
    providerId,
    name: 'Contract Movie',
    kind: 'Movie',
    overview: 'A synthetic provider-contract item.',
    productionYear: 2026,
    durationSeconds: 120,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    versions: [
      {
        id: 'version-direct',
        name: 'Direct',
        container: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        bitrate: 4_000_000,
        width: 1920,
        height: 1080,
        fingerprint: 'version-direct-etag'
      },
      {
        id: 'version-remux',
        name: 'Remux',
        container: 'mkv',
        videoCodec: 'h264',
        audioCodec: 'aac',
        bitrate: 8_000_000,
        width: 1920,
        height: 1080,
        fingerprint: 'version-remux-etag'
      }
    ],
    audioTracks: [
      {
        id: 'audio:1',
        index: 1,
        kind: 'audio',
        title: 'English stereo',
        language: 'eng',
        codec: 'aac',
        channels: 2,
        isDefault: true
      },
      {
        id: 'audio:2',
        index: 2,
        kind: 'audio',
        title: 'Commentary',
        language: 'eng',
        codec: 'aac',
        channels: 2,
        isDefault: false
      }
    ],
    subtitleTracks: [
      {
        id: 'subtitle:3',
        index: 3,
        kind: 'subtitle',
        title: 'English external',
        language: 'eng',
        codec: 'srt',
        external: true,
        isDefault: true,
        isForced: false
      }
    ]
  } satisfies MediaItem;
  return [
    movie,
    {
      id: 'series-1',
      providerId,
      name: 'Contract Series',
      kind: 'Series',
      collectionType: 'tvshows'
    },
    {
      id: 'season-1',
      providerId,
      name: 'Season 1',
      kind: 'Season',
      parentId: 'series-1',
      seriesName: 'Contract Series',
      indexNumber: 1
    },
    {
      ...movie,
      id: 'episode-1',
      name: 'Contract Episode',
      kind: 'Episode',
      parentId: 'season-1',
      seriesName: 'Contract Series',
      seasonName: 'Season 1',
      indexNumber: 1,
      parentIndexNumber: 1
    }
  ];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Provider operation aborted');
}

function sourceRange(range: string | undefined, size: number): { start: number; end: number } {
  if (!range) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) throw new Error('Provider source range is invalid');
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || start < 0 || start >= size)
    throw new Error('Provider source range is unsatisfiable');
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function sourceResponse(range?: string): SourceResponse {
  const { start, end } = sourceRange(range, SOURCE_BYTES.length);
  const partial = range !== undefined;
  const selected = SOURCE_BYTES.subarray(start, end + 1);
  return {
    stream: Readable.from([selected]),
    status: partial ? 206 : 200,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(selected.length),
      'content-type': 'application/octet-stream',
      ...(partial ? { 'content-range': `bytes ${start}-${end}/${SOURCE_BYTES.length}` } : {})
    }
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function sanitizedError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class InMemoryFakeMediaProvider implements MediaProvider {
  readonly type = 'fake' as const;
  readonly capabilities = [
    'search',
    'hierarchy',
    'multiple_versions',
    'activity_reporting',
    'external_subtitles',
    'direct_source'
  ] as const;
  readonly playback: PlaybackObservation[] = [];
  readonly #baseUrl: string;
  readonly #items: MediaItem[];

  constructor(baseUrl: string, providerId: string) {
    this.#baseUrl = baseUrl;
    this.#items = contractItems(providerId);
  }

  async authenticate(
    baseUrl: string,
    credentials: ProviderCredentials,
    signal?: AbortSignal
  ): Promise<ProviderIdentity> {
    throwIfAborted(signal);
    if (baseUrl !== this.#baseUrl) throw new Error('Provider endpoint is not recognized');
    if (credentials.apiKey) {
      if (credentials.apiKey !== VALID_SECRET) throw new Error('Provider authentication failed');
      return { ...BASE_IDENTITY, accessToken: VALID_SECRET };
    }
    if (
      credentials.username !== USER_CREDENTIALS.username ||
      credentials.password !== USER_CREDENTIALS.password
    )
      throw new Error('Provider authentication failed');
    return { ...BASE_IDENTITY, accessToken: VALID_SECRET };
  }

  async validate(
    connection: ProviderConnection,
    secret: string,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    if (connection.baseUrl !== this.#baseUrl || secret !== VALID_SECRET)
      throw new Error('Provider validation failed');
  }

  async browse(
    connection: ProviderConnection,
    secret: string,
    query: CatalogQuery,
    signal?: AbortSignal
  ): Promise<{ items: MediaItem[]; total: number }> {
    await this.validate(connection, secret, signal);
    let matches = this.#items;
    if (query.parentId) matches = matches.filter((item) => item.parentId === query.parentId);
    else matches = matches.filter((item) => !item.parentId);
    if (query.search) {
      const search = query.search.toLocaleLowerCase();
      matches = matches.filter((item) => item.name.toLocaleLowerCase().includes(search));
    }
    if (query.kinds.length > 0) matches = matches.filter((item) => query.kinds.includes(item.kind));
    return {
      items: structuredClone(matches.slice(query.offset, query.offset + query.limit)),
      total: matches.length
    };
  }

  async item(
    connection: ProviderConnection,
    secret: string,
    itemId: string,
    signal?: AbortSignal
  ): Promise<MediaItem> {
    await this.validate(connection, secret, signal);
    const item = this.#items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('Provider item was not found');
    return structuredClone(item);
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
    const audio = item.audioTracks?.find((track) => track.id === source.audioTrackId);
    const subtitle = item.subtitleTracks?.find((track) => track.id === source.subtitleTrackId);
    return {
      url: `${connection.baseUrl}/source/${encodeURIComponent(item.id)}?version=${encodeURIComponent(version?.id ?? 'default')}`,
      headers: { Authorization: `Bearer ${secret}` },
      durationSeconds: item.durationSeconds ?? 0,
      fingerprint:
        source.sourceFingerprint ?? version?.fingerprint ?? `${connection.id}:${item.id}`,
      ...(version?.container ? { container: version.container } : {}),
      ...(audio ? { defaultAudio: audio.index } : {}),
      ...(subtitle ? { defaultSubtitle: subtitle.index } : {})
    };
  }

  async openSource(
    source: ResolvedSource,
    range?: string,
    signal?: AbortSignal
  ): Promise<SourceResponse> {
    throwIfAborted(signal);
    if (!source.url.startsWith(`${this.#baseUrl}/source/`))
      throw new Error('Provider source is not recognized');
    if (source.headers.Authorization !== `Bearer ${VALID_SECRET}`)
      throw new Error('Provider source access failed');
    return sourceResponse(range);
  }

  async reportPlayback(
    connection: ProviderConnection,
    secret: string,
    event: PlaybackEvent,
    signal?: AbortSignal
  ): Promise<void> {
    await this.validate(connection, secret, signal);
    this.playback.push({
      itemId: event.itemId,
      positionTicks: event.positionTicks,
      paused: event.paused,
      event: event.event
    });
  }
}

function requestHeader(options: RequestOptions, name: string): string | undefined {
  const headers = options.headers;
  if (!headers || Array.isArray(headers)) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  if (Array.isArray(value)) return value[0];
  if (value === undefined) return undefined;
  return String(value);
}

function incomingResponse(
  statusCode: number,
  body = '',
  headers: IncomingMessage['headers'] = {}
): IncomingMessage {
  return Object.assign(Readable.from(body ? [body] : []), {
    statusCode,
    headers
  }) as IncomingMessage;
}

function jsonResponse(statusCode: number, body: unknown): IncomingMessage {
  return incomingResponse(statusCode, JSON.stringify(body), {
    'content-type': 'application/json'
  });
}

function jellyfinItem(itemId: string): Record<string, unknown> | undefined {
  const item = contractItems('jellyfin-contract').find((candidate) => candidate.id === itemId);
  if (!item) return undefined;
  const mediaStreams = [
    {
      Index: 0,
      Type: 'Video',
      Codec: 'h264',
      DisplayTitle: 'H.264 1080p',
      Width: 1920,
      Height: 1080
    },
    {
      Index: 1,
      Type: 'Audio',
      Codec: 'aac',
      Language: 'eng',
      DisplayTitle: 'English stereo',
      Channels: 2,
      IsDefault: true
    },
    {
      Index: 2,
      Type: 'Audio',
      Codec: 'aac',
      Language: 'eng',
      DisplayTitle: 'Commentary',
      Channels: 2,
      IsDefault: false
    },
    {
      Index: 3,
      Type: 'Subtitle',
      Codec: 'srt',
      Language: 'eng',
      DisplayTitle: 'English external',
      IsExternal: true,
      IsDefault: true,
      IsForced: false
    }
  ];
  return {
    Id: item.id,
    Name: item.name,
    Type: item.kind,
    Overview: item.overview,
    ProductionYear: item.productionYear,
    RunTimeTicks: (item.durationSeconds ?? 0) * 10_000_000,
    ParentId: item.parentId,
    SeriesName: item.seriesName,
    SeasonName: item.seasonName,
    IndexNumber: item.indexNumber,
    ParentIndexNumber: item.parentIndexNumber,
    CollectionType: item.collectionType,
    MediaStreams: mediaStreams,
    MediaSources: [
      {
        Id: 'version-direct',
        Name: 'Direct',
        Container: 'mp4',
        Bitrate: 4_000_000,
        Size: 60_000_000,
        ETag: 'version-direct-etag',
        MediaStreams: mediaStreams
      },
      {
        Id: 'version-remux',
        Name: 'Remux',
        Container: 'mkv',
        Bitrate: 8_000_000,
        Size: 120_000_000,
        ETag: 'version-remux-etag',
        MediaStreams: mediaStreams
      }
    ]
  };
}

class FakeJellyfinHttpServer {
  readonly playback: PlaybackObservation[] = [];

  readonly connector: JellyfinRequestConnector = async (request) => {
    if (request.options.signal?.aborted) {
      const error = new Error('The local fixture request was aborted') as NodeJS.ErrnoException;
      error.code = 'ABORT_ERR';
      throw error;
    }
    const method = request.options.method ?? 'GET';
    const path = request.url.pathname;
    if (method === 'GET' && path === '/System/Info/Public') {
      return jsonResponse(200, {
        ServerName: BASE_IDENTITY.serverName,
        Version: BASE_IDENTITY.serverVersion
      });
    }
    if (method === 'POST' && path === '/Users/AuthenticateByName') {
      const body = JSON.parse(request.body ?? '{}') as { Username?: string; Pw?: string };
      if (body.Username !== USER_CREDENTIALS.username || body.Pw !== USER_CREDENTIALS.password)
        return incomingResponse(401);
      return jsonResponse(200, {
        AccessToken: VALID_SECRET,
        User: { Id: BASE_IDENTITY.userId, Name: BASE_IDENTITY.username }
      });
    }
    if (requestHeader(request.options, 'X-Emby-Token') !== VALID_SECRET)
      return incomingResponse(401);
    if (method === 'GET' && path === '/System/Info') return incomingResponse(204);
    if (method === 'GET' && path === `/Users/${BASE_IDENTITY.userId}/Items`) {
      return this.#browse(request.url);
    }
    const itemPrefix = `/Users/${BASE_IDENTITY.userId}/Items/`;
    if (method === 'GET' && path.startsWith(itemPrefix)) {
      const item = jellyfinItem(decodeURIComponent(path.slice(itemPrefix.length)));
      return item ? jsonResponse(200, item) : incomingResponse(404);
    }
    if (method === 'GET' && path === '/Videos/movie-1/stream') {
      return this.#source(request);
    }
    if (method === 'POST' && path.startsWith('/Sessions/Playing')) {
      return this.#playback(request);
    }
    return incomingResponse(404);
  };

  #browse(url: URL): IncomingMessage {
    const parentId = url.searchParams.get('ParentId') ?? undefined;
    const search = url.searchParams.get('SearchTerm')?.toLocaleLowerCase();
    const kinds = (url.searchParams.get('IncludeItemTypes') ?? '').split(',').filter(Boolean);
    const start = Number(url.searchParams.get('StartIndex') ?? 0);
    const limit = Number(url.searchParams.get('Limit') ?? 50);
    let items = contractItems('jellyfin-contract');
    if (parentId) items = items.filter((item) => item.parentId === parentId);
    else items = items.filter((item) => !item.parentId);
    if (search) items = items.filter((item) => item.name.toLocaleLowerCase().includes(search));
    if (kinds.length > 0) items = items.filter((item) => kinds.includes(item.kind));
    return jsonResponse(200, {
      Items: items.slice(start, start + limit).map((item) => jellyfinItem(item.id)),
      TotalRecordCount: items.length
    });
  }

  #source(request: JellyfinConnectorRequest): IncomingMessage {
    const range = requestHeader(request.options, 'Range');
    const result = sourceResponse(range);
    const headers = result.headers;
    return Object.assign(result.stream, {
      statusCode: result.status,
      headers
    }) as IncomingMessage;
  }

  #playback(request: JellyfinConnectorRequest): IncomingMessage {
    const body = JSON.parse(request.body ?? '{}') as {
      ItemId?: string;
      PositionTicks?: number;
      IsPaused?: boolean;
    };
    const event: PlaybackEvent['event'] = request.url.pathname.endsWith('/Stopped')
      ? 'stop'
      : request.url.pathname.endsWith('/Progress')
        ? 'progress'
        : 'start';
    if (
      typeof body.ItemId !== 'string' ||
      typeof body.PositionTicks !== 'number' ||
      typeof body.IsPaused !== 'boolean'
    )
      return incomingResponse(400);
    this.playback.push({
      itemId: body.ItemId,
      positionTicks: body.PositionTicks,
      paused: body.IsPaused,
      event
    });
    return incomingResponse(204);
  }
}

function connection(provider: MediaProvider, id: string, baseUrl: string): ProviderConnection {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return {
    id,
    type: provider.type,
    name: `${id} provider`,
    baseUrl,
    authMode: 'user_token',
    secretRef: `provider:${id}`,
    userId: BASE_IDENTITY.userId,
    username: BASE_IDENTITY.username,
    serverName: BASE_IDENTITY.serverName,
    serverVersion: BASE_IDENTITY.serverVersion,
    capabilities: [...provider.capabilities],
    healthy: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function fakeHarness(): MediaProviderContractFixture {
  const baseUrl = 'https://fake.contract.invalid';
  const provider = new InMemoryFakeMediaProvider(baseUrl, 'fake-contract');
  return {
    provider,
    baseUrl,
    connection: connection(provider, 'fake-contract', baseUrl),
    secret: VALID_SECRET,
    playback: provider.playback
  };
}

function jellyfinHarness(): MediaProviderContractFixture {
  const baseUrl = 'https://jellyfin.contract.invalid';
  const server = new FakeJellyfinHttpServer();
  const provider = new JellyfinProvider('contract-test', {
    resolveTarget: async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.origin !== baseUrl) throw new Error('Local fixture received an unexpected origin');
      return {
        url,
        address: '203.0.113.10',
        family: 4,
        privateNetwork: false
      };
    },
    requestConnector: server.connector
  });
  return {
    provider,
    baseUrl,
    connection: connection(provider, 'jellyfin-contract', baseUrl),
    secret: VALID_SECRET,
    playback: server.playback
  };
}

function mediaProviderContract(harness: MediaProviderContractHarness): void {
  describe(`${harness.name} MediaProvider contract`, () => {
    it('publishes valid, unique capability metadata', () => {
      const { provider } = harness.create();
      expect(ProviderTypeSchema.safeParse(provider.type).success).toBe(true);
      expect(ProviderCapabilitySchema.array().safeParse(provider.capabilities).success).toBe(true);
      expect(new Set(provider.capabilities).size).toBe(provider.capabilities.length);
      expect(provider.capabilities).toEqual(
        expect.arrayContaining([
          'search',
          'hierarchy',
          'multiple_versions',
          'activity_reporting',
          'external_subtitles',
          'direct_source'
        ])
      );
    });

    it('authenticates user and API-key modes and validates the resulting secret', async () => {
      const fixture = harness.create();
      const userIdentity = await fixture.provider.authenticate(fixture.baseUrl, USER_CREDENTIALS);
      expect(userIdentity).toMatchObject(BASE_IDENTITY);
      expect(userIdentity.accessToken === fixture.secret).toBe(true);

      const apiIdentity = await fixture.provider.authenticate(fixture.baseUrl, {
        apiKey: fixture.secret
      });
      expect(apiIdentity.serverName).toBe(BASE_IDENTITY.serverName);
      expect(apiIdentity.serverVersion).toBe(BASE_IDENTITY.serverVersion);
      expect(apiIdentity.accessToken === fixture.secret).toBe(true);
      await expect(
        fixture.provider.validate(fixture.connection, fixture.secret)
      ).resolves.toBeUndefined();
    });

    it('supports search, pagination, kind filters, and hierarchical browsing', async () => {
      const fixture = harness.create();
      const search = await fixture.provider.browse(fixture.connection, fixture.secret, {
        search: 'contract movie',
        kinds: ['Movie'],
        limit: 1,
        offset: 0
      });
      expect(search.total).toBe(1);
      expect(search.items).toHaveLength(1);
      expect(search.items[0]).toMatchObject({
        id: 'movie-1',
        providerId: fixture.connection.id,
        name: 'Contract Movie',
        kind: 'Movie'
      });
      expect(MediaItemSchema.safeParse(search.items[0]).success).toBe(true);

      const seasons = await fixture.provider.browse(fixture.connection, fixture.secret, {
        parentId: 'series-1',
        kinds: ['Season'],
        limit: 25,
        offset: 0
      });
      expect(seasons.total).toBe(1);
      expect(seasons.items[0]).toMatchObject({
        id: 'season-1',
        providerId: fixture.connection.id,
        parentId: 'series-1',
        kind: 'Season',
        indexNumber: 1
      });

      const episodes = await fixture.provider.browse(fixture.connection, fixture.secret, {
        parentId: 'season-1',
        kinds: ['Episode'],
        limit: 25,
        offset: 0
      });
      expect(episodes.total).toBe(1);
      expect(episodes.items[0]).toMatchObject({
        id: 'episode-1',
        providerId: fixture.connection.id,
        parentId: 'season-1',
        kind: 'Episode',
        seriesName: 'Contract Series',
        seasonName: 'Season 1',
        indexNumber: 1,
        parentIndexNumber: 1
      });
    });

    it('maps versions and tracks and resolves the explicitly selected source', async () => {
      const fixture = harness.create();
      const item = await fixture.provider.item(fixture.connection, fixture.secret, 'movie-1');
      expect(MediaItemSchema.safeParse(item).success).toBe(true);
      expect(item.versions?.map(({ id }) => id)).toEqual(['version-direct', 'version-remux']);
      expect(item.audioTracks?.map(({ id }) => id)).toEqual(['audio:1', 'audio:2']);
      expect(item.subtitleTracks).toEqual([
        expect.objectContaining({ id: 'subtitle:3', index: 3, external: true })
      ]);

      const source = await fixture.provider.resolveSource(fixture.connection, fixture.secret, {
        providerId: fixture.connection.id,
        itemId: item.id,
        versionId: 'version-remux',
        audioTrackId: 'audio:2',
        subtitleTrackId: 'subtitle:3'
      });
      expect(source).toMatchObject({
        durationSeconds: 120,
        fingerprint: 'version-remux-etag',
        container: 'mkv',
        defaultAudio: 2,
        defaultSubtitle: 3
      });
      expect(source.url).toContain(encodeURIComponent(item.id));
      expect(source.url).toContain(encodeURIComponent('version-remux'));
      expect(Object.keys(source.headers).length).toBeGreaterThan(0);

      const pinned = await fixture.provider.resolveSource(fixture.connection, fixture.secret, {
        providerId: fixture.connection.id,
        itemId: item.id,
        versionId: 'version-direct',
        sourceFingerprint: 'caller-pinned-fingerprint'
      });
      expect(pinned.fingerprint).toBe('caller-pinned-fingerprint');
    });

    it('opens complete and ranged source streams with provider-neutral metadata', async () => {
      const fixture = harness.create();
      const source = await fixture.provider.resolveSource(fixture.connection, fixture.secret, {
        providerId: fixture.connection.id,
        itemId: 'movie-1',
        versionId: 'version-direct'
      });
      const complete = await fixture.provider.openSource(source);
      expect(complete.status).toBe(200);
      expect(complete.headers).toMatchObject({
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream'
      });
      expect((await readAll(complete.stream)).equals(SOURCE_BYTES)).toBe(true);

      const ranged = await fixture.provider.openSource(source, 'bytes=2-7');
      expect(ranged.status).toBe(206);
      expect(ranged.headers['content-range']).toBe(`bytes 2-7/${SOURCE_BYTES.length}`);
      expect((await readAll(ranged.stream)).equals(SOURCE_BYTES.subarray(2, 8))).toBe(true);
    });

    it('reports the full playback lifecycle in order', async () => {
      const fixture = harness.create();
      const events: PlaybackEvent[] = [
        {
          sessionId: 'contract-session',
          itemId: 'movie-1',
          positionTicks: 0,
          paused: false,
          event: 'start'
        },
        {
          sessionId: 'contract-session',
          itemId: 'movie-1',
          positionTicks: 300_000_000,
          paused: true,
          event: 'progress'
        },
        {
          sessionId: 'contract-session',
          itemId: 'movie-1',
          positionTicks: 1_200_000_000,
          paused: false,
          event: 'stop'
        }
      ];
      for (const event of events) {
        await fixture.provider.reportPlayback(fixture.connection, fixture.secret, event);
      }
      expect(fixture.playback).toEqual(
        events.map(({ itemId, positionTicks, paused, event }) => ({
          itemId,
          positionTicks,
          paused,
          event
        }))
      );
    });

    it('honors cancellation and does not disclose rejected credentials', async () => {
      const fixture = harness.create();
      let failure = '';
      try {
        await fixture.provider.validate(fixture.connection, INVALID_SECRET);
      } catch (error) {
        failure = sanitizedError(error);
      }
      expect(failure.length).toBeGreaterThan(0);
      expect(failure.includes(INVALID_SECRET)).toBe(false);
      expect(failure.includes(fixture.baseUrl)).toBe(false);

      const controller = new AbortController();
      controller.abort();
      await expect(
        fixture.provider.item(fixture.connection, fixture.secret, 'movie-1', controller.signal)
      ).rejects.toThrow();
    });
  });
}

mediaProviderContract({ name: 'in-memory fake', create: fakeHarness });
mediaProviderContract({ name: 'Jellyfin local HTTP fixture', create: jellyfinHarness });
