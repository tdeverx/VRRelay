// SPDX-License-Identifier: GPL-3.0-or-later
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { UNSAFE_PUBLIC_HTTP_SECURITY_NOTICE } from '@vrrelay/domain';

const BLOCKED_METADATA_IPV4 = new Set([
  '100.100.100.200', // Alibaba Cloud IMDS
  '168.63.129.16', // Azure WireServer
  '192.0.0.192' // Oracle Cloud IMDS compatibility endpoint
]);
const BLOCKED_METADATA_IPV6 = new Set([
  'fd00:ec2::254', // AWS EC2 IMDS
  'fd20:ce::254' // Google Compute Engine metadata
]);

function unbracket(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

function canonicalAddress(address: string): string {
  const normalized = unbracket(address).toLowerCase().split('%', 1)[0]!;
  if (isIP(normalized) !== 6) return normalized;
  return unbracket(new URL(`http://[${normalized}]`).hostname);
}

function mappedIPv4(address: string): string | undefined {
  const normalized = canonicalAddress(address);
  const dotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dotted && isIP(dotted) === 4) return dotted;
  const hexadecimal = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexadecimal) return undefined;
  const high = Number.parseInt(hexadecimal[1]!, 16);
  const low = Number.parseInt(hexadecimal[2]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function ipv4Parts(address: string): [number, number, number, number] | undefined {
  if (isIP(address) !== 4) return undefined;
  const parts = address.split('.').map(Number);
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

function isPrivateIPv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalized = canonicalAddress(address);
  const mapped = mappedIPv4(normalized);
  if (mapped) return isPrivateIPv4(mapped);
  if (normalized === '::1') return true;
  const first = Number.parseInt(normalized.split(':', 1)[0] ?? '', 16);
  return Number.isInteger(first) && first >= 0xfc00 && first <= 0xfdff;
}

function isBlockedAddress(address: string): boolean {
  const normalized = canonicalAddress(address);
  const mapped = mappedIPv4(normalized);
  if (mapped) return isBlockedAddress(mapped);
  const parts = ipv4Parts(normalized);
  if (parts) {
    const [a, b] = parts;
    return a === 0 || (a === 169 && b === 254) || a >= 224 || BLOCKED_METADATA_IPV4.has(normalized);
  }
  if (isIP(normalized) !== 6) return true;
  if (normalized === '::' || BLOCKED_METADATA_IPV6.has(normalized)) return true;
  const first = Number.parseInt(normalized.split(':', 1)[0] ?? '', 16);
  return (
    Number.isInteger(first) &&
    ((first >= 0xfe80 && first <= 0xfebf) || (first >= 0xff00 && first <= 0xffff))
  );
}

export function isPrivateAddress(address: string): boolean {
  const normalized = canonicalAddress(address);
  return isIP(normalized) === 4
    ? isPrivateIPv4(normalized)
    : isIP(normalized) === 6 && isPrivateIPv6(normalized);
}

export interface ProviderUrlPolicyResult {
  normalizedUrl: string;
  privateNetwork: boolean;
  securityNotice?: string;
}

export interface PinnedProviderTarget {
  url: URL;
  address: string;
  family: 4 | 6;
  privateNetwork: boolean;
}

export type ProviderAddressLookup = (
  hostname: string
) => Promise<readonly { address: string; family?: number }[]>;

const systemAddressLookup: ProviderAddressLookup = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function parseProviderUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Provider URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Provider URL must use HTTP or HTTPS');
  if (url.username || url.password) throw new Error('Provider URL must not contain credentials');
  if (url.hash) throw new Error('Provider URL must not contain a fragment');
  return url;
}

/**
 * Resolves and validates a provider host once, then returns the exact address
 * that the HTTP adapter must pin to its socket. Call this immediately before
 * every connection so a second DNS lookup cannot rebind the request.
 */
export async function resolveProviderRequestTarget(
  rawUrl: string,
  addressLookup: ProviderAddressLookup = systemAddressLookup
): Promise<PinnedProviderTarget> {
  const url = parseProviderUrl(rawUrl);
  const hostname = unbracket(url.hostname);
  const literalFamily = isIP(hostname);
  let addresses: readonly { address: string; family?: number }[];
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await addressLookup(hostname);
  } catch {
    throw new Error('Provider host could not be resolved');
  }
  if (addresses.length === 0) throw new Error('Provider host did not resolve');

  const validated = addresses.map(({ address }) => {
    const normalized = unbracket(address);
    const family = isIP(normalized);
    if (family !== 4 && family !== 6)
      throw new Error('Provider host resolved to an invalid address');
    if (isBlockedAddress(normalized))
      throw new Error(
        'Provider URL resolves to a blocked metadata, link-local, multicast, or unspecified address'
      );
    return { address: normalized, family } as const;
  });
  const selected = validated[0]!;
  return {
    url,
    address: selected.address,
    family: selected.family,
    privateNetwork: validated.every(({ address }) => isPrivateAddress(address))
  };
}

export async function validateProviderUrl(
  rawUrl: string,
  allowPublicHttp = false,
  addressLookup: ProviderAddressLookup = systemAddressLookup
): Promise<ProviderUrlPolicyResult> {
  const url = parseProviderUrl(rawUrl);
  if (url.search) throw new Error('Provider URL must not contain a query or fragment');
  const target = await resolveProviderRequestTarget(url.toString(), addressLookup);

  if (url.protocol === 'http:' && !target.privateNetwork && !allowPublicHttp) {
    throw new Error(
      'Credentials cannot be sent to a public HTTP provider without explicit unsafe transport approval'
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return {
    normalizedUrl: url.toString().replace(/\/$/, ''),
    privateNetwork: target.privateNetwork,
    ...(url.protocol === 'http:'
      ? {
          securityNotice: target.privateNetwork
            ? 'HTTP traffic remains unencrypted on the private network.'
            : UNSAFE_PUBLIC_HTTP_SECURITY_NOTICE
        }
      : {})
  };
}
