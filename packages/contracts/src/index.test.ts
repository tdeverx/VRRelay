// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  CatalogQuerySchema,
  EnrollNodeRequestSchema,
  RotateNodeCertificateRequestSchema,
  SignInConfigurationRequestSchema
} from './index.js';

const capabilities = {
  encoders: [],
  hardwareDevices: [],
  maxWorkers: 1,
  activeWorkers: 0,
  queuedWorkers: 0,
  cacheBytes: 0,
  cacheLimitBytes: null,
  egressMbps: 0,
  providerIds: [],
  vodProducerVersion: 0
};

describe('catalog query contract', () => {
  it('normalizes one or many HTTP query values into a kind list', () => {
    expect(CatalogQuerySchema.parse({ kinds: 'Series' }).kinds).toEqual(['Series']);
    expect(CatalogQuerySchema.parse({ kinds: ['Season', 'Episode'] }).kinds).toEqual([
      'Season',
      'Episode'
    ]);
    expect(CatalogQuerySchema.parse({}).kinds).toEqual([]);
    expect(CatalogQuerySchema.parse({ section: 'next_up' }).section).toBe('next_up');
  });
});

describe('interactive sign-in policy', () => {
  it('keeps playback reporting enabled for existing stored configurations', () => {
    expect(
      SignInConfigurationRequestSchema.parse({
        providerId: 'provider-1',
        defaultProfileId: 'profile-1',
        allowedProfileIds: ['profile-1']
      }).reportPlaybackActivity
    ).toBe(true);
  });
});

describe('node enrollment contract', () => {
  it('accepts only HTTP(S) routing URLs', () => {
    const base = {
      token: 'x'.repeat(32),
      name: 'Edge',
      capabilities,
      csrPem: '-----BEGIN CERTIFICATE REQUEST-----\ntest\n-----END CERTIFICATE REQUEST-----'
    };
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, publicUrl: 'https://edge.example' }).success
    ).toBe(true);
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, publicUrl: 'javascript:alert(1)' }).success
    ).toBe(false);
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, publicUrl: 'ftp://edge.example' }).success
    ).toBe(false);
    expect(
      EnrollNodeRequestSchema.safeParse({
        ...base,
        publicUrl: 'https://user:password@edge.example'
      }).success
    ).toBe(false);
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, publicUrl: 'https://edge.example?token=x' })
        .success
    ).toBe(false);
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, publicUrl: 'https://edge.example#fragment' })
        .success
    ).toBe(false);
  });

  it('requires a bounded certificate signing request', () => {
    const base = {
      token: 'x'.repeat(32),
      name: 'Edge',
      publicUrl: 'https://edge.example',
      capabilities
    };
    expect(EnrollNodeRequestSchema.safeParse(base).success).toBe(false);
    expect(EnrollNodeRequestSchema.safeParse({ ...base, csrPem: 'x' }).success).toBe(true);
    expect(
      EnrollNodeRequestSchema.safeParse({ ...base, csrPem: 'x'.repeat(16 * 1024 + 1) }).success
    ).toBe(false);
  });
});

describe('node certificate rotation contract', () => {
  it('does not advertise an unsupported force option', () => {
    expect(RotateNodeCertificateRequestSchema.safeParse({}).success).toBe(true);
    expect(RotateNodeCertificateRequestSchema.safeParse({ force: true }).success).toBe(false);
  });
});
