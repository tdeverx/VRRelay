// SPDX-License-Identifier: GPL-3.0-or-later
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_METADATA = new Set(['169.254.169.254', '100.100.100.200']);

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

export function isPrivateAddress(address: string): boolean {
  return isIP(address) === 4
    ? isPrivateIPv4(address)
    : isIP(address) === 6 && isPrivateIPv6(address);
}

export interface ProviderUrlPolicyResult {
  normalizedUrl: string;
  privateNetwork: boolean;
  securityNotice?: string;
}

export async function validateProviderUrl(
  rawUrl: string,
  allowPublicHttp = false
): Promise<ProviderUrlPolicyResult> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Provider URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) throw new Error('Provider URL must not contain credentials');
  if (url.hash || url.search) throw new Error('Provider URL must not contain a query or fragment');

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('Provider host did not resolve');
  if (addresses.some(({ address }) => BLOCKED_METADATA.has(address))) {
    throw new Error('Provider URL resolves to a blocked metadata address');
  }

  const privateNetwork = addresses.every(({ address }) => isPrivateAddress(address));
  if (url.protocol === 'http:' && !privateNetwork && !allowPublicHttp) {
    throw new Error(
      'Credentials cannot be sent to a public HTTP provider without explicit unsafe transport approval'
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return {
    normalizedUrl: url.toString().replace(/\/$/, ''),
    privateNetwork,
    ...(url.protocol === 'http:'
      ? {
          securityNotice: privateNetwork
            ? 'HTTP traffic remains unencrypted on the private network.'
            : 'Unsafe public HTTP transport is enabled.'
        }
      : {})
  };
}
