import { describe, expect, it } from 'vitest';
import { isPrivateAddress, validateProviderUrl } from './network-policy.js';

describe('provider URL policy', () => {
  it('allows private HTTP with a persistent warning', async () => {
    const result = await validateProviderUrl('http://10.0.0.5:8096/jellyfin/');
    expect(result.normalizedUrl).toBe('http://10.0.0.5:8096/jellyfin');
    expect(result.privateNetwork).toBe(true);
    expect(result.securityNotice).toContain('unencrypted');
  });

  it('blocks credentials and metadata endpoints', async () => {
    await expect(validateProviderUrl('http://user:secret@127.0.0.1')).rejects.toThrow(
      'credentials'
    );
    await expect(validateProviderUrl('http://169.254.169.254/latest')).rejects.toThrow('metadata');
  });

  it('recognizes loopback, RFC1918, and unique-local addresses', () => {
    expect(
      ['127.0.0.1', '10.0.0.1', '172.20.0.1', '192.168.1.2', '::1', 'fd00::1'].every(
        isPrivateAddress
      )
    ).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});
