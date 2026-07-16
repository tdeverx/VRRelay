// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cloudInit = readFileSync(resolve(root, 'deploy/cloud-init/vrrelay-node.yaml'), 'utf8');
const moduleMain = readFileSync(resolve(root, 'deploy/opentofu/main.tf'), 'utf8');
const moduleVariables = readFileSync(resolve(root, 'deploy/opentofu/variables.tf'), 'utf8');
const moduleOutputs = readFileSync(resolve(root, 'deploy/opentofu/outputs.tf'), 'utf8');
const readme = readFileSync(resolve(root, 'deploy/opentofu/README.md'), 'utf8');
const combinedModule = [moduleMain, moduleVariables, moduleOutputs].join('\n');
const failures = [];

function requireText(source, text, message) {
  if (!source.includes(text)) failures.push(message);
}

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) failures.push(message);
}

for (const [text, message] of [
  ['${image_ref}', 'cloud-init must receive the VRRelay image from OpenTofu'],
  ['${mediamtx_image_ref}', 'cloud-init must receive the MediaMTX image from OpenTofu'],
  [
    'docker compose --profile ${role_profile}',
    'systemd unit must start only the selected role profile'
  ],
  ['/var/lib/vrrelay/data:/data', 'relay data must be persisted outside the container'],
  ['/var/cache/vrrelay:/cache', 'relay cache must be persisted outside the container'],
  ['vrrelay-scrub-join-token', 'cloud-init must install the post-enrollment join-token scrubber'],
  ['"cluster:node-identity"', 'join-token scrubber must wait for persisted node identity'],
  ["sed '/^VRRELAY_NODE_JOIN_TOKEN=/d'", 'join-token scrubber must remove the token from node.env'],
  ['mediamtx-origin', 'ingest-origin cloud-init must include a MediaMTX origin sidecar'],
  ['mediamtx-edge', 'edge cloud-init must include a private MediaMTX edge sidecar'],
  [
    'MTX_AUTHHTTPADDRESS: http://relay:8099/internal/mediamtx/auth',
    'MediaMTX sidecars must authenticate through the local relay'
  ]
]) {
  requireText(cloudInit, text, message);
}

for (const forbidden of [
  'ghcr.io/tdeverx/vrrelay:0.1.0',
  'VRRELAY_NODE_JOIN_TOKEN=${single_use_join_token}',
  'ExecStart=/usr/bin/docker run'
]) {
  if (cloudInit.includes(forbidden))
    failures.push(`cloud-init still contains legacy pattern: ${forbidden}`);
}

for (const [text, message] of [
  ['variable "nodes"', 'OpenTofu module must accept supplied VM node definitions'],
  ['output "cloud_init_user_data"', 'OpenTofu module must output rendered cloud-init user data'],
  ['output "cloud_init_sha256"', 'OpenTofu module must output non-secret cloud-init checksums'],
  [
    'templatefile("${path.module}/../cloud-init/vrrelay-node.yaml"',
    'OpenTofu output must render the cloud-init template'
  ],
  ['@sha256:[0-9a-fA-F]{64}$', 'OpenTofu module must require digest-pinned images'],
  [
    'VRRELAY_NODE_JOIN_TOKEN',
    'OpenTofu module must render single-use join tokens for data-plane nodes'
  ],
  ['VRRELAY_CONTROLLER_AGENT_URL', 'OpenTofu module must render controller agent transport URLs'],
  ['VRRELAY_LIVE_ORIGIN_URL', 'OpenTofu module must render edge live-origin URLs']
]) {
  requireText(combinedModule, text, message);
}

for (const [pattern, message] of [
  [
    /VRRELAY_REPOSITORY_DRIVER\s*=\s*"postgres"/,
    'OpenTofu module must force PostgreSQL repository mode'
  ],
  [
    /VRRELAY_COORDINATION_DRIVER\s*=\s*"valkey"/,
    'OpenTofu module must force Valkey coordination mode'
  ],
  [
    /VRRELAY_SECRET_BACKEND\s*=\s*"encrypted-file"/,
    'OpenTofu module must use persistent encrypted-file secrets'
  ],
  [
    /VRRELAY_MEDIAMTX_API_URL\s*=\s*"http:\/\/mediamtx-origin:9997"/,
    'OpenTofu module must wire ingest-origin MediaMTX API'
  ],
  [
    /VRRELAY_LISTEN_ADDR\s*=\s*"0\.0\.0\.0:8099"/,
    'OpenTofu module must let ingest-origin relay receive MediaMTX sidecar callbacks'
  ],
  [
    /VRRELAY_MEDIAMTX_API_URL\s*=\s*"http:\/\/mediamtx-edge:9997"/,
    'OpenTofu module must wire edge MediaMTX API'
  ]
]) {
  requirePattern(combinedModule, pattern, message);
}

if (/\bresource\s+"/.test(combinedModule))
  failures.push('OpenTofu module must stay provider-neutral and create no cloud resources');

for (const role of ['controller', 'source-worker', 'ingest-origin', 'edge']) {
  requireText(combinedModule, role, `OpenTofu module is missing role support for ${role}`);
}

for (const [text, message] of [
  ['cloud_init_user_data', 'OpenTofu README must document rendered user data'],
  ['cloud_init_sha256', 'OpenTofu README must document retained non-secret checksums'],
  ['VRRELAY_NODE_JOIN_TOKEN', 'OpenTofu README must document join-token cleanup'],
  ['@sha256:<release-digest>', 'OpenTofu README must show digest-pinned image inputs']
]) {
  requireText(readme, text, message);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('Cloud-init/OpenTofu checks passed.');
