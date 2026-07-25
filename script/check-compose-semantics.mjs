// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const standaloneFile = resolve(root, 'deploy/docker/docker-compose.yml');
const multiHostFile = resolve(root, 'deploy/docker/compose.multi-host.yml');

function fail(message) {
  process.stderr.write(`Compose semantic check failed: ${message}\n`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function render(file, arguments_ = []) {
  const result = spawnSync(
    'docker',
    ['compose', '-f', file, ...arguments_, 'config', '--format', 'json'],
    { cwd: root, encoding: 'utf8', env: process.env }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    throw new Error(`docker compose config failed for ${file}`);
  }
  return JSON.parse(result.stdout);
}

function renderProfile(profile) {
  return render(multiHostFile, ['--profile', profile]);
}

function ports(service) {
  return (service.ports ?? [])
    .map((port) => Number(port.published ?? port.target))
    .filter((port) => Number.isFinite(port))
    .sort((left, right) => left - right);
}

function expectServices(profile, expected) {
  const rendered = renderProfile(profile);
  const services = rendered.services ?? {};
  const names = Object.keys(services).sort();
  assert(
    JSON.stringify(names) === JSON.stringify([...expected.services].sort()),
    `${profile} profile rendered services ${names.join(', ')} instead of ${expected.services.join(', ')}`
  );
  for (const [serviceName, role] of Object.entries(expected.roles)) {
    assert(
      services[serviceName]?.environment?.VRRELAY_NODE_ROLES === role,
      `${profile}/${serviceName} must render VRRELAY_NODE_ROLES=${role}`
    );
  }
  for (const [serviceName, expectedPorts] of Object.entries(expected.ports)) {
    const actual = ports(services[serviceName] ?? {});
    assert(
      JSON.stringify(actual) ===
        JSON.stringify([...expectedPorts].sort((left, right) => left - right)),
      `${profile}/${serviceName} published ports ${actual.join(', ') || '(none)'} instead of ${expectedPorts.join(', ') || '(none)'}`
    );
  }
  for (const serviceName of expected.noAgentListener ?? []) {
    assert(
      !services[serviceName]?.environment?.VRRELAY_AGENT_LISTEN_ADDR,
      `${profile}/${serviceName} must not inherit the controller agent listener`
    );
  }
  for (const serviceName of expected.digestImages ?? []) {
    assert(
      String(services[serviceName]?.image ?? '').includes('@sha256:'),
      `${profile}/${serviceName} must render a digest-pinned image`
    );
  }
}

const rawMultiHost = readFileSync(multiHostFile, 'utf8');
assert(!/\bextends\s*:/.test(rawMultiHost), 'multi-host Compose must not use service extends');

const standalone = render(standaloneFile);
const standaloneHttp = (standalone.services?.relay?.ports ?? []).find(
  (port) => Number(port.target) === 8099
);
assert(standaloneHttp, 'standalone relay must publish its HTTP administration port');
assert(
  standaloneHttp?.host_ip === '127.0.0.1',
  `standalone relay HTTP must bind loopback by default, received ${standaloneHttp?.host_ip ?? '(all interfaces)'}`
);

expectServices('controller', {
  services: ['controller'],
  roles: { controller: 'controller' },
  ports: { controller: [8099, 8100] },
  digestImages: ['controller']
});
expectServices('source-worker', {
  services: ['source-worker'],
  roles: { 'source-worker': 'source-worker' },
  ports: { 'source-worker': [] },
  noAgentListener: ['source-worker'],
  digestImages: ['source-worker']
});
expectServices('ingest-origin', {
  services: ['ingest-origin', 'mediamtx-origin'],
  roles: { 'ingest-origin': 'ingest-origin' },
  ports: { 'ingest-origin': [], 'mediamtx-origin': [1935, 8189, 8889, 8890] },
  noAgentListener: ['ingest-origin'],
  digestImages: ['ingest-origin', 'mediamtx-origin']
});
expectServices('edge', {
  services: ['edge', 'mediamtx-edge'],
  roles: { edge: 'edge' },
  ports: { edge: [8099], 'mediamtx-edge': [] },
  noAgentListener: ['edge'],
  digestImages: ['edge', 'mediamtx-edge']
});

if (process.exitCode) process.exit(process.exitCode);
process.stdout.write('Compose semantic checks passed.\n');
