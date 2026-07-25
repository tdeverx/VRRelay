// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = join(root, '.data/local-cluster-smoke');
const controllerUrl = 'http://127.0.0.1:19100';
const postgresName = 'vrrelay-local-smoke-postgres';
const redisName = 'vrrelay-local-smoke-redis';
const postgresPassword = randomBytes(24).toString('base64url');
const adminPassword = `local-smoke-${randomBytes(18).toString('base64url')}`;
const masterKey = randomBytes(32).toString('base64url');
const children = new Map();
let cookie = '';
let csrf = '';

function log(message) {
  process.stdout.write(`[local-cluster] ${message}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: options.timeout ?? 120_000
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(
      `${commandName} ${args.join(' ')} failed (${result.status})\n${result.stderr ?? ''}`
    );
  return result;
}

async function waitFor(description, operation, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}`
  );
}

async function start(name, environment) {
  const logPath = join(state, `${name}.log`);
  await appendFile(logPath, `\n--- ${new Date().toISOString()} start ---\n`);
  const child = spawn('node', ['apps/relay/dist/main.js'], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => void appendFile(logPath, chunk));
  child.stderr.on('data', (chunk) => void appendFile(logPath, chunk));
  children.set(name, child);
  child.once('exit', () => {
    if (children.get(name) === child) children.delete(name);
  });
  return child;
}

async function stop(name) {
  const child = children.get(name);
  if (!child) return;
  children.delete(name);
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function relayEnvironment(name, roles, apiPort, agentPort, joinToken) {
  return {
    VRRELAY_LISTEN_ADDR: `127.0.0.1:${apiPort}`,
    VRRELAY_PUBLIC_URL: `http://127.0.0.1:${apiPort}`,
    VRRELAY_NODE_NAME: name,
    VRRELAY_NODE_REGION: name.includes('B') ? 'backup' : 'home',
    VRRELAY_NODE_ROLES: roles,
    VRRELAY_REPOSITORY_DRIVER: 'postgres',
    VRRELAY_POSTGRES_URL: `postgres://vrrelay:${postgresPassword}@127.0.0.1:19432/vrrelay`,
    VRRELAY_COORDINATION_DRIVER: 'valkey',
    VRRELAY_VALKEY_URL: 'redis://127.0.0.1:19379',
    VRRELAY_OBJECT_STORE_DRIVER: 'local',
    VRRELAY_OBJECT_STORE_PATH: join(state, 'objects'),
    VRRELAY_DATA_DIR: join(state, name, 'data'),
    VRRELAY_CACHE_DIR: join(state, name, 'cache'),
    VRRELAY_MASTER_KEY: masterKey,
    VRRELAY_SECRET_BACKEND: 'encrypted-file',
    VRRELAY_MEDIAMTX_READ_TOKEN: 'local-smoke-read-token',
    VRRELAY_LOG_LEVEL: 'warn',
    ...(roles === 'controller'
      ? {
          VRRELAY_NODE_ID: 'local-smoke-controller',
          VRRELAY_AGENT_LISTEN_ADDR: `127.0.0.1:${agentPort}`,
          VRRELAY_AGENT_TLS_NAMES: '127.0.0.1,localhost',
          VRRELAY_TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
          VRRELAY_VIEWER_REGION_HEADER: 'x-vrrelay-region'
        }
      : {
          VRRELAY_CONTROLLER_AGENT_URL: `wss://127.0.0.1:${agentPort}/api/v1/nodes/connect`,
          VRRELAY_CONTROLLER_ENROLLMENT_URL: controllerUrl,
          ...(joinToken ? { VRRELAY_NODE_JOIN_TOKEN: joinToken } : {})
        })
  };
}

async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  const response = await fetch(`${controllerUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie && options.auth !== false ? { cookie } : {}),
      ...(csrf && !['GET', 'HEAD'].includes(method) && options.auth !== false
        ? { 'x-csrf-token': csrf }
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
  return body;
}

async function login() {
  const response = await fetch(`${controllerUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'recovery', password: adminPassword })
  });
  const body = await response.json();
  assert(response.ok, `Login failed (${response.status})`);
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  cookie = setCookie.split(';', 1)[0];
  csrf = body.csrfToken;
}

async function joinToken(name, roles, region) {
  return (
    await api('/api/v1/nodes/join-tokens', {
      method: 'POST',
      body: { name, roles, region, expiresInSeconds: 600 }
    })
  ).token;
}

async function fetchMedia(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'VRRelay local cluster smoke', ...headers }
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`Media request failed (${response.status})`);
  assert(body.length > 1_000, 'Media response was unexpectedly small');
  return body;
}

function playlistMedia(playlist) {
  return playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function secretsDoNotContain(directory, forbidden) {
  let entries;
  try {
    entries = await import('node:fs/promises').then(({ readdir }) =>
      readdir(directory, { withFileTypes: true })
    );
  } catch {
    return true;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!(await secretsDoNotContain(path, forbidden))) return false;
    } else {
      const content = await readFile(path).catch(() => Buffer.alloc(0));
      if (forbidden.some((value) => content.includes(Buffer.from(value)))) return false;
    }
  }
  return true;
}

async function main() {
  await rm(state, { recursive: true, force: true });
  await mkdir(state, { recursive: true });
  for (const name of [postgresName, redisName])
    command('docker', ['rm', '-f', name], { allowFailure: true, capture: true });
  command('docker', [
    'run',
    '-d',
    '--name',
    postgresName,
    '-e',
    'POSTGRES_USER=vrrelay',
    '-e',
    `POSTGRES_PASSWORD=${postgresPassword}`,
    '-e',
    'POSTGRES_DB=vrrelay',
    '-p',
    '19432:5432',
    'postgres:18-alpine'
  ]);
  command('docker', [
    'run',
    '-d',
    '--name',
    redisName,
    '-p',
    '19379:6379',
    'valkey/valkey:9.1-alpine',
    'valkey-server',
    '--save',
    '',
    '--appendonly',
    'no'
  ]);
  await waitFor('PostgreSQL', () => {
    const result = command('docker', ['exec', postgresName, 'pg_isready', '-U', 'vrrelay'], {
      allowFailure: true,
      capture: true
    });
    return result.status === 0;
  });

  command('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=48000',
    '-t',
    // Keep the media length aligned with the Jellyfin fixture metadata so
    // distant producer seeks exercise real content instead of end-of-file.
    '80',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '120',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-y',
    join(state, 'fixture.mp4')
  ]);
  const fixtureLog = join(state, 'jellyfin.log');
  const fixture = spawn('node', ['deploy/integration/jellyfin-fixture.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      FIXTURE_PORT: '19096',
      FIXTURE_MEDIA_PATH: join(state, 'fixture.mp4')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  fixture.stdout.on('data', (chunk) => void appendFile(fixtureLog, chunk));
  fixture.stderr.on('data', (chunk) => void appendFile(fixtureLog, chunk));
  children.set('jellyfin', fixture);

  log('Starting the real controller with PostgreSQL, Redis, and local object storage');
  await start('controller', relayEnvironment('Controller', 'controller', 19100, 19110));
  await waitFor(
    'controller API',
    async () => (await fetch(`${controllerUrl}/api/v1/health`).catch(() => undefined))?.ok
  );
  await api('/api/v1/setup', {
    method: 'POST',
    auth: false,
    body: { password: adminPassword }
  });
  await login();

  const claims = {
    workerA: await joinToken('Worker A', ['source-worker'], 'home'),
    workerB: await joinToken('Worker B', ['source-worker'], 'backup'),
    edgeA: await joinToken('Edge A', ['edge'], 'home'),
    edgeB: await joinToken('Edge B', ['edge'], 'backup')
  };
  await Promise.all([
    start('worker-a', relayEnvironment('Worker A', 'source-worker', 19211, 19110, claims.workerA)),
    start('worker-b', relayEnvironment('Worker B', 'source-worker', 19212, 19110, claims.workerB)),
    start('edge-a', relayEnvironment('Edge A', 'edge', 19201, 19110, claims.edgeA)),
    start('edge-b', relayEnvironment('Edge B', 'edge', 19202, 19110, claims.edgeB))
  ]);
  const nodes = await waitFor('four outbound agents', async () => {
    const items = (await api('/api/v1/nodes')).items;
    const agents = items.filter((node) => !node.roles.includes('controller'));
    return agents.length === 4 && agents.every((node) => node.agent.connected) ? items : undefined;
  });
  const node = (name) => nodes.find((candidate) => candidate.name === name);
  const workerA = node('Worker A');
  const workerB = node('Worker B');
  assert(workerA && workerB, 'Source workers were not enrolled');

  log('Binding one provider explicitly to both workers');
  const providerInput = {
    type: 'jellyfin',
    name: 'Local fixture',
    baseUrl: 'http://127.0.0.1:19096',
    authMode: 'user_token',
    username: 'fixture-user',
    password: 'fixture-password',
    allowPublicHttp: false
  };
  const first = await api('/api/v1/provider-bindings', {
    method: 'POST',
    body: { ...providerInput, nodeId: workerA.id }
  });
  const providerId = first.provider.id;
  await api('/api/v1/provider-bindings', {
    method: 'POST',
    body: { ...providerInput, providerId, nodeId: workerB.id }
  });
  await waitFor(
    'provider capability heartbeat',
    async () => {
      const current = (await api('/api/v1/nodes')).items;
      return [workerA.id, workerB.id].every((id) =>
        current
          .find((candidate) => candidate.id === id)
          ?.capabilities.providerIds.includes(providerId)
      );
    },
    45_000
  );
  assert(
    await secretsDoNotContain(join(state, 'Controller', 'data'), [
      'fixture-password',
      'fixture-access-token'
    ]),
    'Provider credentials were found in controller-local storage'
  );

  const catalog = await api(`/api/v1/providers/${providerId}/catalog`);
  const profiles = (await api('/api/v1/profiles')).items;
  const profile = profiles.find((candidate) => candidate.profileId === 'universal-h264-hls-vod');
  const item = catalog.items[0];
  assert(profile && item, 'Catalog or default VOD profile was unavailable');
  const session = await api('/api/v1/sessions', {
    method: 'POST',
    body: {
      kind: 'vod',
      name: 'Local distributed smoke',
      source: {
        providerId,
        itemId: item.id,
        versionId: item.versions[0].id,
        sourceFingerprint: item.versions[0].fingerprint
      },
      profileId: profile.profileId,
      profileRevision: profile.revision,
      platformMode: 'universal',
      pinned: false,
      reportActivity: true,
      placementPolicy: 'hosted',
      playbackTtlSeconds: 600
    }
  });
  const cleanUrl = session.outputUrls.primary;
  const token = cleanUrl.split('/play/')[1].split('/')[0];
  const homeManifest = await (
    await fetch(cleanUrl, {
      headers: {
        'x-vrrelay-region': 'home',
        'user-agent': 'VRRelay local home viewer'
      }
    })
  ).text();
  const backupManifest = await (
    await fetch(cleanUrl, {
      headers: {
        'x-vrrelay-region': 'backup',
        'user-agent': 'VRRelay local backup viewer'
      }
    })
  ).text();
  assert(
    homeManifest.includes('#EXT-X-ENDLIST'),
    'Controller did not return a finite VOD manifest'
  );
  assert(
    playlistMedia(homeManifest).every((line) => line.startsWith('http://127.0.0.1:19201')) &&
      playlistMedia(backupManifest).every((line) => line.startsWith('http://127.0.0.1:19202')),
    'Manifest does not contain absolute edge URLs'
  );
  const rawGrantResponse = await fetch(`http://127.0.0.1:19201/play/${token}/segment/0.ts`);
  assert(rawGrantResponse.status === 401, 'Edge accepted a raw controller playback grant');
  await rawGrantResponse.arrayBuffer();

  log('Coalescing one real FFmpeg segment requested through both edges');
  const [a, b] = await Promise.all([
    fetchMedia(playlistMedia(homeManifest)[0], {
      'user-agent': 'VRRelay local home viewer'
    }),
    fetchMedia(playlistMedia(backupManifest)[0], {
      'user-agent': 'VRRelay local backup viewer'
    })
  ]);
  assert(a.equals(b) && a[0] === 0x47, 'Distributed edges did not return identical MPEG-TS');
  const jobs = (await api('/api/v1/jobs')).items.filter(
    (job) => job.sessionId === session.id && job.segmentIndex === 0
  );
  assert(jobs.length === 1 && jobs[0].state === 'complete', 'Segment work was not coalesced');
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

  log('Rotating an edge certificate and reconnecting without reusing its join token');
  const edgeB = node('Edge B');
  const beforeRotation = edgeB.certificateExpiresAt;
  const rotation = await api(`/api/v1/nodes/${edgeB.id}/certificate/rotate`, {
    method: 'POST',
    body: {}
  });
  assert(
    rotation.certificateExpiresAt !== beforeRotation,
    'Administrative rotation did not issue a replacement'
  );
  await stop('edge-b');
  await start('edge-b', relayEnvironment('Edge B', 'edge', 19202, 19110));
  await waitFor(
    'edge reconnect with rotated identity',
    async () =>
      (await api('/api/v1/nodes')).items.find((candidate) => candidate.id === edgeB.id)?.agent
        .connected
  );

  log('Draining the selected edge and checking refreshed route placement');
  const selectedOrigin = new URL(playlistMedia(homeManifest)[0]).origin;
  const selectedEdge = nodes.find((candidate) => candidate.publicUrl === selectedOrigin);
  await api(`/api/v1/nodes/${selectedEdge.id}/drain`, {
    method: 'POST',
    body: { draining: true }
  });
  const rerouted = await (await fetch(cleanUrl)).text();
  assert(
    playlistMedia(rerouted).every((line) => !line.startsWith(selectedOrigin)),
    'Draining edge remained in refreshed playlist'
  );

  log('Revoking the assigned worker and transcoding on its failover binding');
  const assignedWorker = [workerA, workerB].find(
    (candidate) => candidate.id === session.assignedNodeId
  );
  await api(`/api/v1/nodes/${assignedWorker.id}/revoke`, { method: 'POST', body: {} });
  // Use a distant segment so the continuous producer cannot have prefetched it
  // during the certificate/drain checks above. A nearby segment may already be
  // in the shared object store and would correctly bypass failover placement.
  await fetchMedia(playlistMedia(rerouted)[12]);
  const failoverJob = (await api('/api/v1/jobs')).items.find(
    (job) => job.sessionId === session.id && job.segmentIndex === 12
  );
  assert(failoverJob?.ownerNodeId !== assignedWorker.id, 'Revoked worker retained segment work');
  assert(
    failoverJob?.workerHistory?.at(-1)?.nodeId === failoverJob?.ownerNodeId &&
      failoverJob?.workerHistory?.at(-1)?.state === 'complete',
    'Failover worker completion was not retained in segment-job history'
  );

  log('Restarting PostgreSQL and Redis, then the controller');
  command('docker', ['restart', postgresName]);
  command('docker', ['restart', redisName]);
  await waitFor('database reconnection', async () => {
    try {
      return (await api(`/api/v1/sessions/${session.id}`)).id === session.id;
    } catch {
      return false;
    }
  });
  await stop('controller');
  await start('controller', relayEnvironment('Controller', 'controller', 19100, 19110));
  await waitFor(
    'controller restart',
    async () => (await fetch(`${controllerUrl}/api/v1/health`).catch(() => undefined))?.ok
  );
  await login();
  await waitFor('agent reconnection after controller restart', async () =>
    (await api('/api/v1/nodes')).items
      .filter(
        (candidate) => !candidate.roles.includes('controller') && candidate.state !== 'revoked'
      )
      .every((candidate) => candidate.agent.connected)
  );
  const recoveredManifest = await (await fetch(cleanUrl)).text();
  await fetchMedia(playlistMedia(recoveredManifest)[2]);
  assert(
    (await api(`/api/v1/sessions/${session.id}`)).id === session.id,
    'Controller restart lost the persisted session'
  );
  log('PASS: real distributed VOD, mTLS, coalescing, rotation, reroute, failover, and recovery');
}

let cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    await Promise.all([...children.keys()].map((name) => stop(name)));
    for (const name of [postgresName, redisName])
      command('docker', ['rm', '-f', name], { allowFailure: true, capture: true });
  })();
  return cleanupPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  for (const name of ['controller', 'worker-a', 'worker-b', 'edge-a', 'edge-b', 'jellyfin']) {
    const path = join(state, `${name}.log`);
    const content = await readFile(path, 'utf8').catch(() => '');
    if (content) process.stderr.write(`\n--- ${name} ---\n${content.slice(-8_000)}\n`);
  }
} finally {
  await cleanup();
}
if (failed) process.exitCode = 1;
