// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrate = readFileSync(resolve(root, 'deploy/kubernetes/templates/migrate.yaml'), 'utf8');
const runtime = readFileSync(resolve(root, 'deploy/kubernetes/templates/runtime.yaml'), 'utf8');
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
