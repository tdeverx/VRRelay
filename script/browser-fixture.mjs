// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateRoot = resolve(root, 'tmp/browser-e2e');
const dataDirectory = resolve(stateRoot, 'data');
const cacheDirectory = resolve(stateRoot, 'cache');

await rm(stateRoot, { recursive: true, force: true });
await mkdir(dataDirectory, { recursive: true });
await mkdir(cacheDirectory, { recursive: true });

const jellyfinItems = [
  {
    Id: 'movie-1',
    Name: 'Browser Movie',
    Type: 'Movie',
    Overview: 'A browser-test movie ready to relay.',
    ProductionYear: 2026,
    RunTimeTicks: 72_000_000_000,
    UserData: { PlaybackPositionTicks: 18_000_000_000, PlayedPercentage: 25 },
    ImageTags: { Primary: 'movie-image' },
    MediaSources: [{ Id: 'movie-source', Name: 'Original', Container: 'mkv' }]
  },
  {
    Id: 'series-1',
    Name: 'Browser Series',
    Type: 'Series',
    Overview: 'A browser-test series with episodic relay support.',
    ProductionYear: 2026,
    RecursiveItemCount: 2,
    ImageTags: { Primary: 'series-image' }
  },
  {
    Id: 'season-1',
    Name: 'Season 1',
    Type: 'Season',
    ParentId: 'series-1',
    SeriesName: 'Browser Series',
    IndexNumber: 1,
    RecursiveItemCount: 1,
    ImageTags: { Primary: 'season-image' }
  },
  {
    Id: 'episode-1',
    Name: 'The Browser Episode',
    Type: 'Episode',
    ParentId: 'season-1',
    SeriesName: 'Browser Series',
    SeasonName: 'Season 1',
    Overview: 'A browser-test episode with a full description.',
    IndexNumber: 2,
    ParentIndexNumber: 1,
    RunTimeTicks: 1_800_000_000,
    ImageTags: { Primary: 'episode-image' },
    MediaStreams: [
      { Index: 0, Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
      {
        Index: 1,
        Type: 'Audio',
        Codec: 'aac',
        Language: 'eng',
        DisplayTitle: 'English stereo',
        Channels: 2,
        IsDefault: true
      }
    ],
    MediaSources: [
      {
        Id: 'episode-source',
        Name: 'Original',
        Container: 'mkv',
        Bitrate: 4_000_000,
        ETag: 'browser-episode-etag',
        MediaStreams: [
          { Index: 0, Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
          {
            Index: 1,
            Type: 'Audio',
            Codec: 'aac',
            Language: 'eng',
            DisplayTitle: 'English stereo',
            Channels: 2,
            IsDefault: true
          }
        ]
      }
    ]
  },
  {
    Id: 'movie-empty',
    Name: 'Browser Empty Movie',
    Type: 'Movie',
    Overview: 'Metadata without a playable file.',
    MediaSources: []
  },
  {
    Id: 'series-empty',
    Name: 'Browser Empty Series',
    Type: 'Series',
    Overview: 'A show with no playable episodes.',
    RecursiveItemCount: 0
  }
];

const jellyfin = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:18202');
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  if (request.method === 'GET' && url.pathname === '/System/Info/Public') {
    send(200, { ServerName: 'Browser Jellyfin', Version: '10.11.0' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/Users/AuthenticateByName') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.Username !== 'browser-user' || body.Pw !== 'browser-password') {
      send(401, { message: 'Unauthorized' });
      return;
    }
    send(200, {
      AccessToken: 'browser-jellyfin-token',
      User: { Id: 'browser-user', Name: 'Browser User' }
    });
    return;
  }
  if (request.headers['x-emby-token'] !== 'browser-jellyfin-token') {
    send(401, { message: 'Unauthorized' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/System/Info') {
    send(200, { ServerName: 'Browser Jellyfin', Version: '10.11.0' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/Users/browser-user/Items/Resume') {
    send(200, { Items: [jellyfinItems[0]], TotalRecordCount: 1 });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/Shows/NextUp') {
    send(200, { Items: [jellyfinItems[3]], TotalRecordCount: 1 });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/Search/Hints') {
    const search = url.searchParams.get('SearchTerm')?.toLocaleLowerCase() ?? '';
    const kinds = (url.searchParams.get('IncludeItemTypes') ?? '').split(',').filter(Boolean);
    const matches = jellyfinItems.filter(
      (item) =>
        item.Name.toLocaleLowerCase().includes(search) &&
        (kinds.length === 0 || kinds.includes(item.Type))
    );
    send(200, {
      SearchHints: matches.map((item) => ({ ItemId: item.Id })),
      TotalRecordCount: matches.length
    });
    return;
  }
  if (request.method === 'GET' && /^\/Items\/[^/]+\/Images\/Primary$/.test(url.pathname)) {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length)
    });
    response.end(png);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/Users/browser-user/Items') {
    const parentId = url.searchParams.get('ParentId');
    const recursive = url.searchParams.get('Recursive') === 'true';
    const search = url.searchParams.get('searchTerm')?.toLocaleLowerCase();
    const kinds = (url.searchParams.get('IncludeItemTypes') ?? '').split(',').filter(Boolean);
    const start = Number(url.searchParams.get('StartIndex') ?? 0);
    const limit = Number(url.searchParams.get('Limit') ?? 50);
    const ids = new Set((url.searchParams.get('Ids') ?? '').split(',').filter(Boolean));
    let items = jellyfinItems.filter((item) =>
      parentId ? item.ParentId === parentId : recursive || item.ParentId === undefined
    );
    if (ids.size > 0) items = jellyfinItems.filter((item) => ids.has(item.Id));
    if (search) items = items.filter((item) => item.Name.toLocaleLowerCase().includes(search));
    if (kinds.length > 0) items = items.filter((item) => kinds.includes(item.Type));
    send(200, { Items: items.slice(start, start + limit), TotalRecordCount: items.length });
    return;
  }
  const itemMatch = /^\/Users\/browser-user\/Items\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'GET' && itemMatch) {
    const item = jellyfinItems.find((candidate) => candidate.Id === itemMatch[1]);
    send(item ? 200 : 404, item ?? { message: 'Not found' });
    return;
  }
  send(404, { message: 'Not found' });
});

await new Promise((resolvePromise, reject) => {
  jellyfin.once('error', reject);
  jellyfin.listen(18202, '127.0.0.1', resolvePromise);
});

const relay = spawn(process.execPath, ['apps/relay/dist/main.js'], {
  cwd: root,
  env: {
    ...process.env,
    VRRELAY_ENVIRONMENT: 'development',
    VRRELAY_LISTEN_ADDR: '127.0.0.1:18200',
    VRRELAY_AGENT_LISTEN_ADDR: '127.0.0.1:18201',
    VRRELAY_PUBLIC_URL: 'http://127.0.0.1:18200',
    VRRELAY_TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
    VRRELAY_DATA_DIR: dataDirectory,
    VRRELAY_CACHE_DIR: cacheDirectory,
    VRRELAY_REPOSITORY_DRIVER: 'sqlite',
    VRRELAY_COORDINATION_DRIVER: 'memory',
    VRRELAY_OBJECT_STORE_DRIVER: 'local',
    VRRELAY_SECRET_BACKEND: 'encrypted-file',
    VRRELAY_MASTER_KEY: randomBytes(32).toString('base64url'),
    VRRELAY_LOG_LEVEL: 'warn'
  },
  stdio: 'inherit'
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  jellyfin.close();
  relay.kill('SIGTERM');
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
relay.once('error', (error) => {
  console.error('Browser fixture could not start the relay:', error);
  process.exitCode = 1;
});
relay.once('exit', (code, signal) => {
  if (!stopping && (code ?? (signal ? 1 : 0)) !== 0) {
    process.exitCode = code ?? 1;
  }
  process.exit();
});

await new Promise(() => {});
