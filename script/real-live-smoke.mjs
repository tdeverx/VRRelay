// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = join(root, '.data', 'real-live-smoke');
const relayUrl = 'http://127.0.0.1:18300';
const mediaMtxPath = process.env.VRRELAY_TEST_MEDIAMTX ?? 'mediamtx';
const mediaMtxConfig = process.env.VRRELAY_TEST_MEDIAMTX_CONFIG;
const ffmpegPath = process.env.VRRELAY_TEST_FFMPEG ?? 'ffmpeg';
const keep = process.argv.includes('--keep');
const passthrough = process.argv.includes('--passthrough');
const managedMediaMtx = process.argv.includes('--managed-mediamtx');
const adminPassword = `real-live-${randomBytes(18).toString('base64url')}`;
const readToken = randomBytes(24).toString('base64url');
let relay;
let mediaMtx;
let publisher;
let cookie = '';
let csrf = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(message) {
  process.stdout.write(`[real-live] ${message}\n`);
}

async function waitFor(description, operation, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}`
  );
}

async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  const response = await fetch(`${relayUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie && options.auth !== false ? { cookie } : {}),
      ...(csrf && !['GET', 'HEAD'].includes(method) && options.auth !== false
        ? { 'x-csrf-token': csrf }
        : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok)
    throw new Error(
      `${method} ${path} failed (${response.status}): ${body?.error?.message ?? text}`
    );
  return body;
}

async function login() {
  const response = await fetch(`${relayUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'recovery', password: adminPassword })
  });
  const body = await response.json();
  assert(response.ok, `Login failed (${response.status})`);
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  assert(setCookie, 'Login did not issue a session cookie');
  cookie = setCookie.split(';', 1)[0];
  csrf = body.csrfToken;
}

function mediaLines(playlist) {
  return playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function playlist(url) {
  return waitFor(
    `HLS playlist ${url}`,
    async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) }).catch(
        () => undefined
      );
      if (!response?.ok) return undefined;
      const body = await response.text();
      return body.includes('#EXTM3U') ? body : undefined;
    },
    45_000
  );
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function main() {
  if (managedMediaMtx && !mediaMtxConfig)
    throw new Error('--managed-mediamtx requires VRRELAY_TEST_MEDIAMTX_CONFIG');
  await rm(state, { recursive: true, force: true });
  await mkdir(state, { recursive: true });
  const relayLog = join(state, 'relay.log');
  const mediaMtxLog = join(state, 'mediamtx.log');
  const publisherLog = join(state, 'publisher.log');

  relay = spawn('node', ['apps/relay/dist/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      VRRELAY_LISTEN_ADDR: '127.0.0.1:18300',
      VRRELAY_PUBLIC_URL: relayUrl,
      VRRELAY_AGENT_LISTEN_ADDR: '127.0.0.1:18310',
      VRRELAY_AGENT_TLS_NAMES: '127.0.0.1,localhost',
      VRRELAY_DATA_DIR: join(state, 'data'),
      VRRELAY_CACHE_DIR: join(state, 'cache'),
      VRRELAY_SECRET_BACKEND: 'encrypted-file',
      VRRELAY_MASTER_KEY: randomBytes(32).toString('base64url'),
      VRRELAY_MEDIAMTX_RTMP_URL: 'rtmp://127.0.0.1:1936',
      VRRELAY_MEDIAMTX_SRT_URL: 'srt://127.0.0.1:8891',
      VRRELAY_MEDIAMTX_WHIP_URL: 'http://127.0.0.1:8892',
      VRRELAY_MEDIAMTX_HLS_URL: 'http://127.0.0.1:8893',
      VRRELAY_MEDIAMTX_RTSP_URL: 'rtsp://127.0.0.1:8555',
      VRRELAY_MEDIAMTX_API_URL: 'http://127.0.0.1:9998',
      VRRELAY_MEDIAMTX_READ_TOKEN: readToken,
      VRRELAY_MEDIAMTX_ALLOW_INTERNAL_READ: 'true',
      VRRELAY_LOG_LEVEL: 'debug',
      ...(managedMediaMtx
        ? {
            VRRELAY_MEDIAMTX_EXECUTABLE: mediaMtxPath,
            VRRELAY_MEDIAMTX_CONFIG: mediaMtxConfig,
            MTX_LOGLEVEL: 'debug',
            MTX_AUTHHTTPADDRESS: `${relayUrl}/internal/mediamtx/auth`,
            MTX_APIADDRESS: '127.0.0.1:9998',
            MTX_RTSPADDRESS: '127.0.0.1:8555',
            MTX_RTMPADDRESS: '127.0.0.1:1936',
            MTX_HLSADDRESS: '127.0.0.1:8893',
            MTX_WEBRTCADDRESS: '127.0.0.1:8892',
            MTX_WEBRTCLOCALUDPADDRESS: '127.0.0.1:8190',
            MTX_SRTADDRESS: '127.0.0.1:8891'
          }
        : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  relay.stdout.on('data', (chunk) => void appendFile(relayLog, chunk));
  relay.stderr.on('data', (chunk) => void appendFile(relayLog, chunk));

  await waitFor('relay startup', async () =>
    (await fetch(`${relayUrl}/api/v1/health`).catch(() => undefined))?.ok ? true : undefined
  );
  await api('/api/v1/setup', {
    method: 'POST',
    auth: false,
    body: { password: adminPassword }
  });
  await login();

  if (!managedMediaMtx) {
    mediaMtx = spawn(mediaMtxPath, mediaMtxConfig ? [mediaMtxConfig] : [], {
      cwd: state,
      env: {
        ...process.env,
        MTX_LOGLEVEL: 'debug',
        MTX_AUTHMETHOD: 'http',
        MTX_AUTHHTTPADDRESS: `${relayUrl}/internal/mediamtx/auth`,
        MTX_API: 'yes',
        MTX_APIADDRESS: '127.0.0.1:9998',
        MTX_RTSPADDRESS: '127.0.0.1:8555',
        MTX_RTMPADDRESS: '127.0.0.1:1936',
        MTX_HLSADDRESS: '127.0.0.1:8893',
        MTX_HLSVARIANT: 'mpegts',
        MTX_WEBRTCADDRESS: '127.0.0.1:8892',
        MTX_WEBRTCLOCALUDPADDRESS: '127.0.0.1:8190',
        MTX_SRTADDRESS: '127.0.0.1:8891'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    mediaMtx.stdout.on('data', (chunk) => void appendFile(mediaMtxLog, chunk));
    mediaMtx.stderr.on('data', (chunk) => void appendFile(mediaMtxLog, chunk));
  }
  await waitFor('MediaMTX API', async () =>
    (await fetch('http://127.0.0.1:9998/v3/paths/list').catch(() => undefined))?.ok
      ? true
      : undefined
  );

  log(`Creating an authenticated ${passthrough ? 'passthrough' : 'normalized'} OBS channel`);
  const created = await api('/api/v1/live-channels', {
    method: 'POST',
    body: { name: 'Real OBS smoke', normalize: !passthrough }
  });
  assert(
    created.publisher.publishToken,
    'Live channel did not return its one-time publisher token'
  );
  assert(
    created.publisher.rtmpUrl.includes(created.publisher.publishToken),
    'RTMP URL was not authenticated'
  );

  publisher = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-re',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '60',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'flv',
      created.publisher.rtmpUrl
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  publisher.stderr.on('data', (chunk) => void appendFile(publisherLog, chunk));

  await waitFor('publisher state', async () => {
    const channels = (await api('/api/v1/live-channels')).items;
    return (
      channels.find((channel) => channel.id === created.channel.id)?.publisherState === 'online'
    );
  });
  assert(publisher.exitCode === null, 'FFmpeg publisher exited before the channel became ready');

  const profiles = (await api('/api/v1/profiles')).items;
  const profile = profiles.find((candidate) => candidate.profileId === 'h264-live-hls');
  assert(profile, 'The default H.264/AAC live HLS profile was unavailable');
  const session = await api('/api/v1/sessions', {
    method: 'POST',
    body: {
      kind: 'live',
      name: 'Real OBS playback smoke',
      liveChannelId: created.channel.id,
      profileId: profile.profileId,
      profileRevision: profile.revision,
      platformMode: 'universal',
      pinned: true,
      reportActivity: false,
      placementPolicy: 'local',
      playbackTtlSeconds: 600
    }
  });
  assert(
    session.outputUrls.primary.startsWith(`${relayUrl}/play/`),
    'Playback URL bypassed VRRelay'
  );

  log('Fetching the clean grant-backed live HLS URL');
  let currentUrl = session.outputUrls.primary;
  let currentPlaylist = await playlist(currentUrl);
  let segmentUrl;
  for (let depth = 0; depth < 4; depth += 1) {
    const lines = mediaLines(currentPlaylist);
    const child = lines.find((line) => line.includes('.m3u8'));
    if (!child) {
      assert(lines[0], 'Live media playlist did not contain a segment');
      segmentUrl = new URL(lines[0], currentUrl).toString();
      break;
    }
    currentUrl = new URL(child, currentUrl).toString();
    assert(currentUrl.startsWith(`${relayUrl}/play/`), 'Child playlist bypassed VRRelay');
    currentPlaylist = await playlist(currentUrl);
  }
  assert(segmentUrl, 'Could not resolve a live HLS media segment');
  assert(segmentUrl.startsWith(`${relayUrl}/play/`), 'Media segment bypassed VRRelay');
  const segmentResponse = await fetch(segmentUrl, { signal: AbortSignal.timeout(15_000) });
  const segment = Buffer.from(await segmentResponse.arrayBuffer());
  assert(segmentResponse.ok, `Live segment failed (${segmentResponse.status})`);
  assert(segment.length > 1_000, 'Live segment was unexpectedly small');

  log('Stopping the publisher and verifying disconnect reconciliation');
  await terminate(publisher);
  await waitFor('publisher disconnect', async () => {
    const channels = (await api('/api/v1/live-channels')).items;
    return (
      channels.find((channel) => channel.id === created.channel.id)?.publisherState === 'offline'
    );
  });
  await api(`/api/v1/sessions/${session.id}`, { method: 'DELETE' });
  const revoked = await fetch(session.outputUrls.primary);
  assert(
    [401, 403, 404, 410].includes(revoked.status),
    `Deleted live session playback grant remained usable (${revoked.status})`
  );
  await api(`/api/v1/live-channels/${created.channel.id}`, { method: 'DELETE' });
  assert(
    !(await api('/api/v1/live-channels')).items.some(
      (candidate) => candidate.id === created.channel.id
    ),
    'Deleted live channel remained visible'
  );

  log(
    `PASS: published once, ${passthrough ? 'passed through' : 'normalized'}, proxied ${segment.length} bytes through the clean URL, reconciled disconnect, revoked playback, and deleted the channel`
  );
}

try {
  await main();
} finally {
  await terminate(publisher);
  await terminate(mediaMtx);
  await terminate(relay);
  if (!keep) await rm(state, { recursive: true, force: true });
  else log(`Retained diagnostic state at ${state}`);
}
