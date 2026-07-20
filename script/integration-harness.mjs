// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'deploy/integration/compose.yml');
const stateDirectory = resolve(root, '.data/acceptance');
const envFile = resolve(stateDirectory, 'harness.env');
const controllerUrl = 'http://127.0.0.1:18100';
const jellyfinFixtureUrl = 'http://127.0.0.1:18096';
const keep = process.argv.includes('--keep');
const skipBuild = process.argv.includes('--skip-build');
const adminPassword = `acceptance-${randomBytes(18).toString('base64url')}`;
const environment = {
  POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  MINIO_ROOT_USER: 'vrrelay-acceptance',
  // Intentionally starts with '-' to prove Compose bootstrap treats secrets as data, not flags.
  MINIO_ROOT_PASSWORD: `-${randomBytes(24).toString('base64url')}`,
  VRRELAY_MASTER_KEY: randomBytes(32).toString('base64url'),
  VRRELAY_MEDIAMTX_READ_TOKEN: randomBytes(24).toString('base64url'),
  SOURCE_A_JOIN_TOKEN: 'missing',
  SOURCE_B_JOIN_TOKEN: 'missing',
  INGEST_JOIN_TOKEN: 'missing',
  EDGE_A_JOIN_TOKEN: 'missing',
  EDGE_B_JOIN_TOKEN: 'missing',
  LIVE_RTMP_URL: 'rtmp://mediamtx-origin:1935/missing'
};
let cookie = '';
let csrfToken = '';
let failed = false;

function log(message) {
  process.stdout.write(`[acceptance] ${message}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function writeEnvironment() {
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    envFile,
    `${Object.entries(environment)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n')}\n`,
    { mode: 0o600 }
  );
}

function compose(args, options = {}) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      composeFile,
      '--env-file',
      envFile,
      '--profile',
      'agents',
      '--profile',
      'publisher',
      ...args
    ],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: options.capture ? 'pipe' : 'inherit',
      timeout: options.timeout ?? 15 * 60_000
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(
      `docker compose ${args.join(' ')} failed (${result.status})${detail ? `\n${detail}` : ''}`
    );
  }
  return result;
}

async function waitFor(description, operation, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}`
  );
}

async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  const response = await fetch(`${controllerUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie && options.auth !== false ? { cookie } : {}),
      ...(csrfToken && !['GET', 'HEAD'].includes(method) && options.auth !== false
        ? { 'x-csrf-token': csrfToken }
        : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok)
    throw new Error(
      `${method} ${path} failed (${response.status}): ${body?.error?.message ?? text}`
    );
  return { response, body };
}

async function login() {
  const response = await fetch(`${controllerUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'recovery', password: adminPassword })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Administrator login failed (${response.status})`);
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  assert(setCookie, 'Administrator login did not return a session cookie');
  cookie = setCookie.split(';', 1)[0];
  csrfToken = body.csrfToken;
}

async function createJoinToken(name, roles, region) {
  return (
    await api('/api/v1/nodes/join-tokens', {
      method: 'POST',
      body: { name, roles, region, expiresInSeconds: 600 }
    })
  ).body.token;
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'VRRelay acceptance harness', ...headers }
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`GET ${url} failed (${response.status}): ${text.slice(0, 300)}`);
  return text;
}

async function fetchMedia(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'VRRelay acceptance harness', ...headers }
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`GET ${url} failed (${response.status})`);
  assert(body.length > 1_000, `Media response from ${url} was unexpectedly small`);
  return body;
}

async function jellyfinStats() {
  const response = await fetch(`${jellyfinFixtureUrl}/fixture/stats`);
  if (!response.ok) throw new Error(`Jellyfin fixture stats failed (${response.status})`);
  return response.json();
}

function mediaLines(playlist) {
  return playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function waitForPlaylist(url, timeoutMs = 60_000) {
  return waitFor(
    `HLS playlist ${url}`,
    async () => {
      const response = await fetch(url, {
        headers: { 'user-agent': 'VRRelay acceptance harness' }
      });
      if (!response.ok) return undefined;
      const body = await response.text();
      return body.includes('#EXTM3U') ? body : undefined;
    },
    timeoutMs
  );
}

async function run() {
  await writeEnvironment();
  compose(['down', '-v', '--remove-orphans'], { allowFailure: true });
  if (!skipBuild) {
    log('Building the release-equivalent relay image');
    compose(['build', 'controller']);
  }
  log('Starting controller infrastructure and deterministic Jellyfin fixture');
  compose([
    'up',
    '-d',
    'postgres',
    'valkey',
    'minio',
    'minio-init',
    'jellyfin',
    'mediamtx-origin',
    'controller'
  ]);
  await waitFor('controller health', async () => {
    const response = await fetch(`${controllerUrl}/api/v1/health`).catch(() => undefined);
    return response?.ok;
  });
  await api('/api/v1/setup', {
    method: 'POST',
    auth: false,
    body: { password: adminPassword }
  });
  await login();

  environment.SOURCE_A_JOIN_TOKEN = await createJoinToken(
    'Acceptance worker A',
    ['source-worker'],
    'london'
  );
  environment.SOURCE_B_JOIN_TOKEN = await createJoinToken(
    'Acceptance worker B',
    ['source-worker'],
    'new-york'
  );
  environment.INGEST_JOIN_TOKEN = await createJoinToken(
    'Acceptance ingest origin',
    ['ingest-origin'],
    'london'
  );
  environment.EDGE_A_JOIN_TOKEN = await createJoinToken('Acceptance edge A', ['edge'], 'london');
  environment.EDGE_B_JOIN_TOKEN = await createJoinToken('Acceptance edge B', ['edge'], 'new-york');
  await writeEnvironment();

  log('Enrolling two workers, one ingest origin, and two edges over outbound mTLS WSS');
  compose([
    'up',
    '-d',
    'source-worker-a',
    'source-worker-b',
    'ingest-origin',
    'edge-a',
    'edge-b',
    'mediamtx-edge-a',
    'mediamtx-edge-b'
  ]);
  const nodes = await waitFor('all node agents to connect', async () => {
    const items = (await api('/api/v1/nodes')).body.items;
    const agents = items.filter((node) => !node.roles.includes('controller'));
    return agents.length === 5 && agents.every((node) => node.agent?.connected) ? items : undefined;
  });
  const byName = (name) => {
    const node = nodes.find((candidate) => candidate.name === name);
    assert(node, `Missing enrolled node ${name}`);
    return node;
  };
  const workerA = byName('Acceptance worker A');
  const workerB = byName('Acceptance worker B');

  log('Creating explicit node-local primary and failover Jellyfin bindings');
  const bindingBody = {
    type: 'jellyfin',
    name: 'Acceptance Jellyfin',
    baseUrl: 'http://jellyfin:8096',
    authMode: 'user_token',
    username: 'fixture-user',
    password: 'fixture-password',
    allowPublicHttp: false
  };
  const firstBinding = (
    await api('/api/v1/provider-bindings', {
      method: 'POST',
      body: { ...bindingBody, nodeId: workerA.id }
    })
  ).body;
  const providerId = firstBinding.provider.id;
  await api('/api/v1/provider-bindings', {
    method: 'POST',
    body: { ...bindingBody, providerId, nodeId: workerB.id }
  });
  const bindings = (await api(`/api/v1/provider-bindings?providerId=${providerId}`)).body.items;
  assert(bindings.length === 2, 'Provider failover did not create two bindings');
  await waitFor(
    'provider capabilities on both workers',
    async () => {
      const current = (await api('/api/v1/nodes')).body.items;
      return [workerA.id, workerB.id].every((id) =>
        current.find((node) => node.id === id)?.capabilities.providerIds.includes(providerId)
      );
    },
    45_000
  );

  const catalog = (await api(`/api/v1/providers/${providerId}/catalog`)).body;
  assert(catalog.items.length === 1, 'Jellyfin fixture catalog was not available through a worker');
  const item = catalog.items[0];
  const profiles = (await api('/api/v1/profiles')).body.items;
  const vodProfile = profiles.find((profile) => profile.profileId === 'universal-h264-hls-vod');
  assert(vodProfile, 'Default universal H.264 VOD profile was not seeded');

  log('Creating a hosted VOD session and verifying a finite controller playlist');
  const session = (
    await api('/api/v1/sessions', {
      method: 'POST',
      body: {
        kind: 'vod',
        name: 'Acceptance VOD',
        source: {
          providerId,
          itemId: item.id,
          versionId: item.versions[0].id,
          sourceFingerprint: item.versions[0].fingerprint
        },
        profileId: vodProfile.profileId,
        profileRevision: vodProfile.revision,
        platformMode: 'universal',
        pinned: false,
        reportActivity: true,
        placementPolicy: 'hosted',
        playbackTtlSeconds: 600
      }
    })
  ).body;
  const cleanUrl = session.outputUrls.primary;
  const token = cleanUrl.split('/play/')[1].split('/')[0];
  const londonManifest = await fetchText(cleanUrl, { 'x-vrrelay-region': 'london' });
  const newYorkManifest = await fetchText(cleanUrl, { 'x-vrrelay-region': 'new-york' });
  assert(londonManifest.includes('#EXT-X-PLAYLIST-TYPE:VOD'), 'VOD manifest is not finite VOD');
  assert(londonManifest.includes('#EXT-X-ENDLIST'), 'VOD manifest does not expose completion');
  assert(
    mediaLines(londonManifest).every((line) => line.startsWith('http://127.0.0.1:18201')),
    'London controller manifest did not select the London edge'
  );
  assert(
    mediaLines(newYorkManifest).every((line) => line.startsWith('http://127.0.0.1:18202')),
    'New York controller manifest did not select the New York edge'
  );
  assert(
    new URL(mediaLines(londonManifest)[0]).origin !==
      new URL(mediaLines(newYorkManifest)[0]).origin,
    'Regional viewers received the same delivery edge'
  );
  assert(
    mediaLines(londonManifest).every((line) => line.startsWith('http://127.0.0.1:1820')),
    'Controller manifest did not contain absolute authorized edge URLs'
  );

  log('Requesting the same segment through both regions to prove one continuous producer');
  const sourceBefore = await jellyfinStats();
  const segmentPath = `/play/${token}/segment/0.ts`;
  const [segmentA, segmentB] = await Promise.all([
    fetchMedia(`http://127.0.0.1:18201${segmentPath}`, { 'user-agent': 'London viewer' }),
    fetchMedia(`http://127.0.0.1:18202${segmentPath}`, { 'user-agent': 'New York viewer' })
  ]);
  assert(segmentA.equals(segmentB), 'Edges returned different bytes for the same content key');
  assert(segmentA[0] === 0x47, 'Default VOD output is not an MPEG-TS segment');
  const jobs = (await api('/api/v1/jobs')).body.items.filter(
    (job) => job.sessionId === session.id && job.segmentIndex === 0
  );
  assert(jobs.length === 1, `Expected one cluster-wide segment job, found ${jobs.length}`);
  assert(jobs[0].state === 'complete', 'Coalesced segment job did not complete');
  assert(
    jobs[0].attempts === 1,
    'Coalesced segment unexpectedly used more than one worker attempt'
  );
  assert(
    jobs[0].workerHistory?.length === 1 &&
      jobs[0].workerHistory[0].state === 'complete' &&
      jobs[0].workerHistory[0].nodeId === jobs[0].ownerNodeId &&
      jobs[0].workerHistory[0].completedAt,
    'Completed worker attempt was not recorded in segment-job history'
  );
  const sourceAfterFirst = await jellyfinStats();
  assert(
    sourceAfterFirst.sourceRequests - sourceBefore.sourceRequests === 1,
    `One session opened ${sourceAfterFirst.sourceRequests - sourceBefore.sourceRequests} Jellyfin source connections`
  );
  await fetchMedia(`http://127.0.0.1:18202/play/${token}/segment/1.ts`, {
    'user-agent': 'New York viewer'
  });
  const sourceAfterSequential = await jellyfinStats();
  assert(
    sourceAfterSequential.sourceRequests === sourceAfterFirst.sourceRequests,
    'Sequential segments did not reuse the continuous Jellyfin connection'
  );
  await fetchMedia(`http://127.0.0.1:18201${segmentPath}`, { 'user-agent': 'London viewer' });
  assert(
    (await jellyfinStats()).sourceRequests === sourceAfterSequential.sourceRequests,
    'An edge/object-store cache hit opened another Jellyfin request'
  );

  log('Moving a regional majority to a distant segment and verifying one fenced replacement');
  await Promise.all([
    fetchMedia(`http://127.0.0.1:18201/play/${token}/segment/12.ts`, {
      'user-agent': 'London seek viewer'
    }),
    fetchMedia(`http://127.0.0.1:18202/play/${token}/segment/12.ts`, {
      'user-agent': 'New York seek viewer'
    }),
    fetchMedia(`http://127.0.0.1:18201/play/${token}/segment/12.ts`, {
      'user-agent': 'London seek viewer two'
    })
  ]);
  const producerAfterSeek = (await api(`/api/v1/vod-producers/${session.id}`)).body;
  assert(
    producerAfterSeek.generation === 2 && producerAfterSeek.startSegmentIndex === 12,
    'Dominant seek did not create exactly one replacement producer generation'
  );
  const sourceAfterSeek = await jellyfinStats();
  const seekSourceRequests = sourceAfterSeek.sourceRequests - sourceAfterSequential.sourceRequests;
  assert(
    seekSourceRequests === 2,
    `Dominant seek did not use one metadata probe and one positioned range (${JSON.stringify(sourceAfterSeek.sourceRequestRanges)})`
  );
  assert(
    sourceAfterSeek.sourceRequestRanges.at(-2) === 'bytes=0-' &&
      /^bytes=[1-9]\d*-$/.test(sourceAfterSeek.sourceRequestRanges.at(-1) ?? ''),
    'Replacement producer did not seek through a positioned Jellyfin byte range'
  );
  assert(
    sourceAfterSeek.sourceStartTimeTicks.slice(-2).every((value) => value === null),
    'Static Jellyfin source incorrectly claimed StartTimeTicks positioning'
  );
  assert(
    sourceAfterSeek.maximumConcurrentSourceRequests <= 1,
    'Replacement overlapped an accepted old Jellyfin source request'
  );

  log('Creating a distinct session and verifying it may consume an additional source pull');
  const secondSession = (
    await api('/api/v1/sessions', {
      method: 'POST',
      body: {
        kind: 'vod',
        name: 'Acceptance independent VOD',
        source: {
          providerId,
          itemId: item.id,
          versionId: item.versions[0].id,
          sourceFingerprint: `${item.versions[0].fingerprint}-independent`
        },
        profileId: vodProfile.profileId,
        profileRevision: vodProfile.revision,
        platformMode: 'universal',
        pinned: false,
        reportActivity: false,
        placementPolicy: 'hosted',
        playbackTtlSeconds: 600
      }
    })
  ).body;
  const secondToken = secondSession.outputUrls.primary.split('/play/')[1].split('/')[0];
  await fetchMedia(`http://127.0.0.1:18201/play/${secondToken}/segment/0.ts`, {
    'user-agent': 'Independent session viewer'
  });
  assert(
    (await jellyfinStats()).sourceRequests === sourceAfterSeek.sourceRequests + 1,
    'A distinct session did not receive its own permitted Jellyfin source pull'
  );

  compose([
    'exec',
    '-T',
    'controller',
    'sh',
    '-c',
    "! grep -R -a -E 'fixture-password|fixture-access-token' /data 2>/dev/null"
  ]);

  log('Draining the selected edge and verifying refreshed playlist rerouting');
  const initialEdgeUrl = new URL(mediaLines(londonManifest)[0]).origin;
  const initialEdge = nodes.find((node) => node.publicUrl === initialEdgeUrl);
  assert(initialEdge, 'Could not map the selected manifest route to an enrolled edge');
  await api(`/api/v1/nodes/${initialEdge.id}/drain`, {
    method: 'POST',
    body: { draining: true }
  });
  const reroutedManifest = await fetchText(cleanUrl);
  assert(
    mediaLines(reroutedManifest).every((line) => !line.startsWith(initialEdgeUrl)),
    'Refreshed playlist continued routing to the draining edge'
  );

  log('Revoking the assigned worker and verifying explicit provider failover');
  const assignedWorker = [workerA, workerB].find((worker) => worker.id === session.assignedNodeId);
  assert(assignedWorker, 'Hosted session was not assigned to a bound worker');
  await api(`/api/v1/nodes/${assignedWorker.id}/revoke`, { method: 'POST', body: {} });
  const activeEdgeUrl = new URL(mediaLines(reroutedManifest)[0]).origin;
  await fetchMedia(`${activeEdgeUrl}/play/${token}/segment/19.ts`, {
    'user-agent': 'Failover viewer'
  });
  const secondJob = (await api('/api/v1/jobs')).body.items.find(
    (job) => job.sessionId === session.id && job.segmentIndex === 19
  );
  assert(secondJob?.state === 'complete', 'Failover worker did not complete the next segment');
  assert(secondJob.ownerNodeId !== assignedWorker.id, 'Revoked worker retained the segment lease');
  assert(
    secondJob.workerHistory?.at(-1)?.nodeId === secondJob.ownerNodeId &&
      secondJob.workerHistory?.at(-1)?.state === 'complete',
    'Failover worker completion was not retained in segment-job history'
  );

  log('Restarting the controller and verifying session/grant recovery plus agent reconnection');
  compose(['restart', 'controller']);
  await waitFor('controller restart', async () => {
    const response = await fetch(`${controllerUrl}/api/v1/health`).catch(() => undefined);
    return response?.ok;
  });
  await login();
  await waitFor('remaining agents to reconnect', async () => {
    const current = (await api('/api/v1/nodes')).body.items;
    return current
      .filter((node) => !node.roles.includes('controller') && node.state !== 'revoked')
      .every((node) => node.agent?.connected);
  });
  await fetchMedia(`${activeEdgeUrl}/play/${token}/segment/2.ts`);
  assert(
    (await api(`/api/v1/sessions/${session.id}`)).body.id === session.id,
    'Controller restart lost the VOD session'
  );

  log('Publishing one OBS-compatible stream and activating both live edges');
  const liveCreated = (
    await api('/api/v1/live-channels', {
      method: 'POST',
      body: { name: 'Acceptance OBS', normalize: false }
    })
  ).body;
  environment.LIVE_RTMP_URL = liveCreated.publisher.rtmpUrl;
  await writeEnvironment();
  compose(['up', '-d', 'obs-publisher']);
  await waitFor('OBS publisher state', async () => {
    const channels = (await api('/api/v1/live-channels')).body.items;
    return (
      channels.find((channel) => channel.id === liveCreated.channel.id)?.publisherState === 'online'
    );
  });
  const liveProfile = profiles.find((profile) => profile.profileId === 'h264-live-hls');
  assert(liveProfile, 'Default H.264 live profile was not seeded');
  const liveSession = (
    await api('/api/v1/sessions', {
      method: 'POST',
      body: {
        kind: 'live',
        name: 'Acceptance live',
        liveChannelId: liveCreated.channel.id,
        profileId: liveProfile.profileId,
        profileRevision: liveProfile.revision,
        platformMode: 'universal',
        pinned: true,
        reportActivity: false,
        placementPolicy: 'auto',
        playbackTtlSeconds: 600
      }
    })
  ).body;
  const liveToken = liveSession.outputUrls.primary.split('/play/')[1].split('/')[0];
  for (const port of [18201, 18202]) {
    const edgeUrl = `http://127.0.0.1:${port}/play/${liveToken}/live.m3u8?edge=1`;
    const first = await waitForPlaylist(edgeUrl);
    const firstChild = mediaLines(first)[0];
    if (firstChild) await waitForPlaylist(new URL(firstChild, edgeUrl).toString());
    await waitForPlaylist(edgeUrl);
  }
  for (const port of [18301, 18302]) {
    const paths = await waitFor(`MediaMTX edge ${port} path`, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v3/paths/list`).catch(() => undefined);
      if (!response?.ok) return undefined;
      const body = await response.json();
      return body.items?.some((path) => path.name === liveCreated.channel.path && path.ready)
        ? body.items
        : undefined;
    });
    assert(
      paths.filter((path) => path.name === liveCreated.channel.path).length === 1,
      `Edge ${port} created more than one origin pull for the live channel`
    );
  }

  log(
    'PASS: regional edge routing, persistent VOD producers, cache reuse, fenced failover, recovery, and live fan-out'
  );
}

let cleaning = false;
function cleanup() {
  if (cleaning || keep) return;
  cleaning = true;
  compose(['down', '-v', '--remove-orphans'], { allowFailure: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

try {
  await run();
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  compose(['ps'], { allowFailure: true });
  compose(['logs', '--no-color', '--tail', '200'], { allowFailure: true, timeout: 60_000 });
} finally {
  if (keep) log(`Keeping the acceptance cluster running; environment is ${envFile}`);
  else cleanup();
}

if (failed) process.exitCode = 1;
