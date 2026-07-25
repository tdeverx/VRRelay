// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrate = readFileSync(resolve(root, 'deploy/kubernetes/templates/migrate.yaml'), 'utf8');
const runtime = readFileSync(resolve(root, 'deploy/kubernetes/templates/runtime.yaml'), 'utf8');
const values = readFileSync(resolve(root, 'deploy/kubernetes/values.yaml'), 'utf8');
const schema = readFileSync(resolve(root, 'deploy/kubernetes/values.schema.json'), 'utf8');
const failures = [];

function requireText(source, text, message) {
  if (!source.includes(text)) failures.push(message);
}

for (const [text, message] of [
  ['VRRELAY_ENVIRONMENT', 'migration job does not set production environment'],
  ['VRRELAY_PUBLIC_URL', 'migration job does not set the controller public URL'],
  ['VRRELAY_TRUSTED_PROXY_CIDRS', 'migration job does not require trusted proxy CIDRs'],
  ['VRRELAY_NODE_ROLES', 'migration job does not pin controller role configuration'],
  ['VRRELAY_DATA_DIR', 'migration job does not set a writable data directory'],
  ['VRRELAY_REPOSITORY_DRIVER, value: postgres', 'migration job does not force PostgreSQL'],
  ['VRRELAY_POSTGRES_URL', 'migration job does not read PostgreSQL URL from the controller Secret'],
  [
    'envFrom: [{ secretRef: { name: {{ .Values.secrets.controller | quote }} } }]',
    'migration job does not load the controller Secret'
  ],
  ['mountPath: /var/lib/vrrelay', 'migration job does not mount writable data storage'],
  ['mountPath: /tmp', 'migration job does not mount writable tmp storage'],
  ['{ name: data, emptyDir: {} }', 'migration job does not define data emptyDir'],
  ['{ name: tmp, emptyDir: {} }', 'migration job does not define tmp emptyDir']
]) {
  requireText(migrate, text, message);
}

for (const [source, text, message] of [
  [values, "digest: ''", 'Helm values must expose an optional relay image digest'],
  [
    values,
    'runtimeSecretChecksum',
    'Helm values must expose an operator-supplied runtime Secret checksum'
  ],
  [values, 'externalEgress', 'Helm values must expose explicit external egress CIDR blocks'],
  [
    values,
    'activeDeadlineSeconds',
    'Helm values must configure an upgrade-safe migration deadline'
  ],
  [
    values,
    'repository: bluenviron/mediamtx',
    'Helm values must expose structured MediaMTX image identity'
  ],
  [schema, 'sha256:[0-9a-fA-F]{64}', 'Helm values schema must validate digest-shaped image pins'],
  [schema, '"imageRef"', 'Helm values schema must reuse digest-aware image references'],
  [schema, '"networkPolicy"', 'Helm values schema must validate network policy controls'],
  [
    runtime,
    '$relayImage = printf "%s@%s"',
    'runtime template must render relay images by digest when configured'
  ],
  [
    runtime,
    '$mediaMtxImage = printf "%s@%s"',
    'runtime template must render MediaMTX images by digest when configured'
  ],
  [
    runtime,
    'imagePullPolicy: {{ $root.Values.mediaMtx.image.pullPolicy }}',
    'runtime template must render MediaMTX edge pull policy from values'
  ],
  [
    runtime,
    'checksum/runtime-secrets',
    'runtime template must roll pods on operator-supplied Secret checksum changes'
  ],
  [
    runtime,
    'readinessProbe: { httpGet: { path: /api/v1/ready, port: http }',
    'runtime readiness probes must use dependency-aware readiness'
  ],
  [
    runtime,
    'livenessProbe: { httpGet: { path: /api/v1/health, port: http }',
    'runtime liveness probes must use lightweight health'
  ],
  [runtime, 'ipBlock:', 'runtime template must render explicit network-policy egress ipBlocks'],
  [
    runtime,
    'port: 1024, endPort: 65535, protocol: UDP',
    'runtime template must scope WebRTC UDP egress'
  ],
  [
    migrate,
    '$relayImage = printf "%s@%s"',
    'migration template must render relay images by digest when configured'
  ],
  [migrate, 'activeDeadlineSeconds', 'migration hook must have an active deadline']
]) {
  requireText(source, text, message);
}

if (runtime.includes('egress:\n    - {}'))
  failures.push('Kubernetes runtime network policy must not allow unrestricted egress');

requireText(
  runtime,
  '- { name: VRRELAY_REPOSITORY_DRIVER, value: postgres }',
  'runtime deployments do not force PostgreSQL repository mode'
);
requireText(
  runtime,
  'envFrom: [{ secretRef: { name: {{ index $root.Values.secrets $role | quote }} } }]',
  'runtime deployments do not load role-scoped Secrets'
);

if (/\bVRRELAY_REPOSITORY_DRIVER\b[^\n]*sqlite/i.test(migrate + runtime))
  failures.push('Kubernetes templates must not render SQLite repository mode');

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('Kubernetes template checks passed.');
