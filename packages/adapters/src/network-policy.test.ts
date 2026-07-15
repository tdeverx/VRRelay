// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  isPrivateAddress,
  resolveProviderRequestTarget,
  validateProviderUrl,
  type ProviderAddressLookup
} from './network-policy.js';

describe('provider URL policy', () => {
  it('allows private HTTP with a persistent warning', async () => {
    const result = await validateProviderUrl('http://10.0.0.5:8096/jellyfin/');
    expect(result.normalizedUrl).toBe('http://10.0.0.5:8096/jellyfin');
    expect(result.privateNetwork).toBe(true);
    expect(result.securityNotice).toContain('unencrypted');
  });

  it('blocks credentials and the complete IPv4 and IPv6 link-local ranges', async () => {
    await expect(validateProviderUrl('http://user:secret@127.0.0.1')).rejects.toThrow(
      'credentials'
    );
    await expect(validateProviderUrl('http://169.254.169.254/latest')).rejects.toThrow(
      /metadata, link-local/
    );
    await expect(validateProviderUrl('http://2852039166/latest')).rejects.toThrow(/link-local/);
    await expect(validateProviderUrl('https://169.254.20.10')).rejects.toThrow(/link-local/);
    await expect(validateProviderUrl('https://[fe80::1234]')).rejects.toThrow(/link-local/);
    await expect(validateProviderUrl('https://100.100.100.200')).rejects.toThrow(/metadata/);
    await expect(validateProviderUrl('https://168.63.129.16')).rejects.toThrow(/metadata/);
    await expect(validateProviderUrl('https://[fd00:ec2::254]')).rejects.toThrow(/metadata/);
    await expect(validateProviderUrl('https://[fd20:ce::254]')).rejects.toThrow(/metadata/);
    await expect(
      validateProviderUrl('https://[fd20:00ce:0000:0000:0000:0000:0000:0254]')
    ).rejects.toThrow(/metadata/);
  });

  it('classifies IPv4-mapped IPv6 without bypassing private or blocked ranges', async () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('0000:0000:0000:0000:0000:ffff:7f00:0001')).toBe(true);
    expect(isPrivateAddress('::ffff:10.20.30.40')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    await expect(validateProviderUrl('https://[::ffff:169.254.1.5]')).rejects.toThrow(/link-local/);
  });

  it('rejects a hostname if any freshly resolved address is blocked', async () => {
    const lookup: ProviderAddressLookup = async () => [
      { address: '203.0.113.20', family: 4 },
      { address: '::ffff:a9fe:a9fe', family: 6 }
    ];
    await expect(
      resolveProviderRequestTarget('https://jellyfin.example.test', lookup)
    ).rejects.toThrow(/blocked metadata/);
  });

  it('returns the exact freshly validated address for socket pinning', async () => {
    const calls: string[] = [];
    const lookup: ProviderAddressLookup = async (hostname) => {
      calls.push(hostname);
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const target = await resolveProviderRequestTarget(
      'http://jellyfin.example.test:8096/System/Info',
      lookup
    );
    expect(calls).toEqual(['jellyfin.example.test']);
    expect(target).toMatchObject({
      address: '127.0.0.1',
      family: 4,
      privateNetwork: true
    });
    expect(target.url.hostname).toBe('jellyfin.example.test');
  });

  it('does not repeat a private provider hostname in DNS failure details', async () => {
    await expect(
      resolveProviderRequestTarget('https://private-provider.internal', async () => {
        throw new Error('getaddrinfo ENOTFOUND private-provider.internal');
      })
    ).rejects.toThrow('Provider host could not be resolved');
    await expect(
      resolveProviderRequestTarget('https://private-provider.internal', async () => {
        throw new Error('getaddrinfo ENOTFOUND private-provider.internal');
      })
    ).rejects.not.toThrow(/private-provider\.internal/);
  });

  it('recognizes loopback, RFC1918, CGNAT, unique-local, and bracketed addresses', () => {
    expect(
      [
        '127.0.0.1',
        '10.0.0.1',
        '100.64.0.1',
        '172.20.0.1',
        '192.168.1.2',
        '::1',
        '[::1]',
        'fd00::1'
      ].every(isPrivateAddress)
    ).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});
