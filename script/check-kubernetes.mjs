// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) throw new Error('Usage: node script/check-kubernetes.mjs <rendered-manifest.yaml>');
const manifest = await readFile(path, 'utf8');
const failures = [];

function requireText(value, message) {
  if (!manifest.includes(value)) failures.push(message);
}

function document(kind, name) {
  return manifest
    .split(/^---\s*$/m)
    .find(
      (candidate) =>
        new RegExp(`(?:^|\\n)kind:\\s*${kind}(?:\\s|$)`).test(candidate) &&
        (candidate.includes(`name: ${name}\n`) || candidate.includes(`name: ${name} }`))
    );
}

const edge = document('Deployment', 'vrrelay-edge');
if (!edge) failures.push('missing edge Deployment');
else {
  for (const required of [
    'name: mediamtx-edge',
    'VRRELAY_LIVE_ORIGIN_URL',
    'srt://vrrelay-mediamtx-origin:8890',
    'http://127.0.0.1:9997',
    'http://127.0.0.1:8099/internal/mediamtx/auth',
    'secretRef: { name: "vrrelay-edge-runtime" }'
  ]) {
    if (!edge.includes(required)) failures.push(`edge Deployment is missing ${required}`);
  }
  if (!/replicas:\s*1\b/.test(edge)) failures.push('edge Deployment must render exactly one node');
}

const origin = document('Deployment', 'vrrelay-mediamtx-origin');
if (!origin) failures.push('missing MediaMTX origin Deployment');
else {
  for (const required of [
    'MTX_AUTHMETHOD',
    'http://vrrelay-ingest-origin:8099/internal/mediamtx/auth',
    'name: api, containerPort: 9997',
    'name: webrtc-ice, containerPort: 8189',
    'MTX_WEBRTCADDITIONALHOSTS',
    'VRRELAY_LIVE_SRT_PASSPHRASE'
  ]) {
    if (!origin.includes(required)) failures.push(`origin Deployment is missing ${required}`);
  }
}

for (const [kind, name] of [
  ['Service', 'vrrelay-controller-agent'],
  ['Service', 'vrrelay-mediamtx-origin'],
  ['Service', 'vrrelay-mediamtx-ingest'],
  ['Ingress', 'vrrelay'],
  ['Ingress', 'vrrelay-edge'],
  ['Ingress', 'vrrelay-whip'],
  ['NetworkPolicy', 'vrrelay-default-deny'],
  ['NetworkPolicy', 'vrrelay-controller-agent'],
  ['NetworkPolicy', 'vrrelay-mediamtx-origin']
]) {
  if (!document(kind, name)) failures.push(`missing ${kind} ${name}`);
}

const originService = document('Service', 'vrrelay-mediamtx-origin');
if (originService?.includes('type: LoadBalancer'))
  failures.push('internal MediaMTX origin service must not be a LoadBalancer');
const ingestService = document('Service', 'vrrelay-mediamtx-ingest');
if (ingestService?.includes('port: 9997') || ingestService?.includes('port: 8888'))
  failures.push('public ingest service exposes MediaMTX API or HLS');
if (!ingestService?.includes('name: webrtc-ice, port: 8189'))
  failures.push('public ingest service does not expose the WebRTC ICE UDP port');

for (const [role, secret] of [
  ['controller', 'vrrelay-controller-runtime'],
  ['source-worker', 'vrrelay-source-worker-runtime'],
  ['ingest-origin', 'vrrelay-ingest-origin-runtime'],
  ['edge', 'vrrelay-edge-runtime']
]) {
  const workload = document('Deployment', `vrrelay-${role}`);
  if (!workload?.includes(`secretRef: { name: "${secret}" }`))
    failures.push(`${role} Deployment does not use its node-scoped Secret`);
  if (!/name:\s*VRRELAY_ENVIRONMENT,\s*value:\s*production/.test(workload ?? ''))
    failures.push(`${role} Deployment does not activate production configuration validation`);
  if (
    !workload?.includes('name: VRRELAY_TRUSTED_PROXY_CIDRS') ||
    !workload.includes('key: VRRELAY_TRUSTED_PROXY_CIDRS')
  )
    failures.push(`${role} Deployment does not require explicit trusted-proxy CIDRs`);
  if (role !== 'controller') {
    if (!/name:\s*VRRELAY_CONTROLLER_AGENT_URL[^\n]*wss:\/\//.test(workload ?? ''))
      failures.push(`${role} Deployment does not configure WSS agent transport`);
    if (!/name:\s*VRRELAY_CONTROLLER_ENROLLMENT_URL[^\n]*https:\/\//.test(workload ?? ''))
      failures.push(`${role} Deployment does not configure HTTPS enrollment`);
  }
}

requireText(
  'backend: { service: { name: vrrelay-edge, port: { name: http } } }',
  'edge ingress does not target the edge relay'
);
requireText(
  'name: vrrelay-controller-agent',
  'controller mTLS agent service is not rendered separately'
);
requireText(
  'backend: { service: { name: vrrelay-mediamtx-origin, port: { name: whip-tcp } } }',
  'trusted WHIP ingress does not target the internal MediaMTX signaling port'
);
requireText(
  'VRRELAY_MEDIAMTX_WHIP_URL, value: "https://ingest.example.com"',
  'controller does not publish the trusted WHIP URL'
);

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log('Kubernetes topology checks passed.');
