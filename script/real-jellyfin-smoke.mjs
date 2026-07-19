// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = join(root, '.data', 'real-jellyfin-smoke');
const relayUrl = 'http://127.0.0.1:18100';
const jellyfinUrl = process.env.VRRELAY_TEST_JELLYFIN_URL;
const jellyfinUser = process.env.VRRELAY_TEST_JELLYFIN_USER;
const jellyfinPassword = process.env.VRRELAY_TEST_JELLYFIN_PASSWORD;
const keep = process.argv.includes('--keep');
const adminPassword = `real-jellyfin-${randomBytes(18).toString('base64url')}`;
let relay;
let cookie = '';
let csrf = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(message) {
  process.stdout.write(`[real-jellyfin] ${message}\n`);
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
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000)
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

function playlistMedia(playlist) {
  return playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function main() {
  if (!jellyfinUrl || !jellyfinUser || !jellyfinPassword)
    throw new Error(
      'Set VRRELAY_TEST_JELLYFIN_URL, VRRELAY_TEST_JELLYFIN_USER, and VRRELAY_TEST_JELLYFIN_PASSWORD'
    );

  await rm(state, { recursive: true, force: true });
  await mkdir(state, { recursive: true });
  const logPath = join(state, 'relay.log');
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VRRELAY_TEST_JELLYFIN_'))
  );
  relay = spawn('node', ['apps/relay/dist/main.js'], {
    cwd: root,
    env: {
      ...cleanEnvironment,
      VRRELAY_LISTEN_ADDR: '127.0.0.1:18100',
      VRRELAY_PUBLIC_URL: relayUrl,
      VRRELAY_AGENT_LISTEN_ADDR: '127.0.0.1:18110',
      VRRELAY_AGENT_TLS_NAMES: '127.0.0.1,localhost',
      VRRELAY_DATA_DIR: join(state, 'data'),
      VRRELAY_CACHE_DIR: join(state, 'cache'),
      VRRELAY_SECRET_BACKEND: 'encrypted-file',
      VRRELAY_MASTER_KEY: randomBytes(32).toString('base64url'),
      VRRELAY_LOG_LEVEL: 'warn'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  relay.stdout.on('data', (chunk) => void appendFile(logPath, chunk));
  relay.stderr.on('data', (chunk) => void appendFile(logPath, chunk));

  await waitFor('relay startup', async () =>
    (await fetch(`${relayUrl}/api/v1/health`).catch(() => undefined))?.ok ? true : undefined
  );
  await api('/api/v1/setup', {
    method: 'POST',
    auth: false,
    body: { password: adminPassword }
  });
  await login();

  log('Connecting to Jellyfin with a one-time password exchange');
  const provider = await api('/api/v1/providers', {
    method: 'POST',
    body: {
      type: 'jellyfin',
      name: 'Real Jellyfin smoke fixture',
      baseUrl: jellyfinUrl,
      authMode: 'user_token',
      username: jellyfinUser,
      password: jellyfinPassword,
      allowPublicHttp: false
    }
  });
  assert(provider.healthy, 'Jellyfin provider was not healthy after authentication');
  await api(`/api/v1/providers/${provider.id}/validate`, { method: 'POST', body: {} });

  log('Browsing provider-neutral media metadata');
  const catalog = await api(`/api/v1/providers/${provider.id}/catalog?limit=200`);
  const item = catalog.items.find(
    (candidate) =>
      candidate.durationSeconds > 0 &&
      candidate.versions?.length > 0 &&
      ['Movie', 'Episode', 'Video'].includes(candidate.kind)
  );
  assert(item, 'Jellyfin did not expose a playable Movie, Episode, or Video to the test user');
  const selected = await api(
    `/api/v1/providers/${provider.id}/items/${encodeURIComponent(item.id)}`
  );
  assert(selected.durationSeconds > 0, 'Selected Jellyfin media did not expose a finite duration');
  assert(selected.versions?.[0]?.id, 'Selected Jellyfin media did not expose a source version');

  const profiles = (await api('/api/v1/profiles')).items;
  const profile = profiles.find(
    (candidate) => candidate.profileId === 'universal-h264-hls-vod' && candidate.revision === 1
  );
  assert(profile, 'The default universal H.264/AAC HLS profile was unavailable');

  log('Creating a finite just-in-time VOD session');
  const session = await api('/api/v1/sessions', {
    method: 'POST',
    body: {
      kind: 'vod',
      name: 'Real Jellyfin VOD smoke',
      source: {
        providerId: provider.id,
        itemId: selected.id,
        versionId: selected.versions[0].id,
        sourceFingerprint: selected.versions[0].fingerprint,
        audioTrackId: selected.audioTracks?.find((track) => track.isDefault)?.id
      },
      profileId: profile.profileId,
      profileRevision: profile.revision,
      platformMode: 'universal',
      pinned: false,
      reportActivity: true,
      placementPolicy: 'local',
      playbackTtlSeconds: 600
    }
  });
  const manifestResponse = await fetch(session.outputUrls.primary, {
    signal: AbortSignal.timeout(30_000)
  });
  const manifest = await manifestResponse.text();
  assert(manifestResponse.ok, `VOD manifest failed (${manifestResponse.status})`);
  assert(manifest.includes('#EXT-X-PLAYLIST-TYPE:VOD'), 'Manifest was not finite VOD');
  assert(manifest.includes('#EXT-X-ENDLIST'), 'Manifest did not expose completion from the start');
  const media = playlistMedia(manifest);
  assert(media.length > 0, 'Manifest did not contain media segments');

  log('Generating and downloading the first real-time MPEG-TS segment');
  const segmentUrl = new URL(media[0], session.outputUrls.primary).toString();
  const segmentResponse = await fetch(segmentUrl, { signal: AbortSignal.timeout(180_000) });
  const segment = Buffer.from(await segmentResponse.arrayBuffer());
  assert(segmentResponse.ok, `VOD segment failed (${segmentResponse.status})`);
  assert(segment.length > 1_000, 'Generated VOD segment was unexpectedly small');
  assert(segment[0] === 0x47, 'Generated VOD segment was not MPEG-TS');

  log('Deleting the session, revoking playback, and removing the provider credential');
  await api(`/api/v1/sessions/${session.id}`, { method: 'DELETE' });
  const revoked = await fetch(session.outputUrls.primary);
  assert(
    [401, 403, 404, 410].includes(revoked.status),
    `Deleted session playback grant remained usable (${revoked.status})`
  );
  await api(`/api/v1/providers/${provider.id}`, { method: 'DELETE' });
  assert(
    !(await api('/api/v1/providers')).items.some((candidate) => candidate.id === provider.id),
    'Deleted provider remained visible'
  );

  log(
    `PASS: authenticated, browsed, transcoded ${segment.length} bytes, revoked playback, and deleted the credential`
  );
}

try {
  await main();
} finally {
  if (relay) {
    const exited = new Promise((resolvePromise) => relay.once('exit', resolvePromise));
    relay.kill('SIGTERM');
    await Promise.race([
      exited,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))
    ]);
    if (relay.exitCode === null && relay.signalCode === null) relay.kill('SIGKILL');
  }
  if (!keep) await rm(state, { recursive: true, force: true });
  else log(`Retained diagnostic state at ${state}`);
}
