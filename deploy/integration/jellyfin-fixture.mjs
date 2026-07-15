// SPDX-License-Identifier: GPL-3.0-or-later
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.env.FIXTURE_PORT ?? 8096);
const mediaPath = process.env.FIXTURE_MEDIA_PATH ?? '/tmp/fixture.mp4';
const username = process.env.FIXTURE_USERNAME ?? 'fixture-user';
const password = process.env.FIXTURE_PASSWORD ?? 'fixture-password';
const accessToken = process.env.FIXTURE_ACCESS_TOKEN ?? 'fixture-access-token';
const media = statSync(mediaPath);
const durationSeconds = 12;
const stats = { authentications: 0, sourceRequests: 0, playbackEvents: 0 };

function json(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': encoded.length
  });
  response.end(encoded);
}

function authorized(request) {
  return (
    request.headers['x-emby-token'] === accessToken ||
    String(request.headers.authorization ?? '').includes(`Token="${accessToken}"`)
  );
}

function item() {
  return {
    Id: 'fixture-movie',
    Name: 'VRRelay deterministic fixture',
    Type: 'Movie',
    RunTimeTicks: durationSeconds * 10_000_000,
    MediaSources: [
      {
        Id: 'fixture-source-v1',
        Name: 'H.264 / AAC fixture',
        Container: 'mp4',
        Size: media.size,
        ETag: 'fixture-source-v1',
        MediaStreams: [
          {
            Index: 0,
            Type: 'Video',
            Codec: 'h264',
            Width: 640,
            Height: 360,
            IsDefault: true
          },
          {
            Index: 1,
            Type: 'Audio',
            Codec: 'aac',
            Channels: 2,
            Language: 'eng',
            IsDefault: true
          }
        ]
      }
    ]
  };
}

function streamMedia(request, response) {
  stats.sourceRequests += 1;
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, {
      'accept-ranges': 'bytes',
      'content-type': 'video/mp4',
      'content-length': media.size
    });
    if (request.method === 'HEAD') return response.end();
    return createReadStream(mediaPath).pipe(response);
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { 'content-range': `bytes */${media.size}` });
    return response.end();
  }
  const start = Number(match[1]);
  const end = Math.min(match[2] ? Number(match[2]) : media.size - 1, media.size - 1);
  if (start > end || start >= media.size) {
    response.writeHead(416, { 'content-range': `bytes */${media.size}` });
    return response.end();
  }
  response.writeHead(206, {
    'accept-ranges': 'bytes',
    'content-type': 'video/mp4',
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${media.size}`
  });
  if (request.method === 'HEAD') return response.end();
  return createReadStream(mediaPath, { start, end }).pipe(response);
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'fixture'}`);
  if (url.pathname === '/health') return json(response, 200, { status: 'ok' });
  if (url.pathname === '/fixture/stats') return json(response, 200, stats);
  if (url.pathname === '/System/Info/Public')
    return json(response, 200, { ServerName: 'VRRelay fixture', Version: '10.11.11' });
  if (url.pathname === '/Users/AuthenticateByName' && request.method === 'POST') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || '{}');
    if (body.Username !== username || body.Pw !== password)
      return json(response, 401, { error: 'invalid credentials' });
    stats.authentications += 1;
    return json(response, 200, {
      AccessToken: accessToken,
      User: { Id: 'fixture-user-id', Name: username }
    });
  }
  if (!authorized(request)) return json(response, 401, { error: 'unauthorized' });
  if (url.pathname === '/System/Info')
    return json(response, 200, { ServerName: 'VRRelay fixture', Version: '10.11.11' });
  if (url.pathname === '/Users/fixture-user-id/Items')
    return json(response, 200, { Items: [item()], TotalRecordCount: 1 });
  if (url.pathname === '/Users/fixture-user-id/Items/fixture-movie')
    return json(response, 200, item());
  if (url.pathname === '/Videos/fixture-movie/stream') return streamMedia(request, response);
  if (url.pathname.startsWith('/Sessions/Playing') && request.method === 'POST') {
    stats.playbackEvents += 1;
    response.writeHead(204);
    return response.end();
  }
  return json(response, 404, { error: 'not found', path: url.pathname });
}).listen(port, '0.0.0.0', () => {
  process.stdout.write(`Jellyfin fixture listening on ${port}\n`);
});
