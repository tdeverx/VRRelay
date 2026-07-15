// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'deploy/docker/docker-compose.cluster.yml');
const stateDirectory = resolve(root, '.data/cluster-compose-smoke');
const envFile = resolve(stateDirectory, 'smoke.env');
const project = `vrrelay-cluster-smoke-${process.pid}`;
const image = `${project}-relay:latest`;
const controllerUrl = 'http://127.0.0.1:8099';
const adminPassword = `admin-${randomBytes(24).toString('base64url')}`;
const environment = {
  VRRELAY_ENVIRONMENT: 'development',
  VRRELAY_TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
  VRRELAY_CONTROLLER_ENROLLMENT_URL: 'http://controller:8099',
  POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  MINIO_ROOT_USER: 'vrrelay-root',
  // Intentionally option-like to exercise `mc ... --` handling in the production topology.
  MINIO_ROOT_PASSWORD: `-${randomBytes(24).toString('base64url')}`,
  MINIO_CONTROLLER_USER: 'vrrelay-controller',
  MINIO_CONTROLLER_PASSWORD: randomBytes(24).toString('base64url'),
  MINIO_SOURCE_USER: 'vrrelay-source',
  MINIO_SOURCE_PASSWORD: `-${randomBytes(24).toString('base64url')}`,
  MINIO_EDGE_USER: 'vrrelay-edge',
  MINIO_EDGE_PASSWORD: randomBytes(24).toString('base64url'),
  MINIO_INGEST_USER: 'vrrelay-ingest',
  MINIO_INGEST_PASSWORD: randomBytes(24).toString('base64url'),
  VRRELAY_MASTER_KEY: randomBytes(32).toString('base64url'),
  VRRELAY_MEDIAMTX_READ_TOKEN: randomBytes(24).toString('base64url'),
  VRRELAY_SETUP_TOKEN: randomBytes(24).toString('base64url'),
  VRRELAY_PUBLIC_URL: controllerUrl,
  VRRELAY_EDGE_PUBLIC_URL: 'http://127.0.0.1:8100',
  VRRELAY_RTMP_URL: 'rtmp://127.0.0.1:1935/live',
  VRRELAY_SRT_URL: 'srt://127.0.0.1:8890',
  VRRELAY_WHIP_URL: 'http://127.0.0.1:8889',
  VRRELAY_IMAGE: image,
  VRRELAY_SOURCE_JOIN_TOKEN: 'not-enrolled',
  VRRELAY_INGEST_JOIN_TOKEN: 'not-enrolled',
  VRRELAY_EDGE_JOIN_TOKEN: 'not-enrolled'
};

let cookie = '';
let csrfToken = '';
let failed = false;

function log(message) {
  process.stdout.write(`[cluster-compose] ${message}\n`);
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
    ['compose', '--project-name', project, '-f', composeFile, '--env-file', envFile, ...args],
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
      accept: 'application/json',
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
  return body;
}

async function login() {
  const response = await fetch(`${controllerUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: adminPassword })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Administrator login failed (${response.status})`);
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  assert(setCookie, 'Administrator login did not return a session cookie');
  cookie = setCookie.split(';', 1)[0];
  csrfToken = body.csrfToken;
}

async function createJoinToken(name, roles) {
  return (
    await api('/api/v1/nodes/join-tokens', {
      method: 'POST',
      body: { name, roles, region: 'home', expiresInSeconds: 600 }
    })
  ).token;
}

function ensurePortsAvailable() {
  const result = spawnSync('docker', ['ps', '--format', '{{.Ports}}'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Unable to inspect Docker ports');
  for (const port of [1935, 8099, 8100, 8101, 8189, 8889, 8890]) {
    if (new RegExp(`(?:0\\.0\\.0\\.0|\\[::\\]):${port}->`).test(result.stdout))
      throw new Error(`Docker port ${port} is already in use`);
  }
}

async function cleanup() {
  compose(['down', '--volumes', '--remove-orphans'], { allowFailure: true });
  spawnSync('docker', ['image', 'rm', '--force', image], { stdio: 'ignore' });
  await rm(stateDirectory, { recursive: true, force: true });
}

async function run() {
  ensurePortsAvailable();
  await writeEnvironment();
  compose(['down', '--volumes', '--remove-orphans'], { allowFailure: true });

  log('Building the production cluster image');
  compose(['build', 'controller']);
  log('Starting PostgreSQL, Valkey, MinIO initialization, and the controller');
  compose(['up', '--detach', 'postgres', 'valkey', 'minio', 'minio-init', 'controller']);

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

  environment.VRRELAY_SOURCE_JOIN_TOKEN = await createJoinToken('Source worker 1', [
    'source-worker'
  ]);
  environment.VRRELAY_INGEST_JOIN_TOKEN = await createJoinToken('Ingest origin 1', [
    'ingest-origin'
  ]);
  environment.VRRELAY_EDGE_JOIN_TOKEN = await createJoinToken('Edge 1', ['edge']);
  await writeEnvironment();

  log('Enrolling the production source-worker, ingest-origin, and edge over mTLS WSS');
  compose([
    'up',
    '--detach',
    'source-worker',
    'ingest-origin',
    'mediamtx-origin',
    'edge',
    'mediamtx-edge'
  ]);

  const nodes = await waitFor('all three node agents to connect', async () => {
    const items = (await api('/api/v1/nodes')).items;
    const agents = items.filter((node) => !node.roles.includes('controller'));
    return agents.length === 3 && agents.every((node) => node.agent?.connected) ? items : undefined;
  });
  for (const [name, role] of [
    ['Source worker 1', 'source-worker'],
    ['Ingest origin 1', 'ingest-origin'],
    ['Edge 1', 'edge']
  ]) {
    const node = nodes.find((candidate) => candidate.name === name);
    assert(node?.roles.includes(role), `Missing connected ${role} node ${name}`);
  }

  const edgeHealth = await fetch('http://127.0.0.1:8100/api/v1/health');
  assert(edgeHealth.ok, `Edge health returned ${edgeHealth.status}`);
  const mediaMtx = compose(
    [
      'exec',
      '-T',
      'ingest-origin',
      'node',
      '--input-type=module',
      '-e',
      "const r=await fetch('http://mediamtx-origin:9997/v3/config/global/get');if(!r.ok)process.exit(1)"
    ],
    { capture: true }
  );
  assert(mediaMtx.status === 0, 'Ingest origin could not reach the MediaMTX Control API');

  log('Production cluster Compose smoke test passed');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    failed = true;
    void cleanup().finally(() => process.exit(128));
  });
}

try {
  await run();
} catch (error) {
  failed = true;
  compose(['ps'], { allowFailure: true });
  compose(['logs', '--no-color', '--tail', '150'], { allowFailure: true });
  throw error;
} finally {
  await cleanup();
  if (failed) process.exitCode = 1;
}
