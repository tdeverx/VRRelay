// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const caddyfile = readFileSync(resolve(root, 'deploy/docker/Caddyfile'), 'utf8');
const tlsCompose = readFileSync(resolve(root, 'deploy/docker/compose.tls.yml'), 'utf8');
const failures = [];

function requireText(source, text, message) {
  if (!source.includes(text)) failures.push(message);
}

for (const [text, message] of [
  ['VRRELAY_DOMAIN', 'TLS compose must require a distinct relay domain'],
  ['VRRELAY_INGEST_DOMAIN', 'TLS compose must require a distinct ingest domain'],
  [
    'VRRELAY_CADDY_IMAGE:?Set digest-pinned VRRELAY_CADDY_IMAGE',
    'TLS compose must require a digest-pinned Caddy image'
  ],
  ['80:80', 'TLS compose must publish ACME HTTP'],
  ['443:443', 'TLS compose must publish HTTPS'],
  ['443:443/udp', 'TLS compose must publish HTTP/3 UDP']
]) {
  requireText(tlsCompose, text, message);
}

if (tlsCompose.includes('8100:8100'))
  failures.push('TLS HTTP proxy must not publish the raw agent mTLS port');

for (const [text, message] of [
  ['{$VRRELAY_DOMAIN}', 'Caddyfile must define the relay front door'],
  ['{$VRRELAY_INGEST_DOMAIN}', 'Caddyfile must define the ingest front door'],
  [
    '@internal path /internal/* /metrics* /debug*',
    'relay front door must block internal/control paths'
  ],
  [
    '@internal path /internal/* /v3/* /metrics* /debug*',
    'ingest front door must block MediaMTX control paths'
  ],
  ['respond @internal 404', 'internal/control path matchers must fail closed'],
  ['reverse_proxy relay:8099', 'relay front door must target only the relay HTTP service'],
  [
    'reverse_proxy {$VRRELAY_INGEST_UPSTREAM}',
    'ingest front door must target the configured WHIP upstream'
  ]
]) {
  requireText(caddyfile, text, message);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('TLS front-door checks passed.');
